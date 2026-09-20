/**
 * S3b 真机检查（合成数据）：临时数据目录启动应用，对合成的会话文件夹走一遍
 * 列出 → 勾选 → 估算 → 导入，并确认资料页出现新来源。
 * 文件夹选择用主进程的 IXAEON_TEST_DIALOG_RESPONSES 测试钩子（只在环境变量存在时生效）。
 * 截图落到 apps/desktop/release/screenshots/。
 * 没有选用户真实的会话文件夹；会话内容全是合成的。
 *   node_modules/.bin/jiti scripts/real/s3b-agent-sessions-ui.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) {
  throw new Error('no _electron: ' + Object.keys(pw).slice(0, 30).join(','));
}
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-s3b-real-'));
const sessionDir = join(dataDir, 'sessions');
mkdirSync(sessionDir, { recursive: true });
const seg = (type: 'user' | 'assistant', content: unknown) =>
  JSON.stringify({
    sessionId: '11111111-2222-4333-8444-999999999999',
    cwd: 'D:/work/s3b-demo',
    isSidechain: false,
    type,
    timestamp: '2026-09-20T01:00:01.000Z',
    message: { role: type, content },
  });
writeFileSync(
  join(sessionDir, 'cc.jsonl'),
  `${seg('user', 'S3b 合成任务：把会话选择导入做好')}\n${seg('assistant', [
    { type: 'text', text: 'S3b 合成回答。' },
  ])}`,
  'utf8',
);
const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  IXAEON_TEST_DIALOG_RESPONSES: `directory|${sessionDir}`,
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};

async function launch() {
  const app = await electron.launch({
    args: [join(desktopDir, 'out', 'main', 'index.js')],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const run = await launch();
await run.page.getByTestId('setup-next-1').click();
await run.page.getByTestId('setup-model-name').fill('fake-model');
await run.page.getByTestId('setup-next-2').click();
await run.page.getByTestId('setup-project-name').fill('S3b 合成项目');
await run.page.getByTestId('setup-finish').click();
await run.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

await run.page.getByTestId('nav-sources').click();
await run.page.getByTestId('sources-import-agent-sessions').click();
await run.page.getByTestId('agent-sessions-list').waitFor({ timeout: 10_000 });
const rows = await run.page.getByTestId('agent-sessions-list').innerText();
console.log('LIST');
console.log(rows);

await run.page.getByTestId('agent-sessions-select-new').click();
await run.page
  .getByTestId('agent-sessions-estimate')
  .waitFor({ timeout: 10_000, state: 'visible' });
await run.page.waitForTimeout(300);
const estimate = await run.page.getByTestId('agent-sessions-estimate').innerText();
console.log('ESTIMATE');
console.log(estimate);
await run.page.screenshot({ path: join(shotDir, 's3b-agent-list.png'), fullPage: true });

await run.page.getByTestId('agent-sessions-import').click();
await run.page
  .getByTestId('agent-sessions-result')
  .waitFor({ timeout: 20_000, state: 'visible' });
const result = await run.page.getByTestId('agent-sessions-result').innerText();
console.log('RESULT');
console.log(result);
await run.page.waitForTimeout(1500);
const sourceRow = run.page.locator('[data-testid^="source-row-"]').first();
const sourceVisible = await sourceRow.count();
const sourceText = sourceVisible ? await sourceRow.innerText() : '';
console.log('SOURCE_ROW', sourceVisible);
console.log(sourceText);
await run.page.screenshot({ path: join(shotDir, 's3b-after-import.png'), fullPage: true });
await run.app.close();

rmSync(dataDir, { recursive: true, force: true });
console.log('done');
