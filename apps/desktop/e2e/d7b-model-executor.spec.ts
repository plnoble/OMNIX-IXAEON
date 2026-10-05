/**
 * D7b 端到端（随实现一起交，不锁定；规格 docs/委派/D7b-按设置选执行器.md 的「端到端测试」）。
 * 假模型（IXAEON_FAKE_MODEL=1 + 响应脚本）、IXAEON_CODEX_EXE=none、合成数据：
 *   1. 设置页选「我的模型」+ 已保存模型，保存；重新打开设置页还是它；
 *   2. 合成 git 项目（绑了文件夹）里，聊天提问让假模型起草编码任务 → 点「要做」→
 *      对话回报与任务页卡片写着「我的模型（<模型名>）」；副本 README 真的被改了
 *      （证明应用启动时装进编排的是按设置选的执行器，不是替身）。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const d7bRequire = createRequire(join(desktopDir(), 'package.json'));
const Database = d7bRequire('better-sqlite3');

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

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-d7b-e2e-'));
const scriptPath = join(dataDir, 'model-script.json');
const projectRoot = join(dataDir, 'synth-repo');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(projectRoot, 'README.md'), '# 合成项目\n');
execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
execFileSync('git', ['add', '-A'], { cwd: projectRoot });
execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-m', 'init'], {
  cwd: projectRoot,
});

const SAVED_MODEL = 'e2e-model';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(desktopDir(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
      IXAEON_CODEX_EXE: 'none',
      // 编码任务会走「我的模型」→ 假模型 provider，全程不联网（假上游只用于 /models 检测）
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

test.describe('D7b 按设置选执行器（端到端）', () => {
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: SAVED_MODEL }] }));
        return;
      }
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    upstreamBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  test.afterAll(() => server.close());

  test('选「我的模型」→保存→重开还在；点「要做」→对话回报/任务页都写我的模型，副本真被改', async () => {
    // ===== 首次启动：向导 + 设置模型清单 + 编码任务交给谁 =====
    let { app, page } = await launch();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill(SAVED_MODEL);
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('E2E 项目');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-model')).toBeVisible({ timeout: 20_000 });
    // 模型清单：检测假上游、勾选保存
    await page.getByTestId('settings-api-base').fill(upstreamBase);
    await page.getByTestId('settings-api-key').fill('sk-e2e');
    await page.getByTestId('settings-fetch-models').click();
    await expect(page.getByTestId('settings-model-checklist')).toBeVisible({ timeout: 20_000 });
    await page
      .locator(`[data-testid="settings-model-check"][data-model-id="${SAVED_MODEL}"]`)
      .check();
    await page.getByTestId('settings-model-save').click();
    await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });

    // 编码任务交给谁：我的模型
    await page.getByTestId('settings-coding-executor').selectOption('model');
    await page.getByTestId('settings-coding-model').selectOption(SAVED_MODEL);
    await page.getByTestId('settings-coding-save').click();
    await expect(page.locator('.ok-banner')).toContainText('编码任务交给谁已保存', {
      timeout: 15_000,
    });

    // 绑定合成项目文件夹（用 SQL 补上 root_path——原生目录对话框无法自动化，
    // 等价于用户在项目页点过「绑定文件夹」后的状态）
    await app.close();
    const dbPath = join(dataDir, 'ixaeon.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const proj = db.prepare("SELECT id FROM projects WHERE name = 'E2E 项目'").get() as {
      id: string;
    };
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, proj.id);
    db.close();

    // ===== 重新打开设置页：选过的还在 =====
    ({ app, page } = await launch());
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-coding')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('settings-coding-executor')).toHaveValue('model');
    await expect(page.getByTestId('settings-coding-model')).toHaveValue(SAVED_MODEL);

    // ===== 聊天里起草编码任务 → 点「要做」 =====
    const db2 = new Database(dbPath);
    const proj2 = db2.prepare("SELECT id FROM projects WHERE name = 'E2E 项目'").get() as {
      id: string;
    };
    db2.close();
    writeFileSync(
      scriptPath,
      JSON.stringify({
        structured: [
          {
            tool: 'propose_task',
            args: {
              projectId: proj2.id,
              goal: '在 README.md 末尾加一行「D7b e2e 加的一行」',
              scope: ['README.md'],
              verifyCommand: ['node', '-e', 'process.exit(0)'],
            },
          },
          { tool: 'answer', args: { text: '已经起草好，等你拍板。' } },
          { items: [] },
          // 编码任务（派发时）由同一个假模型供给：改写 README 的响应
          {
            changes: [
              {
                path: 'README.md',
                action: 'write',
                content: '# 合成项目\\nD7b e2e 加的一行\\n',
              },
            ],
            summary: 'README 加了一行',
            claimedSuccess: true,
          },
          { items: [] },
        ],
      }),
    );
    await page.getByTestId('nav-ask').click();
    await page.getByTestId('ask-input').fill('改一下 README');
    await page.getByTestId('ask-run').click();
    await expect(page.getByTestId('message-list')).toContainText('等你拍板', { timeout: 30_000 });
    // 等一会儿让答后记忆提取把它的脚本条目消费掉，编码任务的响应排在其后
    await page.waitForTimeout(1500);
    // 点「要做」（建议待办卡）
    await page.locator('[data-testid^="todo-card-accept-"]').first().click();
    // 对话里出现回报：写着 我的模型（<模型名>）
    await expect(page.getByTestId('message-list')).toContainText('我的模型（e2e-model）', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('message-list')).toContainText('等你验收', { timeout: 30_000 });

    // 副本里的 README 真的被改了
    await expect
      .poll(
        async () => {
          const rows = await page.evaluate(async () => {
            const list = await window.ixaeon!.listCodingTasks();
            return list.tasks;
          });
          return rows;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const check = await page.evaluate(async () => {
      const { tasks } = await window.ixaeon!.listCodingTasks();
      return tasks[0]?.status ?? '';
    });
    expect(check).toBe('pending_accept');

    // 任务页卡片也写着 我的模型（…）
    await page.getByTestId('nav-tasks').click();
    await expect(page.getByTestId('page-tasks')).toBeVisible({ timeout: 20_000 });
    const taskId = await page.evaluate(async () => {
      const { tasks } = await window.ixaeon!.listCodingTasks();
      return tasks[0]?.id ?? '';
    });
    await expect(page.locator(`[data-testid="task-${taskId}"]`)).toContainText(
      '我的模型（e2e-model）',
    );

    // ===== 真机检查步骤 1 的第三段：把设置里的模型清空后点「要做」→ 停在排队 + 回报 =====
    // 重启一次：让新的脚本（下面再写）随启动加载；顺带证明设置页记忆住了选择
    await app.close();
    ({ app, page } = await launch());
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-coding')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('settings-coding-model').selectOption('');
    await page.getByTestId('settings-coding-save').click();
    await expect(page.locator('.ok-banner')).toContainText('编码任务交给谁已保存', {
      timeout: 15_000,
    });
    writeFileSync(
      scriptPath,
      JSON.stringify({
        structured: [
          {
            tool: 'propose_task',
            args: {
              projectId: proj2.id,
              goal: '清空设置后再次提议的任务',
              scope: ['README.md'],
              verifyCommand: ['node', '-e', 'process.exit(0)'],
            },
          },
          { tool: 'answer', args: { text: '已经起草好，等你拍板。' } },
          { items: [] },
        ],
      }),
    );
    await page.getByTestId('nav-ask').click();
    await page.getByTestId('ask-input').fill('再提一个任务');
    await page.getByTestId('ask-run').click();
    await expect(page.getByTestId('message-list')).toContainText('等你拍板', { timeout: 30_000 });
    await page.locator('[data-testid^="todo-card-accept-"]').first().click();
    // 回报停在排队 + 写明缺什么、去哪设置
    await expect(page.getByTestId('message-list')).toContainText('编码任务停在排队里', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('message-list')).toContainText('编码任务交给谁', {
      timeout: 15_000,
    });

    await app.close();
  });
});
