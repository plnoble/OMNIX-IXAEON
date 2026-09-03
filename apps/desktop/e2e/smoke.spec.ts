import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 找到 desktop 应用目录（test-e2e.mjs 以 apps/desktop 为 cwd 运行）。 */
function findDesktopDir(): string {
  for (let dir = process.cwd(); ; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js（请先 build 并在 apps/desktop 下运行）');
    dir = parent;
  }
}

const desktopDir = findDesktopDir();

/** 启动打包后的桌面应用（先 build 再 e2e 是 verify 之外的独立步骤）。 */
async function launchApp(env: Record<string, string>): Promise<ElectronApplication> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  Object.assign(merged, env);
  return electron.launch({
    args: [join(desktopDir, 'out', 'main', 'index.js')],
    env: merged,
  });
}

test.describe('桌面应用 M1 冒烟', () => {
  let app: ElectronApplication;
  let page: Page;
  let dataDir: string;
  let importDoc: string;

  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-e2e-'));
    // 准备一个待导入的文档（真实文件，走完整 vault + FTS 流程）
    importDoc = join(dataDir, 'seed-notes.md');
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
    app = await launchApp({
      IXAEON_DATA_DIR: dataDir,
      // 对话框 stub：documents 选择 seed-notes.md；directory 选择 dataDir
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${importDoc};directory|${dataDir}`,
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('应用启动 → 首次设置向导', async () => {
    await expect(page.getByTestId('app-root')).toBeVisible();
    await expect(page.getByTestId('setup-wizard')).toBeVisible();
    await expect(page.getByTestId('setup-step-dir')).toBeVisible();

    // 步骤 1：默认数据目录（环境变量注入，直接下一步）
    await page.getByTestId('setup-next-1').click();
    await expect(page.getByTestId('setup-step-model')).toBeVisible();

    // 步骤 2：模型（留空 key，允许稍后配置）
    await page.getByTestId('setup-model-name').fill('gpt-5.2');
    await page.getByTestId('setup-next-2').click();
    await expect(page.getByTestId('setup-step-project')).toBeVisible();

    // 步骤 3：第一个项目
    await page.getByTestId('setup-project-name').fill('橙子计划');
    await page.getByTestId('setup-pick-root').click();
    await expect(page.getByTestId('setup-project-root')).toHaveValue(dataDir);
    await page.getByTestId('setup-finish').click();

    // 完成后进入主界面（向导把用户带到来源页）
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
  });

  test('导入文档 → 来源列表与片段阅读器', async () => {
    await page.getByTestId('nav-sources').click();
    await expect(page.getByTestId('sources-card')).toBeVisible();
    await expect(page.getByTestId('sources-empty')).toBeVisible();

    await page.getByTestId('sources-import-docs').click();
    // stub 对话框直接返回 seed-notes.md → 导入 → 列表出现
    const row = page.locator('tbody tr').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('seed-notes.md');
    await expect(row).toContainText('文档');

    // 打开详情 → 片段阅读器
    await row.click();
    await expect(page.getByTestId('source-detail')).toBeVisible();
    await expect(page.getByTestId('segment-list')).toBeVisible();
    await expect(page.locator('.segment-text').first()).toContainText('原文永久保留');
  });

  test('全文检索命中导入内容', async () => {
    await page.getByTestId('nav-search').click();
    await expect(page.getByTestId('search-card')).toBeVisible();
    await page.getByTestId('search-input').fill('橙子计划');
    await page.getByTestId('search-run').click();
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.search-hit').first()).toContainText('仓库骨架');
  });

  test('项目页显示第一个项目', async () => {
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('projects-card')).toBeVisible();
    await expect(page.locator('.project-row').first()).toContainText('橙子计划');
    await expect(page.locator('.project-row').first()).toContainText('进行中');
  });

  test('总览显示状态与服务端口', async () => {
    await page.getByTestId('nav-overview').click();
    await expect(page.getByTestId('state-card')).toBeVisible();
    await expect(page.getByTestId('state-server')).toContainText('127.0.0.1:43191');
    await expect(page.getByTestId('state-setup')).toHaveText('已完成');
  });

  test('设置页 MCP 片段与数据目录', async () => {
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-mcp')).toBeVisible();
    const snippet = page.getByTestId('settings-mcp-snippet');
    await expect(snippet).toContainText('ixaeon');
    await expect(page.getByTestId('settings-data')).toContainText(dataDir);
  });
});
