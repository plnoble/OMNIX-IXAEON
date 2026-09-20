/**
 * U1 真机检查（合成数据）：临时数据目录启动应用，造一个没有来源、也没配搜索的
 * 合成主题，点「立即检查」（会立刻失败）：失败提示挂在这个主题上，新建表单的
 * 创建按钮全程可点。不碰用户数据目录。
 *   node_modules/.bin/jiti scripts/real/u1-research-busy.ts
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

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-u1-real-'));
const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
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
try {
  await run.page.getByTestId('setup-next-1').click();
  await run.page.getByTestId('setup-model-name').fill('fake-model');
  await run.page.getByTestId('setup-next-2').click();
  await run.page.getByTestId('setup-project-name').fill('U1 合成项目');
  await run.page.getByTestId('setup-finish').click();
  await run.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

  await run.page.getByTestId('nav-research').click();
  await run.page.getByTestId('page-research').waitFor({ timeout: 10_000 });
  await run.page.getByTestId('research-question').fill('U1 合成关注');
  await run.page.getByTestId('research-create').click();
  await run.page.locator('[data-testid^="research-topic-"]').first().waitFor({ timeout: 10_000 });
  const topicTestId = await run.page
    .locator('[data-testid^="research-topic-"]')
    .first()
    .getAttribute('data-testid');
  const topicId = topicTestId!.slice('research-topic-'.length);
  console.log('TOPIC', topicId);

  await run.page.getByTestId('research-question').fill('另一个关注');
  const createBefore = await run.page.getByTestId('research-create').isDisabled();
  console.log('CREATE_BEFORE', createBefore);

  await run.page.getByTestId(`research-check-${topicId}`).click();
  const createDuring = await run.page.getByTestId('research-create').isDisabled();
  console.log('CREATE_DURING', createDuring);
  const notice = run.page.getByTestId(`research-run-notice-${topicId}`);
  await notice.waitFor({ timeout: 30_000 });
  console.log('NOTICE');
  console.log(await notice.innerText());
  const createAfter = await run.page.getByTestId('research-create').isDisabled();
  console.log('CREATE_AFTER', createAfter);
  const bannerCount = await run.page.getByTestId('error-banner').count();
  console.log('BANNER_COUNT', bannerCount);
  await run.page.screenshot({ path: join(shotDir, 'u1-research-busy.png'), fullPage: true });
} finally {
  await run.app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log('done');
