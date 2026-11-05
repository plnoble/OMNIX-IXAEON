/**
 * MP3b 验收条件 12（端到端）：用假聊天剧本，让第一个候选回 429、第二个正常回答。
 * 在「模型」页上配好替补（选主选、添加替补、保存），问一句：对话里出现替补答的回答和那句提示。
 *
 * 现在实现还没做，本文件应当红（模型页没有替补列表）。
 * 配替补走「模型」页的真实点击（与条件 11 用同一批 data-testid：fallback-list-chat / fallback-add-chat）。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktopMain = resolve(process.cwd(), 'out', 'main', 'index.js');
const dataDir = mkdtempSync(join(tmpdir(), 'ixa-mp3b-e2e-'));
const chatScript = join(dataDir, 'chat-script.json');

let server: Server;
let base = '';
let app: ElectronApplication;
let page: Page;

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

  // 第一步 429（主选 demo-a 不行），第二步正常回答（替补 demo-b）
  writeFileSync(
    chatScript,
    JSON.stringify([{ error: '额度用完', status: 429 }, { deltas: ['这是替补答的回答'] }]),
  );

  app = await electron.launch({
    args: [desktopMain],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_CHAT_SCRIPT: chatScript,
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  server.close();
});

/** 在「模型」页新建一家供应商，勾上 demo-a、demo-b 两个模型。 */
async function addProvider(name: string, key: string): Promise<void> {
  await page.getByTestId('provider-add-name').fill(name);
  await page.getByTestId('provider-add-base').fill(base);
  await page.getByTestId('provider-add-key').fill(key);
  await page.getByTestId('provider-add-save').click();
  const card = page.locator('[data-testid^="provider-card-"]').filter({ hasText: name }).last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId(/^provider-models-/).click();
  await expect(card.getByTestId('model-row-demo-a')).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('model-row-demo-a').locator('input[type="checkbox"]').check();
  await card.getByTestId('model-row-demo-b').locator('input[type="checkbox"]').check();
  await card.getByTestId(/^provider-save-/).click();
  await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });
}

test('条件 12：模型页配好替补，主选 429、替补回答 → 对话里有替补的回答和整句提示', async () => {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

  // ===== 在「模型」页配：两家供应商、聊天主选甲·demo-a、替补乙·demo-b =====
  await page.getByTestId('nav-models').click();
  await expect(page.getByTestId('models-page')).toBeVisible({ timeout: 20_000 });
  await addProvider('合成甲', 'sk-synthetic-a1b2c3d4');
  await addProvider('合成乙', 'sk-synthetic-b9f8e7d6');

  await page.getByTestId('uses-analysis').selectOption({ label: '合成甲 · demo-a' });
  await page.getByTestId('uses-chat').selectOption({ label: '合成甲 · demo-a' });
  const add = page.getByTestId('fallback-add-chat');
  await add.locator('select').selectOption({ label: '合成乙 · demo-b' });
  await add.getByRole('button', { name: '添加' }).click();
  await expect(page.getByTestId('fallback-list-chat')).toContainText('合成乙 · demo-b');
  await page.getByTestId('uses-save').click();
  await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });

  // ===== 问一句：对话里出现替补答的回答和整句提示 =====
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('ask-input').fill('合成问题');
  await page.getByTestId('ask-run').click();

  await expect(page.getByTestId('message-list')).toContainText('这是替补答的回答', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('message-list')).toContainText(
    '「合成甲 · demo-a」这次不行（额度用完），由替补「合成乙 · demo-b」回答',
    { timeout: 15_000 },
  );
});
