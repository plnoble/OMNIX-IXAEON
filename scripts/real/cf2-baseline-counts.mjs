/**
 * CF2 真机计数：临时数据目录 + 本机 magpie（http://127.0.0.1:3425/v1，Key `magpie`），
 * 按顺序问固定问题集 8 句，然后只读临时库数结果（不打印回答原文）。
 *   node scripts/real/cf2-baseline-counts.mjs
 *   CF2_REAL_MODEL=<模型 id> 可指定在 UI 里勾哪个模型（默认第一个）。
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
  '帮我把代码提交一下，git commit 写『修 bug』',
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
  // 可选：CF2_REAL_MODEL=<模型 id> 勾指定的那个（某家限流 429 时换一家）；不设就取第一个
  const want = process.env.CF2_REAL_MODEL;
  const modelRows = card.locator('[data-testid^="model-row-"]');
  const firstRow = want
    ? modelRows.and(card.locator(`[data-model-id="${want}"]`)).first()
    : modelRows.first();
  await firstRow.waitFor({ state: 'visible', timeout: 120_000 });
  const modelId = (await firstRow.getAttribute('data-model-id')) ?? '';
  modelName = modelId;
  await firstRow.locator('input[type="checkbox"]').check();
  await card.getByTestId(/^provider-save-/).click();
  await page.waitForTimeout(500);
  // 按规格走 UI：先把「后台分析」也选成勾选过的模型，再选「聊天」，再点保存
  const pick = async (testId, label) => {
    const sel = page.getByTestId(testId);
    const labels = (await sel.locator('option').allTextContents()).map((s) => s.trim());
    const hit = labels.find((x) => x.includes(label));
    if (!hit)
      throw new Error(
        testId + ' 里没有 ' + label + '（有：' + labels.join(' / ').slice(0, 120) + '）',
      );
    await sel.selectOption({ label: hit });
  };
  await pick('uses-analysis', modelId);
  await pick('uses-chat', modelId);
  await page.getByTestId('uses-save').click();
  await page.waitForTimeout(800);
  const uses = await page.evaluate(async () => (await window.ixaeon.getSettings()).config.uses);
  if (!uses?.chat) throw new Error('UI 保存后 uses.chat 仍是空');

  // 新对话，按顺序问 8 句
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('conversation-new').click();
  await page.waitForTimeout(500);
  // 先确认聊天模型真的保存上了（否则直连起不来、点了也没反应）
  const settings = await page.evaluate(async () => (await window.ixaeon.getSettings()).config);
  console.log('聊天模型（保存后）：', settings.chatModelName || settings.modelName || '（空）');
  console.log('uses.chat：', JSON.stringify(settings.uses?.chat ?? null));
  await page.getByTestId('ask-input').waitFor({ state: 'visible', timeout: 20_000 });
  // 发送按钮只在这一轮还在答（busy）时是灰的
  const runReady = () => {
    const b = document.querySelector('[data-testid="ask-run"]');
    return Boolean(b) && !b.disabled;
  };
  for (const [i, q] of Q.entries()) {
    const before = await page.getByTestId('message-list').locator('article').count();
    await page.getByTestId('ask-input').fill(q);
    await page.getByTestId('ask-run').click();
    try {
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="message-list"] article').length >= n + 2,
        before,
        { timeout: 60_000 },
      );
      // 等这一轮真的答完（按钮回到可用状态）再问下一句
      await page.waitForFunction(runReady, undefined, { timeout: 300_000 });
    } catch {
      // 规格要求只贴计数：这里不输出任何界面正文
      throw new Error('第 ' + (i + 1) + ' 句没答完（超时；不输出回答内容）');
    }
    await page.waitForTimeout(500);
  }
  // 等 8 条助手消息都到终态（complete），再关应用统计
  const probe = new Database(join(dir, 'ixaeon.db'), { readonly: true });
  const deadline = Date.now() + 180_000;
  for (;;) {
    const done = probe
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND status = 'complete'",
      )
      .get().n;
    if (done >= 8 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const finalDone = probe
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND status = 'complete'")
    .get().n;
  // 只取状态计数（不读正文），失败时说明是哪种没完成
  const byStatus = probe
    .prepare("SELECT status, COUNT(*) AS n FROM messages WHERE role = 'assistant' GROUP BY status")
    .all()
    .map((r) => r.status + '=' + r.n)
    .join(' ');
  // 失败轮只报错误里的 HTTP 码 / 超时字样（不输出错误全文，免得带出地址等）
  const failKinds = probe
    .prepare(
      "SELECT error_message AS e FROM messages WHERE role = 'assistant' AND status = 'failed'",
    )
    .all()
    .map((r) => (String(r.e ?? '').match(/\b[45]\d\d\b|超时|timeout|轮次上限/i) ?? ['其它'])[0]);
  probe.close();
  await app.close();
  app = null;
  if (finalDone < 8)
    throw new Error(
      '8 句只完成了 ' +
        finalDone +
        ' 句（' +
        byStatus +
        (failKinds.length ? '；失败类别：' + failKinds.join(',') : '') +
        '）',
    );

  // 只读临时库数结果
  const db = new Database(join(dir, 'ixaeon.db'), { readonly: true });
  const todos = db.prepare('SELECT COUNT(*) AS n FROM todos').get().n;
  const userTodos = db.prepare("SELECT COUNT(*) AS n FROM todos WHERE origin = 'user'").get().n;
  const tasks = db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get().n;
  const rows = db.prepare("SELECT content, status FROM messages WHERE role = 'assistant'").all();
  const complete = rows.filter((r) => r.status === 'complete').length;
  const withSuggest = rows.filter((r) => String(r.content).includes('建议待办')).length;
  db.close();
  // 新临时库里只有这一个对话：助手消息必须恰好 8 条、全部 complete
  if (rows.length !== 8 || complete !== 8)
    throw new Error(
      '助手消息应恰好 8 条且全部完成，实际 ' + rows.length + ' 条、完成 ' + complete + ' 条',
    );

  console.log('用的模型：', modelName || '（没选上）');
  console.log('待办行数：', todos, '｜其中来源用户：', userTodos);
  console.log('编码任务行数：', tasks);
  console.log('完成的助手消息数（应为 8）：', complete, '｜助手消息总数：', rows.length);
  console.log('8 轮里回答正文含「建议待办」的轮数：', withSuggest);
  console.log('（临时目录已遮：' + mask('<临时目录>') + '）');
} finally {
  if (app) await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
