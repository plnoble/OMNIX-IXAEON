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
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  test('选「我的模型」→保存→重开还在；任务页建草案→批准→派发，执行器是我的模型，副本真被改', async () => {
    // ===== 首次启动：向导 + 设置模型清单 + 编码任务交给谁 =====
    let { app, page } = await launch();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill(SAVED_MODEL);
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('E2E 项目');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    // MP2b：模型接入搬到「模型」页
    await page.getByTestId('nav-models').click();
    await expect(page.getByTestId('models-page')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('provider-base-input-default').fill(upstreamBase);
    await page.getByTestId('provider-key-input-default').fill('sk-e2e');
    await page.getByTestId('provider-models-default').click();
    await expect(page.getByTestId(`model-row-${SAVED_MODEL}`)).toBeVisible({ timeout: 20_000 });
    await page.locator(`[data-testid="model-row-${SAVED_MODEL}"] input[type="checkbox"]`).check();
    await page.getByTestId('provider-save-default').click();
    await expect(page.locator('.ok-banner')).toContainText('已保存', { timeout: 15_000 });
    // 编码任务交给谁：我的模型
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-coding')).toBeVisible({ timeout: 20_000 });
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
    // 项目根目录的读取授权（绑定文件夹时会发的那一条；P6 之后没有它派不了任务）
    db.prepare(
      `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
       VALUES (?, 'folder', ?, 'continuous', 'active', ?, NULL)`,
    ).run(randomUUID(), projectRoot, new Date().toISOString());
    db.close();
    // 编码执行器的假模型剧本（CF3c 起聊天走独立剧本；这里只留执行器要的那一段）
    writeFileSync(
      scriptPath,
      JSON.stringify({
        structured: [
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

    // ===== 重开：设置记住了选择 =====
    ({ app, page } = await launch());
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-coding')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('settings-coding-model')).toHaveValue(SAVED_MODEL);

    // ===== 整条走任务页：创建草案 → 批准并排队 → 派发（我的模型）=====
    const GOAL = '在 README.md 末尾加一行「D7b e2e 加的一行」';
    const createDraft = async (goal: string) => {
      await page.getByTestId('nav-tasks').click();
      await expect(page.getByTestId('page-tasks')).toBeVisible({ timeout: 20_000 });
      const form = page.locator('section.card', { hasText: '新建草案' });
      await page.getByTestId('task-goal').fill(goal);
      await form.locator('input').nth(1).fill('README.md');
      await page.getByTestId('task-verify').fill('node -e "process.exit(0)"');
      await form.getByRole('button', { name: '创建草案' }).click();
      const card = page.locator('section.card', { hasText: goal }).last();
      await expect(card).toBeVisible({ timeout: 20_000 });
      return card;
    };

    const first = await createDraft(GOAL);
    await first.getByRole('button', { name: '批准并排队' }).click();
    await expect(first).toContainText('排队', { timeout: 20_000 });
    await first.getByRole('button', { name: '派发（我的模型）' }).click();
    // 执行器是我的模型（原来「对话里出现回报写着我的模型」那一句，改看任务卡上同样的信息）
    await expect(first).toContainText('执行器 我的模型（e2e-model）', { timeout: 60_000 });
    // 原来「等你验收」那句：任务页同一状态
    await expect(first).toContainText('待用户接受', { timeout: 60_000 });

    // 副本里的 README 真的被改了；真实项目里的那份没动
    const rows = await page.evaluate(async () => {
      const { tasks } = await window.ixaeon!.listCodingTasks();
      return tasks.map((t) => ({ status: t.status, workspace: t.workspace_path ?? '' }));
    });
    const done = rows.find((r) => r.status === 'pending_accept' && r.workspace.length > 0);
    expect(done).toBeTruthy();
    expect(readFileSync(join(done!.workspace, 'README.md'), 'utf8')).toContain('D7b e2e 加的一行');
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe('# 合成项目\n');

    // ===== 清空「我的模型」的模型选择后再点派发：停在排队，并写明缺什么、去哪设置 =====
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-coding')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('settings-coding-model').selectOption('');
    await page.getByTestId('settings-coding-save').click();
    await expect(page.locator('.ok-banner')).toContainText('编码任务交给谁已保存', {
      timeout: 15_000,
    });

    const second = await createDraft('清空设置后再次创建的任务');
    await second.getByRole('button', { name: '批准并排队' }).click();
    await expect(second).toContainText('排队', { timeout: 20_000 });
    await second.getByRole('button', { name: '派发（我的模型）' }).click();
    // 派发被拒：任务还在排队，页面写明缺什么、去哪设置
    // （原来「对话里回报停在排队里 / 编码任务交给谁」那两句，改看任务页同样的信息）
    await expect(second).toContainText('排队', { timeout: 20_000 });
    await expect(page.getByTestId('page-tasks')).toContainText('编码任务交给谁', {
      timeout: 20_000,
    });
    await app.close();
  });
});
