/**
 * A5 真机检查：假模型（不给响应 → 模型调用失败）启动构建好的应用，
 * 只动临时数据目录、合成问题；输出只含状态与数字。
 *
 * 1. 第一次启动（假模型脚本为空）：问一句 → 对话里显示失败与错误信息、不再转圈；
 *    用 scripts/real/last-ask-status.mjs 看这条消息 = failed + 有错误信息；
 *    库里没有新增的问答存档来源。
 * 2. 第二次启动（同一数据目录，假模型脚本给正常回答）：再问一句 → 照常回答、
 *    照常存档（来源新增一条）。
 *
 *   node scripts/real/a5-model-failure-real.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
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
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
const localRequire = createRequire(join(desktopApp, 'package.json'));
const { _electron: electron } = localRequire('@playwright/test');
const Database = localRequire('better-sqlite3');

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-a5-real-'));
const scriptPath = join(dataDir, 'model-script.json');
console.log('DATA_DIR', dataDir);

/** 逐条对照，只有全都符合才写「通过」；出错非零（照 p5/p7 的规矩）。 */
let passed = true;
const fail = (why) => {
  passed = false;
  console.log('不符：', why);
};

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  // 照现在的规矩隔离：随机端口（不和用户开着的应用撞）、不载嵌入模型、不碰真 Codex / 真 Hermes
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  HERMES_HOME: '',
  IXAEON_HERMES_HOME: '',
  IXAEON_HERMES_EXE: '',
};
// 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell / 门禁都带），Electron 会当普通 node
// 跑、主进程里 app 是 undefined、窗口起不来。照 scripts/real/p8-delete-project.mjs 清掉。
delete env.ELECTRON_RUN_AS_NODE;

function desktopDir() {
  if (existsSync(join(desktopApp, 'out', 'main', 'index.js'))) return desktopApp;
  throw new Error('找不到 out/main/index.js（请先 build）');
}

async function launch() {
  const app = await electron.launch({
    args: [
      join(desktopDir(), 'out', 'main', 'index.js'),
      `--user-data-dir=${join(dataDir, 'profile')}`,
    ],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function setupOnce(page) {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('fake');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('A5 真机项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
}

function sourceCount() {
  const db = new Database(join(dataDir, 'ixaeon.db'));
  const n = db
    .prepare(`SELECT COUNT(*) AS n FROM sources WHERE provider IN ('ask_session','ask')`)
    .get().n;
  db.close();
  return n;
}

let app = null;
try {
  // ---- 第一问：假模型没有响应 → 模型调用失败
  writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');
  ({ app } = await launch());
  let page = await app.firstWindow();
  page = await app.firstWindow();
  await setupOnce(page);
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('ask-input').fill('A5 真机：这一问会失败');
  await page.getByTestId('ask-run').click();
  // 失败显示：气泡里出现「失败」，转圈消失
  await page.locator('[data-testid="message-item"][data-status="failed"]').waitFor({
    timeout: 60_000,
  });
  await page.getByTestId('message-list').getByText(/失败/).first().waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="loading"]').waitFor({ state: 'detached', timeout: 30_000 });
  console.log('Q1_UI', '失败气泡可见，转圈已消失');
  const beforeSources = sourceCount();
  if (beforeSources !== 0)
    fail(`失败的那一问之后，库里多出了 ${beforeSources} 条问答存档来源（不该有）`);
  await app.close();
  app = null;
  console.log('Q1_SOURCES_BEFORE', beforeSources);

  // 用诊断脚本看库里的收尾（只输出状态与数字）
  const status = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'real', 'last-ask-status.mjs'), dataDir, '3'],
    { encoding: 'utf8' },
  );
  const statusText = status.stdout.trim();
  console.log(statusText);
  if (!statusText.includes('failed')) fail('库里那条助手消息不是 failed 状态');
  if (!statusText.includes('有错误信息:是')) fail('库里那条助手消息没有错误信息');

  // ---- 第二问：假模型给正常回答 → 照常回答、照常存档
  writeFileSync(
    scriptPath,
    JSON.stringify({
      structured: [{ tool: 'answer', args: { text: 'A5 真机第二问的正常回答。' } }, { items: [] }],
    }),
    'utf8',
  );
  ({ app } = await launch());
  page = await app.firstWindow();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('ask-input').fill('A5 真机：这一问正常');
  await page.getByTestId('ask-run').click();
  await page.getByTestId('message-list').getByText('正常回答').first().waitFor({ timeout: 60_000 });
  console.log('Q2_UI', '正常回答已显示');
  await app.close();
  app = null;
  const afterSources = sourceCount();
  if (afterSources !== beforeSources + 1) {
    fail(`正常那一问之后，问答存档来源从 ${beforeSources} 变成 ${afterSources}（期望 +1）`);
  }
  console.log('Q2_SOURCES_AFTER', afterSources);
} catch (err) {
  passed = false;
  console.log('脚本出错：', err instanceof Error ? err.message : String(err));
} finally {
  if (app) await app.close().catch(() => undefined);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
}
console.log(
  'RESULT',
  passed
    ? '通过：模型失败那一问记成 failed（有错误信息、不再转圈、不进问答存档）→ 下一问正常回答并存档（来源 +1）'
    : '没通过：上面有不符或脚本出错的那条',
);
process.exit(passed ? 0 : 1);
