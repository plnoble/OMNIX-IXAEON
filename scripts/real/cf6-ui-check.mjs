/**
 * CF6 界面真机检查：临时数据目录、4 个合成会话（归档 1 个）。
 * 产出三张截图：搜索片段、已归档+恢复、恢复后接着问一句。
 *   node scripts/real/cf6-ui-check.mjs
 * 模型：IXAEON_FAKE_MODEL=1 的假模型（本机没有 magpie 时用它；不打印回答原文）。
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron } = requireDesktop('playwright');
const Database = requireDesktop('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf6-ui-'));

async function launch() {
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  });
  const page = await app.firstWindow();
  return { app, page };
}

let { app, page } = await launch();
try {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });
} finally {
  await app.close().catch(() => undefined);
}

// 直接往临时库里放 4 个会话（3 正常 + 1 归档），内容是合成的
const db = new Database(join(dir, 'ixaeon.db'));
const now = new Date().toISOString();
const insConv = db.prepare(
  'INSERT INTO conversations (id, title, project_id, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?)',
);
const insMsg = db.prepare(
  `INSERT INTO messages (id, conversation_id, seq, role, content, status, created_at, updated_at)
   VALUES (?,?,?,?,?, 'complete', ?, ?)`,
);
const rows = [
  ['c1', '周报写法', null, ['帮我写周报', '可以分三部分来写周报']],
  ['c2', '买咖啡豆', null, ['推荐一款手冲豆子', '试试浅烘的耶加雪菲']],
  ['c3', '面试准备', null, ['明天面试要准备什么', '准备三分钟自我介绍']],
  ['c4', '旧的周报', now, ['去年的周报模板', '旧周报留档']],
];
for (const [id, title, archived, msgs] of rows) {
  insConv.run(id, title, null, now, now, archived);
  msgs.forEach((content, i) =>
    insMsg.run(`${id}-${i}`, id, i + 1, i % 2 === 0 ? 'user' : 'assistant', content, now, now),
  );
}
db.close();

({ app, page } = await launch());
try {
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });
  await page
    .getByTestId('nav-ask')
    .click()
    .catch(() => undefined);

  // 截图 1：搜「周报」，看到片段与加粗
  const box = page.getByTestId('conversation-search');
  await box.fill('周报');
  await page
    .getByTestId('conversation-search-snippet')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  const snippet =
    (await page.getByTestId('conversation-search-snippet').first().textContent()) ?? '';
  const bold =
    (await page
      .getByTestId('conversation-search-snippet')
      .first()
      .locator('strong')
      .first()
      .textContent()) ?? '';
  console.log('搜索片段（遮路径）：', snippet.replaceAll(dir, '<临时目录>'));
  console.log('加粗命中词：', bold);
  await page.screenshot({ path: '.logs/cf6-search.png' });
  await box.fill('');
  await page.waitForTimeout(300);

  // 截图 2：打开「已归档（N）」，恢复那一个
  const toggle = page.getByTestId('conversation-archived-toggle');
  console.log('开关文字：', (await toggle.textContent())?.trim());
  await toggle.click();
  await page.getByTestId('conversation-restore-c4').waitFor({ state: 'visible', timeout: 15_000 });
  await page.screenshot({ path: '.logs/cf6-archived.png' });
  await page.getByTestId('conversation-restore-c4').click();
  await page.waitForTimeout(500);
  console.log('恢复后开关文字：', (await toggle.textContent())?.trim());
  console.log(
    '恢复后列表里有「旧的周报」：',
    (await page.getByTestId('conversation-list').textContent())?.includes('旧的周报'),
  );

  // 回到正常列表，再在恢复的会话里接着问一句
  if ((await toggle.textContent())?.includes('返回')) await toggle.click();
  await page.waitForTimeout(500);
  await page.getByTestId('conversation-item').filter({ hasText: '旧的周报' }).first().click();
  await page.waitForTimeout(500);
  const before = await page.getByTestId('message-list').locator('article').count();
  await page.getByTestId('ask-input').fill('接着刚才的说');
  await page.getByTestId('ask-run').click();
  try {
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="message-list"] article').length >= n + 2,
      before,
      { timeout: 120_000 },
    );
  } catch {
    throw new Error('恢复后这一问没答出来');
  }
  const articles = await page.getByTestId('message-list').locator('article').allInnerTexts();
  console.log('续聊这一轮的消息条数（含前文轮次）：', articles.length);
  console.log('最后一轮有回答正文：', String(articles.at(-1) ?? '').trim().length > 0);
  console.log('模型：IXAEON_FAKE_MODEL=1（fake-direct，走直连链路）');
  await page.screenshot({ path: '.logs/cf6-continue.png' });
  console.log('截图: .logs/cf6-search.png / .logs/cf6-archived.png / .logs/cf6-continue.png');
} finally {
  await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
