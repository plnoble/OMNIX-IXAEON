/**
 * V2 排查探针 2（本机临时，不入库）：完整复刻 smoke 前五步（设置向导 →
 * 导入文档 → 检索 → 项目页 → 总览），逐步 dump 定位「应用退回首次设置
 * 向导」的触发点。用法：node scripts/real/v2-probe-overview2.mjs（先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ixaeon-v2probe2-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const importDoc = join(dataDir, 'seed-notes.md');
writeFileSync(
  importDoc,
  [
    '# IXAEON 种子文档',
    '',
    'IXAEON（析衍）坚持两条原则：原文永久保留；当前理解可纠正。',
    '橙子计划第一周完成仓库骨架搭建。',
    '',
  ].join('\n'),
  'utf8',
);
const tailLogs = () => {
  try {
    const files = readdirSync(join(dataDir, 'logs')).filter((f) => f.endsWith('.log'));
    return files
      .map((f) =>
        readFileSync(join(dataDir, 'logs', f), 'utf8')
          .split('\n')
          .slice(-4)
          .join(' | '),
      )
      .join('\n');
  } catch {
    return '(no logs)';
  }
};

let app = null;
try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${importDoc};directory|${dataDir}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const state = async (tag) => {
    const r = await page.evaluate(() => ({
      hasMainNav: !!document.querySelector('[data-testid="main-nav"]'),
      hasWizard: !!document.querySelector('[data-testid="setup-wizard"]'),
      badge: document.querySelector('[data-testid^="todo-linked"]')?.textContent ?? null,
    }));
    console.log(`[${tag}]`, JSON.stringify(r));
  };

  // 向导
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('gpt-5.2');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('橙子计划');
  await page.getByTestId('setup-pick-root').click();
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await state('after-wizard');

  // 导入文档
  await page.getByTestId('nav-sources').click();
  await page.getByTestId('sources-import-docs').click();
  await page.locator('tbody tr').first().waitFor({ timeout: 20_000 });
  await state('after-import');

  // 检索
  await page.getByTestId('nav-search').click();
  await page.getByTestId('search-input').fill('橙子计划');
  await page.getByTestId('search-run').click();
  await page.waitForTimeout(1500);
  await state('after-search');

  // 项目页
  await page.getByTestId('nav-projects').click();
  await page.waitForTimeout(1500);
  await state('after-projects');

  // 总览（smoke 第 5 条的失败点）
  await page.getByTestId('nav-overview').click();
  await page.waitForTimeout(1500);
  await state('overview-1.5s');
  await page.waitForTimeout(5000);
  await state('overview-6.5s');

  // 设置
  try {
    await page.getByTestId('nav-settings').click({ timeout: 5000 });
    await state('after-settings-click-ok');
  } catch (e) {
    console.log('[after-settings-click] FAILED (wizard back?):', String(e).split('\n')[0]);
    await state('settings-failed-state');
  }
  console.log('[final logs]', tailLogs());
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  rmSync(root, { recursive: true, force: true });
}
