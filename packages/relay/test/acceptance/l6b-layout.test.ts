/**
 * L6b 验收测试（二）：独立克隆的替推、交代里那句话（规格条件 2、3、4，契约第 2、3 条）。
 *
 * 逐条对应：
 * - 条件 2：开发的 cwd 里一份独立克隆（`.git` 在里面）、`origin` 和调度器的一样 → 替推成功。
 * - 条件 3：独立克隆的 `origin` 指到另一个裸仓库 → 一条都不推、停下、原因里有它的目录；
 *   `origin` 只差末尾的 `/` → 算一样、放行。
 * - 条件 4：`pushByRelay` 角色的交代里有那句（`<cwd>` 换成真路径，`/repo` 照字面接上）；整合方的交代里没有。
 *
 * 整合方写（2026-10-23）。用 L6 的共用骨架（临时裸仓库当 origin，调度器跑在合成仓库里），不调真模型、不连 GitHub。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l6-harness.js';

const worlds: World[] = [];
const world = (opts: Parameters<typeof makeWorld>[0] = {}) => {
  const w = makeWorld(opts);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

/** 在开发的 cwd 里克隆一份独立的仓库，`origin` 设成给定的地址，并在分支 dev/c 上提交一笔。 */
const independentClone = (w: World, origin: string) => {
  const clone = join(w.dev, 'repo');
  const r = w.git(w.dev, ['clone', '-q', w.origin, 'repo']);
  if (r.code !== 0) throw new Error(r.out);
  w.git(clone, ['remote', 'set-url', 'origin', origin]);
  w.git(clone, ['switch', '-q', '-c', 'dev/c']);
  writeFileSync(join(clone, 'c.txt'), '独立克隆里的一笔\n', 'utf8');
  w.git(clone, ['add', '-A']);
  w.git(clone, [
    '-c',
    'user.email=x@example.invalid',
    '-c',
    'user.name=x',
    'commit',
    '-q',
    '-m',
    '独立克隆：一笔',
  ]);
  return clone;
};

describe('条件 2：cwd 里的独立克隆、origin 一样 → 替推成功', () => {
  it('裸仓库上有了 dev/c，pushes 一条 ok，不停下', async () => {
    const w = world();
    const clone = independentClone(w, w.origin);
    w.writePlan({ pushes: [`RELAY-PUSH ${clone} dev/c dev/c`] });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.originBranches().sort()).toEqual(['dev/c', 'main']);
    const row = w.ledger()[0]!;
    expect((row.pushes as Array<Record<string, unknown>>)[0]).toMatchObject({
      remote: 'dev/c',
      ok: true,
    });
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);

  it('origin 只差末尾的 /（同一个地址）→ 也放行', async () => {
    const w = world();
    const clone = independentClone(w, `${w.origin}/`);
    w.writePlan({ pushes: [`RELAY-PUSH ${clone} dev/c dev/c`] });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.originBranches().sort()).toEqual(['dev/c', 'main']);
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);
});

describe('条件 3：cwd 里的独立克隆、origin 是别的仓库 → 拒', () => {
  it('一条都不推、停下、原因里有它的目录', async () => {
    const w = world();
    const otherBare = join(w.root, 'other.git');
    w.git(w.root, ['init', '--bare', '-q', otherBare]);
    const clone = independentClone(w, otherBare);
    w.writePlan({ pushes: [`RELAY-PUSH ${clone} dev/c dev/c`] });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.originBranches()).toEqual(['main']);
    const otherHeads = w.git(otherBare, ['for-each-ref', 'refs/heads']).out;
    expect(otherHeads).toBe('');
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送被拒：');
    expect(reason).toContain('repo');
  }, 120_000);
});

describe('条件 4：交代里那句话', () => {
  const SENTENCE = (cwd: string) =>
    `你的仓库是 ${cwd}/repo：AGENTS.md 里说的「共用检出目录」换成它；工作目录照 AGENTS.md 用 node scripts/worktree.mjs 建，会落在 ${cwd} 下面。`;

  it('pushByRelay 的开发：交代里有那句，<cwd> 换成了它的 cwd', async () => {
    const w = world();
    const copy = join(w.root, 'prompt-copy.md');
    w.writePlan({ copyPrompt: copy });
    expect((await w.run(['once'])).status).toBe(0);
    expect(readFileSync(copy, 'utf8')).toContain(SENTENCE(w.dev));
  }, 120_000);

  it('整合方（没有 pushByRelay）：交代里没有那句', async () => {
    const w = world({ queueStatus: '测试待审（整合方）' });
    const copy = join(w.root, 'prompt-copy.md');
    w.writePlan({ copyPrompt: copy });
    expect((await w.run(['once'])).status).toBe(0);
    const prompt = readFileSync(copy, 'utf8');
    expect(prompt).toContain('RELAY-DONE 70');
    expect(prompt).not.toContain('你的仓库是');
  }, 120_000);
});
