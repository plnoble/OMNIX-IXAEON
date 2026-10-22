/**
 * L2b 验收测试（一）：接上飞书（规格条件 4 的后半、条件 5，对应契约第 4 条）。
 *
 * 逐条对应：
 * - 条件 4：替身把状态改成「等用户：要不要买新电脑」→ 假飞书收到一条 `needs-user`。
 * - 条件 5：越界 → 一条 `stopped`，正文就是 `formatEvent` 那段；撞额度 → 一条 `paused`；
 *   `run --exit-when-idle` 转到 `queue-empty` → 一条 `idle`；连着两次 `once` 都越界停下
 *   （中间 `resume`）、30 分钟内 → 只收到一条 `stopped`（限频记在 `state.json` 里）；
 *   没有 `feishu.json` → 照跑、一条都不发、不报错。
 *
 * 假飞书是本机 http 服务（127.0.0.1 随机端口），地址和密钥都是合成的。数据目录用
 * IXAEON_RELAY_DIR 指到临时目录，不读用户本机真的 feishu.json。不调真模型。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatEvent } from '../../src/notify/feishu.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const SECRET = 'synthetic-secret-not-real';
const dirs: string[] = [];
const servers: Array<() => Promise<void>> = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l2b-notify-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const c of servers.splice(0)) await c();
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

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
};

const queueOf = (status: string) =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    `| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | ${status} |`,
    '',
  ].join('\n');

/** 替身：--mode 决定这一棒做什么。quota 在标准输出里打额度字样。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const mode = argv[argv.indexOf("--mode") + 1];',
  'const clone = argv[argv.indexOf("--clone") + 1];',
  'const g = (...a) => spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  'if (mode === "quota") { console.log("usage_limit_reached"); process.exit(3); }',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'let after = "待复审（整合方）";',
  'if (mode === "ask") {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 等用户：要不要买新电脑 |"), "utf8");',
  '  after = "等用户：要不要买新电脑";',
  '} else if (mode === "merge-b") {',
  '  writeFileSync(clone + "/docs/委派/笔记.md", "并入的一笔\\n", "utf8");',
  '} else {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 已完成（2026-10-22） |"), "utf8");',
  '  after = "已完成（2026-10-22）";',
  '}',
  'g("add", "-A");',
  'g("commit", "-q", "-m", mode === "merge-b" ? "并入 L7：合成的越界" : "合成：替身改状态");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE 70 " + after);',
  '',
].join('\n');

function setup(opts: { status: string; mode: string; feishu?: { url: string }; pause?: boolean }) {
  const root = mkTmp();
  const origin = join(root, 'origin.git');
  const integ = join(root, 'integ');
  const dev = join(root, 'dev');
  const dataDir = join(root, 'relay');
  mkdirSync(dataDir, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, integ]);
  git(integ, ['config', 'user.email', 'relay@example.invalid']);
  git(integ, ['config', 'user.name', 'relay']);
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(join(integ, 'docs', '委派', '队列.md'), queueOf(opts.status), 'utf8');
  git(integ, ['add', '-A']);
  git(integ, ['commit', '-m', '初始合成仓库']);
  git(integ, ['push', 'origin', 'HEAD:main']);
  git(root, ['clone', origin, dev]);
  git(dev, ['config', 'user.email', 'relay@example.invalid']);
  git(dev, ['config', 'user.name', 'relay']);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--mode', opts.mode, '--clone', cwd],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 120,
  });
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: { integrator: role(integ), developer: role(dev) },
        idleSeconds: 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify(
      {
        stoppedReason: null,
        pausedUntil: opts.pause ? { integrator: '2999-01-01T00:00:00.000Z' } : {},
        turns: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (opts.feishu) {
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: opts.feishu.url, secret: SECRET })}\n`,
      'utf8',
    );
  }
  return { dataDir };
}

const relay = (dataDir: string, args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
    windowsHide: true,
    timeout: 120_000,
  });

describe('条件 4 / 5：什么时候发', () => {
  it('替身把状态改成「等用户：要不要买新电脑」→ 假飞书收到一条 needs-user', async () => {
    const fake = await fakeFeishu();
    const s = setup({ status: '待领', mode: 'ask', feishu: fake, pause: true });
    const r = relay(s.dataDir, ['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const want = formatEvent({
      kind: 'needs-user',
      taskId: '70',
      task: 'L7 合成的一行',
      status: '等用户：要不要买新电脑',
    });
    expect(fake.texts).toContain(want);
  }, 120_000);

  it('越界 → 一条 stopped，正文就是 formatEvent 那段', async () => {
    const fake = await fakeFeishu();
    const s = setup({ status: '待领', mode: 'merge-b', feishu: fake, pause: true });
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    const state = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      stoppedReason: string;
    };
    const want = formatEvent({
      kind: 'stopped',
      reason: state.stoppedReason,
      taskId: '70',
      task: 'L7 合成的一行',
    });
    expect(fake.texts).toEqual([want]);
  }, 120_000);

  it('撞额度 → 一条 paused', async () => {
    const fake = await fakeFeishu();
    const s = setup({ status: '待领', mode: 'quota', feishu: fake, pause: true });
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    const state = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      pausedUntil: { developer?: string };
    };
    const want = formatEvent({
      kind: 'paused',
      role: 'developer',
      until: state.pausedUntil.developer ?? '',
    });
    expect(fake.texts).toContain(want);
  }, 120_000);

  it('run --exit-when-idle 转到 queue-empty → 一条 idle', async () => {
    const fake = await fakeFeishu();
    const s = setup({ status: '已完成（2026-10-21）', mode: 'done', feishu: fake });
    const r = relay(s.dataDir, ['run', '--exit-when-idle']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(fake.texts).toContain(formatEvent({ kind: 'idle', why: 'queue-empty' }));
  }, 120_000);

  it('连着两次越界停下、中间 resume、30 分钟内 → 只收到一条 stopped', async () => {
    const fake = await fakeFeishu();
    const s = setup({ status: '待领', mode: 'merge-b', feishu: fake, pause: true });
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    expect(relay(s.dataDir, ['resume']).status).toBe(0);
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    const stopped = fake.texts.filter((t) => t.includes('停下来了'));
    expect(stopped).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      notify?: { sent: Record<string, string> };
    };
    expect(state.notify?.sent).toBeTruthy();
  }, 120_000);

  it('没有 feishu.json → 照跑、一条都不发、不报错', async () => {
    const fake = await fakeFeishu();
    const s = setup({ status: '待领', mode: 'merge-b', pause: true });
    expect(existsSync(join(s.dataDir, 'feishu.json'))).toBe(false);
    const r = relay(s.dataDir, ['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(fake.texts).toHaveLength(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain(SECRET);
  }, 120_000);
});
