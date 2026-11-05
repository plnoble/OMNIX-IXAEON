/**
 * MP3d 验收条件 8–11：编码候选串的执行器 `CodingChainExecutor`（core 导出）。
 *
 * 构造：`new CodingChainExecutor(candidates: () => CodingCandidate[], { skip, now? })`；
 * `CodingCandidate = { key, label, executor: CodingExecutor | null }`。
 * 用假的 CodingExecutor 对象（不起进程），工作区是否改动由假对象自己写不写文件决定。
 *
 * 8：主选 Codex 报额度、工作区没改 → 换第二项；提示句一字不差；执行器名字是实际做的。
 * 9：工作区已有改动不换；取消 / 超时 / 别的失败不换。
 * 10：主选工具没找到（executor 为 null）→ 直接用第二项，不写提示。
 * 11：5 分钟内先跳过（3 分钟先第二项、6 分钟又先主选、清空 skip 马上主选）。
 *     都不行时写明试过哪几项、各自原因。
 *
 * 现在 `CodingChainExecutor` 还没实现，本文件红在「不是构造函数」。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as core from '@ixaeon/core';
import { ModelError } from '@ixaeon/core';

interface FakeExecutor {
  name: string;
  calls: number;
  run: (task: unknown, workspace: string, signal: AbortSignal) => Promise<unknown>;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3d-chain-exec-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function okExecutor(name: string, writeFile?: string): FakeExecutor {
  const e: FakeExecutor = {
    name,
    calls: 0,
    run: async (_t, workspace) => {
      e.calls += 1;
      if (writeFile) writeFileSync(join(workspace, writeFile), 'x', 'utf8');
      return { summary: 'done', claimedSuccess: true, changes: [] };
    },
  };
  return e;
}

function failExecutor(name: string, message: string, writeFile?: string): FakeExecutor {
  const e: FakeExecutor = {
    name,
    calls: 0,
    run: async (_t, workspace) => {
      e.calls += 1;
      if (writeFile) writeFileSync(join(workspace, writeFile), 'x', 'utf8');
      throw new Error(message);
    },
  };
  return e;
}

interface ChainCtor {
  new (
    candidates: () => Array<{ key: string; label: string; executor: FakeExecutor | null }>,
    opts: { skip: Map<string, number>; now?: () => number },
  ): {
    name: string;
    run: (
      task: unknown,
      workspace: string,
      signal: AbortSignal,
    ) => Promise<{ summary: string; [k: string]: unknown }>;
  };
}

function chainCtor(): ChainCtor {
  const ctor = (core as unknown as Record<string, unknown>)['CodingChainExecutor'] as ChainCtor;
  expect(typeof ctor).toBe('function');
  return ctor;
}

const TASK = { id: 't', goal: '合成目标', scope: ['note.txt'] };

describe('MP3d 条件 8：额度换下一个', () => {
  it('主选报额度、工作区没改 → 换第二项；提示句一字不差；名字是实际做的', async () => {
    const codex = failExecutor('codex-cli', 'usage_limit_reached');
    const claude = okExecutor('claude-code', 'note.txt');
    const skip = new Map<string, number>();
    const chain = new (chainCtor())(
      () => [
        { key: 'tool:codex', label: 'Codex', executor: codex },
        { key: 'tool:claude:sonnet', label: 'Claude Code · sonnet', executor: claude },
      ],
      { skip },
    );
    expect(chain.name).toBe('codex-cli');
    const report = await chain.run(TASK, dir, new AbortController().signal);
    expect(codex.calls).toBe(1);
    expect(claude.calls).toBe(1);
    expect(
      String(report.summary).startsWith(
        '「Codex」这次不行（额度用完），由替补「Claude Code · sonnet」来做',
      ),
    ).toBe(true);
    expect(chain.name).toBe('claude-code');
  });
});

describe('MP3d 条件 9：不换的几种', () => {
  it('工作区已经有改动 → 不换，照失败回报', async () => {
    const codex = failExecutor('codex-cli', 'usage_limit_reached', 'half.txt');
    const claude = okExecutor('claude-code');
    const chain = new (chainCtor())(
      () => [
        { key: 'tool:codex', label: 'Codex', executor: codex },
        { key: 'tool:claude:sonnet', label: 'Claude Code · sonnet', executor: claude },
      ],
      { skip: new Map() },
    );
    const report = await chain
      .run(TASK, dir, new AbortController().signal)
      .catch((e: unknown) => ({ summary: e instanceof Error ? e.message : String(e) }));
    expect(claude.calls).toBe(0);
    expect(String(report.summary)).not.toContain('由替补');
  });

  for (const msg of ['用户取消', '超时', '别的失败']) {
    it(`${msg} → 不换`, async () => {
      const codex = failExecutor('codex-cli', msg);
      const claude = okExecutor('claude-code');
      const chain = new (chainCtor())(
        () => [
          { key: 'tool:codex', label: 'Codex', executor: codex },
          { key: 'tool:claude:sonnet', label: 'Claude Code · sonnet', executor: claude },
        ],
        { skip: new Map() },
      );
      await chain.run(TASK, dir, new AbortController().signal).catch(() => undefined);
      expect(claude.calls).toBe(0);
    });
  }
});

describe('MP3d 条件 8、9 补（整合方 11-05）：判定的其它几种', () => {
  const pair = (first: FakeExecutor, second: FakeExecutor) =>
    new (chainCtor())(
      () => [
        { key: 'a', label: 'A', executor: first },
        { key: 'b', label: 'B', executor: second },
      ],
      { skip: new Map() },
    );

  it('额度不是抛出来的、而是写在失败回报的 raw 里 → 也换', async () => {
    const first: FakeExecutor = {
      name: 'codex-cli',
      calls: 0,
      run: async () => {
        first.calls += 1;
        return { summary: '没做完', claimedSuccess: false, raw: 'error: rate_limit_exceeded' };
      },
    };
    const second = okExecutor('claude-code');
    const report = await pair(first, second).run(TASK, dir, new AbortController().signal);
    expect(second.calls).toBe(1);
    expect(String(report.summary)).toContain('额度用完');
  });

  it('供应商那一项 401 → 换，原因「Key 不对或没权限」；400 → 不换', async () => {
    const bad = failExecutor('model', 'x');
    bad.run = async () => {
      bad.calls += 1;
      throw new ModelError('API 错误 401', false, 401);
    };
    const second = okExecutor('claude-code');
    const report = await pair(bad, second).run(TASK, dir, new AbortController().signal);
    expect(second.calls).toBe(1);
    expect(String(report.summary)).toContain('Key 不对或没权限');

    const bad400 = failExecutor('model', 'x');
    bad400.run = async () => {
      bad400.calls += 1;
      throw new ModelError('API 错误 400', false, 400);
    };
    const second2 = okExecutor('claude-code');
    await pair(bad400, second2)
      .run(TASK, dir, new AbortController().signal)
      .catch(() => undefined);
    expect(second2.calls).toBe(0);
  });

  it('已经取消（signal 已中止）时，就算错误里有额度错误码也不换', async () => {
    const ctrl = new AbortController();
    const first = failExecutor('codex-cli', 'x');
    first.run = async () => {
      first.calls += 1;
      ctrl.abort();
      throw new Error('usage_limit_reached');
    };
    const second = okExecutor('claude-code');
    await pair(first, second)
      .run(TASK, dir, ctrl.signal)
      .catch(() => undefined);
    expect(second.calls).toBe(0);
  });

  it('成功的回报原样带回（没换过时 summary 不加那一句）', async () => {
    const first = okExecutor('codex-cli');
    const second = okExecutor('claude-code');
    const report = await pair(first, second).run(TASK, dir, new AbortController().signal);
    expect(report.summary).toBe('done');
    expect(second.calls).toBe(0);
  });
});

describe('MP3d 条件 10：没找到直接用第二项', () => {
  it('executor 为 null → 用第二项，不写那一句提示', async () => {
    const claude = okExecutor('claude-code');
    const chain = new (chainCtor())(
      () => [
        { key: 'tool:codex', label: 'Codex', executor: null },
        { key: 'tool:claude:sonnet', label: 'Claude Code · sonnet', executor: claude },
      ],
      { skip: new Map() },
    );
    expect(chain.name).toBe('claude-code');
    const report = await chain.run(TASK, dir, new AbortController().signal);
    expect(claude.calls).toBe(1);
    expect(String(report.summary)).not.toContain('由替补');
  });
});

describe('MP3d 条件 11：5 分钟内先跳过', () => {
  it('3 分钟先第二项、6 分钟又先主选、清空 skip 马上主选；都不行时写明试过哪几项', async () => {
    let now = 1_000_000;
    const skip = new Map<string, number>();
    const codex = failExecutor('codex-cli', 'usage_limit_reached');
    const claude = okExecutor('claude-code');
    const make = () =>
      new (chainCtor())(
        () => [
          { key: 'tool:codex', label: 'Codex', executor: codex },
          { key: 'tool:claude:sonnet', label: 'Claude Code · sonnet', executor: claude },
        ],
        { skip, now: () => now },
      );

    // 第一次：主选额度 → 换，记 skip 到 +5 分钟
    await make().run(TASK, dir, new AbortController().signal);
    expect(codex.calls).toBe(1);

    // 3 分钟后：先第二项（主选被排到最后）
    now += 3 * 60_000;
    codex.calls = 0;
    claude.calls = 0;
    await make().run(TASK, dir, new AbortController().signal);
    expect(claude.calls).toBe(1);
    expect(codex.calls).toBe(0);

    // 6 分钟后：又先试主选
    now += 3 * 60_000;
    codex.calls = 0;
    claude.calls = 0;
    await make().run(TASK, dir, new AbortController().signal);
    expect(codex.calls).toBe(1);

    // 清空 skip → 马上先试主选
    skip.clear();
    codex.calls = 0;
    claude.calls = 0;
    await make().run(TASK, dir, new AbortController().signal);
    expect(codex.calls).toBe(1);
  });

  it('都不行：回报写明试过哪几项、各自为什么不行', async () => {
    const codex = failExecutor('codex-cli', 'usage_limit_reached');
    const claude = failExecutor('claude-code', '别的失败');
    const chain = new (chainCtor())(
      () => [
        { key: 'tool:codex', label: 'Codex', executor: codex },
        { key: 'tool:claude:sonnet', label: 'Claude Code · sonnet', executor: claude },
      ],
      { skip: new Map() },
    );
    const report = await chain.run(TASK, dir, new AbortController().signal).catch((e) => e);
    const text = report instanceof Error ? report.message : JSON.stringify(report);
    expect(text).toContain('Codex');
    expect(text).toContain('额度用完');
    expect(text).toContain('Claude Code · sonnet');
  });
});
