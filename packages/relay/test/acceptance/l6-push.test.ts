/**
 * L6 验收测试（二）：调度器替开发推送（规格条件 3–6，对应契约第 4 条）。
 *
 * 逐条对应：
 * - 条件 3（替推成功）：`pushByRelay: true` 的替身在它 `cwd` 里的仓库上提交到本地 `relay-dev`（当 main 用）
 *   和 `dev/x`，**不推**，输出两行 `RELAY-PUSH` → `once` 之后裸仓库上有了 `dev/x`、`main` 前进了；
 *   记账 `pushes` 两条都 `ok: true`；核对照常（不是「并入 B 档」就不越界）。
 * - 条件 4（替推被拒）：远端分支是 `release/x`、`dir` 在 `cwd` 外面、`local` 带 `+`——各一条：
 *   一条都没推（裸仓库没变）、停下、原因里写清。
 * - 条件 5（替推失败）：本地 `relay-dev` 不是快进（先往裸仓库推一笔别的）→ 推送失败、停下、
 *   裸仓库的 `main` 还是那一笔（没被强推掉）、假飞书收到一条 `stopped`。
 * - 条件 6（没标的角色不推）：整合方（没有 `pushByRelay`）输出 `RELAY-PUSH` → 裸仓库没变、不停下、
 *   记账里没有 `pushes`。
 *
 * 全是临时 git 仓库（裸仓库当 origin）和替身，不调真模型、不连 GitHub；假飞书是本机 http 服务。
 */
import { createServer } from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l6-harness.js';

const worlds: World[] = [];
const servers: Array<() => Promise<void>> = [];
const world = (opts: Parameters<typeof makeWorld>[0] = {}) => {
  const w = makeWorld(opts);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const c of servers.splice(0)) await c();
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

async function fakeFeishu() {
  const texts: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { content?: { text?: string } };
      texts.push(body.content?.text ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  servers.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${port}/synthetic`, texts };
}

const rowOf = (w: World) => {
  const rows = w.ledger();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe('条件 3：替推成功', () => {
  it('两行 RELAY-PUSH → 裸仓库有了 dev/x、main 前进了；pushes 两条 ok；不越界', async () => {
    const w = world();
    w.writePlan({
      commits: [
        {
          branch: 'relay-dev',
          file: 'docs/委派/笔记.md',
          content: '开发这一棒的一笔\n',
          message: '开发：合成的一笔',
        },
        {
          branch: 'dev/x',
          file: 'docs/委派/笔记2.md',
          content: '开发分支的一笔\n',
          message: '开发：dev/x 的一笔',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`, `RELAY-PUSH ${w.dev} dev/x dev/x`],
    });
    const beforeMain = w.originSha('refs/heads/main');
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.originBranches().sort()).toEqual(['dev/x', 'main']);
    const afterMain = w.originSha('refs/heads/main');
    expect(afterMain).not.toBe(beforeMain);
    // 裸仓库的 main 就是那份工作目录里 relay-dev 的尖（没有被多推一笔、也没被改成别的）
    expect(afterMain).toBe(w.git(w.dev, ['rev-parse', 'relay-dev']).out);

    const row = rowOf(w);
    const pushes = row.pushes as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({ local: 'relay-dev', remote: 'main', ok: true });
    expect(pushes[1]).toMatchObject({ local: 'dev/x', remote: 'dev/x', ok: true });
    expect(row.violations).toEqual([]);
    expect(w.state().stoppedReason).toBe(null);
  }, 120_000);
});

describe('条件 4：替推被拒（一条都没推、停下、原因写清）', () => {
  const cases: Array<{ what: string; token: string; line: (w: World) => string }> = [
    {
      what: '远端分支是 release/x',
      token: 'release/x',
      line: (w) => `RELAY-PUSH ${w.dev} relay-dev release/x`,
    },
    {
      what: 'dir 在 cwd 外面',
      token: 'integ',
      line: (w) => `RELAY-PUSH ${w.integ} relay-dev main`,
    },
    // 整合方改（2026-10-23）：+ 写在开头才是 git 的强推写法（+本地:远端），原来写在末尾测不到要害
    {
      what: 'local 开头带 +（强推写法）',
      token: '+',
      line: (w) => `RELAY-PUSH ${w.dev} +relay-dev main`,
    },
  ];

  for (const c of cases) {
    it(`${c.what} → 裸仓库没变、退出码 0、原因里有它`, async () => {
      const w = world();
      w.writePlan({
        commits: [
          {
            branch: 'relay-dev',
            file: 'docs/委派/笔记.md',
            content: '一笔\n',
            message: '开发：一笔',
          },
        ],
        pushes: [c.line(w)],
      });
      const beforeMain = w.originSha('refs/heads/main');
      const r = await w.run(['once']);
      expect(r.status, r.stderr || r.stdout).toBe(0);

      expect(w.originSha('refs/heads/main')).toBe(beforeMain);
      expect(w.originBranches()).toEqual(['main']);
      const reason = String(w.state().stoppedReason ?? '');
      expect(reason).toContain('第 1 棒替开发推送被拒：');
      expect(reason).toContain(c.token);
      const pushes = (rowOf(w).pushes ?? []) as Array<Record<string, unknown>>;
      expect(pushes).toHaveLength(0);
    }, 120_000);
  }
});

describe('条件 5：替推失败（不是快进）', () => {
  it('裸仓库 main 前进了、本地不是快进 → 停下、main 没被强推掉、飞书一条 stopped', async () => {
    const fake = await fakeFeishu();
    const w = world({ feishu: fake });
    // 别人先往裸仓库推一笔：本地 relay-dev 就落在后面了
    w.git(w.integ, ['fetch', '-q', 'origin']);
    writeFileSync(`${w.integ}/docs/委派/别人.md`, '别人推的一笔\n', 'utf8');
    w.git(w.integ, ['add', '-A']);
    w.git(w.integ, ['commit', '-q', '-m', '别人：合成的一笔']);
    w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
    const advanced = w.originSha('refs/heads/main');

    w.writePlan({
      commits: [
        {
          branch: 'relay-dev',
          file: 'docs/委派/笔记.md',
          content: '一笔\n',
          message: '开发：一笔',
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
    expect(fake.texts.filter((t) => t.includes('停下来了')).length).toBe(1);
  }, 120_000);
});

describe('条件 6：没标的角色不推', () => {
  it('整合方（没有 pushByRelay）输出 RELAY-PUSH → 裸仓库没变、不停下、记账里没有 pushes', async () => {
    const w = world({ queueStatus: '测试待审（整合方）' });
    w.writePlan({ pushes: [`RELAY-PUSH ${w.integ} relay-dev main`] });
    const beforeMain = w.originSha('refs/heads/main');
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.originSha('refs/heads/main')).toBe(beforeMain);
    expect(w.originBranches()).toEqual(['main']);
    const row = rowOf(w);
    expect(row.role).toBe('integrator');
    // 这一棒真的跑了（不是「什么都没发生」的假绿）：替身打了完成行
    expect(String(row.doneLine ?? '')).toContain('RELAY-DONE 70');
    expect('pushes' in row).toBe(false);
    expect(w.state().stoppedReason).toBe(null);
    expect(existsSync(`${w.dataDir}/feishu.json`)).toBe(false);
  }, 120_000);
});

// 整合方补（2026-10-23）：契约第 4 条「dir 是调度器所在仓库的工作目录」——在 cwd 里面、却是另一个仓库
describe('条件 4（整合方补）：dir 在 cwd 里面，但不是这个仓库的工作目录', () => {
  it('cwd 里另外 git init 的仓库 → 一条都没推、停下、原因里有它', async () => {
    const w = world();
    const other = `${w.dev}/other-repo`;
    w.git(w.dev, ['init', '-q', '-b', 'main', 'other-repo']);
    writeFileSync(`${other}/a.txt`, '另一个仓库\n', 'utf8');
    w.git(other, ['add', '-A']);
    w.git(other, [
      '-c',
      'user.email=x@example.invalid',
      '-c',
      'user.name=x',
      'commit',
      '-q',
      '-m',
      'x',
    ]);
    // 整合方改（2026-10-23，为 L6b）：origin 指到另一个裸仓库——L6b 之后「cwd 里、origin 一样」的独立克隆会被放行
    const otherBare = `${w.root}/other.git`;
    w.git(w.root, ['init', '--bare', '-q', otherBare]);
    w.git(other, ['remote', 'add', 'origin', otherBare]);
    w.writePlan({ pushes: [`RELAY-PUSH ${other} main main`] });
    const beforeMain = w.originSha('refs/heads/main');
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.originSha('refs/heads/main')).toBe(beforeMain);
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送被拒：');
    expect(reason).toContain('other-repo');
  }, 120_000);
});

// 整合方补（2026-10-23）：契约第 4 条「verifyTurn 之前」推——替推上去的东西也要被核对到
describe('条件 3（整合方补）：替推上去的「并入 B 档」照样认成越界', () => {
  it('开发提交「并入 L7」（L7 是 B 档），调度器替它推上 main → b-tier-merged-by-developer、停下', async () => {
    const w = world();
    w.writePlan({
      commits: [
        {
          branch: 'relay-dev',
          file: 'docs/委派/笔记.md',
          content: '并入的一笔\n',
          message: '并入 L7：合成的越界',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`],
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const row = rowOf(w);
    expect((row.pushes as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true });
    expect(row.violations).toContain('b-tier-merged-by-developer');
    expect(String(w.state().stoppedReason ?? '')).toContain('b-tier-merged-by-developer');
  }, 120_000);
});

// 整合方补（2026-10-23）：上面「dir 在 cwd 外面」那条用的是另一个克隆，会先被「不是同一个仓库」拦下；
// 这一条是同一个仓库的工作目录、只是不在开发的 cwd 里——要靠「在不在 cwd 里」那一道拦
describe('条件 4（整合方补）：同一个仓库的工作目录，但不在开发的 cwd 里', () => {
  it('cwd 外面的同仓库工作目录 → 一条都没推、停下', async () => {
    const w = world();
    const elsewhere = `${w.root}/elsewhere`;
    w.git(w.sched, ['worktree', 'add', '-q', '-b', 'dev/y', elsewhere]);
    writeFileSync(`${elsewhere}/y.txt`, '别处的一笔\n', 'utf8');
    w.git(elsewhere, ['add', '-A']);
    w.git(elsewhere, ['commit', '-q', '-m', '别处：一笔']);
    w.writePlan({ pushes: [`RELAY-PUSH ${elsewhere} dev/y dev/y`] });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.originBranches()).toEqual(['main']);
    const reason = String(w.state().stoppedReason ?? '');
    expect(reason).toContain('第 1 棒替开发推送被拒：');
    expect(reason).toContain('elsewhere');
  }, 120_000);
});

// 整合方补（2026-10-23，复审实现时）：推上去过东西、后面一条才失败——先推上去的那些照样要核对
describe('条件 5（整合方补）：前面推成了、后面一条失败 → 照样核对', () => {
  it('main 推成了（里面有「并入 L7」）、dev/ 那条失败 → 停下，越界也认出来', async () => {
    const w = world();
    w.writePlan({
      commits: [
        {
          branch: 'relay-dev',
          file: 'docs/委派/笔记.md',
          content: '并入的一笔\n',
          message: '并入 L7：合成的越界',
        },
      ],
      pushes: [`RELAY-PUSH ${w.dev} relay-dev main`, `RELAY-PUSH ${w.dev} no-such-branch dev/z`],
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const row = rowOf(w);
    const pushes = row.pushes as Array<Record<string, unknown>>;
    expect(pushes[0]).toMatchObject({ remote: 'main', ok: true });
    expect(pushes[1]).toMatchObject({ remote: 'dev/z', ok: false });
    expect(row.violations).toContain('b-tier-merged-by-developer');
    expect(String(w.state().stoppedReason ?? '')).toContain('第 1 棒替开发推送失败：');
  }, 120_000);
});
