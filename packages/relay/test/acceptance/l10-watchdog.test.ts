/**
 * L10 验收测试（一）：看门人一直转、崩了接着转（规格条件 1、2，对应契约第 1 条）。
 *
 * 逐条对应：
 * - 条件 1：`IXAEON_RELAY_CODE` 指本仓库、合成仓库 + 替身角色，`relay run --exit-when-idle` 跑两棒
 *   再转到没活：输出里有 `看门人 <pid>`、至少两行 `子进程 <pid> 退出 0`，子进程号互不相同、
 *   也不等于看门人的；记账里有这两棒；退出码 0。
 * - 条件 2：假代码目录（`packages/relay/bin/relay.mjs` 打 `炸了` 到错误输出、退出码 1）→
 *   试 3 次后退出，`stoppedReason` 是「调度器连着崩了 3 次：炸了」，假飞书收到一条 stopped；
 *   「崩一次、下一轮正常、再崩两次」→ 不停下（中间清零了），两棒照跑。
 *
 * 全在临时目录里跑；替身照 `l2b-notify` 的做法（拉、改队列、提交、推回合成 origin）。不调真模型、不连 GitHub。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { makeWorld, REPO, type World } from './l10-harness.js';

const worlds: World[] = [];
const servers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
const world = (opts: Parameters<typeof makeWorld>[0] = {}) => {
  const w = makeWorld(opts);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const c of servers.splice(0)) await c();
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** 假代码目录：只放一个 `packages/relay/bin/relay.mjs`。 */
const fakeCode = (script: string): string => {
  const dir = tmp('ixa-l10-fakecode-');
  const bin = join(dir, 'packages', 'relay', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'relay.mjs'), script, 'utf8');
  return dir;
};

const pidsOf = (stdout: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of stdout.matchAll(re)) out.push(m[1]!);
  return out;
};

describe('条件 1：看门人跑两棒再转到没活', () => {
  it('输出有 看门人 <pid>、至少两行 子进程 … 退出 0；子进程号互不相同也不等于看门人；记账两棒；退出码 0', async () => {
    const w = world();
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: REPO });
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const keepers = pidsOf(r.stdout, /看门人 (\d+)/g);
    expect(keepers.length).toBeGreaterThanOrEqual(1);
    const children = pidsOf(r.stdout, /子进程 (\d+) 退出 0/g);
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(new Set(children).size).toBe(children.length); // 子进程号互不相同
    for (const c of children) expect(c).not.toBe(keepers[0]);

    expect(w.ledger()).toHaveLength(2);
    expect(w.state().stoppedReason).toBe(null);
    // 整合方补（2026-10-23）：子进程的输出原样转出来（「第 N 棒 …」是子进程里的 once 打的）
    expect(r.stdout).toContain('第 1 棒 developer');
    expect(r.stdout).toContain('第 2 棒 integrator');
    // IXAEON_RELAY_CODE 有值 → 不建 relay-run
    expect(existsSync(join(w.root, 'trees', 'relay-run'))).toBe(false);
    // 看门人退出时放锁
    expect(existsSync(join(w.dataDir, 'lock.json'))).toBe(false);
  }, 180_000);
});

describe('条件 2：崩了接着转', () => {
  it('连着崩 3 次 → 停下，「调度器连着崩了 3 次：炸了」，飞书一条 stopped', async () => {
    const fake = await fakeFeishu();
    // 整合方改严（2026-10-23）：错误输出有两行，原因只取第一行
    const code = fakeCode("console.error('炸了');\nconsole.error('第二行');\nprocess.exit(1);\n");
    const w = world({ feishu: fake, idleSeconds: 1 });
    const t0 = Date.now();
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: code });
    const elapsed = Date.now() - t0;
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(String(w.state().stoppedReason ?? '')).toBe('调度器连着崩了 3 次：炸了');
    // 试了 3 次
    expect(pidsOf(r.stdout, /子进程 \d+ 退出 1/g).length).toBe(3);
    expect(fake.texts.filter((t) => t.includes('停下来了')).length).toBe(1);
    expect(fake.texts.some((t) => t.includes('调度器连着崩了 3 次：炸了'))).toBe(true);
    expect(w.ledger()).toHaveLength(0);
    // 整合方补（2026-10-23）：第 1、2 次崩之后各等 idleSeconds × 1、× 5（这里一共至少 6 秒）
    expect(elapsed).toBeGreaterThanOrEqual(5_500);
    // 子进程的错误输出也原样转出来
    expect(r.stderr).toContain('炸了');
  }, 180_000);

  // 整合方补（2026-10-23）：原因取「最后一次」错误输出的第一行，不超过 200 个字；子进程的命令行、cwd 照契约
  it('原因取最后一次的第一行、截到 200 个字；子进程是 once --under <看门人>、cwd 是代码根', async () => {
    const log = join(tmp('ixa-l10-crashlog-'), 'calls.jsonl');
    const code = fakeCode(
      [
        "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
        `const log = ${JSON.stringify(log)};`,
        'const n = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;',
        'appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");',
        'if (n < 2) console.error("早先的错 " + n);',
        'else console.error("长".repeat(300) + "\\n第二行");',
        'process.exit(1);',
        '',
      ].join('\n'),
    );
    const w = world({ idleSeconds: 1 });
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: code });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(String(w.state().stoppedReason ?? '')).toBe(`调度器连着崩了 3 次：${'长'.repeat(200)}`);

    const keeper = pidsOf(r.stdout, /看门人 (\d+)/g)[0];
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(calls).toHaveLength(3);
    const norm = (p: string) => realpathSync(p).toLowerCase();
    for (const c of calls) {
      expect(c.argv).toEqual(['once', '--under', keeper]);
      expect(norm(c.cwd)).toBe(norm(code));
    }
  }, 180_000);

  it('崩一次、下一轮正常、再崩两次 → 不停下（中间清零了），两棒照跑', async () => {
    // 计数器：第 1、3、4 次崩；其它次交给真 relay.mjs 跑一棒
    const counter = join(tmp('ixa-l10-counter-'), 'n.json');
    const code = fakeCode(
      [
        "import { spawnSync } from 'node:child_process';",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const counter = ${JSON.stringify(counter)};`,
        'const n = existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")).n : 0;',
        'const next = n + 1;',
        'writeFileSync(counter, JSON.stringify({ n: next }), "utf8");',
        'if (next === 1 || next === 3 || next === 4) {',
        '  console.error("炸了");',
        '  process.exit(1);',
        '}',
        `const r = spawnSync(process.execPath, [${JSON.stringify(join(REPO, 'packages', 'relay', 'bin', 'relay.mjs'))}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });`,
        'process.exit(r.status ?? 1);',
        '',
      ].join('\n'),
    );
    const w = world({ idleSeconds: 1 });
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: code });
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.state().stoppedReason).toBe(null); // 没停
    expect(w.ledger()).toHaveLength(2); // 两棒照跑（第 2 次和第 5 次）
    expect(pidsOf(r.stdout, /子进程 \d+ 退出 1/g).length).toBe(3); // 崩了三次，但没连着
  }, 240_000);
});
