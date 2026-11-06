/**
 * MP3db 复审补测（条件 8/11 与 8 条）：
 * - 执行器失败时给 claimedSuccess:false 回报、raw 带输出 → 候选串换到下一项；
 * - 工作区里的自建报告通道文件（EXECUTOR_CHANNEL_FILE）不算「改过工作区」；
 * - 换过之后 ConfiguredCodingExecutor.lastRunName 是实际做完的那个（任务行写它）。
 *
 * 用假的 CodingExecutor 对象，不起进程。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodingChainExecutor, EXECUTOR_CHANNEL_FILE } from '@ixaeon/core';
import { ConfiguredCodingExecutor } from '../../src/main/codingExecutor.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3db-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TASK = { id: 't', goal: 'g', scope: ['note.txt'], timeout_ms: 60_000 } as never;

function fake(
  name: string,
  run: () => Promise<unknown>,
): {
  name: string;
  calls: number;
  run: () => Promise<unknown>;
} {
  const e = {
    name,
    calls: 0,
    run: async () => {
      e.calls += 1;
      return run();
    },
  };
  return e;
}

describe('复审第 2 条：失败回报带 raw，额度照样换下一个', () => {
  it('假 Claude Code 退出 1、输出 usage_limit_reached → 换到下一项', async () => {
    const first = fake('codex-cli', async () => {
      writeFileSync(join(dir, EXECUTOR_CHANNEL_FILE), 'half', 'utf8');
      return {
        claimedSuccess: false,
        summary: 'Codex 没做成（退出码 1）',
        changedPaths: [],
        testsModified: false,
        raw: 'error: usage_limit_reached',
      };
    });
    const second = fake('claude-code', async () => ({
      claimedSuccess: true,
      summary: 'ok',
      changedPaths: [],
      testsModified: false,
      raw: '',
    }));
    const chain = new CodingChainExecutor(
      () => [
        { key: 'a', label: 'Codex', executor: first as never },
        { key: 'b', label: 'Claude Code · sonnet', executor: second as never },
      ],
      { skip: new Map() },
    );
    const report = await chain.run(TASK, dir, new AbortController().signal);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(String(report.summary)).toContain('由替补「Claude Code · sonnet」来做');
    expect(String(report.summary)).toContain('额度用完');
  });
});

describe('复审第 7 条：EXECUTOR_CHANNEL_FILE 不算改过工作区', () => {
  it('只写了通道文件 + 额度失败 → 仍然换', async () => {
    const first = fake('codex-cli', async () => {
      writeFileSync(join(dir, EXECUTOR_CHANNEL_FILE), 'x', 'utf8');
      return {
        claimedSuccess: false,
        summary: '没做成',
        changedPaths: [],
        testsModified: false,
        raw: 'usage_limit_reached',
      };
    });
    const second = fake('claude-code', async () => ({
      claimedSuccess: true,
      summary: 'ok',
      changedPaths: [],
      testsModified: false,
      raw: '',
    }));
    const chain = new CodingChainExecutor(
      () => [
        { key: 'a', label: 'Codex', executor: first as never },
        { key: 'b', label: 'Claude Code · sonnet', executor: second as never },
      ],
      { skip: new Map() },
    );
    await chain.run(TASK, dir, new AbortController().signal);
    expect(second.calls).toBe(1);
  });
});

describe('复审第 8 条：换过之后 lastRunName 是实际做完的那个', () => {
  it('候选串换到 Claude Code → ConfiguredCodingExecutor.lastRunName = claude-code', async () => {
    const codex = fake('codex-cli', async () => ({
      claimedSuccess: false,
      summary: '没做成',
      changedPaths: [],
      testsModified: false,
      raw: 'usage_limit_reached',
    }));
    const claude = fake('claude-code', async () => ({
      claimedSuccess: true,
      summary: 'ok',
      changedPaths: [],
      testsModified: false,
      raw: '',
    }));
    const chain = new CodingChainExecutor(
      () => [
        { key: 'a', label: 'Codex', executor: codex as never },
        { key: 'b', label: 'Claude Code · sonnet', executor: claude as never },
      ],
      { skip: new Map() },
    );
    const configured = new ConfiguredCodingExecutor(codex as never, () => ({
      use: 'model',
      executor: chain,
    }));
    await configured.run(TASK, dir, new AbortController().signal);
    expect(configured.lastRunName).toBe('claude-code');
  });

  it('没换过时 lastRunName 是开工时那个执行器', async () => {
    const codex = fake('codex-cli', async () => ({
      claimedSuccess: true,
      summary: 'ok',
      changedPaths: [],
      testsModified: false,
      raw: '',
    }));
    const configured = new ConfiguredCodingExecutor(codex as never, () => ({ use: 'codex' }));
    await configured.run(TASK, dir, new AbortController().signal);
    expect(configured.lastRunName).toBe('codex-cli');
  });
});
