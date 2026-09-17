/**
 * P4 自查审核修复验收：Door 设备状态数据库持久化（迁移 24）。
 * 修复前 DoorService 为内存 Map：重启即失、凭证原文入库。
 * 本套件验证：
 * 1. 设备身份、遥测、实测、租约在数据库重启后完整保留；
 * 2. 凭证只落哈希，原文仅配对时出现一次；重启后原文不可再得；
 * 3. 撤销状态持久化，重启后依然拒绝心跳与派发。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  DoorService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-door-persist-'));
  db = openDatabase(join(dir, 'door.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-door-persist-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P4 持久化修复（自查审核 69.2-1）', () => {
  it('PDP-01 [重启保留] 配对、遥测、实测与租约在重启（重开数据库）后完整保留', () => {
    const door = new DoorService(db);
    const { device, rawToken } = door.pairDevice({
      name: '家庭 NAS',
      platform: 'linux',
      capabilities: ['index'],
      specs: {
        cpuCores: 4,
        totalRamMb: 8192,
        storageGb: 2048,
        availableLocalModels: ['qwen2.5:7b'],
      },
    });

    door.heartbeat(device.id, rawToken, {
      availableRamMb: 4096,
      batteryPct: null,
      isCharging: null,
      temperatureC: 41,
      reportedAt: new Date().toISOString(),
    });
    door.recordBenchmark(device.id, {
      kind: 'ram_stress',
      resultValue: 3500,
      ttlMs: 3_600_000,
    });
    door.dispatchTask(device.id, { taskId: 'pdp-task-1', leaseMs: 60_000 });

    // 模拟主节点重启：关闭数据库，重开并迁移（幂等）
    db.close();
    db = openDatabase(join(dir, 'door.db'));
    migrate(db);
    const door2 = new DoorService(db);

    const revived = door2.getDevice(device.id);
    expect(revived.name).toBe('家庭 NAS');
    expect(revived.status).toBe('online');
    expect(revived.telemetry?.availableRamMb).toBe(4096);
    expect(revived.telemetry?.temperatureC).toBe(41);
    expect(revived.benchmarks.length).toBe(1);
    expect(revived.benchmarks[0]!.kind).toBe('ram_stress');

    // 租约同样持久：换设备重派依然被拒（断线后先查原租约）
    const lease = door2.getTaskLease('pdp-task-1');
    expect(lease?.deviceId).toBe(device.id);

    // 重启后凭证原文仍有效（哈希比对），伪造仍拒绝
    expect(() => door2.heartbeat(device.id, rawToken)).not.toThrow();
    expect(() => door2.heartbeat(device.id, 'forged')).toThrow(/设备凭证非法/);
  });

  it('PDP-02 [凭证只落哈希] 数据库中不存凭证原文；重启后撤销状态持久', () => {
    const door = new DoorService(db);
    const { device, rawToken } = door.pairDevice({
      name: '测试手机',
      platform: 'android',
      capabilities: ['chat'],
      specs: {
        cpuCores: 8,
        totalRamMb: 8192,
        storageGb: 256,
        availableLocalModels: [],
      },
    });

    // 库中 token_hash 是 sha256(rawToken)，不是原文
    const row = db.prepare('SELECT token_hash FROM door_devices WHERE id = ?').get(device.id) as {
      token_hash: string;
    };
    expect(row.token_hash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(row.token_hash).not.toBe(rawToken);
    expect(row.token_hash).not.toContain('door-');

    // 撤销 → 重启 → 撤销状态保持，心跳与派发均拒绝
    door.revokeDevice(device.id);
    db.close();
    db = openDatabase(join(dir, 'door.db'));
    migrate(db);
    const door2 = new DoorService(db);

    expect(door2.getDevice(device.id).status).toBe('revoked');
    expect(() => door2.heartbeat(device.id, rawToken)).toThrow(/已撤销授权/);
    expect(() => door2.dispatchTask(device.id, { taskId: 'pdp-task-2', leaseMs: 60_000 })).toThrow(
      /设备已撤销/,
    );
  });
});
