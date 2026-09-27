/**
 * D3 真机检查（合成数据）：临时数据目录启动应用，用执行器替身（不调用真 Codex）。
 * 在库里造一个项目对话、一轮提问、一个编码任务草案和它的待办卡，
 * 然后在界面上点「要做」，看任务自动开始、对话里出现回报。
 *   node_modules/.bin/jiti scripts/real/d3-auto-dispatch.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) throw new Error('no _electron');
const Database = require(require.resolve('better-sqlite3', { paths: [desktopDir, root] }));

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-d3-real-'));
writeFileSync(join(dataDir, 'model-script.json'), JSON.stringify({ structured: [] }), 'utf8');
console.log('DATA_DIR', dataDir);

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: join(dataDir, 'model-script.json'),
  // 不找真 Hermes、不找真 Codex：执行器用替身
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
  IXAEON_CODEX_EXE: 'none',
};

const app = await electron.launch({ args: [join(desktopDir, 'out', 'main', 'index.js')], env });
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.getByTestId('setup-next-1').click();
await page.getByTestId('setup-model-name').fill('fake-model');
await page.getByTestId('setup-next-2').click();
await page.getByTestId('setup-project-name').fill('D3 合成项目');
await page.getByTestId('setup-finish').click();
await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await app.close();

// 应用关着时往库里塞合成数据：项目对话、一轮提问、编码任务草案、待办卡
const db = new Database(join(dataDir, 'ixaeon.db'));
const now = new Date().toISOString();
const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
const projectRoot = join(dataDir, 'project');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(projectRoot, 'note.txt'), '合成文件');
db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, project.id);

const conversationId = randomUUID();
const userMessageId = randomUUID();
const assistantMessageId = randomUUID();
const runId = randomUUID();
const taskId = randomUUID();
const todoId = randomUUID();
db.prepare(
  `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?)`,
).run(conversationId, project.id, 'D3 合成对话', now, now);
const insertMessage = db.prepare(
  `INSERT INTO messages
     (id, conversation_id, seq, role, content, status, created_at, updated_at,
      run_id, engine, model_name, citations_json, meta_json, error_message)
   VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, NULL, NULL, '[]', '{}', NULL)`,
);
insertMessage.run(
  userMessageId,
  conversationId,
  1,
  'user',
  '在这个项目里加一个 hello.txt',
  now,
  now,
  null,
);
insertMessage.run(
  assistantMessageId,
  conversationId,
  2,
  'assistant',
  '好，我提了一个编码任务草案，等你点「要做」。',
  now,
  now,
  runId,
);
db.prepare(
  `INSERT INTO coding_tasks (
     id, project_id, goal, scope_json, workspace_path, snapshot_ref, context_digest,
     allowed_commands_json, timeout_ms, status, version, approval_id, dispatch_key,
     generation, executor_name, executor_report_json, verify_status, verify_exit_code,
     verify_output, tests_modified, accepted_at, error, created_at, updated_at, origin_run_id,
     acceptance_json
   ) VALUES (?, ?, ?, ?, NULL, NULL, ?, '[]', ?, 'draft', 1, NULL, NULL,
             0, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?)`,
).run(
  taskId,
  project.id,
  '加一个 hello.txt，写上你好',
  '["note.txt"]',
  'd3-real',
  900000,
  now,
  now,
  runId,
  '["项目里有 hello.txt"]',
);
db.prepare(
  `INSERT INTO todos
     (id, title, status, origin, conversation_id, message_id, linked_kind, linked_id,
      created_at, updated_at, decided_at, done_at)
   VALUES (?, ?, 'proposed', 'agent', ?, ?, 'coding_task', ?, ?, ?, NULL, NULL)`,
).run(todoId, '加一个 hello.txt，写上你好', conversationId, assistantMessageId, taskId, now, now);
// 回答消息上挂待办卡
db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(
  JSON.stringify({ proposedTodos: [{ id: todoId, title: '加一个 hello.txt，写上你好' }] }),
  assistantMessageId,
);
db.close();

const second = await electron.launch({ args: [join(desktopDir, 'out', 'main', 'index.js')], env });
const p2 = await second.firstWindow();
await p2.waitForLoadState('domcontentloaded');
await p2.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await p2.getByTestId('nav-ask').click();
await p2.getByTestId('conversation-item').first().click();
await p2.getByTestId(`todo-card-accept-${todoId}`).click();

// 等回报出现在打开的对话里（窗口收到事件后重新读这一条）
await p2.getByText('做完了，等你验收').waitFor({ timeout: 30_000 });
const answer = await p2.getByTestId('ask-answer').last().innerText();
console.log('REPORT');
console.log(answer.replace(/\s+/g, ' ').slice(0, 400));

const db2 = new Database(join(dataDir, 'ixaeon.db'), { readonly: true });
const task = db2
  .prepare('SELECT status, executor_name FROM coding_tasks WHERE id = ?')
  .get(taskId) as {
  status: string;
  executor_name: string | null;
};
console.log('TASK_STATUS', task.status);
console.log('EXECUTOR', task.executor_name);
const report = db2
  .prepare("SELECT content FROM messages WHERE json_extract(meta_json, '$.kind') = 'task_report'")
  .get() as { content: string } | undefined;
console.log('REPORT_IN_DB');
console.log(report?.content ?? '无');
db2.close();
await second.close();
rmSync(dataDir, { recursive: true, force: true });
