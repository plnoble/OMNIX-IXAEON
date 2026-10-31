/**
 * CF1 真机：临时数据目录启动应用，看打开后的第一屏。
 *
 * 规格 docs/委派/CF1-聊天做首页.md「真机检查」：
 * 设 IXAEON_DATA_DIR=<临时目录> 启动应用，截图打开后的第一屏
 * （应是聊天页、导航第一项「聊天」、第二项「驾驶舱」）。
 *
 * 步骤：
 * 1. 临时数据目录里跑完设置向导（合成）；关掉；
 * 2. 重新启动（没有任何保存的页面状态）→ 第一屏应是聊天页；
 * 3. 读出导航全部文字：第一项「聊天」、第二项「驾驶舱」，其余各项先后不变；
 * 4. 点第一项回聊天页、点第二项开驾驶舱页；
 * 5. 第一屏截图落到 apps/desktop/release/screenshots/cf1-first-screen.png。
 *
 * 只写合成数据；打印一律遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
const fail = (why) => {
  console.log('不符：', why);
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
const shotDir = join(desktopDir, 'release', 'screenshots');
const shot = join(shotDir, 'cf1-first-screen.png');
mkdirSync(shotDir, { recursive: true });
// 先删上一轮的截图，免得「截图还在」认的是旧文件。
rmSync(shot, { force: true });

// 低完整性下用户临时目录写不了：合成数据目录放在工作区的 .logs/（已忽略，且不会带账户名）。
const dataDir = mkdtempSync(join(root, '.logs', 'cf1-real-'));

// L14：接力里的 DSH 给工作区打了低完整性标签，Electron 写不了用户目录；照 verify.mjs 的做法
// 把 TEMP/APPDATA/LOCALAPPDATA 放到工作区的 .logs/ 下。
const electronEnv = {};
if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') {
  const base = join(root, '.logs', 'cf1-electron-env');
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
  IXAEON_RELAY_DIR: join(dataDir, 'relay'),
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_FAKE_MODEL: '1',
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

const labels = async (page) =>
  (await page.locator('[data-testid="main-nav"] > button').allTextContents()).map((s) =>
    s.trim().replace(/\s+/g, ' '),
  );

const first = await launch();
await first.page.getByTestId('setup-next-1').click();
await first.page.getByTestId('setup-model-name').fill('fake-model');
await first.page.getByTestId('setup-next-2').click();
await first.page.getByTestId('setup-project-name').fill('CF1 合成项目');
await first.page.getByTestId('setup-finish').click();
await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await first.app.close();

// 重新启动（不保存任何页面状态）→ 第一屏。
const second = await launch();
await second.page.getByTestId('page-ask').waitFor({ timeout: 20_000 });
await second.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
const nav = await labels(second.page);
console.log('NAV', JSON.stringify(nav));
console.log('FIRST_SCREEN page-ask', (await second.page.getByTestId('page-ask').count()) === 1);
if (nav[0] !== '聊天') fail(`导航第一项是「${nav[0] ?? '（没有）'}」，不是「聊天」`);
if (nav[1] !== '驾驶舱') fail(`导航第二项是「${nav[1] ?? '（没有）'}」，不是「驾驶舱」`);
await second.page.screenshot({ path: shot, fullPage: true });

await second.page.getByTestId('nav-cockpit').click();
await second.page.getByTestId('page-cockpit').waitFor({ timeout: 15_000 });
console.log('CLICK_COCKPIT page-cockpit', true);
await second.page.locator('[data-testid="main-nav"] > button').first().click();
await second.page.getByTestId('page-ask').waitFor({ timeout: 15_000 });
console.log('CLICK_CHAT page-ask', true);
await second.app.close();

const shots = existsSync(shot);
console.log('shots', shots);
if (!shots) fail('第一屏截图没落盘');
console.log(
  passed
    ? 'RESULT 通过：第一屏是聊天页、导航第一项「聊天」、第二项「驾驶舱」，两项都能点开；截图已落盘'
    : 'RESULT 没通过：见上面的不符',
);
process.exit(passed ? 0 : 1);
