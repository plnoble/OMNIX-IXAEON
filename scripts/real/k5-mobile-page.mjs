/**
 * K5 真机检查：合成数据下打开「手机查看」，在本机浏览器按手机尺寸（390×844）打开
 * `http://127.0.0.1:43192/m`，把四个视图各截一张图，并核对：
 * - 四个按钮在同一行、页面没有横向滚动（条件 5 的真机那一半）；
 * - 打开开关后 43192 才有监听，关掉开关后立刻关掉。
 *
 * 只写合成数据；截图落到工作区的 `.logs/k5-shots/`（已忽略）。
 * `tailscale serve` 和 iPhone 上打开由用户执行，脚本不碰 Tailscale。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
const chromium = pw.chromium;
const Database = require(require.resolve('better-sqlite3', { paths: [desktopDir, root] }));

const shotDir = join(root, '.logs', 'k5-shots');
mkdirSync(shotDir, { recursive: true });
const shotNames = ['k5-overview.png', 'k5-waiting.png', 'k5-quota.png', 'k5-projects.png'];
for (const f of shotNames) rmSync(join(shotDir, f), { force: true });

const PORT = 43192;
const now = new Date().toISOString();
const dataDir = mkdtempSync(join(root, '.logs', 'k5-real-'));
const relayDir = join(dataDir, 'relay');
const repo = join(dataDir, 'repo');
mkdirSync(relayDir, { recursive: true });
mkdirSync(join(repo, 'docs', '委派'), { recursive: true });

// 合成 relay：调度器活着、今天完成 3 棒。
writeFileSync(
  join(relayDir, 'lock.json'),
  `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`,
);
const ledger = [1, 2, 3].map((turn) =>
  JSON.stringify({
    turn,
    role: turn === 1 ? 'dev' : 'integrator',
    kind: 'turn',
    taskId: turn === 1 ? 'K1' : turn === 2 ? 'K2' : 'K3',
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    timedOut: false,
    quotaHit: false,
    statusBefore: '进行中（dev）',
    statusAfter: '已完成',
  }),
);
writeFileSync(join(relayDir, 'ledger.jsonl'), `${ledger.join('\n')}\n`);
writeFileSync(join(relayDir, 'state.json'), `${JSON.stringify({ stoppedReason: null })}\n`);
for (const turn of [1, 2, 3, 4]) {
  const dir = join(relayDir, 'turns', String(turn));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), `合成第 ${turn} 棒\n`);
}

// 合成仓库：origin/main 上有三条「等用户」，手机页总览正好能看到前 3 条。
writeFileSync(
  join(repo, 'docs', '委派', '队列.md'),
  [
    '# 委派队列（合成）',
    '',
    '## 可以领的',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    '| 140 | K5 合成甲 | — | B | 无 | 等用户：合成问题甲，要不要现在做 |',
    '| 141 | K5 合成乙 | — | B | 无 | 等用户：合成问题乙，先并不并 |',
    '| 142 | K5 合成丙 | — | A | 无 | 等用户：合成问题丙，选哪条路 |',
    '',
    '',
  ].join('\n'),
);
const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
git(['init', '-q']);
git(['-c', 'user.name=K5 合成仓库', '-c', 'user.email=k5@ixaeon.invalid', 'add', '.']);
git([
  '-c',
  'user.name=K5 合成仓库',
  '-c',
  'user.email=k5@ixaeon.invalid',
  'commit',
  '-q',
  '-m',
  '合成队列',
]);
git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }));

// L14：DSH 低完整性下 Electron 写不了用户临时目录，照 verify.mjs 的做法把 TEMP 放进工作区。
const electronEnv = {};
const isolateElectron = process.env.IXAEON_ELECTRON_NO_SANDBOX === '1';
if (isolateElectron) {
  const base = join(root, '.logs', 'k5-electron-env');
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
  if (isolateElectron) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

function isListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return predicate();
}

const first = await launch();
await first.page.getByTestId('setup-next-1').click();
await first.page.getByTestId('setup-model-name').fill('fake-model');
await first.page.getByTestId('setup-next-2').click();
await first.page.getByTestId('setup-project-name').fill('K5 合成项目');
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
add('合成进行中甲', 'active', 'K5 合成项目：进行中甲', '正在做甲');
add('合成进行中乙', 'active', 'K5 合成项目：进行中乙', '正在做乙');
add('合成进行中丙', 'active', 'K5 合成项目：进行中丙', '正在做丙');
add('合成暂缓丁', 'paused', 'K5 合成项目：暂缓丁', null);
db.prepare('DELETE FROM app_settings WHERE key IN (?, ?, ?)').run(
  'cockpit.ixaeon_repo',
  'mobile.enabled',
  'mobile.port',
);
db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
  'cockpit.ixaeon_repo',
  repo,
  now,
);
db.close();

const second = await launch();
await second.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
console.log('关着时 43192 有监听：', await isListening(PORT));
if (await isListening(PORT)) fail('开关默认关，43192 却有监听');

await second.page.getByTestId('nav-settings').click();
await second.page.getByTestId('settings-mobile-enabled').waitFor({ timeout: 10_000 });
const checkedBefore = await second.page.getByTestId('settings-mobile-enabled').isChecked();
const portBefore = await second.page.getByTestId('settings-mobile-port').inputValue();
console.log('设置页默认：勾选=', checkedBefore, '端口=', portBefore);
if (checkedBefore) fail('「手机查看」默认应该是关的');
if (portBefore !== '43192') fail(`端口默认应该是 43192，实际 ${portBefore}`);

await second.page.getByTestId('settings-mobile-enabled').check();
const command = await second.page.getByTestId('settings-mobile-command').innerText();
console.log('COMMAND_BLOCK');
console.log(command);
if (!command.includes('tailscale serve --bg 43192')) fail('命令不对');
if (command.includes('funnel')) fail('命令里出现了 funnel');
const notes = await second.page.getByTestId('settings-mobile-notes').innerText();
console.log('NOTES_BLOCK');
console.log(notes);
for (const want of ['tailscale serve status', 'tailscale serve reset', '所有设备', '限制访问']) {
  if (!notes.includes(want)) fail(`说明里少了「${want}」`);
}
await second.page.getByTestId('settings-mobile-save').click();
const up = await waitFor(() => isListening(PORT), 10_000);
console.log('保存后 43192 有监听：', up);
if (!up) fail('保存后 43192 没起来');

// 手机尺寸的真浏览器：四个按钮各截一张，并核对一行、无横向滚动。
const browser = await chromium.launch({
  headless: true,
  args: isolateElectron ? ['--no-sandbox'] : [],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const resp = await page.goto(`http://127.0.0.1:${PORT}/m`, { waitUntil: 'domcontentloaded' });
console.log('GET /m 状态码：', resp?.status());
if (resp?.status() !== 200) fail(`/m 状态码 ${resp?.status()}`);
await page.waitForFunction(
  () => {
    const el = document.getElementById('today-turns');
    return el && el.textContent !== '–';
  },
  { timeout: 15_000 },
);
const labels = ['总览', '等你处理', '额度', '项目'];
const buttons = page.locator('nav button');
const count = await buttons.count();
if (count !== 4) fail(`按钮个数 ${count}`);
const boxes = [];
for (let i = 0; i < count; i++) boxes.push(await buttons.nth(i).boundingBox());
const ys = boxes.map((b) => Math.round(b.y));
const xs = boxes.map((b) => Math.round(b.x));
console.log(
  '四按钮位置：',
  JSON.stringify({ x: xs, y: ys, w: boxes.map((b) => Math.round(b.width)) }),
);
if (new Set(ys).size !== 1) fail(`四个按钮不在同一行：y=${ys.join(',')}`);
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
console.log('横向溢出像素：', overflow);
if (overflow > 0) fail(`390px 视口出现横向滚动 ${overflow}px`);
const texts = await buttons.allInnerTexts();
if (texts.map((t) => t.trim()).join('|') !== labels.join('|'))
  fail('按钮顺序不对：' + texts.join('|'));

const overviewText = await page.locator('main').innerText();
console.log('OVERVIEW_BLOCK');
console.log(overviewText);
const headerText = await page.locator('header').innerText();
console.log('HEADER_BLOCK');
console.log(headerText);
if (!headerText.includes('分钟前更新')) fail('顶部没有「分钟前更新」');
const stale = await page.locator('#updated.stale').count();
if (stale !== 0) fail('刚刷新完就显示陈旧（红色）');
for (const want of ['今天完成', '进行中', '活跃项目', '合成问题甲', '合成问题乙', '合成问题丙'])
  if (!overviewText.includes(want)) fail(`总览少了「${want}」`);

await page.screenshot({ path: join(shotDir, 'k5-overview.png'), fullPage: true });
for (const [i, name] of ['waiting', 'quota', 'projects'].entries()) {
  await buttons.nth(i + 1).click();
  await page.waitForTimeout(300);
  const block = await page.locator('main').innerText();
  console.log(`${name.toUpperCase()}_BLOCK`);
  console.log(block);
  await page.screenshot({ path: join(shotDir, `k5-${name}.png`), fullPage: true });
}
const projectText = await page.locator('#project-list').innerText();
for (const want of ['合成进行中甲', '合成进行中乙', '合成进行中丙', '合成暂缓丁'])
  if (!projectText.includes(want)) fail(`项目视图少了「${want}」`);

await browser.close();

// 关掉开关：端口应立刻关闭，设置读回是关。
await second.page.getByTestId('settings-mobile-enabled').uncheck();
await second.page.getByTestId('settings-mobile-save').click();
const down = await waitFor(async () => !(await isListening(PORT)), 5_000);
console.log('关掉后 43192 有监听：', await isListening(PORT));
if (!down) fail('关掉开关后 43192 还开着');
await second.app.close();

const shots = shotNames.map((f) => existsSync(join(shotDir, f)));
console.log('截图：', ...shots.map((ok, i) => `${shotNames[i]}=${ok}`));
if (shots.some((ok) => !ok)) fail('截图没落全：' + shots.join(' '));

console.log(
  'RESULT',
  passed
    ? '通过：默认关；设置页打开并保存后 43192 起来；390px 下四按钮一行、无横向滚动；四个视图截图都在；关掉后端口关闭'
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
