/**
 * SUB1 / SUB1b 真机检查（甲，开发做）：临时数据目录启动应用，用**用户本机真的 magpie**。
 *
 * 规格 docs/委派/SUB1-直接接magpie.md「真机检查」甲：
 * 1. 点「用本机 magpie」→ 模型清单列出 magpie 的全部模型（截图只露模型名）；
 * 2. 选一个 magpie 模型当聊天模型，问一句「只回复两个字母：OK」，贴出回答；
 * 3. 驾驶舱额度区从 magpie 读出卡片（截图前把卡片上的账号名遮掉）。
 *
 * 只读 magpie 的 HTTP 接口；不读它的配置 / 数据库 / 登录信息。只打印模型名、数量与回答，
 * 不打印额度卡上的账号名 / user，也不打印临时目录（照 scripts/real/p5-unbind-folder.mjs 遮掉）。
 *
 *   node scripts/real/sub1-magpie.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const MAGPIE = 'http://127.0.0.1:3425';
const CHAT_MODEL = 'auto/deepseek-v4.1-flash';
const QUESTION = '只回复两个字母：OK';

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

/** 先直接问一次 magpie 的 /v1/models：要列的就是这些，运行完再核对。 */
let magpieModels;
try {
  const res = await fetch(`${MAGPIE}/v1/models`, {
    headers: { authorization: 'Bearer magpie' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  magpieModels = (body.data ?? []).map((m) => String(m.id)).filter(Boolean);
} catch (err) {
  console.log(
    `RESULT 没通过：本机 magpie 没连上（${MAGPIE}）：${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}
console.log(`MAGPIE models=${magpieModels.length}`);

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) throw new Error('no _electron: ' + Object.keys(pw).slice(0, 30).join(','));
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });
const modelShot = join(shotDir, 'sub1-magpie-models.png');
const quotaShot = join(shotDir, 'sub1-cockpit-quotas.png');
for (const p of [modelShot, quotaShot]) rmSync(p, { force: true });

// 低完整性下用户临时目录写不了：合成数据目录放在工作区的 .logs/（已忽略，且不会带账户名）。
const dataDir = mkdtempSync(join(root, '.logs', 'sub1-real-'));

const electronEnv = {};
if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') {
  const base = join(root, '.logs', 'sub1-electron-env');
  Object.assign(electronEnv, {
    TEMP: join(base, 'temp'),
    TMP: join(base, 'temp'),
    APPDATA: join(base, 'appdata'),
    LOCALAPPDATA: join(base, 'localappdata'),
  });
  for (const dir of Object.values(electronEnv)) mkdirSync(dir, { recursive: true });
}

// 真 Hermes：应用只认 IXAEON 专属路径（IXAEON_HERMES_HOME / IXAEON_HERMES_EXE / HERMES_HOME）。
// 不写死本机路径：由跑的人用环境变量给出；脚本只检查给到、不打印路径。
const hermesGiven =
  process.env.IXAEON_HERMES_HOME?.trim() ||
  process.env.IXAEON_HERMES_EXE?.trim() ||
  process.env.HERMES_HOME?.trim();
if (!hermesGiven) {
  console.log(
    'RESULT 没通过：没给 IXAEON_HERMES_HOME / IXAEON_HERMES_EXE / HERMES_HOME，应用会走 Core 兜底而不是 Hermes',
  );
  process.exit(1);
}
if (!existsSync(hermesGiven)) {
  console.log('RESULT 没通过：给的环境变量指向的路径不存在（不打印具体路径）');
  process.exit(1);
}
console.log('HERMES_ENV given');

const env = {
  ...process.env,
  ...electronEnv,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_RELAY_DIR: join(dataDir, 'relay'),
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
};
// 只清掉上一轮界面用例留下的假模型与 Electron 变量；Hermes 的路径照环境原样带进去。
for (const k of ['IXAEON_FAKE_MODEL', 'ELECTRON_RUN_AS_NODE']) {
  delete env[k];
}

async function launch() {
  const args = [
    join(desktopDir, 'out', 'main', 'index.js'),
    `--user-data-dir=${join(dataDir, 'profile')}`,
  ];
  if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const app = await electron.launch({ args, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const first = await launch();
let { app, page } = first;
try {
  // 设置向导（合成）：模型名先随便给一个，下面会用 magpie 预设覆盖。
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill(CHAT_MODEL);
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('SUB1 合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

  // --- 1. 设置 →「模型接入」→「用本机 magpie」 ---
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('page-settings').waitFor({ timeout: 20_000 });
  const hermesClass = await page.getByTestId('settings-hermes-notice').getAttribute('class');
  console.log(`HERMES found=${hermesClass?.includes('note') === true}`);
  if (hermesClass?.includes('note') !== true) fail('应用没找到 Hermes（会走 Core 兜底）');
  await page.getByTestId('settings-model').scrollIntoViewIfNeeded();
  await page.getByTestId('settings-magpie').click();
  await page.locator('[data-testid="settings-model-check"]').first().waitFor({ timeout: 30_000 });

  const base = await page.getByTestId('settings-api-base').inputValue();
  const key = await page.getByTestId('settings-api-key').inputValue();
  console.log(`PRESET base=${base} key=${key === 'magpie' ? 'magpie' : '（不是 magpie）'}`);
  if (base !== `${MAGPIE}/v1`) fail(`API 地址是「${base}」，不是 ${MAGPIE}/v1`);
  if (key !== 'magpie') fail('API Key 没填成 magpie');

  const listed = await page
    .locator('[data-testid="settings-model-check"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-model-id')));
  console.log(`LISTED ${JSON.stringify(listed)}`);
  if (JSON.stringify([...listed].sort()) !== JSON.stringify([...magpieModels].sort()))
    fail(`模型清单有 ${listed.length} 个，和 magpie 的 ${magpieModels.length} 个不一致`);

  // 模型清单截图（只含模型名，不含 Key / 账号）。
  await page.getByTestId('settings-model-checklist').screenshot({ path: modelShot });

  if (!listed.includes(CHAT_MODEL)) fail(`清单里没有聊天用的 ${CHAT_MODEL}`);
  await page.locator(`[data-testid="settings-model-check"][data-model-id="${CHAT_MODEL}"]`).check();
  // 先「保存选择」把勾选的模型写进已保存清单；下拉框只列已保存的模型。
  await page.getByTestId('settings-model-save').click();
  await page.locator('.ok-banner', { hasText: '模型设置已保存' }).waitFor({ timeout: 20_000 });
  await page.getByTestId('settings-model-select').selectOption(CHAT_MODEL);
  await page.getByTestId('settings-chat-model').selectOption(CHAT_MODEL);
  await page.getByTestId('settings-model-save').click();
  await page.locator('.ok-banner', { hasText: '模型设置已保存' }).waitFor({ timeout: 20_000 });
  console.log('SAVED models+chat model');

  // 保存后重开一次：确保预热会话是按 magpie 的网关/模型建的（不在旧配置上留长驻进程）。
  await app.close();
  ({ app, page } = await launch());
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  // 打开聊天页会立刻后台预热 Hermes 会话（5–9 秒）。等它建完再发问，避免两个网关进程
  // 同时抢同一个会话（真机上先到的用户不会在一秒内按发送；这是一次性真机脚本的等待）。
  await page.waitForTimeout(12_000);

  // --- 2. 聊天：选 magpie 模型，问「只回复两个字母：OK」 ---
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('page-ask').waitFor({ timeout: 20_000 });
  await page.getByTestId('ask-input').fill(QUESTION);
  await page.getByTestId('ask-run').click();
  // 问答两条消息：等助手那条真的答完（不要拿用户消息里自带的「OK」冒充）。
  await page
    .getByTestId('ask-answer')
    .filter({ hasText: 'OK' })
    .last()
    .waitFor({ timeout: 180_000 });
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="ask-run"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 180_000 },
  );
  const answer = (await page.getByTestId('ask-answer').last().innerText())
    .replace(/\s+/g, ' ')
    .trim();
  console.log(`ANSWER ${answer.slice(-200)}`);
  if (!answer.includes('OK')) fail('回答里没有 OK');
  if (answer.includes('core-bounded')) fail('回答来自 Core 兜底，不是 Hermes');

  // --- 3. 驾驶舱额度区（账号名遮掉再截图） ---
  await page.getByTestId('nav-cockpit').click();
  await page.getByTestId('cockpit-quotas').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="cockpit-quota-card"]').first().waitFor({ timeout: 20_000 });
  const cards = await page.locator('[data-testid="cockpit-quota-card"]').count();
  const windows = await page.locator('[data-testid="cockpit-quota-window"]').count();
  const note = await page.getByTestId('cockpit-quota-note').count();
  console.log(
    `QUOTAS cards=${cards} windows=${windows} note=${note ? await page.getByTestId('cockpit-quota-note').innerText() : '（无）'}`,
  );
  if (cards < 1) fail('额度区一张 magpie 卡都没有');

  // 账号名是卡片里唯一的 <strong>：涂黑，避免截图带出账号显示名。
  await page.addStyleTag({
    content:
      '[data-testid="cockpit-quota-card"] > strong{color:transparent!important;background:#333!important;border-radius:4px}',
  });
  await page.getByTestId('cockpit-quotas').screenshot({ path: quotaShot });

  await app.close();
  const shots = existsSync(modelShot) && existsSync(quotaShot);
  console.log(`shots=${shots} models=${existsSync(modelShot)} quotas=${existsSync(quotaShot)}`);
  if (!shots) fail('截图没落盘');
  console.log(
    passed
      ? 'RESULT 通过：magpie 预设与模型清单一致、聊天真的走 magpie 答出 OK、驾驶舱额度区读到卡片；两张截图已落盘'
      : 'RESULT 没通过：见上面的不符',
  );
  process.exit(passed ? 0 : 1);
} catch (err) {
  try {
    await app.close();
  } catch {
    /* 已经关了 */
  }
  crash(err);
}
