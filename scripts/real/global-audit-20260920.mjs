/**
 * 独立审核的真实 Electron 检查：只建临时空库与合成项目，不调用云端/真 Hermes/Codex。
 * 当前版本预期复现 G06；不是新的锁定验收，不修改任何生产代码或用户数据库。
 * node scripts/build.mjs
 * node scripts/real/global-audit-20260920.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(root, 'apps', 'desktop');
const require = createRequire(join(desktop, 'package.json'));
const { _electron: electron } = require('@playwright/test');
const data = mkdtempSync(join(tmpdir(), 'ixaeon-global-ui-'));
const evidence = join(root, '.audit-global-20260920');
mkdirSync(evidence, { recursive: true });
const suffix = new Date().toISOString().replaceAll(/[:.]/g, '-');
const env = {
  ...process.env,
  IXAEON_DATA_DIR: data,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: '',
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};
let app;
try {
  app = await electron.launch({
    args: [join(desktop, 'out', 'main', 'index.js'), `--user-data-dir=${join(data, 'chromium')}`],
    env,
    timeout: 20000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForLoadState('domcontentloaded');
  // 本检查不需要用户看到窗口；不碰用户已开的 IXAEON 实例。
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.setBackgroundThrottling(false);
      w.hide();
    }),
  );
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('synthetic');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目 A');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor();
  const ids = await page.evaluate(async () => {
    const api = window.ixaeon;
    const a = (await api.listProjects())[0];
    const b = await api.createProject({ name: '合成项目 B', rootPath: null, description: null });
    const conversation = await api.createConversation({ projectId: a.id });
    await api.renameConversation({ id: conversation.id, title: '只属于 A 的合成对话' });
    return { a: a.id, b: b.id, conversation: conversation.id };
  });
  await page.reload();
  await page.getByTestId('main-nav').waitFor();
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('ask-project-select').selectOption(ids.b);
  await page
    .locator(
      `[data-testid="conversation-item"][data-conversation-id="${ids.conversation}"] .ask-conv-main`,
    )
    .click();
  await page
    .locator(`[data-testid="conversation-item"][data-conversation-id="${ids.conversation}"].active`)
    .waitFor();
  const selected = await page.getByTestId('ask-project-select').inputValue();
  const report = {
    kind: 'real-electron-synthetic-data-no-cloud',
    openedConversationBelongsTo: 'A',
    selectedProjectAfterOpening: selected === ids.a ? 'A' : selected === ids.b ? 'B' : 'personal',
    projectRestoredCorrectly: selected === ids.a,
    realHermesChat: false,
    realCodingExecution: false,
  };
  // 隐藏窗口的截图在本机超时；按仓库规则保留实际操作与状态输出，不把截图失败算产品失败。
  writeFileSync(join(evidence, `desktop-${suffix}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.projectRestoredCorrectly) process.exitCode = 1;
} finally {
  if (app) await app.close();
  const abs = resolve(data);
  if (abs.startsWith(resolve(tmpdir()) + sep) && basename(abs).startsWith('ixaeon-global-ui-')) {
    try {
      rmSync(abs, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      console.log('合成临时目录未删除；未触碰用户数据。');
    }
  }
}
