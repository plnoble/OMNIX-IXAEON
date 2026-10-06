/**
 * D5a 端到端（随实现一起交，不锁定；规格 docs/委派/D5a-验收先行-先写测试再写实现.md）。
 * 假模型加响应脚本（两次：先写测试的、再写实现的）、IXAEON_CODEX_EXE=none、
 * 设置里选「我的模型」、合成的小 git 项目（calc.mjs 只有 add）。
 * 带验收条件的任务造不出来（假模型的 propose_task 带验证命令）：照
 * scripts/real/d3-auto-dispatch.ts 的做法直接写进临时库，再在界面上点「要做」。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const d5aRequire = createRequire(join(process.cwd(), 'package.json'));
const Database = d5aRequire('better-sqlite3');

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

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-d5a-e2e-'));
const scriptPath = join(dataDir, 'model-script.json');
const projectRoot = join(dataDir, 'synth-repo');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(projectRoot, 'calc.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
execFileSync('git', ['add', '-A'], { cwd: projectRoot });
execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'init'], {
  cwd: projectRoot,
});

const MODEL = 'e2e-model';
const HEAD = `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`;
const MUL_TEST = `${HEAD}test('条件 1：multiply(2, 3) 等于 6', async () => {\n  const calc = await import('../../calc.mjs');\n  assert.equal(calc.multiply(2, 3), 6);\n});\n`;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(desktopDir(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
      IXAEON_CODEX_EXE: 'none',
      HERMES_HOME: '',
      IXAEON_HERMES_HOME: '',
      IXAEON_HERMES_EXE: '',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

let server: Server;
let upstreamBase = '';

test.describe('D5a 验收先行（端到端）', () => {
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    upstreamBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  test.afterAll(() => server.close());

  test('带验收条件的任务：先写测试再写实现，回报「验证通过」，接受后分支里两样都有', async () => {
    // ===== 第一段：向导 + 模型清单 + 编码任务交给「我的模型」 =====
    let { app, page } = await launch();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill(MODEL);
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('E2E 项目');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-model')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('settings-api-base').fill(upstreamBase);
    await page.getByTestId('settings-api-key').fill('sk-e2e');
    await page.getByTestId('settings-fetch-models').click();
    await expect(page.getByTestId('settings-model-checklist')).toBeVisible({ timeout: 20_000 });
    await page.locator(`[data-testid="settings-model-check"][data-model-id="${MODEL}"]`).check();
    await page.getByTestId('settings-model-save').click();
    await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });
    await page.getByTestId('settings-coding-executor').selectOption('model');
    await page.getByTestId('settings-coding-model').selectOption(MODEL);
    await page.getByTestId('settings-coding-save').click();
    await expect(page.locator('.ok-banner')).toContainText('编码任务交给谁已保存', {
      timeout: 15_000,
    });
    await app.close();

    // ===== 直写临时库：项目绑目录 + 带验收条件（无验证命令）的任务 + 待办卡 =====
    const dbPath = join(dataDir, 'ixaeon.db');
    const db = new Database(dbPath);
    const proj = db.prepare("SELECT id FROM projects WHERE name = 'E2E 项目'").get() as {
      id: string;
    };
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, proj.id);
    // 项目根目录的读取授权（等价于用户在项目页点过「绑定文件夹」后的授权行）
    db.prepare(
      `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
       VALUES (?, 'folder', ?, 'continuous', 'active', ?, NULL)`,
    ).run(randomUUID(), projectRoot, new Date().toISOString());
    const now = new Date().toISOString();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const runId = randomUUID();
    const taskId = randomUUID();
    const todoId = randomUUID();
    db.prepare(
      `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(conversationId, proj.id, 'D5a E2E 对话', now, now);
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
      '给 calc.mjs 加个乘法',
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
      proj.id,
      '给 calc.mjs 加一个 multiply(a, b)',
      '["calc.mjs"]',
      'd5a-e2e',
      900000,
      now,
      now,
      runId,
      '["multiply(2, 3) 等于 6", "原来的 add 不变"]',
    );
    db.prepare(
      `INSERT INTO todos
         (id, title, status, origin, conversation_id, message_id, linked_kind, linked_id,
          created_at, updated_at, decided_at, done_at)
       VALUES (?, ?, 'proposed', 'agent', ?, ?, 'coding_task', ?, ?, ?, NULL, NULL)`,
    ).run(
      todoId,
      '给 calc.mjs 加一个 multiply(a, b)',
      conversationId,
      assistantMessageId,
      taskId,
      now,
      now,
    );
    db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(
      JSON.stringify({
        proposedTodos: [{ id: todoId, title: '给 calc.mjs 加一个 multiply(a, b)' }],
      }),
      assistantMessageId,
    );
    db.close();

    // ===== 第二段：假模型给两步的响应（先写测试、再写实现），点「要做」 =====
    const testDir = `ixaeon-acceptance/${taskId.slice(0, 8)}`;
    writeFileSync(
      scriptPath,
      JSON.stringify({
        structured: [
          // 第 1 步：写测试（结构化响应按 ModelCodingExecutor 的 schema）
          {
            changes: [{ path: `${testDir}/mul.test.mjs`, action: 'write', content: MUL_TEST }],
            summary: '写了一个测试',
            claimedSuccess: true,
          },
          // 第 2 步：写实现
          {
            changes: [
              {
                path: 'calc.mjs',
                action: 'write',
                content:
                  'export function add(a, b) {\n  return a + b;\n}\nexport function multiply(a, b) {\n  return a * b;\n}\n',
              },
            ],
            summary: '加了 multiply',
            claimedSuccess: true,
          },
        ],
      }),
      'utf8',
    );
    ({ app, page } = await launch());
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nav-ask').click();
    await expect(page.getByTestId('page-ask')).toBeVisible({ timeout: 20_000 });
    // 打开任务所在的对话，待办卡挂在它的回答消息上
    await page.locator('[data-testid="conversation-item"]').first().click();
    await page.getByTestId(`todo-card-accept-${todoId}`).click();
    // 对话里的回报写「验证通过」
    await expect(page.getByTestId('message-list')).toContainText('做完了，等你验收', {
      timeout: 120_000,
    });
    await expect(page.getByTestId('message-list')).toContainText('验证通过', { timeout: 15_000 });
    await expect(page.getByTestId('message-list')).toContainText('我的模型（e2e-model）', {
      timeout: 15_000,
    });

    // 任务页显示「独立验证 passed」
    await page.getByTestId('nav-tasks').click();
    await expect(page.getByTestId('page-tasks')).toBeVisible({ timeout: 20_000 });
    const taskCard = page.locator(`[data-testid="task-${taskId}"]`);
    await expect(taskCard).toContainText('独立验证 passed', { timeout: 20_000 });

    // 副本里测试文件和实现都在（等条件成立，不 sleep）
    await expect
      .poll(
        async () => {
          const db2 = new Database(dbPath);
          const r = db2
            .prepare('SELECT status, verify_status, workspace_path FROM coding_tasks WHERE id = ?')
            .get(taskId) as { status: string; verify_status: string; workspace_path: string };
          db2.close();
          return r;
        },
        { timeout: 30_000 },
      )
      .toMatchObject({ status: 'pending_accept', verify_status: 'passed' });
    const db3 = new Database(dbPath);
    const wsRow = db3
      .prepare('SELECT workspace_path FROM coding_tasks WHERE id = ?')
      .get(taskId) as { workspace_path: string };
    db3.close();
    expect(existsSync(join(wsRow.workspace_path, testDir, 'mul.test.mjs'))).toBe(true);
    expect(readFileSync(join(wsRow.workspace_path, 'calc.mjs'), 'utf8')).toContain('multiply');

    // 接受：分支里有测试文件和实现
    await taskCard.getByRole('button', { name: '接受' }).click();
    // accept 先标 completed 再落地（建分支）；要等 applied_ref 写上，别在中间读
    await expect
      .poll(
        async () => {
          const db4 = new Database(dbPath);
          const r = db4
            .prepare('SELECT status, applied_ref, apply_error FROM coding_tasks WHERE id = ?')
            .get(taskId) as { status: string; applied_ref: string | null };
          db4.close();
          return r.status === 'completed' && r.applied_ref !== null ? 'landed' : 'pending';
        },
        { timeout: 30_000 },
      )
      .toBe('landed');
    const db5 = new Database(dbPath);
    const applied = db5
      .prepare(
        'SELECT applied_ref, apply_error, status, executor_report_json FROM coding_tasks WHERE id = ?',
      )
      .get(taskId) as {
      applied_ref: string | null;
      apply_error: string | null;
      status: string;
      executor_report_json: string | null;
    };
    db5.close();
    const rep = JSON.parse(applied.executor_report_json ?? '{}') as Record<string, unknown>;
    console.log(
      '[d5a-landing]',
      JSON.stringify({
        applied_ref: applied.applied_ref,
        apply_error: applied.apply_error,
        status: applied.status,
        changedPaths: rep.changedPaths,
        acceptanceTests: rep.acceptanceTests,
      }),
    );
    expect(applied.applied_ref).toMatch(/^ixaeon\//);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
    const files = git('diff', '--name-only', 'main', applied.applied_ref!).split('\n');
    expect(files).toContain('calc.mjs');
    expect(files.some((f) => f.startsWith('ixaeon-acceptance/'))).toBe(true);

    await app.close();
  });
});
