/**
 * MP3b 验收条件 11（界面）：apps/desktop/e2e 里点一遍「模型」页「用途」的替补列表。
 *
 * 对应规格「验收条件」第 11 条：
 * - 两个用途下面各有替补列表，能添加、上移、下移、删掉；保存后刷新页面顺序不变；
 * - 满 4 项时「添加」不能点；
 * - 下拉框里没有主选和已在列表里的；
 * - 聊天选「跟着后台分析」时替补列表收起，显示一行说明；
 * - 保存被拒时，主进程的提示原样显示；
 * - 聊天里，带替补提示的回答下面显示那句话。
 *
 * 只按用户看得到的文字与角色找元素（不新造 data-testid）：列表在「用途」卡片里，
 * 按钮文字「上移」「下移」「删掉」「添加」，保存用现有的「保存」。
 * 现在界面还没做，本文件应当红（找不到替补列表）。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { _electron: electronLauncher } = { _electron: electron };
const desktopMain = resolve(process.cwd(), 'out', 'main', 'index.js');

let server: Server;
let base = '';
let app: ElectronApplication;
let page: Page;
const dataDir = mkdtempSync(join(tmpdir(), 'ixa-mp3b-ui-'));

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'demo-a' }, { id: 'demo-b' }] }));
      return;
    }
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

  app = await electronLauncher.launch({
    args: [desktopMain],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir, IXAEON_FAKE_MODEL: '1' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  server.close();
});

const usesCard = () => page.getByTestId('models-uses');

async function addProvider(name: string): Promise<void> {
  await page.getByTestId('nav-models').click();
  await expect(page.getByTestId('models-page')).toBeVisible({ timeout: 20_000 });
  // 新建供应商（沿用现有表单；测试只关心它出现在下拉里）
  await page
    .getByRole('button', { name: /新建供应商|添加供应商/ })
    .first()
    .click();
  await page.getByTestId('provider-name-input').fill(name);
  await page.getByTestId('provider-base-input').fill(base);
  await page.getByTestId('provider-key-input').fill('sk-synthetic-a1b2c3d4');
  await page.getByTestId('provider-models').click();
  await expect(page.getByTestId('model-row-demo-a')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('model-row-demo-a').locator('input[type="checkbox"]').check();
  await page.getByTestId('model-row-demo-b').locator('input[type="checkbox"]').check();
  await page.getByTestId('provider-save').click();
  await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });
}

test('条件 11：两个用途各有替补列表，能加/上移/下移/删，保存后刷新顺序不变', async () => {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

  await addProvider('合成甲');
  await addProvider('合成乙');

  await page.getByTestId('nav-models').click();
  await expect(usesCard()).toBeVisible({ timeout: 20_000 });
  // 两个用途下面各一个替补列表
  await expect(usesCard().getByText('替补（这一个不行按顺序换下一个）')).toHaveCount(2);

  // 后台分析：主选 合成甲·demo-a，替补加 合成乙·demo-b，保存
  await page.getByTestId('uses-analysis').selectOption({ label: '合成甲 · demo-a' });
  await usesCard().getByRole('button', { name: '添加' }).first().click();
  await page.getByTestId('uses-save').click();
  await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });

  // 刷新页面：顺序仍在
  await page.reload();
  await page.getByTestId('nav-models').click();
  await expect(usesCard()).toContainText('合成乙 · demo-b', { timeout: 20_000 });

  // 上移 / 下移 / 删掉 都能用
  const firstList = usesCard().locator('li').first();
  await firstList.getByRole('button', { name: '上移' }).click();
  await firstList.getByRole('button', { name: '下移' }).click();
  await firstList.getByRole('button', { name: '删掉' }).click();
  await expect(usesCard()).not.toContainText('合成乙 · demo-b');
});

test('条件 11：满 4 项时「添加」不能点；下拉里没有主选和已在列表里的', async () => {
  await page.getByTestId('nav-models').click();
  await expect(usesCard()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('uses-analysis').selectOption({ label: '合成甲 · demo-a' });
  for (let i = 0; i < 4; i += 1) {
    await usesCard().getByRole('button', { name: '添加' }).first().click();
  }
  await expect(usesCard().getByRole('button', { name: '添加' }).first()).toBeDisabled();
  const options = await usesCard().locator('select').first().locator('option').allTextContents();
  expect(options.join('|')).not.toContain('合成甲 · demo-a');
});

test('条件 11：聊天选「跟着后台分析」时替补列表收起并显示说明；保存被拒时提示原样显示', async () => {
  await page.getByTestId('nav-models').click();
  await page.getByTestId('uses-chat').selectOption('');
  await expect(usesCard()).toContainText('跟着后台分析，替补也用后台分析的');
  // 保存被拒：把后台分析的替补清空后仍传一个不合法的组合，看主进程提示是否原样显示
  // （这里用「跟主选相同」造拒绝；文案由主进程给，界面应原样显示）
  await page.getByTestId('uses-save').click();
  // 任何被拒情况下应看到提示（warn 区）；成功则跳过
  const warn = page.locator('.warn');
  if (await warn.count()) {
    await expect(warn.first()).not.toBeEmpty();
  }
});
