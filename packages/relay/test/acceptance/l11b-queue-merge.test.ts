/**
 * L11b 验收测试：替开发推 `main` 时 rebase 撞上队列里的行冲突，两边改的不是同一行就自己合。
 *
 * 逐条对应规格「验收」：
 * - 条件 1：`mergeQueue` 纯函数——
 *   两边各改不同的一行（挨着的两行也算）→ 两处都在、别的行不变；
 *   两边改同一行、改得不一样 → `null`，改得一样 → 就是它；
 *   一边加第 80 行、另一边加第 81 行 → 两行都在、`ours` 的在前；两边都加 80 行、内容不同 → `null`；
 *   一边删了一行、另一边没动它 → 删掉；一边删、另一边改 → `null`；
 *   表头不一样 → `null`；主表后面的说明文字只有一边改了 → 用改了的那边；两边都改、不一样 → `null`；
 *   `\r\n` 的队列合完还是 `\r\n`。
 * - 条件 2：替推（照 `l13-rebase-push.test.ts` 的合成仓库做法）——别人先推一笔改第 71 行状态、
 *   开发这一棒改第 72 行 → 推上去了，main 上两处改动都在，记账 `ok: true`、`rebased: true`，没停下；
 *   别人和开发改同一行 → 停下，main 没被强推，开发目录里没有留下没做完的 rebase。
 *   另加：冲突的不只队列一个文件 → 也照原来停下。
 * - 条件 3：开发这一棒有两笔提交、两笔都和别人的改动在队列里冲突（不同行）→ 两笔都合上、都推上去。
 *
 * 合成仓库照 `l6-harness.ts`（临时裸仓库当 origin，不连 GitHub）。`l6-harness.ts` 是 L6 锁定的，
 * 测试不改它：这里先把自己那份合成的队列（70–73 行）推成三方共同的起点，再做「别人先推」「开发提交」。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeQueue } from '../../src/queue-merge.js';
import { makeWorld, type World } from './l6-harness.js';

const HEADER = '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |';
const SEPARATOR = '| ---- | ---- | ------------ | ---- | ---- | ---- |';

const row = (no: string, status = '待领'): string =>
  `| ${no} | L${no} 合成的一行 | [L${no}](L${no}.md) | A | 无 | ${status} |`;

/** 拼一份合成队列；`before` / `after` 是主表前后的整段（用来测「表外只改了一边」）。 */
function queue(opts: {
  rows: string[];
  before?: string[];
  after?: string[];
  header?: string;
  separator?: string;
  nl?: string;
}): string {
  const nl = opts.nl ?? '\n';
  return [
    ...(opts.before ?? ['# 委派队列', '']),
    opts.header ?? HEADER,
    opts.separator ?? SEPARATOR,
    ...opts.rows,
    ...(opts.after ?? ['', '主表后的说明文字（合成）。', '']),
  ].join(nl) + nl;
}

const three = (statuses: Record<string, string> = {}): string[] =>
  ['71', '72', '73'].map((no) => row(no, statuses[no] ?? '待领'));

describe('条件 1：mergeQueue 纯函数', () => {
  it('两边各改不同的一行（挨着的两行）→ 两处都在、别的行不变', () => {
    const base = queue({ rows: three() });
    const ours = queue({ rows: three({ '71': '进行中（ours）' }) });
    const theirs = queue({ rows: three({ '72': '进行中（theirs）' }) });
    const merged = mergeQueue(base, ours, theirs);
    expect(merged).toBe(queue({ rows: three({ '71': '进行中（ours）', '72': '进行中（theirs）' }) }));
  });

  it('两边改同一行：改得不一样 → null；改得一样 → 合出来就是它', () => {
    const base = queue({ rows: three() });
    const ours = queue({ rows: three({ '72': '进行中（a）' }) });
    const theirs = queue({ rows: three({ '72': '进行中（b）' }) });
    expect(mergeQueue(base, ours, theirs)).toBe(null);
    const same = queue({ rows: three({ '72': '进行中（a）' }) });
    expect(mergeQueue(base, ours, same)).toBe(ours);
  });

  it('一边加第 80 行、另一边加第 81 行 → 两行都在、ours 的在前', () => {
    const base = queue({ rows: three() });
    const ours = queue({ rows: [...three(), row('80', '进行中（a）')] });
    const theirs = queue({ rows: [...three(), row('81', '进行中（b）')] });
    const merged = mergeQueue(base, ours, theirs);
    expect(merged).toBe(queue({ rows: [...three(), row('80', '进行中（a）'), row('81', '进行中（b）')] }));
    expect(merged!.indexOf('| 80 |')).toBeLessThan(merged!.indexOf('| 81 |'));
  });

  it('两边都加第 80 行：一样就放一次；不一样 → null', () => {
    const base = queue({ rows: three() });
    const same = queue({ rows: [...three(), row('80', '待领')] });
    expect(mergeQueue(base, same, same)!.split('| 80 |')).toHaveLength(2); // 只出现一次
    const other = queue({ rows: [...three(), row('80', '等用户：合成的一行')] });
    expect(mergeQueue(base, same, other)).toBe(null);
  });

  it('一边删了一行、另一边没动它 → 删掉；一边删、另一边改 → null', () => {
    const base = queue({ rows: three() });
    const deleted = queue({ rows: [row('71'), row('73')] });
    expect(mergeQueue(base, deleted, base)).toBe(deleted);
    const changed = queue({ rows: three({ '72': '进行中（theirs）' }) });
    expect(mergeQueue(base, deleted, changed)).toBe(null);
  });

  it('表头不一样 → null；主表前后的说明文字只有一边改了 → 用改了的那边；两边都改、不一样 → null', () => {
    const base = queue({ rows: three() });
    const ours = queue({ rows: three({ '71': '进行中（ours）' }) });
    const spaced = queue({ rows: three(), header: '|序号|任务|委派单或规格|档位|依赖|状态|' });
    expect(mergeQueue(base, spaced, base)).toBe(null);
    expect(mergeQueue(base, ours, spaced)).toBe(null);

    const afterChanged = queue({ rows: three(), after: ['', '说明文字（改过）。', ''] });
    expect(mergeQueue(base, base, afterChanged)).toBe(
      queue({ rows: three(), after: ['', '说明文字（改过）。', ''] }),
    );
    const afterOther = queue({ rows: three(), after: ['', '说明文字（另一份）。', ''] });
    expect(mergeQueue(base, afterChanged, afterOther)).toBe(null);

    const beforeChanged = queue({
      rows: three(),
      before: ['# 委派队列（改过）', ''],
    });
    expect(mergeQueue(base, beforeChanged, base)).toBe(beforeChanged);
    const beforeOther = queue({ rows: three(), before: ['# 委派队列（另一份）', ''] });
    expect(mergeQueue(base, beforeChanged, beforeOther)).toBe(null);
  });

  it('\\r\\n 的队列合完还是 \\r\\n', () => {
    const base = queue({ rows: three(), nl: '\r\n' });
    const ours = queue({ rows: three({ '71': '进行中（ours）' }), nl: '\r\n' });
    const theirs = queue({ rows: three({ '72': '进行中（theirs）' }), nl: '\r\n' });
    const merged = mergeQueue(base, ours, theirs);
    expect(merged).not.toBe(null);
    expect(merged!.includes('\r\n')).toBe(true);
    expect(merged!.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

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
 * 合成起点：初始仓库里只有第 70 行；补成 70–73 行推上去，开发目录也退到这一笔——
 * 这样「别人改第 71 行」「开发改第 72 行」才是从同一份队列出发的。
 */
function baseWorld(): { w: World; baseSha: string } {
  const w = world();
  const base = queue({ rows: [row('70'), ...three()] });
  writeFileSync(`${w.integ}/docs/委派/队列.md`, base, 'utf8');
  w.git(w.integ, ['add', '-A']);
  w.git(w.integ, ['commit', '-q', '-m', '合成：70–73 行']);
  w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
  w.git(w.dev, ['fetch', '-q', 'origin']);
  w.git(w.dev, ['reset', '-q', '--hard', 'origin/main']);
  return { w, baseSha: w.originSha('refs/heads/main') };
}

/** 别人（整合方的克隆）往裸仓库推一笔改队列。 */
function othersPush(w: World, content: string, message = '别人：合成的一笔'): string {
  writeFileSync(`${w.integ}/docs/委派/队列.md`, content, 'utf8');
  w.git(w.integ, ['add', '-A']);
  w.git(w.integ, ['commit', '-q', '-m', message]);
  w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
  return w.originSha('refs/heads/main');
}

/** 开发目录里有没有没做完的 rebase。 */
function rebaseInProgress(w: World): boolean {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const rel = w.git(w.dev, ['rev-parse', '--git-path', name]).out;
    if (rel && existsSync(resolve(w.dev, rel))) return true;
  }
  return /rebase in progress|rebase-merge|rebase-apply/.test(w.git(w.dev, ['status']).out);
}

describe('条件 2：替推撞上队列行冲突', () => {
  it('别人改第 71 行、开发改第 72 行（挨着）→ 推上去了，两处都在，ok + rebased，没停下', async () => {
    const { w } = baseWorld();
    const base = queue({ rows: [row('70'), ...three()] });
    const advanced = othersPush(w, queue({ rows: [row('70'), ...three({ '71': '进行中（dev2）' })] }));
    const dev = queue({ rows: [row('70'), ...three({ '72': '进行中（dev）' })] });
    expect(dev).not.toBe(base);

    w.writePlan({
      commits: [
        { branch: 'relay-dev', file: 'docs/委派/队列.md', content: dev, message: '开发：改第 72 行' },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`],
      taskId: '70',
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const log = w.git(w.origin, ['log', '--format=%s', 'main']).out.split('\n');
    expect(log[0]).toBe('开发：改第 72 行');
    expect(log[1]).toBe('别人：合成的一笔');
    expect(w.originSha('refs/heads/main')).not.toBe(advanced);
    expect(w.originSha('refs/heads/main')).toBe(w.git(w.dev, ['rev-parse', 'relay-dev']).out);

    const mainText = w.git(w.origin, ['show', 'main:docs/委派/队列.md']).out;
    expect(mainText).toContain(row('71', '进行中（dev2）'));
    expect(mainText).toContain(row('72', '进行中（dev）'));
    expect(mainText).toContain(row('70', '待领'));
    expect(mainText).toContain(row('73', '待领'));

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'relay-dev', remote: 'main', ok: true, rebased: true });
    expect(w.state().stoppedReason).toBe(null);
    expect(rebaseInProgress(w)).toBe(false);
  }, 120_000);

  it('别人和开发改的是同一行 → 停下、main 没被强推、没留下没做完的 rebase', async () => {
    const { w, baseSha } = baseWorld();
    const advanced = othersPush(w, queue({ rows: [row('70'), ...three({ '71': '进行中（dev2）' })] }));
    const dev = queue({ rows: [row('70'), ...three({ '71': '进行中（dev）' })] });

    w.writePlan({
      commits: [
        { branch: 'relay-dev', file: 'docs/委派/队列.md', content: dev, message: '开发：也改第 71 行' },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`],
      taskId: '70',
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.originSha('refs/heads/main')).toBe(advanced); // 没被强推掉
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送失败：');
    expect(reason).toContain('main');
    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'relay-dev', remote: 'main', ok: false });
    expect('rebased' in pushes[0]!).toBe(false);

    expect(rebaseInProgress(w)).toBe(false);
    expect(w.git(w.dev, ['rev-parse', 'relay-dev^']).out).toBe(baseSha);
  }, 120_000);

  it('冲突的不只队列一个文件 → 也照原来停下', async () => {
    const { w, baseSha } = baseWorld();
    const advanced = othersPush(
      w,
      queue({ rows: [row('70'), ...three({ '71': '进行中（dev2）' })] }),
    );
    // 别人那一笔还改了另一份文件
    writeFileSync(`${w.integ}/docs/委派/笔记.md`, '别人写的笔记\n', 'utf8');
    w.git(w.integ, ['add', '-A']);
    w.git(w.integ, ['commit', '-q', '-m', '别人：队列和笔记一起改']);
    w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
    const bothFiles = w.originSha('refs/heads/main');
    expect(bothFiles).not.toBe(advanced);

    // 开发也改队列（第 72 行）和笔记，笔记内容不同 → 两个文件都冲突
    w.writePlan({
      commits: [
        { branch: 'relay-dev', file: 'docs/委派/队列.md', content: queue({ rows: [row('70'), ...three({ '72': '进行中（dev）' })] }), message: '开发：队列第 72 行' },
        { file: 'docs/委派/笔记.md', content: '开发写的笔记\n', message: '开发：笔记' },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`],
      taskId: '70',
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.originSha('refs/heads/main')).toBe(bothFiles);
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送失败：');
    expect(rebaseInProgress(w)).toBe(false);
    // abort 干净：开发分支还在原来那两笔上（第二笔的父提交还是开棒那条）
    expect(w.git(w.dev, ['rev-parse', 'relay-dev']).out).not.toBe(baseSha);
    expect(w.git(w.dev, ['rev-parse', 'relay-dev^^']).out).toBe(baseSha);
  }, 120_000);
});

describe('条件 3：两笔提交都和别人的改动冲突（不同行）→ 两笔都合上、都推上去', () => {
  it('别人改第 72 行；开发第一笔改第 71 行、第二笔改第 73 行 → 都推上去', async () => {
    const { w } = baseWorld();
    othersPush(w, queue({ rows: [row('70'), ...three({ '72': '进行中（dev2）' })] }));
    const first = queue({ rows: [row('70'), ...three({ '71': '进行中（第 1 笔）', '72': '待领' })] });
    const second = queue({
      rows: [row('70'), ...three({ '71': '进行中（第 1 笔）', '73': '进行中（第 2 笔）' })],
    });

    w.writePlan({
      commits: [
        { branch: 'relay-dev', file: 'docs/委派/队列.md', content: first, message: '开发：第 1 笔改第 71 行' },
        { file: 'docs/委派/队列.md', content: second, message: '开发：第 2 笔改第 73 行' },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`],
      taskId: '70',
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const log = w.git(w.origin, ['log', '--format=%s', 'main']).out.split('\n');
    expect(log[0]).toBe('开发：第 2 笔改第 73 行');
    expect(log[1]).toBe('开发：第 1 笔改第 71 行');
    expect(log[2]).toBe('别人：合成的一笔');

    const mainText = w.git(w.origin, ['show', 'main:docs/委派/队列.md']).out;
    expect(mainText).toContain(row('71', '进行中（第 1 笔）'));
    expect(mainText).toContain(row('72', '进行中（dev2）'));
    expect(mainText).toContain(row('73', '进行中（第 2 笔）'));
    expect(mainText).toContain(row('70', '待领'));

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'relay-dev', remote: 'main', ok: true, rebased: true });
    expect(w.state().stoppedReason).toBe(null);
    expect(rebaseInProgress(w)).toBe(false);
  }, 120_000);
});