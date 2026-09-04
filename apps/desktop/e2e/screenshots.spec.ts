import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * P2-11 截图采集：桌面端主要页面 + 扩展弹窗状态（真实渲染，非 DOM 断言替代）。
 * 输出 → apps/desktop/release/screenshots/*.png（REVIEW_PACKET 引用）。
 */

function findDesktopDir(): string {
  for (let dir = process.cwd(); ; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js');
    dir = parent;
  }
}

const desktopDir = findDesktopDir();
// e2e 以 apps/desktop 为 cwd：仓库根 = 上两级
const root = resolve(process.cwd(), '..', '..');
const shotDir = join(root, 'apps', 'desktop', 'release', 'screenshots');

test.describe('截图采集', () => {
  let app: ElectronApplication;
  let page: Page;
  let dataDir: string;
  let importDoc: string;

  test.beforeAll(async () => {
    mkdirSync(shotDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-shot-'));
    importDoc = join(dataDir, 'IXAEON-种子资料.md');
    writeFileSync(
      importDoc,
      [
        '# IXAEON（析衍）',
        '',
        'IXAEON 是本地优先的项目记忆系统：原文永久保留，当前理解可纠正。',
        '第一阶段先解决项目连续性，不做大而全的聊天助手。',
        '编码 AI 通过 MCP 获得有限、相关、带引用的项目背景。',
        'ChatGPT 网页对话经浏览器扩展自动增量收回，可全局暂停或暂停当前对话。',
        '',
        '## 原则',
        '',
        '- 原文不可改：所有导入内容按内容指纹保存在本地 vault。',
        '- 当前理解可纠正：用户纠正优先于 AI 推断，旧结论保留为历史。',
        '- 默认无授权不读取：只有用户明确选择的范围才可访问。',
      ].join('\n'),
      'utf8',
    );
    app = await electron.launch({
      args: [join(desktopDir, 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        IXAEON_DATA_DIR: dataDir,
        IXAEON_FAKE_MODEL: '1',
        IXAEON_TEST_DIALOG_RESPONSES: `documents|${importDoc};directory|${dataDir}`,
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('采集主要页面截图', async () => {
    // 1. 首次设置向导
    await expect(page.getByTestId('setup-wizard')).toBeVisible();
    await page.screenshot({ path: join(shotDir, '01-setup.png') });

    // 完成设置
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('gpt-5.2');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('IXAEON');
    await page.getByTestId('setup-pick-root').click();
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

    // 2. 导入文档（来源页）
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('sources-import-docs').click();
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(shotDir, '02-sources.png') });

    // 3. 来源详情（片段阅读器）
    await page.locator('tbody tr').first().click();
    await expect(page.getByTestId('segment-list')).toBeVisible();
    await page.screenshot({ path: join(shotDir, '03-source-detail.png') });

    // 4. 检索页
    await page.getByTestId('nav-search').click();
    await page.getByTestId('search-input').fill('项目连续性');
    await page.getByTestId('search-run').click();
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(shotDir, '04-search.png') });

    // 5. 项目页
    await page.getByTestId('nav-projects').click();
    await expect(page.locator('.project-row').first()).toBeVisible();
    await page.screenshot({ path: join(shotDir, '05-projects.png') });

    // 6. 理解页（FakeProvider 提取结果可能为空——展示空态也真实）
    await page.getByTestId('nav-understanding').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shotDir, '06-understanding.png') });

    // 7. 问答页
    await page.getByTestId('nav-ask').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, '07-ask.png') });

    // 8. 设置页（MCP 配置 + 采集开关）
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-mcp-snippet')).toBeVisible();
    await page.screenshot({ path: join(shotDir, '08-settings.png') });

    // 9. 总览
    await page.getByTestId('nav-overview').click();
    await expect(page.getByTestId('state-card')).toBeVisible();
    await page.screenshot({ path: join(shotDir, '09-overview.png') });

    const shots = [
      '01-setup.png',
      '02-sources.png',
      '03-source-detail.png',
      '04-search.png',
      '05-projects.png',
      '06-understanding.png',
      '07-ask.png',
      '08-settings.png',
      '09-overview.png',
    ];
    for (const s of shots) {
      expect(existsSync(join(shotDir, s)), s).toBe(true);
    }
  });
});
