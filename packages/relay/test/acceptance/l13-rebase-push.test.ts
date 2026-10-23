/**
 * L13 验收测试：替开发推 `main` 被拒时，先 rebase 再推一次（规格「验收」1–5）。
 *
 * 逐条对应：
 * - 条件 1：裸仓库 main 先被别人推了一笔**别的文件** → 开发那一笔被拒后调度器 fetch + rebase 再推；
 *   裸仓库 main 上两笔都在、开发那一笔在别人那一笔后面；记账 `ok: true`、`rebased: true`；没停下。
 * - 条件 2：别人那一笔改的是**同一个文件**（rebase 冲突）→ 停下、`stoppedReason` 含
 *   「第 1 棒替开发推送失败：」；裸仓库 main 还是别人那一笔（没被强推）；开发目录里没有
 *   留着没做完的 rebase（`git status` 里没有 rebase 进行中）。
 * - 条件 3：推 `dev/x` 被拒（裸仓库上那个分支被别人推过）→ 不重试、照原来停下，记账那一条没有 `rebased`。
 * - 条件 4：`local` 不是检出的分支（目录里检出的是 `a`、推的是 `b`）、main 被拒 → 不重试、照原来停下。
 * - 条件 5：没被拒的推送记账里没有 `rebased`。
 *
 * 另加一条（契约第 2 条里和「当前检出的分支」并列的写法）：`local` 是 `HEAD`（目录 detached）→ 也要重试。
 *
 * 照 `l6-push.test.ts` 的合成仓库做法（`l6-harness.ts`）：临时裸仓库当 origin，不连 GitHub。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** 别人（整合方的克隆）往裸仓库推一笔。 */
function othersPush(w: World, file: string, content: string, message = '别人：合成的一笔') {
  w.git(w.integ, ['fetch', '-q', 'origin']);
  writeFileSync(`${w.integ}/${file}`, content, 'utf8');
  w.git(w.integ, ['add', '-A']);
  w.git(w.integ, ['commit', '-q', '-m', message]);
  w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
  return w.originSha('refs/heads/main');
}

/** 开发目录里有没有没做完的 rebase（`.git/<worktree>/rebase-merge` 之类的目录在不在）。 */
function rebaseInProgress(w: World): boolean {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const rel = w.git(w.dev, ['rev-parse', '--git-path', name]).out;
    if (rel && existsSync(resolve(w.dev, rel))) return true;
  }
  return /rebase in progress|rebase-merge|rebase-apply/.test(w.git(w.dev, ['status']).out);
}

describe('条件 1：main 被拒、别人改的是别的文件 → rebase 后推上去', () => {
  it('裸仓库 main 两笔都在、开发那笔在后面；ok: true、rebased: true；没停下', async () => {
    const w = world();
    const generated = othersPush(w, 'docs/委派/别人.md', '别人推的一笔\n');
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

    // 两笔都在，链条是 别人那一笔 → 开发那一笔
    const log = w.git(w.origin, ['log', '--format=%s', 'main']).out.split('\n');
    expect(log[0]).toBe('开发：合成的一笔');
    expect(log[1]).toBe('别人：合成的一笔');
    expect(w.originSha('refs/heads/main')).toBe(w.git(w.dev, ['rev-parse', 'relay-dev']).out);
    expect(w.git(w.origin, ['rev-parse', 'main']).out).not.toBe(generated);

    const row = rowOf(w);
    const pushes = row.pushes as Array<Record<string, unknown>>;
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

describe('条件 1（契约第 2 条）：local 是 HEAD → 同样 rebase 再推', () => {
  it('目录 detached 在 HEAD、推 main 被拒 → 重试推上去、rebased: true', async () => {
    const w = world();
    othersPush(w, 'docs/委派/别人.md', '别人推的一笔\n');
    w.git(w.dev, ['checkout', '-q', '--detach']);
    w.writePlan({
      commits: [
        { file: 'docs/委派/笔记.md', content: '开发这一棒的一笔\n', message: '开发：HEAD 的一笔' },
      ],
      pushes: [`RELAY-PUSH ${w.dev} HEAD main`],
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const log = w.git(w.origin, ['log', '--format=%s', 'main']).out.split('\n');
    expect(log[0]).toBe('开发：HEAD 的一笔');
    expect(log[1]).toBe('别人：合成的一笔');
    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'HEAD', remote: 'main', ok: true, rebased: true });
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);
});

describe('条件 2：main 被拒、别人改的是同一个文件 → 冲突，停下、不留 rebase', () => {
  it('stoppedReason 含「第 1 棒替开发推送失败：」；main 还是别人那一笔；没有 rebase 进行中', async () => {
    const w = world();
    const advanced = othersPush(w, 'docs/委派/笔记.md', '别人推的一笔\n');
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

    expect(w.originSha('refs/heads/main')).toBe(advanced); // 没被强推掉
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送失败：');
    expect(reason).toContain('main');

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ remote: 'main', ok: false });
    expect('rebased' in pushes[0]!).toBe(false);

    // rebase 冲突后 abort 干净了：没有进行中的 rebase，分支还在自己那一笔上（父提交还是开棒那条）
    expect(rebaseInProgress(w)).toBe(false);
    expect(w.git(w.dev, ['log', '-1', '--format=%s', 'relay-dev']).out).toBe('开发：合成的一笔');
    expect(w.git(w.dev, ['log', '-1', '--format=%s', 'relay-dev^']).out).toBe('初始合成仓库');
  }, 120_000);
});

describe('条件 3：推 dev/x 被拒 → 不重试、照原来停下', () => {
  it('dev/x 没被强推、记账那一条没有 rebased、停下', async () => {
    const w = world();
    // 别人先推 dev/x 的一笔
    w.git(w.integ, ['fetch', '-q', 'origin']);
    w.git(w.integ, ['switch', '-q', '-c', 'dev/x']);
    writeFileSync(`${w.integ}/docs/委派/devx.md`, '别人 dev/x 的一笔\n', 'utf8');
    w.git(w.integ, ['add', '-A']);
    w.git(w.integ, ['commit', '-q', '-m', '别人：dev/x 的一笔']);
    w.git(w.integ, ['push', '-q', 'origin', 'HEAD:dev/x']);
    const advanced = w.originSha('refs/heads/dev/x');
    const beforeMain = w.originSha('refs/heads/main');

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
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.originSha('refs/heads/dev/x')).toBe(advanced); // 没被强推
    expect(w.originSha('refs/heads/main')).toBe(beforeMain);
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送失败：');
    expect(reason).toContain('dev/x');
    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'dev/x', remote: 'dev/x', ok: false });
    expect('rebased' in pushes[0]!).toBe(false);
    expect(rebaseInProgress(w)).toBe(false);
  }, 120_000);
});

describe('条件 4：local 不是检出的分支 → main 被拒也不重试', () => {
  it('目录里检出 relay-dev、推的是 b → 不重试、照原来停下', async () => {
    const w = world();
    const advanced = othersPush(w, 'docs/委派/别人.md', '别人推的一笔\n');
    // 本地另建一个分支 b（有一笔自己的提交），再切回 relay-dev：b 不是当前检出的分支
    w.git(w.dev, ['switch', '-q', '-c', 'b']);
    writeFileSync(`${w.dev}/docs/委派/b.md`, 'b 分支的一笔\n', 'utf8');
    w.git(w.dev, ['add', '-A']);
    w.git(w.dev, ['commit', '-q', '-m', 'b：合成的一笔']);
    w.git(w.dev, ['switch', '-q', 'relay-dev']);

    w.writePlan({
      commits: [
        {
          branch: 'relay-dev',
          file: 'docs/委派/笔记.md',
          content: '开发这一棒的一笔\n',
          message: '开发：合成的一笔',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} b main`],
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.originSha('refs/heads/main')).toBe(advanced); // 没重试、没推上去
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送失败：');
    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'b', remote: 'main', ok: false });
    expect('rebased' in pushes[0]!).toBe(false);
    expect(rebaseInProgress(w)).toBe(false);
  }, 120_000);
});

describe('条件 5：没被拒的推送记账里没有 rebased', () => {
  it('直接推上 main → ok: true、没有 rebased 字段', async () => {
    const w = world();
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

    const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ local: 'relay-dev', remote: 'main', ok: true });
    expect('rebased' in pushes[0]!).toBe(false);
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);
});
