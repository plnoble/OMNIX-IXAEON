/**
 * L19 验收测试：撞了 Claude 的周额度就歇到周四凌晨 4 点（委派单「验收」1–6）。
 *
 * 逐条对应：
 * - 条件 1：`nextWeeklyReset` 的三个例子（周四 03:59 → 当天 04:00；周四 04:00 整 → 下周四；
 *   周三 23:00 → 第二天 04:00），以及周四 04:00:00.001、周日中午这两个例子；
 *   返回值都是 UTC 周三 20:00:00.000，返回值和 `now` 的差在 (0, 7 天] 里。
 * - 条件 2：替身角色输出里有 `weeklyQuotaPatterns` 的字样（大小写和配置里不一样）→ `quotaHit` 为 true，
 *   `pausedUntil` 是周三 20:00:00.000Z、晚于现在、不超过 7 天（不再加 `quotaPauseMinutes`）。
 * - 条件 3：同时对上 `quotaPatterns` 和 `weeklyQuotaPatterns` → 按周额度歇。
 * - 条件 4：只对上 `quotaPatterns` → `pausedUntil` 约等于现在 + `quotaPauseMinutes`。
 * - 条件 5：周额度字样只出现在 DSH 的工具结果里（`agentNoise` 去掉的那种行）→ 不算撞额度。
 * - 条件 6：`weeklyQuotaPatterns` 是 `[""]` 或 `["  "]` → 什么都不认；是字符串（不是数组）、
 *   数组里有数字 → `checkConfig` 拒绝，原因照契约第 5 条。
 *
 * 替身命令行是测试自己在临时目录里写的小脚本，全在临时目录里跑，不调真的模型、不碰用户的数据目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkConfig,
  nextWeeklyReset,
  runTurn,
  type RelayConfig,
  type RelayState,
  type Turn,
} from '../../src/index.js';

const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l19-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** 北京时间（UTC+8）的某个时刻 → UTC 的 Date。 */
const beijing = (iso: string): Date => new Date(`${iso}+08:00`);

/** 是「UTC 周三 20:00:00.000」：周额度的刷新点。 */
const isWednesdayReset = (d: Date): boolean =>
  d.getUTCDay() === 3 &&
  d.getUTCHours() === 20 &&
  d.getUTCMinutes() === 0 &&
  d.getUTCSeconds() === 0 &&
  d.getUTCMilliseconds() === 0;

describe('条件 1：nextWeeklyReset', () => {
  it('北京周四 03:59 → 当天 04:00（UTC 周三 20:00）', () => {
    const reset = nextWeeklyReset(beijing('2026-11-05T03:59:00.000'));
    expect(reset.toISOString()).toBe('2026-11-04T20:00:00.000Z');
  });

  it('北京周四 04:00 整 → 下周四 04:00（严格晚于 now）', () => {
    const reset = nextWeeklyReset(beijing('2026-11-05T04:00:00.000'));
    expect(reset.toISOString()).toBe('2026-11-11T20:00:00.000Z');
  });

  it('北京周三 23:00 → 第二天（周四）04:00', () => {
    const reset = nextWeeklyReset(beijing('2026-11-04T23:00:00.000'));
    expect(reset.toISOString()).toBe('2026-11-04T20:00:00.000Z');
  });

  it('北京周四 04:00:00.001 → 下周四 04:00', () => {
    const reset = nextWeeklyReset(beijing('2026-11-05T04:00:00.001'));
    expect(reset.toISOString()).toBe('2026-11-11T20:00:00.000Z');
  });

  it('北京周日中午 → 接下来那个周四 04:00', () => {
    const reset = nextWeeklyReset(beijing('2026-11-08T12:00:00.000'));
    expect(reset.toISOString()).toBe('2026-11-11T20:00:00.000Z');
  });

  it('返回值都是 UTC 周三 20:00:00.000，和 now 的差在 (0, 7 天] 里', () => {
    const samples = [
      '2026-11-05T03:59:00.000',
      '2026-11-05T04:00:00.000',
      '2026-11-04T23:00:00.000',
      '2026-11-05T04:00:00.001',
      '2026-11-08T12:00:00.000',
      '2026-11-01T00:00:00.000',
      '2026-11-12T00:00:00.000',
    ];
    for (const s of samples) {
      const now = beijing(s);
      const reset = nextWeeklyReset(now);
      const diff = reset.getTime() - now.getTime();
      expect(isWednesdayReset(reset), `${s} → ${reset.toISOString()}`).toBe(true);
      expect(diff, `${s}：差 ${diff}ms`).toBeGreaterThan(0);
      expect(diff, `${s}：差 ${diff}ms`).toBeLessThanOrEqual(7 * DAY);
    }
  });
});

/** 替身脚本：按 `--mode` 打不同的行；全是合成字样，不调模型。 */
const STUB = [
  'const mode = process.argv[process.argv.indexOf("--mode") + 1] ?? "weekly";',
  'if (mode === "weekly") {',
  '  console.log("error: WEEKLY QUOTA EXCEEDED, try again after the reset");',
  '} else if (mode === "both") {',
  '  console.log("session limit reached; weekly quota exceeded");',
  '} else if (mode === "session") {',
  '  console.log("error: usage_limit_reached (session limit)");',
  '} else if (mode === "weekly-in-tool") {',
  '  console.log(JSON.stringify({ type: "session", sessionId: "s-1" }));',
  '  console.log(JSON.stringify({ type: "tool_result", output: "weekly quota exceeded" }));',
  '  console.log(JSON.stringify({ type: "final", text: "RELAY-DONE 90 待复审（整合方）" }));',
  '} else if (mode === "ok") {',
  '  console.log("RELAY-DONE 90 待复审（整合方）");',
  '}',
  '',
].join('\n');

function setup(mode: string, over: Partial<RelayConfig['roles']['developer']> = {}) {
  const root = mkTmp();
  const cwd = join(root, 'dev-cwd');
  const dataDir = join(root, 'relay');
  const stub = join(root, 'stub-role.mjs');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stub, STUB, 'utf8');
  const role = (argvMode: string) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--mode', argvMode],
    cwd,
    timeoutMinutes: 60,
    quotaPatterns: ['usage_limit_reached', 'session limit'] as string[],
    quotaPauseMinutes: 200,
  });
  const config: RelayConfig = {
    roles: {
      integrator: role('ok'),
      developer: { ...role(mode), ...over },
    },
    idleSeconds: 60,
  };
  const state: RelayState = { stoppedReason: null, pausedUntil: {}, turns: 0 };
  const turn: Turn = {
    role: 'developer',
    kind: 'developer-continue',
    taskId: '90',
    task: 'L90 合成的周额度一行',
    status: '进行中（dev）',
  };
  return { root, cwd, dataDir, stub, config, state, turn };
}

const pausedUntilOf = (state: RelayState): Date => {
  const raw = state.pausedUntil.developer;
  expect(raw, 'pausedUntil.developer 应当有值').toBeTruthy();
  return new Date(raw!);
};

describe('条件 2：周额度字样（大小写不同）→ 歇到下一个周四 04:00', () => {
  it('quotaPatterns 没对上、weeklyQuotaPatterns 对上 → quotaHit，pausedUntil 是 UTC 周三 20:00', async () => {
    const s = setup('weekly', {
      quotaPatterns: [],
      weeklyQuotaPatterns: ['Weekly Quota Exceeded'],
    });
    const before = Date.now();
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 1 });
    const after = Date.now();

    expect(result.quotaHit).toBe(true);
    const until = pausedUntilOf(s.state);
    expect(isWednesdayReset(until)).toBe(true);
    expect(until.getTime()).toBeGreaterThan(before);
    expect(until.getTime() - before).toBeLessThanOrEqual(7 * DAY + (after - before));
  });
});

describe('条件 3：两种字样同时对上 → 按周额度歇', () => {
  it('会话额度也被对上时也歇到周四 04:00，而不是 now + quotaPauseMinutes', async () => {
    const s = setup('both', {
      quotaPatterns: ['session limit'],
      quotaPauseMinutes: 30,
      weeklyQuotaPatterns: ['weekly quota exceeded'],
    });
    const before = Date.now();
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 2 });
    const after = Date.now();

    expect(result.quotaHit).toBe(true);
    const until = pausedUntilOf(s.state);
    expect(isWednesdayReset(until)).toBe(true);
    expect(until.getTime()).toBeGreaterThan(before);
    expect(until.getTime() - before).toBeLessThanOrEqual(7 * DAY + (after - before));
    // 不是 now + 30 分钟：那样落不到「UTC 周三 20:00:00.000」这个整点上。
    expect(until.getTime() - before).toBeGreaterThan(0);
  });
});

describe('条件 4：只对上 quotaPatterns → 照旧 quotaPauseMinutes', () => {
  it('pausedUntil 约等于现在 + quotaPauseMinutes', async () => {
    const s = setup('session', { quotaPatterns: ['session limit'], quotaPauseMinutes: 200 });
    const before = Date.now();
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 3 });
    const after = Date.now();

    expect(result.quotaHit).toBe(true);
    const until = pausedUntilOf(s.state).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 200 * 60_000 - 5_000);
    expect(until).toBeLessThanOrEqual(after + 200 * 60_000 + 5_000);
  });
});

describe('条件 5：周额度字样只在 DSH 的工具结果里 → 不算撞额度', () => {
  it('tool_result 里的字样不算，quotaHit 为 false、不歇', async () => {
    const s = setup('weekly-in-tool', { quotaPatterns: [], weeklyQuotaPatterns: ['weekly quota'] });
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 4 });

    expect(result.doneLine).toBe('RELAY-DONE 90 待复审（整合方）');
    expect(result.quotaHit).toBe(false);
    expect(s.state.pausedUntil.developer).toBeUndefined();
  });
});

describe('条件 6：空字样不认；配置类型不对 checkConfig 拒绝', () => {
  it('[""] 和 ["  "] → 什么都不认', async () => {
    for (const blanks of [[''], ['  ']]) {
      const s = setup('weekly', { quotaPatterns: [], weeklyQuotaPatterns: blanks });
      const result = await runTurn(s.turn, s.config, s.state, {
        dataDir: s.dataDir,
        turnNumber: 5,
      });
      expect(result.quotaHit, JSON.stringify(blanks)).toBe(false);
      expect(s.state.pausedUntil.developer).toBeUndefined();
    }
  });

  it('是字符串（不是数组）或数组里有数字 → 拒绝启动，原因照契约', () => {
    const cwd = mkTmp();
    const goodRole = () => ({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd,
      timeoutMinutes: 60,
      quotaPatterns: [] as string[],
      quotaPauseMinutes: 10,
    });
    const configWith = (role: 'integrator' | 'developer', bad: unknown): RelayConfig => {
      const config = {
        roles: { integrator: goodRole(), developer: goodRole() },
        idleSeconds: 60,
      } as RelayConfig;
      (config.roles[role] as unknown as Record<string, unknown>).weeklyQuotaPatterns = bad;
      return config;
    };
    for (const role of ['integrator', 'developer'] as const) {
      for (const bad of ['weekly limit', ['weekly limit', 3], [3]]) {
        const r = checkConfig(configWith(role, bad));
        expect(r.ok, `${role} weeklyQuotaPatterns=${JSON.stringify(bad)} 应当被拒绝`).toBe(false);
        if (!r.ok) expect(r.reason).toBe(`${role} 的 weeklyQuotaPatterns 必须是字符串数组`);
      }
    }
  });

  it('没这个字段、[]、["weekly quota"] → 放行', () => {
    const cwd = mkTmp();
    const goodRole = () => ({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd,
      timeoutMinutes: 60,
      quotaPatterns: [] as string[],
      quotaPauseMinutes: 10,
    });
    const base = {
      roles: { integrator: goodRole(), developer: goodRole() },
      idleSeconds: 60,
    } as RelayConfig;
    expect(checkConfig(base).ok).toBe(true);
    for (const good of [[], ['weekly quota'], ['', '  ']]) {
      const config = {
        roles: { integrator: goodRole(), developer: goodRole() },
        idleSeconds: 60,
      } as RelayConfig;
      config.roles.developer.weeklyQuotaPatterns = good;
      const r = checkConfig(config);
      expect(r.ok, JSON.stringify(good)).toBe(true);
    }
  });
});
