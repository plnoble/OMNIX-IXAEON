/**
 * U6 真机检查（规格 U6「真机检查」）：报错条里不再有 Electron 加的那串英文前缀。
 * 照 scripts/real/p5-unbind-folder.mjs（整合方并 P5 时改过的那版）的规矩：
 * 临时数据目录、随机 IXAEON_HTTP_PORT、IXAEON_EMBED_MODEL=none、IXAEON_CODEX_EXE=none、
 * 打印时遮掉临时目录；RESULT 和退出码一致，脚本自己出错也以非零码退出。
 *   node scripts/real/u6-error-banner.mjs   （先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const log = (...a) => console.log(...a);
const work = mkdtempSync(join(tmpdir(), 'ixa-u6-real-'));
const dataDir = join(work, 'data');
mkdirSync(dataDir, { recursive: true });
/** 打印时把临时目录遮掉（合成数据，本来就能原样贴；照 P5 版规矩统一遮）。 */
const mask = (s) => s.replaceAll(work, '<临时目录>');

let app = null;
let result = '没通过：脚本没跑完';
let passed = true;
function fail(why) {
  log('不符：', why);
  passed = false;
  result = `没通过：${why}`;
}

try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(work, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      IXAEON_EMBED_MODEL: 'none',
      IXAEON_CODEX_EXE: 'none',
      IXAEON_FAKE_MODEL: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('gpt-5.2');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('第一个项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

  // 1. 新建一个不绑文件夹的项目；任务页给它建草案，点「批准并排队」
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('没绑文件夹的项目');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);

  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('task-goal').fill('U6 真机草案');
  await page.locator('select').first().selectOption({ label: '没绑文件夹的项目' });
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(600);

  // 2. 打印报错条里的字（遮掉临时目录）
  const banner = (
    (await page
      .locator('.error-banner')
      .textContent()
      .catch(() => null)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  log('[1] 报错条里的字：', mask(banner));

  if (!banner) fail('报错条没有字');
  else if (banner.includes('Error invoking remote method')) fail('报错条里还带着英文前缀');
  else if (!banner.startsWith('IXA0012：')) fail('报错条不是以 IXA0012：开头');
  else result = '通过：报错条只剩 IXA0012：那句，没有英文前缀';
} catch (err) {
  passed = false;
  result = `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`;
  log('脚本出错：', mask(result));
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
log('RESULT', mask(result));
process.exit(passed ? 0 : 1);
