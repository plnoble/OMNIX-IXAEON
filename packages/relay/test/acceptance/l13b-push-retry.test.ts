/**
 * L13b 验收测试：替开发推送时网络抖一下不停（推送重试三次），rebase 保留合并提交。
 * 规格「验收」1–5，逐条对应：
 *
 * - 条件 1：开发推 `dev/x`，裸仓库的 `pre-receive` 钩子拒第 1 次 → 推上去了：裸仓库 `dev/x`
 *   指向开发那一笔；记账 `ok: true`、没有 `rebased`；没停下；钩子被调了 2 次；钩子两次被调用的
 *   时间戳间隔至少 2 秒（直接量重试等待，不看整棒耗时）。
 * - 条件 2：开发推 `main`（没人先推过），钩子拒前 2 次 → 推上去了：`ok: true`、没有 `rebased`；
 *   钩子被调了 3 次（第 1 次 + 隔 2 秒 + 隔 5 秒）；第 1→2 次间隔至少 2 秒、第 2→3 次至少 5 秒。
 * - 条件 3：开发推 `dev/x`，钩子一直拒 → 停下、`stoppedReason` 含「第 1 棒替开发推送失败：dev/x」；
 *   钩子被调了正好 3 次；后面那条 `RELAY-PUSH` 没推（裸仓库上没有那个分支）。
 * - 条件 4：main 先被别人推了一笔别的文件；开发在检出的分支上 `merge --no-ff` 了一支
 *   （那一支改另一个文件），`RELAY-PUSH <dev> relay-dev main` → 推上去了：裸仓库 main 最新一笔
 *   有两个父提交，别人那一笔是它的祖先，那一支改的文件在 main 上；`ok: true`、`rebased: true`。
 * - 条件 5（L13 条件 2：同一个文件冲突）沿用已锁定的 `l13-rebase-push.test.ts`，这里不重写；
 *   交付说明里记 `acceptance.mjs run L13`、`run L6` 的结果。
 *
 * 合成仓库照 `l6-push.test.ts` / `l13-rebase-push.test.ts`（`l6-harness.ts`）：临时裸仓库当 origin，
 * 不连 GitHub。「推一次失败一次」用裸仓库里的 `pre-receive` 钩子造：钩子读写一个计数文件，
 * 前 N 次 `exit 1`、之后放行（Git for Windows 自带 sh，本机和 CI 都跑得了）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l6-harness.js';

const worlds: World[] = [];
const world = () => {
  const w = makeWorld({});
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

const rowOf = (w: World) => {
  const rows = w.ledger();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

/**
 * 在裸仓库上装一个 `pre-receive` 钩子：前 `times` 次推送 `exit 1`，之后放行。
 * 每次被调用都往计数文件里加一（`calls()` 读它），并把调用时刻（毫秒）追加到时间文件
 * （`times()` 读它）——重试等待直接量两次钩子调用之间的间隔，不靠整棒耗时。
 */
function rejectFirst(w: World, times: number): { calls: () => number; times: () => number[] } {
  const hooks = join(w.origin, 'hooks');
  mkdirSync(hooks, { recursive: true });
  const countFile = join(w.root, 'hook-push-count.txt');
  const timeFile = join(w.root, 'hook-push-times.txt');
  const posix = (p: string) => p.replace(/\\/g, '/');
  const hook = [
    '#!/bin/sh',
    `count_file='${posix(countFile)}'`,
    `time_file='${posix(timeFile)}'`,
    // Git for Windows 和 CI 的 sh 都带 GNU date：%s 秒 + %3N 毫秒
    'printf "%s\\n" "$(date +%s%3N)" >> "$time_file"',
    'n=0',
    'if [ -f "$count_file" ]; then n=$(cat "$count_file"); fi',
    'n=$((n+1))',
    'printf %s "$n" > "$count_file"',
    `if [ "$n" -le ${times} ]; then`,
    '  echo "synthetic: 推一次失败一次" >&2',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(hooks, 'pre-receive'), hook, 'utf8');
  chmodSync(join(hooks, 'pre-receive'), 0o755);
  return {
    calls: () =>
      existsSync(countFile) ? Number(readFileSync(countFile, 'utf8').trim() || '0') : 0,
    times: () =>
      existsSync(timeFile)
        ? readFileSync(timeFile, 'utf8')
            .split('\n')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [],
  };
}

/** 别人（整合方的克隆）往裸仓库 main 推一笔。 */
function othersPush(w: World, file: string, content: string, message = '别人：合成的一笔') {
  w.git(w.integ, ['fetch', '-q', 'origin']);
  writeFileSync(`${w.integ}/${file}`, content, 'utf8');
  w.git(w.integ, ['add', '-A']);
  w.git(w.integ, ['commit', '-q', '-m', message]);
  w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
  return w.originSha('refs/heads/main');
}

describe('条件 1：推 dev/x 被拒 1 次 → 隔 2 秒重试，第 2 次推上去', () => {
  it('裸仓库 dev/x 指向开发那一笔；ok: true、没有 rebased、没停下；钩子 2 次；至少等了 2 秒', async () => {
    const w = world();
    const hook = rejectFirst(w, 1);
    w.writePlan({
      commits: [
        {
          branch: 'dev/x',
          file: 'docs/委派/笔记.md',
          content: '开发 dev/x 的一笔\n',
          message: '开发：dev/x 的一笔',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} dev/x dev/x`],
    });
    const beforeMain = w.originSha('refs/heads/main');

    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(hook.calls()).toBe(2);
    expect(w.originSha('refs/heads/dev/x')).toBe(w.git(w.dev, ['rev-parse', 'dev/x']).out);
    expect(w.originSha('refs/heads/main')).toBe(beforeMain);

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'dev/x', remote: 'dev/x', ok: true });
    expect('rebased' in pushes[0]!).toBe(false);
    expect(w.state().stoppedReason).toBe(null);

    // 直接看重试间隔：第 1 次被钩子拒到第 2 次钩子调用之间，实现里等的是 2 秒。
    const times = hook.times();
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(2_000);
  }, 120_000);
});

describe('条件 2：推 main 被拒前 2 次 → 第 3 次推上去（2 秒 + 5 秒）', () => {
  it('ok: true、没有 rebased；钩子被调了 3 次；main 是开发那一笔', async () => {
    const w = world();
    const hook = rejectFirst(w, 2);
    w.writePlan({
      commits: [
        {
          branch: 'relay-dev',
          file: 'docs/委派/笔记.md',
          content: '开发这一棒的一笔\n',
          message: '开发：合成的一笔',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`],
    });

    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(hook.calls()).toBe(3);
    expect(w.originSha('refs/heads/main')).toBe(w.git(w.dev, ['rev-parse', 'relay-dev']).out);
    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'relay-dev', remote: 'main', ok: true });
    expect('rebased' in pushes[0]!).toBe(false);
    expect(w.state().stoppedReason).toBe(null);

    // 直接量两段重试等待：第 1→2 次至少 2 秒，第 2→3 次至少 5 秒。
    const times = hook.times();
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(2_000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(5_000);
  }, 120_000);
});

describe('条件 3：钩子一直拒 → 试正好 3 次后停下，后面的不推', () => {
  it('stoppedReason 含「第 1 棒替开发推送失败：dev/x」；钩子 3 次；dev/y 没被推', async () => {
    const w = world();
    const hook = rejectFirst(w, 99);
    w.writePlan({
      commits: [
        {
          branch: 'dev/x',
          file: 'docs/委派/笔记.md',
          content: '开发 dev/x 的一笔\n',
          message: '开发：dev/x 的一笔',
        },
        {
          branch: 'dev/y',
          file: 'docs/委派/笔记2.md',
          content: '开发 dev/y 的一笔\n',
          message: '开发：dev/y 的一笔',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} dev/x dev/x`, `RELAY-PUSH ${w.dev} dev/y dev/y`],
    });
    const beforeMain = w.originSha('refs/heads/main');

    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(hook.calls()).toBe(3);
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送失败：dev/x');
    expect(w.originBranches()).toEqual(['main']);
    expect(w.originSha('refs/heads/main')).toBe(beforeMain);

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'dev/x', remote: 'dev/x', ok: false });
    expect('rebased' in pushes[0]!).toBe(false);
  }, 120_000);
});

describe('条件 4：main 被抢先推、开发那一棒里有 merge --no-ff → rebase 保留合并提交', () => {
  it('main 最新一笔两个父提交、别人的是祖先、那一支的文件在；ok: true、rebased: true', async () => {
    const w = world();
    const others = othersPush(w, 'docs/委派/别人.md', '别人推的一笔\n');

    // 开发这一棒里：先在一支上提交，再 merge --no-ff 回检出的 relay-dev
    w.git(w.dev, ['switch', '-q', '-c', 'topic']);
    writeFileSync(`${w.dev}/docs/委派/分支.md`, '那一支改的文件\n', 'utf8');
    w.git(w.dev, ['add', '-A']);
    w.git(w.dev, ['commit', '-q', '-m', '那一支：合成的一笔']);
    w.git(w.dev, ['switch', '-q', 'relay-dev']);
    w.git(w.dev, ['merge', '--no-ff', '-q', 'topic', '-m', '合并那一支']);
    expect(w.git(w.dev, ['rev-list', '--parents', '-n', '1', 'relay-dev']).out.split(/\s+/)).toHaveLength(3);

    w.writePlan({ pushes: [`RELAY-PUSH ${w.dev} relay-dev main`] });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const tip = w.git(w.origin, ['rev-list', '--parents', '-n', '1', 'main']).out.split(/\s+/);
    expect(tip).toHaveLength(3); // 合并提交：自己 + 两个父提交
    expect(w.git(w.origin, ['merge-base', '--is-ancestor', others, 'main']).code).toBe(0);
    expect(w.git(w.origin, ['show', 'main:docs/委派/分支.md']).out).toContain('那一支改的文件');
    expect(w.originSha('refs/heads/main')).toBe(w.git(w.dev, ['rev-parse', 'relay-dev']).out);

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      local: 'relay-dev',
      remote: 'main',
      ok: true,
      rebased: true,
    });
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);
});