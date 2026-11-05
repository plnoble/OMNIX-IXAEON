/**
 * MP3e 界面真机检查：临时数据目录起应用，在「模型」页排一串编码候选并截图。
 *   node scripts/real/mp3e-models-ui.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron } = requireDesktop('playwright');
const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3e-ui-'));

const app = await electron.launch({
  args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
  env: { ...process.env, IXAEON_DATA_DIR: dir },
});
try {
  const page = await app.firstWindow();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('nav-models').click();

  const add = page.getByTestId('coding-chain-add');
  await page.getByTestId('coding-chain-kind').selectOption({ label: '开发工具' });
  await page.getByTestId('coding-chain-tool').selectOption({ label: 'Codex' });
  await add.getByRole('button', { name: '添加' }).click();
  await page.getByTestId('coding-chain-tool').selectOption({ label: 'Claude Code' });
  await page.getByTestId('coding-chain-claude-model').selectOption({ label: 'sonnet' });
  await add.getByRole('button', { name: '添加' }).click();
  await page.getByTestId('coding-chain-tool').selectOption({ label: 'DSH' });
  await add.getByRole('button', { name: '添加' }).click();
  const labels = await page.getByTestId('coding-chain-list').locator('li').allTextContents();
  console.log('编码候选列表：', JSON.stringify(labels.map((s) => s.replaceAll(dir, '<临时目录>'))));
  await page.screenshot({ path: '.logs/mp3e-models.png', fullPage: true });
  console.log('截图: .logs/mp3e-models.png');
} finally {
  await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
