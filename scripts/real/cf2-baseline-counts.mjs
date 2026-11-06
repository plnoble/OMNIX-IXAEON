/**
 * CF2 真机计数：临时数据目录 + 本机 magpie（http://127.0.0.1:3425/v1，Key `magpie`），
 * 按顺序问固定问题集 8 句，然后只读临时库数结果（不打印回答原文）。
 *   node scripts/real/cf2-baseline-counts.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron } = requireDesktop('playwright');
const Database = requireDesktop('better-sqlite3');

const Q = [
  '帮我制定一个完整的开发方案：做一个记账小程序',
  '接下来我该做什么？',
  "帮我把这段代码改成异步的：function load() { return readFileSync('a.txt'); }",
  '我明天要去面试，帮我准备一下',
  '帮我查一下 RTX 4090 的功耗',
  '帮我把代码提交一下，git commit 写「修 bug」',
  '记一下：我下周三要交报告',
  '待办：周五前把发票寄出去',
];

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf2-real-'));
const mask = (s) => String(s).replaceAll(dir, '<临时目录>');
let app;
let modelName = '';

async function launch() {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir },
  });
  return app.firstWindow();
}

try {
  const page = await launch();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('magpie');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('CF2 合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });

  // 模型页：用本机 magpie 预设加一家，勾上第一个模型，聊天选它
  await page.getByTestId('nav-models').click();
  await page.getByTestId('provider-magpie-preset').click();
  await page.getByTestId('provider-add-save').click();
  const card = page.locator('[data-testid^="provider-card-"]').filter({ hasText: 'magpie' }).last();
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await card.getByTestId(/^provider-models-/).click();
  const firstRow = card.locator('[data-testid^="model-row-"]').first();
  await firstRow.waitFor({ state: 'visible', timeout: 120_000 });
  const modelId = (await firstRow.getAttribute('data-model-id')) ?? '';
  modelName = modelId;
  await firstRow.locator('input[type="checkbox"]').check();
  await card.getByTestId(/^provider-save-/).click();
  await page.waitForTimeout(500);
  const chat = page.getByTestId('uses-chat');
  const target = (await chat.locator('option').allTextContents()).find((t) => t.includes(modelId));
  if (target) await chat.selectOption({ label: target });
  await page.getByTestId('uses-save').click();
  await page.waitForTimeout(500);

  // 新对话，按顺序问 8 句
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('conversation-new').click();
  await page.waitForTimeout(500);
  for (const q of Q) {
    const before = await page.getByTestId('message-list').locator('article').count();
    await page.getByTestId('ask-input').fill(q);
    await page.getByTestId('ask-run').click();
    await page
      .waitForFunction(
        (n) => document.querySelectorAll('[data-testid="message-list"] article').length >= n + 2,
        before,
        { timeout: 180_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(500);
  }
  await app.close();
  app = null;

  // 只读临时库数结果
  const db = new Database(join(dir, 'ixaeon.db'), { readonly: true });
  const todos = db.prepare('SELECT COUNT(*) AS n FROM todos').get().n;
  const userTodos = db.prepare("SELECT COUNT(*) AS n FROM todos WHERE origin = 'user'").get().n;
  const tasks = db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get().n;
  const rows = db.prepare("SELECT content FROM messages WHERE role = 'assistant'").all();
  const withSuggest = rows.filter((r) => String(r.content).includes('建议待办')).length;
  db.close();

  console.log('用的模型：', modelName || '（没选上）');
  console.log('待办行数：', todos, '｜其中来源用户：', userTodos);
  console.log('编码任务行数：', tasks);
  console.log('8 轮里回答正文含「建议待办」的轮数：', withSuggest);
  console.log('（临时目录已遮：' + mask('<临时目录>') + '）');
} finally {
  if (app) await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
