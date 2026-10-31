/**
 * K9b 验收测试（二）：一棒跑完的记账、飞书、越界（规格条件 1、4、6、7、8）。
 *
 * 逐条对应（合成仓库照 l10-harness：临时裸仓库当 origin + 整合方/开发各一份克隆 + 替身）：
 * - 条件 1：队列一行「待复审（整合方）」、整合方在歇、配了替补 → 派给替补、记账 role 是
 *   integrator-substitute、交代里含「你是替补整合方」那段；
 * - 条件 4：有没办的飞书回复 → 派给替补的飞书回复棒，办完 inboxDone 记上、群里写明是替补；
 * - 条件 6：替身①在 main 上改 packages/、②改锁定验收.json、③改迁移、④推 dev/x → 各自停下，
 *   记账里有 substitute-touched-main-code / substitute-locked / substitute-migration /
 *   substitute-bad-branch；只改队列那一行和交付说明、推 integrate-sub/x → 不停下，状态含「替补审过」；
 * - 条件 7：替身撞额度 → pausedUntil['integrator-substitute'] 设上，开发那条道照常派活；
 * - 条件 8：记账 role 是 integrator-substitute；飞书通知文字含「替补整合方」和 label。
 *
 * 不调真模型、不连 GitHub；全是合成内容。
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

const LABEL = 'DSH + 合成/模型';
const PAUSED = '2026-11-01T04:30:00+08:00';

/** 替补替身：--mode 决定改什么、推什么、输出什么。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { dirname } from 'node:path';",
  'const argv = process.argv.slice(2);',
  'const opt = (n) => argv[argv.indexOf(n) + 1];',
  'const mode = opt("--mode");',
  'const clone = opt("--clone");',
  "copyFileSync(argv[0], opt('--dump'));",
  'const g = (...a) => {',
  '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
  '};',
  'const q = clone + "/docs/委派/队列.md";',
  'const put = (file, text) => { mkdirSync(dirname(clone + "/" + file), { recursive: true }); writeFileSync(clone + "/" + file, text, "utf8"); };',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'if (mode === "quota") {',
  '  console.log("usage_limit_reached");',
  '  process.exit(0);',
  '}',
  'if (mode === "ok" || mode === "integrate-sub" || mode === "inbox") {',
  '  const qq = readFileSync(q, "utf8");',
  '  const next = mode === "inbox"',
  '    ? qq.replace("等用户：合成的一个问题", "已完成（2026-10-31）")',
  '    : qq.replace("| 待复审（整合方） |", "| 待复审（整合方）：替补审过（10月31日）：复审通过；原来的要点 |");',
  '  writeFileSync(q, next, "utf8");',
  '  put("docs/委派/交付/K9b.md", "## 替补整合方预审（10月31日，合成/模型）\\n\\n合成的一行意见。\\n");',
  '}',
  'if (mode === "touch-code") {',
  '  mkdirSync(clone + "/packages", { recursive: true });',
  '  put("packages/合成.txt", "越界了\\n");',
  '}',
  'if (mode === "lock") put("docs/委派/锁定验收.json", JSON.stringify({ tasks: [{ id: "K9b" }] }) + "\\n");',
  'if (mode === "migration") {',
  '  mkdirSync(clone + "/packages/core/src/db", { recursive: true });',
  '  put("packages/core/src/db/migrations.ts", "// 替补不该写迁移\\n");',
  '}',
  'if (mode === "bad-branch") put("docs/委派/交付/K9b.md", "替补想推 dev 分支\\n");',
  'g("add", "-A");',
  'g("commit", "-q", "--allow-empty", "-m", "合成：替补的一笔");',
  'if (mode === "bad-branch") {',
  '  g("push", "-q", "origin", "HEAD:refs/heads/dev/x");',
  '} else if (mode !== "quota") {',
  '  g("push", "-q", "origin", "HEAD:main");',
  '  if (mode === "integrate-sub") g("push", "-q", "origin", "HEAD:refs/heads/integrate-sub/70");',
  '}',
  'if (mode === "inbox") console.log("RELAY-DONE inbox 按用户说的办了");',
  'else if (mode !== "quota") console.log("RELAY-DONE 70 待复审（整合方）：替补审过（10月31日）：复审通过；原来的要点");',
  '',
].join('\n');

/** 造一个世界：队列一行「待复审（整合方）」、整合方在歇、替补换成合成替身。 */
function world(mode: string, o: { status?: string; feishu?: { url: string } } = {}) {
  const w = makeWorld({
    status: o.status ?? '待复审（整合方）',
    idleSeconds: 1,
    integArgv: [],
    feishu: o.feishu,
  });
  worlds.push(w);
  const stub = join(tmp('ixa-k9b-stub-'), 'stub-substitute.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const dump = join(tmp('ixa-k9b-dump-'), 'prompt.md');
  const cfgPath = join(w.dataDir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    roles: Record<string, unknown>;
  };
  cfg.roles.integratorSubstitute = {
    argv: [
      process.execPath,
      stub,
      '{prompt_file}',
      '--mode',
      mode,
      '--clone',
      w.integ,
      '--dump',
      dump,
    ],
    label: LABEL,
  };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  const statePath = join(w.dataDir, 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  st.pausedUntil = { integrator: PAUSED };
  writeFileSync(statePath, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  return { w, dump };
}

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

describe('条件 1、8：派给替补、记账、交代', () => {
  it('派替补、记账 role=integrator-substitute、交代含那段；不越界不停', async () => {
    const { w, dump } = world('ok');
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.state().stoppedReason).toBe(null);
    const row = w.ledger()[0]!;
    expect(row.role).toBe('integrator-substitute');
    expect(row.kind).toBe('integrator-review');
    expect(row.statusBefore).toBe('待复审（整合方）');
    expect(String(row.statusAfter)).toContain('替补审过');
    expect(row.violations).toEqual([]);
    const prompt = readFileSync(dump, 'utf8');
    expect(prompt).toContain(`你是替补整合方（${LABEL}）`);
    expect(prompt).toContain('integrate-sub/');
    // 那一行的新状态仍以原来的前缀开头，Claude 回来照常接
    const queueMd = w.git(w.integ, ['show', 'origin/main:docs/委派/队列.md']).out;
    expect(queueMd).toContain('| 待复审（整合方）：替补审过（10月31日）');
  }, 180_000);
});

describe('条件 4：替补办飞书回复', () => {
  it('派替补的飞书回复棒、inboxDone 记上、群里通知写明替补和 label', async () => {
    const fake = await fakeFeishu();
    const { w } = world('inbox', { status: '等用户：合成的一个问题', feishu: fake });
    writeFileSync(
      join(w.dataDir, 'inbox.jsonl'),
      `${JSON.stringify({ id: 'om_9', at: '2026-10-31T02:00:00.000Z', text: '合成的一条回复' })}\n`,
      'utf8',
    );
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.state().stoppedReason).toBe(null);
    expect((w.state() as { inboxDone?: string[] }).inboxDone).toEqual(['om_9']);
    expect(w.ledger()[0]).toMatchObject({
      role: 'integrator-substitute',
      kind: 'integrator-inbox',
    });
    expect(
      fake.texts.filter((t) => t.includes(`替补整合方（${LABEL}）处理了你的回复：按用户说的办了`)),
    ).toHaveLength(1);
  }, 180_000);
});

describe('条件 6：替补的越界', () => {
  const cases: Array<[string, string]> = [
    ['touch-code', 'substitute-touched-main-code'],
    ['lock', 'substitute-locked'],
    ['migration', 'substitute-migration'],
    ['bad-branch', 'substitute-bad-branch'],
  ];
  for (const [mode, violation] of cases) {
    it(`${mode} → 停下，记账里有 ${violation}`, async () => {
      const { w } = world(mode);
      const r = await w.run(['once']);
      expect(r.status, r.stderr || r.stdout).toBe(0);
      expect(String(w.state().stoppedReason)).toContain(violation);
      const row = w.ledger()[0]!;
      expect(row.role).toBe('integrator-substitute');
      expect(row.violations).toContain(violation);
    }, 180_000);
  }

  it('只改队列那一行和交付说明、推 integrate-sub/70 → 不停下，状态以原前缀开头、含「替补审过」', async () => {
    const { w } = world('integrate-sub');
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.state().stoppedReason).toBe(null);
    const row = w.ledger()[0]!;
    expect(row.violations).toEqual([]);
    const queueMd = w.git(w.integ, ['show', 'origin/main:docs/委派/队列.md']).out;
    expect(queueMd).toContain('| 待复审（整合方）：替补审过（10月31日）');
    const heads = w.git(w.integ, ['ls-remote', '--heads', 'origin']).out;
    expect(heads).toContain('refs/heads/integrate-sub/70');
  }, 180_000);
});

describe('条件 7、8：替补撞额度', () => {
  it('设 pausedUntil[integrator-substitute]、飞书写明替补、开发照常派活', async () => {
    const fake = await fakeFeishu();
    const { w } = world('quota', { feishu: fake });
    expect((await w.run(['once'])).status).toBe(0);
    const st = w.state() as Record<string, unknown>;
    const paused = st.pausedUntil as Record<string, string>;
    expect(paused['integrator-substitute']).toBeTruthy();
    expect(Date.parse(paused['integrator-substitute']!)).toBeGreaterThan(Date.now());
    expect(w.ledger()[0]).toMatchObject({
      role: 'integrator-substitute',
      quotaHit: true,
    });
    expect(fake.texts.some((t) => t.includes(`替补整合方（${LABEL}）撞上额度`))).toBe(true);

    // 再跑一次：替补在歇 → 开发那条道照常（队列里另加一行「待领」）
    w.git(w.integ, ['pull', '--ff-only', '-q', 'origin', 'main']);
    const q = join(w.integ, 'docs', '委派', '队列.md');
    writeFileSync(
      q,
      `${readFileSync(q, 'utf8')}| 71 | K9c 待领的一行 | [x](x.md) | A | 无 | 待领 |\n`,
      'utf8',
    );
    w.git(w.integ, ['add', '-A']);
    w.git(w.integ, ['commit', '-q', '-m', '合成：加一行待领']);
    w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
    expect((await w.run(['once'])).status).toBe(0);
    expect(w.ledger()[1]).toMatchObject({
      role: 'developer',
      kind: 'developer-claim',
      taskId: '71',
    });
  }, 180_000);
});
