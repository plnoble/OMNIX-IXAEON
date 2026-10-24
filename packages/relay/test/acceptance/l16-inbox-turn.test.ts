/**
 * L16 验收测试（五）：飞书回复棒的核对、记账、inboxDone、群里回话（规格条件 5，对应契约第 6 条）。
 *
 * 逐条对应：
 * - 替身当整合方，只改 `docs/` 并输出 `RELAY-DONE inbox 第 70 行照你说的办了` → 不停，
 *   `inboxDone` 记上那几条，假飞书收到 `整合方处理了你的回复：第 70 行照你说的办了`，记账照契约
 *   （kind/taskId/statusBefore 是条数/statusAfter 是 summary）；
 * - 替身改了 `packages/` 下的文件 → `inbox-touched-code`、停下；
 * - 替身没输出 `RELAY-DONE` → `inboxDone` 不记，下一次 `once` 又派飞书回复棒。
 *
 * 合成世界照 `l10-harness` 的做法（临时裸仓库 + 替身角色），整合方的 argv 换成本单自己的替身。
 * 不调真模型、不连 GitHub；原话用合成的（「76 要」）。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l10-harness.js';

const worlds: World[] = [];
const servers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
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

/** 飞书回复棒的替身：--mode 决定改什么、输出什么。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const opt = (n) => argv[argv.indexOf(n) + 1];',
  'const mode = opt("--mode");',
  'const clone = opt("--clone");',
  "copyFileSync(argv[0], opt('--dump'));", // 把这一棒的交代原样存下来
  'const g = (...a) => {',
  '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
  '};',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'writeFileSync(q, readFileSync(q, "utf8").replace("| 等用户：要不要买新电脑 |", "| 已完成（2026-10-24） |"), "utf8");',
  'if (mode === "touch-code") writeFileSync(clone + "/packages/合成.txt", "越界了\\n", "utf8");',
  'g("add", "-A");',
  'g("commit", "-q", "-m", "合成：回复用户");',
  'g("push", "-q", "origin", "HEAD:main");',
  'if (mode === "ok" || mode === "touch-code") console.log("RELAY-DONE inbox 第 70 行照你说的办了");',
  'else console.log("做完了，没有按格式输出");',
  '',
].join('\n');

const inboxLine = (id: string, text: string): string =>
  `${JSON.stringify({ id, at: '2026-10-24T06:03:00.000Z', text })}\n`;

/** 造一个世界：队列第 70 行等用户、inbox 有一条、整合方换成合成替身。 */
const world = (mode: string, fake: { url: string }, o: { inbox?: string } = {}) => {
  const w = makeWorld({
    status: '等用户：要不要买新电脑',
    idleSeconds: 1,
    integArgv: [],
  });
  worlds.push(w);
  const stub = join(tmp('ixa-l16-stub-'), 'stub-inbox.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const dump = join(tmp('ixa-l16-dump-'), 'prompt.md');
  const cfgPath = join(w.dataDir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    roles: { integrator: { argv: string[] } };
  };
  cfg.roles.integrator.argv = [
    process.execPath,
    stub,
    '{prompt_file}',
    '--mode',
    mode,
    '--clone',
    w.integ,
    '--dump',
    dump,
  ];
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(w.dataDir, 'feishu.json'),
    `${JSON.stringify({ webhookUrl: fake.url, secret: 's' })}\n`,
    'utf8',
  );
  writeFileSync(join(w.dataDir, 'inbox.jsonl'), inboxLine('om_1', o.inbox ?? '76 要'), 'utf8');
  return { w, dump };
};

describe('条件 5：飞书回复棒', () => {
  it('只改 docs/ 并输出 RELAY-DONE inbox → 不停、inboxDone 记上、群里收到回话、记账照契约', async () => {
    const fake = await fakeFeishu();
    const { w, dump } = world('ok', fake);
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.state().stoppedReason).toBe(null);

    const st = w.state() as { inboxDone?: string[] };
    expect(st.inboxDone).toEqual(['om_1']);

    expect(
      fake.texts.filter((t) => t.includes('整合方处理了你的回复：第 70 行照你说的办了')),
    ).toHaveLength(1);

    const row = w.ledger()[0]!;
    expect(row).toMatchObject({
      kind: 'integrator-inbox',
      taskId: 'inbox',
      statusBefore: '1 条',
      statusAfter: '第 70 行照你说的办了',
    });
    expect(row.violations).toEqual([]);

    // 这一棒的交代是逐字那段 + 原话
    const prompt = readFileSync(dump, 'utf8');
    expect(prompt).toContain('这一棒是飞书回复棒');
    expect(prompt).toContain('- 10月24日 14:03：76 要');
  }, 120_000);

  it('替身改了 packages/ 下的文件 → inbox-touched-code、停下、inboxDone 不记', async () => {
    const fake = await fakeFeishu();
    const { w } = world('touch-code', fake);
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const st = w.state() as { stoppedReason: string | null; inboxDone?: string[] };
    expect(st.stoppedReason ?? '').toContain('inbox-touched-code');
    expect(st.inboxDone ?? []).toEqual([]);
  }, 120_000);

  it('替身没输出 RELAY-DONE → inboxDone 不记，下一次 once 又派飞书回复棒', async () => {
    const fake = await fakeFeishu();
    const { w } = world('no-done', fake);
    expect((await w.run(['once'])).status).toBe(0);
    expect((w.state() as { inboxDone?: string[] }).inboxDone ?? []).toEqual([]);
    expect((await w.run(['once'])).status).toBe(0);
    const kinds = w.ledger().map((x) => x.kind);
    expect(kinds).toEqual(['integrator-inbox', 'integrator-inbox']);
  }, 180_000);
});
