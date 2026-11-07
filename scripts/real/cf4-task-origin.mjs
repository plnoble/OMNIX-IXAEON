/**
 * CF4 真机检查：临时数据目录 + 本机假 OpenAI 网关（demo-a / sk-synthetic）。
 * 新对话问两句 → 在第 2 条回答下点「转成任务」→ 开始挪到第 1 句 → 填两条验收 → 建草案
 * → 任务页看来源。最后只读临时库输出计数（不打印任何对话原文、遮掉临时目录）。
 *   node scripts/real/cf4-task-origin.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron } = requireDesktop('playwright');
const Database = requireDesktop('better-sqlite3');

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf4-real-'));
const folder = mkdtempSync(join(tmpdir(), 'ixaeon-cf4-proj-'));

// 假网关：不打印请求正文，只回固定回答
const server = createServer((req, res) => {
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'demo-a' }] }));
    return;
  }
  const answer = '先做记一笔和列表两页。';
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n',
  );
  res.end();
});
const port = await new Promise((r) =>
  server.listen(0, '127.0.0.1', () => r(server.address().port)),
);

let app;
const mask = (s) => String(s).replaceAll(dir, '<临时目录>').replaceAll(folder, '<临时项目目录>');
try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir },
  });
  let page = await app.firstWindow();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目甲');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });

  // 项目绑文件夹要文件对话框票据，真机脚本里直接写库（等价于用户点「绑定文件夹」后授权）
  await app.close();
  app = null;
  const seed = new Database(join(dir, 'ixaeon.db'));
  const proj = seed.prepare("SELECT id FROM projects WHERE name = '合成项目甲'").get();
  seed.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(folder, proj.id);
  seed
    .prepare(
      "INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at) VALUES (?, 'folder', ?, 'continuous', 'active', ?)",
    )
    .run('perm-cf4-real', folder, new Date().toISOString());
  seed.close();
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });
  const setup = await page.evaluate(
    async ({ base }) => {
      const projects = await window.ixaeon.listProjects();
      const p = projects.find((x) => x.name === '合成项目甲') ?? projects[0];
      const prov = await window.ixaeon.saveModelProvider({
        name: '合成甲',
        kind: 'openai',
        apiBaseUrl: base,
        apiKey: 'sk-synthetic',
        savedModels: ['demo-a'],
      });
      await window.ixaeon.saveModelUses({ chat: { providerId: prov.id, model: 'demo-a' } });
      const uses = (await window.ixaeon.getSettings()).config.uses;
      return { projectId: p.id, ok: Boolean(uses?.chat) };
    },
    { base: `http://127.0.0.1:${port}/v1` },
  );
  if (!setup.ok) throw new Error('uses.chat 没存上');

  // 新对话问两句
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('conversation-new').click();
  await page.getByTestId('ask-input').waitFor({ state: 'visible', timeout: 20_000 });
  for (const q of ['帮我想想记账小程序要哪些页面', '那先做记一笔这页']) {
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="ask-run"]');
        return b && !b.disabled;
      },
      undefined,
      { timeout: 60_000 },
    );
    const before = await page.getByTestId('message-list').locator('article').count();
    await page.getByTestId('ask-input').fill(q);
    await page.getByTestId('ask-run').click();
    await page.waitForFunction(
      (n) => {
        const list = document.querySelectorAll('[data-testid="message-list"] article');
        const b = document.querySelector('[data-testid="ask-run"]');
        return list.length >= n + 2 && b && !b.disabled;
      },
      before,
      { timeout: 120_000 },
    );
  }
  // 第 2 条回答下点「转成任务」
  const answers = page.locator('[data-testid="message-item"][data-role="assistant"]');
  await answers.last().getByText('转成任务').click();
  await page.getByTestId('message-to-task-goal').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('message-to-task-from').selectOption({ index: 0 });
  await page.getByTestId('message-to-task-acceptance').fill('记一笔能保存\n列表能看到');
  const picker = page.getByTestId('message-to-task-project');
  if (await picker.count()) {
    await picker.selectOption({ label: '合成项目甲' }).catch(async () => {
      const opts = await picker.locator('option').all();
      if (opts.length > 1) await picker.selectOption({ index: 1 });
    });
  }
  await page.screenshot({ path: '.logs/cf4-form.png' });
  await page.getByTestId('message-to-task-submit').click();
  await page.getByTestId('message-to-task-submit').waitFor({ state: 'detached', timeout: 20_000 });

  // 任务页看来源
  await page
    .getByTestId('nav-tasks')
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(1200);
  const cardOrigin = (await page.getByTestId('page-tasks').innerText()).includes('来自对话');
  await page.screenshot({ path: '.logs/cf4-origin.png' });
  console.log('任务页显示「来自对话」：', cardOrigin);
  await app.close();
  app = null;

  const db = new Database(join(dir, 'ixaeon.db'), { readonly: true });
  const tasks = db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get().n;
  const withOrigin = db
    .prepare('SELECT COUNT(*) AS n FROM coding_tasks WHERE origin_conversation_id IS NOT NULL')
    .get().n;
  const row = db
    .prepare(
      'SELECT origin_from_seq, origin_to_seq, status FROM coding_tasks ORDER BY created_at DESC LIMIT 1',
    )
    .get();
  const convId = db
    .prepare('SELECT origin_conversation_id FROM coding_tasks ORDER BY created_at DESC LIMIT 1')
    .get().origin_conversation_id;
  const msgCount = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
    .get(convId).n;
  const audit = db
    .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'conversation.task_created'")
    .get().n;
  db.close();
  console.log('编码任务行数：', tasks, '｜有来源的：', withOrigin);
  console.log(
    '范围：',
    mask(String(row.origin_from_seq)) + '–' + row.origin_to_seq,
    '｜状态：',
    row.status,
  );
  console.log('对话消息条数：', msgCount, '｜审计 conversation.task_created：', audit);
} finally {
  if (app) await app.close().catch(() => undefined);
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
}
