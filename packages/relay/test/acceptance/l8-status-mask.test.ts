/**
 * L8 验收测试：`relay status` 打印路径时遮掉用户目录。
 *
 * 逐条对应规格：
 * - 条件 1：数据目录用 `IXAEON_RELAY_DIR` 指到用户目录（`os.homedir()`）底下的临时目录，
 *   跑 `relay status`，输出里没有用户目录原文、有 `~`（JSON 里转义过的反斜杠写法也算原文）。
 * - 条件 2：只改打印，不改 `state.json` / `ledger.jsonl` 里存的东西——跑之前写进去的合成内容
 *   跑完之后一个字不变，存的路径还是原样。
 *
 * 全程用用户目录下的一次性目录（跑完删掉），不读、不写用户本机真的数据目录。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const HOME = homedir();
const dirs: string[] = [];

const mkTmp = (base: string, prefix: string) => {
  const d = mkdtempSync(join(base, prefix));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `relay status` 第一段 JSON 里的 dataDir（JSON 解码之后的值）。 */
const dataDirOf = (stdout: string): string => {
  const m = /"dataDir":\s*"((?:[^"\\]|\\.)*)"/.exec(stdout);
  if (!m) throw new Error(`status 输出里没有 dataDir：${stdout}`);
  return JSON.parse(`"${m[1]}"`) as string;
};

const status = (dataDir: string, worktrees: string) => {
  const env = { ...process.env };
  delete env.IXAEON_NOW;
  env.IXAEON_RELAY_DIR = dataDir;
  env.IXAEON_WORKTREES = worktrees;
  return spawnSync(process.execPath, [CLI, 'status'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });
};

/** 用户目录在输出里可能出现的三种写法（原文、正斜杠、JSON 转义）。 */
const homeForms = (): string[] => [
  HOME,
  HOME.replaceAll('\\', '/'),
  JSON.stringify(HOME).slice(1, -1),
];

describe('条件 1：status 打印时用户目录换成 ~', () => {
  it('数据目录在用户目录下面 → 输出里没有用户目录原文，dataDir 以 ~ 开头', () => {
    const base = mkTmp(HOME, 'ixa-l8-');
    const dataDir = join(base, 'relay');
    const worktrees = join(base, 'worktrees');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktrees, { recursive: true });

    const r = status(dataDir, worktrees);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    for (const form of homeForms()) expect(out).not.toContain(form);
    expect(r.stdout).toContain('~');
    expect(dataDirOf(r.stdout).startsWith('~')).toBe(true);
  }, 60_000);

  it('记账里带着用户目录 → 打印时也遮掉（最近 5 条那一行）', () => {
    const base = mkTmp(HOME, 'ixa-l8-');
    const dataDir = join(base, 'relay');
    const worktrees = join(base, 'worktrees');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktrees, { recursive: true });
    const savedPath = join(HOME, 'synthetic', 'note.txt');
    writeFileSync(
      join(dataDir, 'ledger.jsonl'),
      `${JSON.stringify({
        turn: 1,
        role: 'developer',
        kind: 'developer-claim',
        taskId: '70',
        startedAt: '2026-10-23T00:00:00.000Z',
        endedAt: '2026-10-23T00:01:00.000Z',
        exitCode: 0,
        timedOut: false,
        quotaHit: false,
        statusBefore: '待领',
        statusAfter: '已完成',
        doneLine: `写到了 ${savedPath}`,
        violations: [],
      })}\n`,
      'utf8',
    );

    const r = status(dataDir, worktrees);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    for (const form of homeForms()) expect(out).not.toContain(form);
    expect(r.stdout).toContain('~');
  }, 60_000);
});

describe('条件 2：只改打印，不改存的东西', () => {
  it('state.json / ledger.jsonl 跑之前和跑之后一字不差，存的路径还是原样', () => {
    const base = mkTmp(HOME, 'ixa-l8-');
    const dataDir = join(base, 'relay');
    const worktrees = join(base, 'worktrees');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktrees, { recursive: true });
    const savedPath = join(HOME, 'synthetic', 'note.txt');
    const stateText = `${JSON.stringify(
      { stoppedReason: 'synthetic-stop', pausedUntil: {}, turns: 3 },
      null,
      2,
    )}\n`;
    const ledgerText = `${JSON.stringify({
      turn: 3,
      role: 'developer',
      kind: 'developer-claim',
      taskId: '70',
      startedAt: '2026-10-23T00:00:00.000Z',
      endedAt: '2026-10-23T00:01:00.000Z',
      exitCode: 0,
      timedOut: false,
      quotaHit: false,
      statusBefore: '待领',
      statusAfter: '已完成',
      doneLine: `写到了 ${savedPath}`,
      violations: [],
    })}\n`;
    writeFileSync(join(dataDir, 'state.json'), stateText, 'utf8');
    writeFileSync(join(dataDir, 'ledger.jsonl'), ledgerText, 'utf8');

    const r = status(dataDir, worktrees);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe(stateText);
    expect(readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerText);
    const stored = JSON.parse(
      readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8').trim(),
    ) as { doneLine: string };
    expect(stored.doneLine).toContain(savedPath);
  }, 60_000);
});