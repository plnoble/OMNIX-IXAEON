/**
 * M2 界面验收（规格 docs/委派/M2-模型管理-检测勾选保存.md 契约 1-7 的界面部分；
 * 后端细节由 apps/desktop/test/acceptance/m2-saved-models.test.ts 照过）。
 *
 * 用一个本地的假上游（node http 只回 GET /v1/models，不碰真实网关）走完整流程：
 *   检测 → 勾选保存 → 改假上游再检测看标记 → 两个下拉框只从清单选 →
 *   当前在用的模型不在清单里的显示与标注 → Key 留空复用 → 重启应用清单还在。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 从 cwd 往上找 desktop 应用目录（照 smoke.spec.ts 的 findDesktopDir）。 */
function desktopDir(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js（请先 build）');
    dir = parent;
  }
}

const TEST_KEY = 'sk-test-m2';
const dataDir = mkdtempSync(join(tmpdir(), 'ixa-m2-'));

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(desktopDir(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      // 别让本机 Hermes 干扰：这里只测设置页与本地假上游
      HERMES_HOME: '',
      IXAEON_HERMES_HOME: '',
      IXAEON_HERMES_EXE: '',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function setupOnce(page: Page): Promise<void> {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('wizard-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('M2 项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
}

let server: Server;
let upstream: string[];
let failModels = false;
const auths: string[] = [];

test.describe('M2 模型管理（界面）', () => {
  test.beforeAll(async () => {
    upstream = ['gpt-a', 'gemini-b', 'claude-c'];
    server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        auths.push(String(req.headers.authorization ?? ''));
        if (failModels) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('upstream exploded for this test');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: upstream.map((id) => ({ id })) }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  test.afterAll(() => {
    server.close();
  });

  test('检测→勾选保存→重检标记→下拉只从清单选→Key 复用→重启还在', async () => {
    const upstreamBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

    // 第一段：首次设置 + 到设置页
    let { app, page } = await launch();
    await setupOnce(page);
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-model')).toBeVisible({ timeout: 20_000 });

    // 填假上游地址与 Key，点检测
    await page.getByTestId('settings-api-base').fill(upstreamBase);
    await page.getByTestId('settings-api-key').fill(TEST_KEY);
    await page.getByTestId('settings-fetch-models').click();
    await expect(page.getByTestId('settings-model-checklist')).toBeVisible({ timeout: 20_000 });
    const rows = page.locator('[data-testid="settings-model-check"]');
    await expect(rows).toHaveCount(3);

    // 契约 1/2：全部标「新」（从没保存过），默认不打勾
    await expect(page.getByTestId('settings-model-badge-gpt-a')).toHaveText('新');
    await expect(page.getByTestId('settings-model-badge-gemini-b')).toHaveText('新');
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gpt-a"]'),
    ).not.toBeChecked();

    // 契约 3：勾两个保存；保存只认勾上的
    await page.locator('[data-testid="settings-model-check"][data-model-id="gpt-a"]').check();
    await page.locator('[data-testid="settings-model-check"][data-model-id="gemini-b"]').check();
    // 契约 3 界面：没有手输模型名的入口（模型名称是下拉框）
    await expect(page.getByTestId('settings-model-select')).toBeVisible();
    await page.getByTestId('settings-model-save').click();
    await expect(page.locator('.ok-banner')).toContainText('模型设置已保存', { timeout: 15_000 });

    // 契约 4：当前在用的模型（wizard-model）不在已保存清单里——下拉照样显示并标注
    const modelSelect = page.getByTestId('settings-model-select');
    await expect(modelSelect.locator('option[value="wizard-model"]')).toContainText(
      '不在已保存清单',
    );
    // 契约 4：聊天模型下拉有「跟随分析模型」+ 清单里的模型
    const chatSelect = page.getByTestId('settings-chat-model');
    await expect(chatSelect.locator('option[value=""]')).toHaveText(/跟随分析模型/);
    await expect(chatSelect.locator('option[value="gpt-a"]')).toHaveText('gpt-a');

    // 选上两个再保存（改在用的模型）
    await modelSelect.selectOption('gpt-a');
    await chatSelect.selectOption('gemini-b');
    await page.getByTestId('settings-model-save').click();
    await expect(page.locator('.ok-banner')).toContainText('模型设置已保存', { timeout: 15_000 });
    await expect(page.getByTestId('settings-model-select')).toHaveValue('gpt-a');
    await expect(page.getByTestId('settings-chat-model')).toHaveValue('gemini-b');

    // 契约 6：Key 留空再检测，用已保存的 Key（服务器这一笔 Auth 还是 TEST_KEY）。
    // 等这次检测真的把请求发出去再比对，不跟 UI 渲染抢。
    const beforeAuths = auths.length;
    await page.getByTestId('settings-api-key').fill('');
    await page.getByTestId('settings-fetch-models').click();
    await expect.poll(() => auths.length, { timeout: 20_000 }).toBe(beforeAuths + 1);
    expect(auths.slice(beforeAuths)).toEqual([`Bearer ${TEST_KEY}`]);

    // 契约 1/2/5：换假上游（少 gemini-b、多 gpt-new）再检测——
    // 已保存的勾还在；新增标「新」；上游没有的标「上游已没有」不自动删；在用的模型不变
    upstream = ['gpt-a', 'claude-c', 'gpt-new'];
    await page.getByTestId('settings-api-key').fill(TEST_KEY);
    await page.getByTestId('settings-fetch-models').click();
    await expect(page.getByTestId('settings-model-checklist')).toBeVisible({ timeout: 20_000 });
    const rows2 = page.locator('[data-testid="settings-model-check"]');
    await expect(rows2).toHaveCount(4); // 上游 3 + 已保存但上游没有的 gemini-b
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gpt-a"]'),
    ).toBeChecked();
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gemini-b"]'),
    ).toBeChecked();
    await expect(page.getByTestId('settings-model-badge-gpt-new')).toHaveText('新');
    await expect(page.getByTestId('settings-model-badge-gemini-b')).toHaveText('上游已没有');
    // 契约 5：重检不改在用的模型（还没保存，就在下拉里）
    await expect(page.getByTestId('settings-model-select')).toHaveValue('gpt-a');
    await expect(page.getByTestId('settings-chat-model')).toHaveValue('gemini-b');
    // 契约 3：下拉框里没有未保存的模型（claude-c 上游有但没勾选保存）
    await expect(
      page.getByTestId('settings-model-select').locator('option[value="claude-c"]'),
    ).toHaveCount(0);
    await expect(
      page.getByTestId('settings-chat-model').locator('option[value="claude-c"]'),
    ).toHaveCount(0);

    // 契约 7：上游故障 → 检测失败如实显示错误，清单/勾选/在用的模型都不变
    failModels = true;
    await page.getByTestId('settings-fetch-models').click();
    // 契约 7：如实显示上游错误——假上游的报错原文要原样可见，不能只给一个笼统前缀
    await expect(page.getByTestId('error-banner')).toContainText(
      'upstream exploded for this test',
      {
        timeout: 20_000,
      },
    );
    await expect(rows2).toHaveCount(4); // 清单还是上一轮检测的四项
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gpt-a"]'),
    ).toBeChecked();
    await expect(page.getByTestId('settings-model-select')).toHaveValue('gpt-a');
    await expect(page.getByTestId('settings-chat-model')).toHaveValue('gemini-b');
    failModels = false;
    // 错误关掉后再检测一次复原（进入下面的保存流程）
    await page.getByTestId('error-banner').getByRole('button').click();
    await page.getByTestId('settings-fetch-models').click();
    await expect(page.getByTestId('settings-model-checklist')).toBeVisible({ timeout: 20_000 });

    // 契约 2：筛选框按名字过滤
    await page.getByTestId('settings-model-filter').fill('gpt');
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="claude-c"]'),
    ).toHaveCount(0);
    await page.getByTestId('settings-model-filter').fill('');

    // 保存新的勾选（gpt-a、gemini-b、gpt-new）后重启
    await page.locator('[data-testid="settings-model-check"][data-model-id="gpt-new"]').check();
    await page.getByTestId('settings-model-save').click();
    await expect(page.locator('.ok-banner')).toContainText('模型设置已保存', { timeout: 15_000 });
    await expect(page.getByTestId('settings-model-select')).toHaveValue('gpt-a');

    await app.close();

    // 契约 2：重启后清单与勾选状态还在
    ({ app, page } = await launch());
    await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-model')).toBeVisible({ timeout: 20_000 });
    const rows3 = page.locator('[data-testid="settings-model-check"]');
    await expect(rows3).toHaveCount(3); // 没检测过：只显示已保存的
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gpt-a"]'),
    ).toBeChecked();
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gemini-b"]'),
    ).toBeChecked();
    await expect(
      page.locator('[data-testid="settings-model-check"][data-model-id="gpt-new"]'),
    ).toBeChecked();
    await expect(page.getByTestId('settings-model-select')).toHaveValue('gpt-a');
    await expect(page.getByTestId('settings-chat-model')).toHaveValue('gemini-b');
    // 均不打「不在已保存清单」的补丁：在用的都在清单里
    await expect(page.getByTestId('settings-model-select')).not.toContainText('不在已保存清单');

    await app.close();
  });
});
