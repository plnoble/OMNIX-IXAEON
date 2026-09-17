import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { sha256 } from '../vault.js';

export type DevicePlatform = 'linux' | 'darwin' | 'win32' | 'android' | 'ios';
export type DeviceStatus = 'online' | 'offline' | 'restricted' | 'revoked';

export interface DeviceTelemetry {
  availableRamMb: number;
  batteryPct?: number | null;
  isCharging?: boolean | null;
  temperatureC?: number | null;
  reportedAt: string;
}

export interface DeviceBenchmark {
  kind: 'ram_stress' | 'inference_speed';
  resultValue: number;
  testedAt: string;
  expiresAt: string;
}

export interface DoorDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  status: DeviceStatus;
  capabilities: string[];
  specs: {
    cpuCores: number;
    totalRamMb: number;
    storageGb: number;
    availableLocalModels: string[];
  };
  telemetry: DeviceTelemetry | null;
  benchmarks: DeviceBenchmark[];
  tokenHash: string;
  pairedAt: string;
  lastHeartbeatAt: string;
}

export interface SuitabilityReport {
  suitable: boolean;
  reason: string;
  estimatedResource: string;
  expiredEvaluation: boolean;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  status: string;
  capabilities_json: string;
  cpu_cores: number;
  total_ram_mb: number;
  storage_gb: number;
  local_models_json: string;
  token_hash: string;
  telemetry_json: string | null;
  paired_at: string;
  last_heartbeat_at: string;
}

/**
 * P4: Door 设备能力感知与生命周期管理服务（迁移 24 起数据库持久化）。
 * 规范：
 * 1. 独立身份与受控凭证：配对只落凭证哈希，原文仅在配对响应返回一次，
 *    绝不写入日志或数据库明文；
 * 2. 区分静态规格、低负载遥测与主动实测（带 TTL 过期）；
 * 3. 任务适配依据真实实测与当前可用性（电量/内存），不凭型号猜测；
 * 4. 派发具备租约与幂等：同任务重复派发同设备幂等返回，
 *    换设备派发同任务直接冲突拒绝（断线不得盲目重派副作用工作）；
 * 5. 撤销后立即拒绝新交互与派发，状态持久保存。
 */
export class DoorService {
  constructor(private readonly db: CoreDatabase) {}

  private rowToDevice(row: DeviceRow): DoorDevice {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform as DevicePlatform,
      status: row.status as DeviceStatus,
      capabilities: JSON.parse(row.capabilities_json) as string[],
      specs: {
        cpuCores: row.cpu_cores,
        totalRamMb: row.total_ram_mb,
        storageGb: row.storage_gb,
        availableLocalModels: JSON.parse(row.local_models_json) as string[],
      },
      telemetry: row.telemetry_json ? (JSON.parse(row.telemetry_json) as DeviceTelemetry) : null,
      benchmarks: this.db
        .prepare('SELECT * FROM door_benchmarks WHERE device_id = ? ORDER BY tested_at')
        .all(row.id)
        .map(
          (b) =>
            ({
              kind: (b as { kind: string }).kind as DeviceBenchmark['kind'],
              resultValue: (b as { result_value: number }).result_value,
              testedAt: (b as { tested_at: string }).tested_at,
              expiresAt: (b as { expires_at: string }).expires_at,
            }) satisfies DeviceBenchmark,
        ),
      tokenHash: row.token_hash,
      pairedAt: row.paired_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  }

  /** 配对新设备，颁发独立凭证（原文只出现一次；库中仅存 sha256）。 */
  pairDevice(input: {
    name: string;
    platform: DevicePlatform;
    capabilities: string[];
    specs: {
      cpuCores: number;
      totalRamMb: number;
      storageGb: number;
      availableLocalModels: string[];
    };
  }): { device: DoorDevice; rawToken: string } {
    const id = randomUUID();
    const rawToken = `door-${randomUUID()}${randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO door_devices (id, name, platform, status, capabilities_json, cpu_cores,
           total_ram_mb, storage_gb, local_models_json, token_hash, telemetry_json, paired_at, last_heartbeat_at)
         VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.platform,
        JSON.stringify(input.capabilities),
        input.specs.cpuCores,
        input.specs.totalRamMb,
        input.specs.storageGb,
        JSON.stringify(input.specs.availableLocalModels),
        sha256(rawToken),
        now,
        now,
      );

    return { device: this.getDevice(id), rawToken };
  }

  getDevice(id: string): DoorDevice {
    const row = this.db.prepare('SELECT * FROM door_devices WHERE id = ?').get(id) as
      DeviceRow | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `设备不存在: ${id}`);
    return this.rowToDevice(row);
  }

  listDevices(): DoorDevice[] {
    const rows = this.db.prepare('SELECT id FROM door_devices ORDER BY paired_at').all() as Array<{
      id: string;
    }>;
    return rows.map((r) => this.getDevice(r.id));
  }

  /** 设备心跳与低负载状态上报（凭证哈希比对；撤销后拒绝）。 */
  heartbeat(id: string, token: string, telemetry?: DeviceTelemetry): DoorDevice {
    const dev = this.getDevice(id);
    if (dev.status === 'revoked') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '该设备已撤销授权，拒绝交互');
    }
    if (dev.tokenHash !== sha256(token)) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '设备凭证非法');
    }

    this.db
      .prepare('UPDATE door_devices SET last_heartbeat_at = ?, telemetry_json = ? WHERE id = ?')
      .run(
        new Date().toISOString(),
        telemetry ? JSON.stringify(telemetry) : JSON.stringify(dev.telemetry),
        id,
      );
    return this.getDevice(id);
  }

  /** 主动实测记录（单独授权实测结果，带 TTL；同种类覆盖旧记录）。 */
  recordBenchmark(
    id: string,
    benchmark: { kind: DeviceBenchmark['kind']; resultValue: number; ttlMs: number },
  ): DoorDevice {
    const dev = this.getDevice(id);
    if (dev.status === 'revoked') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '该设备已撤销授权');
    }

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO door_benchmarks (id, device_id, kind, result_value, tested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, kind) DO UPDATE SET
           result_value = excluded.result_value,
           tested_at = excluded.tested_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        randomUUID(),
        id,
        benchmark.kind,
        benchmark.resultValue,
        new Date(now).toISOString(),
        new Date(now + benchmark.ttlMs).toISOString(),
      );
    return this.getDevice(id);
  }

  /** 评估设备对特定任务的适任性（依据硬件、低负载状态、实测和过期规则）。 */
  evaluateSuitability(
    id: string,
    input: {
      taskKind: string;
      requiredRamMb: number;
      requiresActiveBenchmark?: boolean;
    },
  ): SuitabilityReport {
    const dev = this.getDevice(id);
    if (dev.status === 'revoked') {
      return {
        suitable: false,
        reason: '设备已撤销',
        estimatedResource: 'none',
        expiredEvaluation: false,
      };
    }
    if (!dev.capabilities.includes(input.taskKind)) {
      return {
        suitable: false,
        reason: `设备未获准或不支持该类任务（${input.taskKind}）`,
        estimatedResource: 'none',
        expiredEvaluation: false,
      };
    }

    // 检查低负载遥测（电量与内存）
    if (dev.telemetry) {
      if (
        dev.telemetry.batteryPct !== undefined &&
        dev.telemetry.batteryPct !== null &&
        dev.telemetry.batteryPct < 20 &&
        !dev.telemetry.isCharging
      ) {
        return {
          suitable: false,
          reason: '设备电量过低（<20% 且未充电），避免耗尽电池',
          estimatedResource: 'battery_constrained',
          expiredEvaluation: false,
        };
      }
      if (dev.telemetry.availableRamMb < input.requiredRamMb) {
        return {
          suitable: false,
          reason: `当前可用内存不足（剩余 ${dev.telemetry.availableRamMb} MB，需 ${input.requiredRamMb} MB）`,
          estimatedResource: 'ram_constrained',
          expiredEvaluation: false,
        };
      }
    }

    // 检查实测有效性
    let expired = false;
    if (input.requiresActiveBenchmark) {
      const bm = dev.benchmarks.find((b) => b.kind === 'ram_stress');
      if (!bm) {
        return {
          suitable: false,
          reason: '缺少主动压力实测记录，不能盲目下派密集型任务',
          estimatedResource: 'untested',
          expiredEvaluation: false,
        };
      }
      if (new Date(bm.expiresAt).getTime() < Date.now()) {
        expired = true;
        return {
          suitable: false,
          reason: '实测评估已过期，设备状态可能已变化，需重新测量',
          estimatedResource: 'expired',
          expiredEvaluation: true,
        };
      }
    }

    return {
      suitable: true,
      reason: '设备资源与能力检查通过，适宜承担本任务',
      estimatedResource: `需 RAM约 ${input.requiredRamMb}MB`,
      expiredEvaluation: expired,
    };
  }

  /**
   * 派发任务给设备（带租约与幂等保护）。
   * - 同任务重复派发到同一设备：幂等返回现有租约，不新建副作用；
   * - 同任务换设备：CONFLICT 拒绝（断线后必须先查询原租约状态，不能盲目重派）。
   */
  dispatchTask(
    deviceId: string,
    task: { taskId: string; leaseMs: number },
  ): { ok: boolean; leaseUntil: string } {
    const dev = this.getDevice(deviceId);
    if (dev.status === 'revoked') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '设备已撤销，禁止派发任务');
    }

    const existing = this.getTaskLease(task.taskId);
    if (existing) {
      if (existing.deviceId === deviceId) {
        return { ok: true, leaseUntil: existing.leaseUntil };
      }
      throw new IxaError(
        ErrorCodes.CONFLICT,
        `任务 ${task.taskId} 已持有设备 ${existing.deviceId} 的租约，换设备重派必须先核销原租约`,
      );
    }

    const leaseUntil = new Date(Date.now() + task.leaseMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO door_task_leases (task_id, device_id, lease_until, status, created_at)
         VALUES (?, ?, ?, 'dispatched', ?)`,
      )
      .run(task.taskId, deviceId, leaseUntil, new Date().toISOString());

    return { ok: true, leaseUntil };
  }

  /** 查询任务租约（断线恢复时先查原状态再决定动作）。 */
  getTaskLease(
    taskId: string,
  ): { taskId: string; deviceId: string; leaseUntil: string; status: string } | null {
    const row = this.db.prepare('SELECT * FROM door_task_leases WHERE task_id = ?').get(taskId) as
      { task_id: string; device_id: string; lease_until: string; status: string } | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      deviceId: row.device_id,
      leaseUntil: row.lease_until,
      status: row.status,
    };
  }

  /** 结束租约（完成/取消后核销）。 */
  settleTaskLease(taskId: string, status: string): void {
    const info = this.db
      .prepare('UPDATE door_task_leases SET status = ? WHERE task_id = ?')
      .run(status, taskId);
    if (info.changes === 0) {
      throw new IxaError(ErrorCodes.NOT_FOUND, `租约不存在: ${taskId}`);
    }
  }

  /** 撤销设备（持久化；立即拒绝后续心跳、评测与派发）。 */
  revokeDevice(id: string): void {
    this.getDevice(id);
    this.db.prepare("UPDATE door_devices SET status = 'revoked' WHERE id = ?").run(id);
  }
}
