/**
 * MP3b 验收条件 12（端到端）：用假聊天剧本，让第一个候选回 429、第二个正常回答。
 * 配好替补后问一句：对话里出现替补答的回答和那句提示。
 *
 * 现在实现还没做，本文件应当红（modelName 不是替补 / 没有 notice）。
 * 供应商与替补通过 IPC 配好（「模型」页那套界面在条件 11 里点过；这里只验端到端的回答与提示）。
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

test('条件 12：主选 429、替补回答 → 对话里有替补的回答和那句提示', async () => {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

  await page.evaluate(
    async ({ b }) => {
      const a = await window.ixaeon!.saveModelProvider({
        name: '合成甲',
        kind: 'openai',
        apiBaseUrl: b,
        apiKey: 'synthetic-a',
        savedModels: ['demo-a'],
      });
      const c = await window.ixaeon!.saveModelProvider({
        name: '合成乙',
        kind: 'openai',
        apiBaseUrl: b,
        apiKey: 'synthetic-b',
        savedModels: ['demo-b'],
      });
      await window.ixaeon!.saveModelUses({ chat: { providerId: a.id, model: 'demo-a' } });
      await window.ixaeon!.saveModelFallbacks({ chat: [{ providerId: c.id, model: 'demo-b' }] });
    },
    { b: base },
  );

  await page.getByTestId('nav-ask').click();
  await page.getByTestId('ask-input').fill('合成问题');
  await page.getByTestId('ask-run').click();

  await expect(page.getByTestId('message-list')).toContainText('这是替补答的回答', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('message-list')).toContainText('由替补', { timeout: 15_000 });
  await expect(page.getByTestId('message-list')).toContainText('额度用完', { timeout: 15_000 });
});
