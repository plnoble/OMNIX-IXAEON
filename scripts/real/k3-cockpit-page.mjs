/**
 * K3 真机：临时数据目录 + 合成 relay 目录启动应用，看驾驶舱（默认页）。
 * 1. 截图驾驶舱；
 * 2. 把合成 lock.json 的 pid 改成不存在的值，点刷新后再截图，应看到红色「调度器进程不在了」。
 * 只写合成数据；截图落到 apps/desktop/release/screenshots/。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩）
const maskOut = (v) => {
  let text;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

let passed = true;
let firstFail = '';
const fail = (why) => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
const crash = (err) => {
  console.log('脚本出错：', err);
  console.log('RESULT 没通过：脚本出错：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) throw new Error('no _electron: ' + Object.keys(pw).slice(0, 30).join(','));
const Database = require(require.resolve('better-sqlite3', { paths: [desktopDir, root] }));
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const now = new Date().toISOString();
const hhmm = new Date(Date.now() + 60 * 60_000).toISOString();

// 低完整性下用户临时目录写不了：合成数据目录放在工作区的 .logs/（已忽略，且不会带账户名）。
const dataDir = mkdtempSync(join(root, '.logs', 'k3-real-'));
const relayDir = join(dataDir, 'relay');
const repo = join(dataDir, 'repo');
mkdirSync(relayDir, { recursive: true });

// 合成 relay：lock 用本脚本的 pid（活着）；ledger 3 棒；turns/4 没进 ledger。
writeFileSync(
  join(relayDir, 'lock.json'),
  `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`,
  'utf8',
);
const ledger = [1, 2, 3].map((turn) =>
  JSON.stringify({
    turn,
    role: turn === 1 ? 'dev' : 'integrator',
    kind: 'turn',
    taskId: turn === 1 ? 'K1' : turn === 2 ? 'L13' : 'K2',
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    timedOut: false,
    quotaHit: false,
    statusBefore: '进行中（dev）',
    statusAfter: '已完成',
  }),
);
writeFileSync(join(relayDir, 'ledger.jsonl'), `${ledger.join('\n')}\n`, 'utf8');
writeFileSync(
  join(relayDir, 'state.json'),
  `${JSON.stringify({ stoppedReason: null, pausedUntil: { dev2: hhmm } })}\n`,
  'utf8',
);
for (const turn of [1, 2, 3, 4]) {
  const dir = join(relayDir, 'turns', String(turn));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), `合成第 ${turn} 棒的交代文件\n`, 'utf8');
}

// 合成仓库：origin/main 上的队列（有一条「等用户」）。
mkdirSync(join(repo, 'docs', '委派'), { recursive: true });
writeFileSync(
  join(repo, 'docs', '委派', '队列.md'),
  [
    '# 委派队列（合成）',
    '',
    '## 可以领的',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    '| 140 | K3 合成行 | — | A | 无 | 进行中（dev） |',
    '| 141 | K4 合成行 | — | B | 无 | 等用户：要不要现在做 K4 |',
    '',
    '',
  ].join('\n'),
  'utf8',
);
const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
git(['init', '-q']);
git(['-c', 'user.name=K3 合成仓库', '-c', 'user.email=k3@ixaeon.invalid', 'add', '.']);
git([
  '-c',
  'user.name=K3 合成仓库',
  '-c',
  'user.email=k3@ixaeon.invalid',
  'commit',
  '-q',
  '-m',
  '合成队列',
]);
git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');

// L14：接力里的 DSH 给工作区打了低完整性标签，Electron 写不了用户目录；照 verify.mjs 的做法
// 把 TEMP/APPDATA/LOCALAPPDATA 放到工作区的 .logs/ 下。
const electronEnv = {};
if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') {
  const base = join(root, '.logs', 'k3-electron-env');
  Object.assign(electronEnv, {
    TEMP: join(base, 'temp'),
    TMP: join(base, 'temp'),
    APPDATA: join(base, 'appdata'),
    LOCALAPPDATA: join(base, 'localappdata'),
  });
  for (const dir of Object.values(electronEnv)) mkdirSync(dir, { recursive: true });
}

const env = {
  ...process.env,
  ...electronEnv,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_RELAY_DIR: relayDir,
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};
delete env.ELECTRON_RUN_AS_NODE;

async function launch() {
  const args = [
    join(desktopDir, 'out', 'main', 'index.js'),
    `--user-data-dir=${join(dataDir, 'profile')}`,
  ];
  // L14：DSH 的受限令牌下 Chromium 沙箱起不来，照界面用例把 --no-sandbox 放最前面。
  if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const app = await electron.launch({ args, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const first = await launch();
await first.page.getByTestId('setup-next-1').click();
await first.page.getByTestId('setup-model-name').fill('fake-model');
await first.page.getByTestId('setup-next-2').click();
await first.page.getByTestId('setup-project-name').fill('K3 合成项目');
await first.page.getByTestId('setup-finish').click();
await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await first.app.close();

const db = new Database(join(dataDir, 'ixaeon.db'));
const insert = db.prepare(
  `INSERT INTO projects (id, name, root_path, description, status, created_at, updated_at, purpose, current_state)
   VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
);
const add = (name, status, description, currentState) =>
  insert.run(randomUUID(), name, description, status, now, now, currentState);
add('K3 合成进行中 A', 'active', '驾驶舱进行中卡片：合成描述', '正在做 K3');
add('K3 合成进行中 B', 'active', '驾驶舱进行中卡片：合成描述', '正在做 K4');
add('K3 合成进行中 C', 'active', '驾驶舱进行中卡片：合成描述', '正在做 K5');
for (let i = 0; i < 10; i++) add(`K3 合成暂缓 ${i + 1}`, 'paused', '合成暂缓', null);
add('K3 合成放弃', 'archived', '合成放弃', null);
db.prepare('DELETE FROM app_settings WHERE key = ?').run('cockpit.ixaeon_repo');
db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
  'cockpit.ixaeon_repo',
  repo,
  now,
);
db.close();

const second = await launch();
await second.page.getByTestId('page-cockpit').waitFor({ timeout: 20_000 });
await second.page.getByTestId('cockpit-count-attention').waitFor({ timeout: 10_000 });
const before = await second.page.getByTestId('page-cockpit').innerText();
await second.page.screenshot({ path: join(shotDir, 'k3-cockpit-before.png'), fullPage: true });
console.log('BEFORE_BLOCK');
console.log(before);
for (const want of [
  '驾驶舱',
  '等你处理',
  '正在运行',
  '今天完成',
  '进行中',
  '暂缓（10）',
  '放弃（1）',
])
  if (!before.includes(want)) fail(`驾驶舱少了「${want}」`);

// 调度器进程没了：改 lock.json 的 pid，点刷新，等页面变红。
writeFileSync(
  join(relayDir, 'lock.json'),
  `${JSON.stringify({ pid: 999999, startedAt: now })}\n`,
  'utf8',
);
await second.page.getByTestId('cockpit-refresh').click();
await second.page
  .getByTestId('cockpit-attention')
  .getByText('调度器进程不在了', { exact: false })
  .waitFor({ timeout: 10_000 });
const after = await second.page.getByTestId('page-cockpit').innerText();
await second.page.screenshot({ path: join(shotDir, 'k3-cockpit-after.png'), fullPage: true });
console.log('AFTER_BLOCK');
console.log(after);
if (!after.includes('调度器进程不在了')) fail('刷新后没看到「调度器进程不在了」');
const red = await second.page.locator('[data-testid="cockpit-attention-item"].warn').count();
console.log('RED_ATTENTION_ITEMS', red);
if (red < 1) fail(`红色「等你处理」条数是 ${red}，期望至少 1`);
await second.app.close();

const shots = [
  existsSync(join(shotDir, 'k3-cockpit-before.png')),
  existsSync(join(shotDir, 'k3-cockpit-after.png')),
];
console.log('shots', ...shots);
if (!shots[0] || !shots[1]) fail(`截图没落全：${shots.join(' ')}`);

// 交付说明里只贴工作区内的相对路径，不贴本机绝对路径。
try {
  readFileSync(join(root, 'docs', '委派', '交付', 'K3b.md'), 'utf8');
} catch {
  /* 交付说明还没写，不影响检查 */
}
console.log(
  'RESULT',
  passed
    ? '通过：默认打开驾驶舱、三组项目与计数可见、两张截图都在；改 pid 后红色「调度器进程不在了」'
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
