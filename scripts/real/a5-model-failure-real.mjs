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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
const localRequire = createRequire(join(desktopApp, 'package.json'));
const { _electron: electron } = localRequire('@playwright/test');
const Database = localRequire('better-sqlite3');

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-a5-real-'));
const scriptPath = join(dataDir, 'model-script.json');
console.log('DATA_DIR', dataDir);

function desktopDir() {
  if (existsSync(join(desktopApp, 'out', 'main', 'index.js'))) return desktopApp;
  throw new Error('找不到 out/main/index.js（请先 build）');
}

async function launch() {
  const app = await electron.launch({
    args: [join(desktopDir(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
      HERMES_HOME: '',
      IXAEON_HERMES_HOME: '',
      IXAEON_HERMES_EXE: '',
    },
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
  await app.close();
  app = null;
  console.log('Q1_SOURCES_BEFORE', beforeSources);

  // 用诊断脚本看库里的收尾（只输出状态与数字）
  const status = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'real', 'last-ask-status.mjs'), dataDir, '3'],
    { encoding: 'utf8' },
  );
  console.log(status.stdout.trim());

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
  console.log('Q2_SOURCES_AFTER', sourceCount());
} finally {
  if (app) await app.close().catch(() => undefined);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
}
