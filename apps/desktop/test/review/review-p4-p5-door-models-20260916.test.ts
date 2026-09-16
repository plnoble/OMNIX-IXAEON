/**
 * P4（Door 设备感知）与 P5（模型池与资源调度）验收套件
 * 按照 IXAEON 长期开发总计划 2026-09-16 编制：
 * 1. P4 Door 最小设备身份、生命周期、低负载遥测感知、任务适任性、实测过期与撤权拦截；
 * 2. P5 模型池：隐私硬约束一票否决、多任务匹配、可解释决策与授权内安全故障回退。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DoorService, ModelPool } from '../../../../packages/core/src/index.js';

let door: DoorService;
let pool: ModelPool;

beforeEach(() => {
  door = new DoorService();
  pool = new ModelPool();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P4 Door 设备能力感知与生命周期', () => {
  it('P4-A01 [设备配对与鉴权心跳] 配对颁发独立凭证，凭证非法或撤销后拒绝心跳', () => {
    const { device, rawToken } = door.pairDevice({
      name: '我的 NAS 存储节点',
      platform: 'linux',
      capabilities: ['index', 'verify'],
      specs: {
        cpuCores: 8,
        totalRamMb: 16384,
        storageGb: 4096,
        availableLocalModels: ['qwen2.5-coder:7b'],
      },
    });

    expect(device.id).toBeTruthy();
    expect(device.status).toBe('online');

    // 正常凭证上报心跳
    const updated = door.heartbeat(device.id, rawToken, {
      availableRamMb: 8192,
      reportedAt: new Date().toISOString(),
    });
    expect(updated.telemetry?.availableRamMb).toBe(8192);

    // 伪造错误凭证上报，坚决拒绝
    expect(() => door.heartbeat(device.id, 'fake-token')).toThrow(/设备凭证非法/);

    // 用户在桌面端撤销该设备
    door.revokeDevice(device.id);

    // 撤销后即使携带正确凭证也坚决拒绝
    expect(() => door.heartbeat(device.id, rawToken)).toThrow(/已撤销授权/);
  });

  it('P4-B01 [实测过期与任务适任性评估] 低电量/内存不足拒绝派发，实测过期提示重新测量', () => {
    const { device } = door.pairDevice({
      name: '日常主力手机',
      platform: 'android',
      capabilities: ['chat', 'voice'],
      specs: {
        cpuCores: 8,
        totalRamMb: 8192,
        storageGb: 256,
        availableLocalModels: [],
      },
    });

    // 1. 低电量保护：电量只有 10% 且未充电
    door.heartbeat(device.id, device.tokenHash, {
      availableRamMb: 4096,
      batteryPct: 10,
      isCharging: false,
      reportedAt: new Date().toISOString(),
    });

    const reportBattery = door.evaluateSuitability(device.id, {
      taskKind: 'chat',
      requiredRamMb: 1024,
    });
    expect(reportBattery.suitable).toBe(false);
    expect(reportBattery.reason).toContain('电量过低');

    // 2. 充电后状态恢复正常
    door.heartbeat(device.id, device.tokenHash, {
      availableRamMb: 4096,
      batteryPct: 80,
      isCharging: true,
      reportedAt: new Date().toISOString(),
    });

    const reportOk = door.evaluateSuitability(device.id, {
      taskKind: 'chat',
      requiredRamMb: 1024,
    });
    expect(reportOk.suitable).toBe(true);

    // 3. 内存压力实测与过期检查
    // 注入一条已过期的实测记录（ttlMs = -1000）
    door.recordBenchmark(device.id, {
      kind: 'ram_stress',
      resultValue: 3500,
      ttlMs: -1000,
    });

    const reportExpired = door.evaluateSuitability(device.id, {
      taskKind: 'chat',
      requiredRamMb: 1024,
      requiresActiveBenchmark: true,
    });
    expect(reportExpired.suitable).toBe(false);
    expect(reportExpired.expiredEvaluation).toBe(true);
    expect(reportExpired.reason).toContain('实测评估已过期');
  });

  it('P4-D01 [受控真派发与撤销拦截] 派发带租约保护，已撤销设备禁止派发任务', () => {
    const { device } = door.pairDevice({
      name: '离线工作站',
      platform: 'win32',
      capabilities: ['verify', 'compile'],
      specs: {
        cpuCores: 16,
        totalRamMb: 32768,
        storageGb: 2048,
        availableLocalModels: [],
      },
    });

    // 正常派发低风险任务（租约 60 秒）
    const dispatch = door.dispatchTask(device.id, { taskId: 'task-v01', leaseMs: 60000 });
    expect(dispatch.ok).toBe(true);
    expect(new Date(dispatch.leaseUntil).getTime()).toBeGreaterThan(Date.now());

    // 撤销设备后派发任务被拦截
    door.revokeDevice(device.id);
    expect(() => door.dispatchTask(device.id, { taskId: 'task-v02', leaseMs: 60000 })).toThrow(
      /设备已撤销/,
    );
  });
});

describe('P5 模型池与多维资源调度', () => {
  beforeEach(() => {
    // 注册 1 个高质量云模型与 1 个合规本机模型
    pool.register({
      id: 'deepseek-chat-v3',
      name: 'DeepSeek-V3 云端模型',
      provider: 'deepseek',
      tier: 'cloud',
      privacyScope: 'public',
      supportedTasks: ['extraction', 'research', 'coding', 'chat'],
      contextWindow: 64000,
      costPer1k: 0.002,
      latencyMs: 800,
      healthy: true,
    });

    pool.register({
      id: 'qwen-local-7b',
      name: '千问 7B 本机私密模型',
      provider: 'ollama',
      tier: 'local',
      privacyScope: 'local_only',
      supportedTasks: ['extraction', 'chat'],
      contextWindow: 16000,
      costPer1k: 0,
      latencyMs: 300,
      healthy: true,
    });
  });

  it('P5-C01 [隐私硬约束一票否决] 未获准外发的私密数据，云模型一票否决，强制选择本地模型', () => {
    // 包含个人敏感信息，不允许外发云端 (allowCloud: false)
    const result = pool.selectModel({
      task: 'extraction',
      allowCloud: false,
    });

    // 必须选成本机模型，绝不把云模型作为选项
    expect(result.selected.id).toBe('qwen-local-7b');
    expect(result.selected.tier).toBe('local');
    expect(result.rejectedReasons['deepseek-chat-v3']).toContain(
      '隐私硬限制：本次资料未获准外发云端',
    );
    expect(result.rationale).toContain('已综合比较 2 个候选资源');
  });

  it('P5-C02 [能力匹配与公开展开] 公开研究任务需复杂分析且允许云端时，优先选中高质量模型', () => {
    const result = pool.selectModel({
      task: 'research',
      allowCloud: true,
    });

    expect(result.selected.id).toBe('deepseek-chat-v3');
    // 本地 7B 模型未声明支持复杂 research 任务，被正确排除
    expect(result.rejectedReasons['qwen-local-7b']).toContain('模型未声明支持此类任务');
  });

  it('P5-C03 [授权内安全故障回退] 主选模型故障时受控回退，回退绝不能违背隐私限制', () => {
    // 新增一个备用本地模型
    pool.register({
      id: 'llama-local-3b',
      name: 'Llama 3B 轻量本地备用模型',
      provider: 'ollama',
      tier: 'local',
      privacyScope: 'local_only',
      supportedTasks: ['extraction', 'chat'],
      contextWindow: 8000,
      costPer1k: 0,
      latencyMs: 200,
      healthy: true,
    });

    // 主选本地模型发生故障，在私密限制内回退到备用本地模型
    const fallback = pool.fallback('qwen-local-7b', {
      task: 'extraction',
      allowCloud: false,
    });

    expect(fallback.id).toBe('llama-local-3b');
    expect(fallback.tier).toBe('local');
  });
});
