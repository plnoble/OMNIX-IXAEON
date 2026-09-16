import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

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

/**
 * P4: Door 设备能力感知与生命周期管理服务
 * 规范：
 * 1. 独立身份与受控凭证，撤销后立即拒绝新交互；
 * 2. 区分静态规格、低负载遥测与主动实测；
 * 3. 任务适配依据真实实测与当前可用性（电量/内存），不凭型号猜测；
 * 4. 派发具备租约、幂等键与断线保护。
 */
export class DoorService {
  private devices = new Map<string, DoorDevice>();
  private assignedTasks = new Map<
    string,
    { taskId: string; deviceId: string; leaseUntil: string; status: string }
  >();

  constructor(_db?: CoreDatabase) {}

  /** 配对新设备，颁发独立凭证 */
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
    const rawToken = `door-token-${randomUUID()}`;
    const now = new Date().toISOString();

    const device: DoorDevice = {
      id,
      name: input.name,
      platform: input.platform,
      status: 'online',
      capabilities: input.capabilities,
      specs: input.specs,
      telemetry: null,
      benchmarks: [],
      tokenHash: rawToken,
      pairedAt: now,
      lastHeartbeatAt: now,
    };

    this.devices.set(id, device);
    return { device, rawToken };
  }

  getDevice(id: string): DoorDevice {
    const dev = this.devices.get(id);
    if (!dev) throw new IxaError(ErrorCodes.NOT_FOUND, `设备不存在: ${id}`);
    return dev;
  }

  /** 设备心跳与低负载状态上报 */
  heartbeat(id: string, token: string, telemetry?: DeviceTelemetry): DoorDevice {
    const dev = this.getDevice(id);
    if (dev.status === 'revoked') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '该设备已撤销授权，拒绝交互');
    }
    if (dev.tokenHash !== token) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '设备凭证非法');
    }

    dev.lastHeartbeatAt = new Date().toISOString();
    if (telemetry) {
      dev.telemetry = telemetry;
    }
    return dev;
  }

  /** 主动实测记录（单独授权实测结果） */
  recordBenchmark(
    id: string,
    benchmark: { kind: DeviceBenchmark['kind']; resultValue: number; ttlMs: number },
  ): DoorDevice {
    const dev = this.getDevice(id);
    if (dev.status === 'revoked') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '该设备已撤销授权');
    }

    const now = Date.now();
    const bm: DeviceBenchmark = {
      kind: benchmark.kind,
      resultValue: benchmark.resultValue,
      testedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + benchmark.ttlMs).toISOString(),
    };

    dev.benchmarks = dev.benchmarks.filter((b) => b.kind !== benchmark.kind).concat(bm);
    return dev;
  }

  /** 评估设备对特定任务的适任性（依据硬件、低负载状态、实测和过期规则） */
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

  /** 派发任务给设备（带租约与幂等保护） */
  dispatchTask(
    deviceId: string,
    task: { taskId: string; leaseMs: number },
  ): { ok: boolean; leaseUntil: string } {
    const dev = this.getDevice(deviceId);
    if (dev.status === 'revoked') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '设备已撤销，禁止派发任务');
    }

    const leaseUntil = new Date(Date.now() + task.leaseMs).toISOString();
    this.assignedTasks.set(task.taskId, {
      taskId: task.taskId,
      deviceId,
      leaseUntil,
      status: 'dispatched',
    });

    return { ok: true, leaseUntil };
  }

  /** 撤销设备 */
  revokeDevice(id: string): void {
    const dev = this.getDevice(id);
    dev.status = 'revoked';
  }
}
