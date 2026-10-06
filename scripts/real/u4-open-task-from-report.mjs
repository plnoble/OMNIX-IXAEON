/**
 * U4 真机检查：对话里的回报，点一下就到那条任务，改动已经展开。
 *
 *   node scripts/real/u4-open-task-from-report.mjs
 * （先构建桌面端：apps/desktop 下 electron-vite build）
 *
 * 照 scripts/real/d3-auto-dispatch.ts：临时数据目录、替身执行器（不调用真 Codex）。
 * 在临时库里造出项目对话、这一轮提问、任务草案和待办卡，在界面上点「要做」，
 * 等对话里出现回报之后：
 *   1. 点回报下面的按钮，打印：现在是哪个页面、哪条任务的改动展开了、列出几个文件。
 *   2. 回到对话再点一次，打印同样的东西。
 * 结果不对以非零码退出。不联网，不碰用户的数据。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const require = createRequire(join(desktopDir, 'package.json'));
const { _electron: electron } = require('@playwright/test');
const Database = require('better-sqlite3');

const work = mkdtempSync(join(tmpdir(), 'ixa-u4-real-'));
const dataDir = join(work, 'data');
const projectRoot = join(work, 'synth-repo');
mkdirSync(dataDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(dataDir, 'model-script.json'), JSON.stringify({ structured: [] }), 'utf8');
writeFileSync(join(projectRoot, 'note.txt'), '合成文件\n第二行\n');
writeFileSync(join(projectRoot, 'README.md'), '# 合成项目\n');
const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
git('init', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: join(dataDir, 'model-script.json'),
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
  IXAEON_CODEX_EXE: 'none',
};

let app = null;
let result = '没通过：脚本没跑完';
const fail = (why) => {
  throw new Error(why);
};

try {
  app = await electron.launch({ args: [join(desktopDir, 'out', 'main', 'index.js')], env });
  const page = await app.firstWindow();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('fake-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('U4 合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await app.close();
  app = null;

  const db = new Database(join(dataDir, 'ixaeon.db'));
  const now = new Date().toISOString();
  const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
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
  ).run(conversationId, project.id, 'U4 合成对话', now, now);
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
    '把 note.txt 改成一句话',
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
    '把 note.txt 改成一句话',
    '["note.txt"]',
    'u4-real',
    900000,
    now,
    now,
    runId,
    '["项目里的 note.txt 被改过"]',
  );
  db.prepare(
    `INSERT INTO todos
       (id, title, status, origin, conversation_id, message_id, linked_kind, linked_id,
        created_at, updated_at, decided_at, done_at)
     VALUES (?, ?, 'proposed', 'agent', ?, ?, 'coding_task', ?, ?, ?, NULL, NULL)`,
  ).run(todoId, '把 note.txt 改成一句话', conversationId, assistantMessageId, taskId, now, now);
  db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(
    JSON.stringify({ proposedTodos: [{ id: todoId, title: '把 note.txt 改成一句话' }] }),
    assistantMessageId,
  );
  db.close();

  app = await electron.launch({ args: [join(desktopDir, 'out', 'main', 'index.js')], env });
  const p2 = await app.firstWindow();
  await p2.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await p2.getByTestId('nav-ask').click();
  await p2.getByTestId('conversation-item').first().click();
  await p2.getByTestId(`todo-card-accept-${todoId}`).click();
  await p2.getByText('做完了，等你验收').waitFor({ timeout: 60_000 });

  const button = p2.getByTestId(`task-report-open-${taskId}`);
  await button.waitFor({ timeout: 10_000 });

  /** 点回报下面的按钮，等改动展开，打印页面、哪条展开了、列出几个文件。 */
  const openAndPrint = async (label) => {
    await button.click();
    await p2.getByTestId('page-tasks').waitFor({ timeout: 10_000 });
    const box = p2.getByTestId(`task-changes-${taskId}`);
    await box.waitFor({ timeout: 10_000 });
    await p2.waitForFunction(
      ([tid]) => {
        const el = document.querySelector(`[data-testid="${tid}"]`);
        if (!el) return false;
        const text = el.textContent ?? '';
        return text.length > 0 && !text.includes('加载中');
      },
      [`task-changes-${taskId}`],
      { timeout: 10_000 },
    );
    const pageName = (await p2.getByTestId('page-tasks').count()) === 1 ? '任务' : '不是任务页';
    const paths = (await box.locator('strong').allInnerTexts())
      .map((s) => s.trim())
      .filter(Boolean);
    console.log(`--- ${label} ---`);
    console.log('现在的页面：', pageName);
    console.log('改动展开的任务：', taskId);
    console.log('列出文件：', paths.length, paths.join('、') || '（没有）');
    if (pageName !== '任务') fail(`${label}：没有切到任务页`);
    if (!paths.includes('note.txt')) fail(`${label}：改动没展开，或没列出 note.txt`);
    return paths.length;
  };

  const first = await openAndPrint('第一次点按钮');
  if (first < 1) fail('第一次：一个文件都没列出来');

  // 问答页切走再回来会卸掉：左边点「问答」是照常打开，不自动回到刚才那条对话。
  await p2.getByTestId('nav-ask').click();
  await p2.getByTestId('conversation-item').first().click();
  await button.waitFor({ timeout: 10_000 });
  const second = await openAndPrint('回到对话再点一次');
  if (second < 1) fail('第二次：一个文件都没列出来');

  result = `通过：两次都切到任务页，任务 ${taskId} 的改动展开，列出 note.txt`;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('脚本出错：', msg);
  result = `没通过：${msg}`;
} finally {
  if (app) await app.close().catch(() => undefined);
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (existsSync(work)) console.log('临时目录没删干净：', work);
}
console.log('RESULT', result);
process.exit(result.startsWith('通过') ? 0 : 1);
