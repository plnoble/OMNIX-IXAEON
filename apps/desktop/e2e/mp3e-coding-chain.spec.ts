/**
 * MP3e 验收条件 15（端到端）：合成数据目录、两个假开发工具。
 *
 * - 假 Codex：输出 `usage_limit_reached` 后退出；假 Claude Code：在工作区写一个文件，
 *   输出 `{"result":"done","is_error":false}`；
 * - 在「模型」页手填两个假工具的位置，编码任务排「Codex → Claude Code」，保存；
 * - 在任务页派发一单：回报里有「「Codex」这次不行（额度用完），由替补「Claude Code · sonnet」来做」，
 *   改动是假 Claude Code 写的那个文件。
 *
 * 现在实现还没做（开发工具、编码任务替补列表都没有），本文件应当红。
 */
import { createServer, type Server } from 'node:http';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { buildFakeTool } from './helpers/fake-tool.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const desktopMain = resolve(process.cwd(), 'out', 'main', 'index.js');
const dataDir = mkdtempSync(join(tmpdir(), 'ixa-mp3e-e2e-'));
const projectRoot = join(dataDir, 'synth-repo');
const tools = join(dataDir, 'tools');

/** 假 Codex：只输出额度用完，失败退出（整合方 11-05：原来退出 0，那是成功，正确的实现不会换）。 */
function fakeCodex(): string {
  return buildFakeTool(tools, 'codex', { stdout: ['usage_limit_reached'], exitCode: 1 });
}

/** 假 Claude Code：在工作区写 note.txt，输出 JSON。 */
function fakeClaude(): string {
  return buildFakeTool(tools, 'claude', {
    stdout: ['{"result":"done","is_error":false}'],
    writeFiles: [{ path: 'note.txt', content: 'done\n' }],
    exitCode: 0,
  });
}

const MODE =
  process.env.MP3E_CHAIN === 'dsh'
    ? 'dsh'
    : process.env.MP3E_CHAIN === 'provider'
      ? 'provider'
      : 'claude';
let server: Server | null = null;
let providerBase = '';
const SECOND_LABEL =
  MODE === 'dsh' ? 'DSH' : MODE === 'provider' ? '合成甲 · demo-a' : 'Claude Code · sonnet';

/** 假 DSH：安装目录里放真的 exe，输出一行 final；返回的是「安装目录」（不是 exe 路径）。 */
function fakeDsh(): string {
  const install = join(dataDir, 'dsh-install');
  mkdirSync(
    join(
      install,
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
    ),
    {
      recursive: true,
    },
  );
  buildFakeTool(install, 'DeepSeek Harness', {
    stdout: ['{"type":"final","text":"DSH done"}'],
    writeFiles: [{ path: 'note.txt', content: 'done\n' }],
    exitCode: 0,
  });
  return install;
}

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  mkdirSync(tools, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), '# 合成项目\n', 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
  execFileSync('git', ['add', '-A'], { cwd: projectRoot });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'init'], {
    cwd: projectRoot,
  });

  if (MODE === 'provider') {
    const answer = {
      changes: [{ path: 'note.txt', action: 'write', content: 'done\n' }],
      summary: '供应商做的',
      claimedSuccess: true,
    };
    server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'demo-a' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const text = JSON.stringify(answer);
      res.end(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          output_text: text,
          output: [{ content: [{ type: 'output_text', text }] }],
        }),
      );
    });
    const port = await new Promise<number>((r) =>
      server!.listen(0, '127.0.0.1', () => r((server!.address() as { port: number }).port)),
    );
    providerBase = `http://127.0.0.1:${port}/v1`;
  }
  app = await electron.launch({
    args: [desktopMain],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir, IXAEON_CODEX_EXE: 'none' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  server?.close();
});

test('条件 15：Codex → Claude Code，回报写着替补来做，改动是 Claude 写的', async () => {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('E2E 项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

  // 绑定合成项目文件夹（原生目录对话框无法自动化，SQL 补上，等价于点过「绑定文件夹」）
  await app.close();
  const Database = createRequire(join(process.cwd(), 'package.json'))('better-sqlite3');
  const db = new Database(join(dataDir, 'ixaeon.db'));
  const proj = db.prepare("SELECT id FROM projects WHERE name = 'E2E 项目'").get() as {
    id: string;
  };
  db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, proj.id);
  db.prepare(
    `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
     VALUES (?, 'folder', ?, 'continuous', 'active', ?, NULL)`,
  ).run(randomUUID(), projectRoot, new Date().toISOString());
  db.close();

  app = await electron.launch({
    args: [desktopMain],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir, IXAEON_CODEX_EXE: 'none' },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

  // 「模型」页
  await page.getByTestId('nav-models').click();
  await page.getByTestId('devtool-path-codex').fill(fakeCodex());
  await page.getByTestId('devtool-save-codex').click();
  if (MODE === 'dsh') {
    await page.getByTestId('devtool-path-dsh').fill(fakeDsh());
    await page.getByTestId('devtool-save-dsh').click();
  } else if (MODE === 'claude') {
    await page.getByTestId('devtool-path-claude').fill(fakeClaude());
    await page.getByTestId('devtool-save-claude').click();
  } else {
    await page.getByTestId('provider-add-name').fill('合成甲');
    await page.getByTestId('provider-add-base').fill(providerBase);
    await page.getByTestId('provider-add-key').fill('sk-synthetic');
    await page.getByTestId('provider-add-save').click();
    const pcard = page
      .locator('[data-testid^="provider-card-"]')
      .filter({ hasText: '合成甲' })
      .last();
    await pcard.waitFor({ state: 'visible', timeout: 20_000 });
    await pcard.getByTestId(/^provider-models-/).click();
    await pcard.getByTestId('model-row-demo-a').waitFor({ state: 'visible', timeout: 20_000 });
    await pcard.getByTestId('model-row-demo-a').locator('input[type="checkbox"]').check();
    await pcard.getByTestId(/^provider-save-/).click();
  }

  // 编码任务排「Codex → Claude Code · sonnet」
  const addBox = page.getByTestId('coding-chain-add');
  await page.getByTestId('coding-chain-kind').selectOption({ label: '开发工具' });
  await page.getByTestId('coding-chain-tool').selectOption({ label: 'Codex' });
  await addBox.getByRole('button', { name: '添加' }).click();
  if (MODE === 'dsh') {
    await page.getByTestId('coding-chain-tool').selectOption({ label: 'DSH' });
  } else if (MODE === 'provider') {
    await page.getByTestId('coding-chain-kind').selectOption({ label: '供应商' });
    await page.getByTestId('coding-chain-provider').selectOption({ label: '合成甲 · demo-a' });
  } else {
    await page.getByTestId('coding-chain-tool').selectOption({ label: 'Claude Code' });
    await page.getByTestId('coding-chain-claude-model').selectOption({ label: 'sonnet' });
  }
  await addBox.getByRole('button', { name: '添加' }).click();
  await expect(page.getByTestId('coding-chain-list')).toContainText(SECOND_LABEL);
  await page.waitForTimeout(300);
  await page.getByTestId('uses-save').click();
  await page.waitForTimeout(300);

  // 任务页：建草案 → 批准 → 派发
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('task-goal').fill('写一条 note.txt');
  await page
    .locator('section.card', { hasText: '新建草案' })
    .locator('input')
    .nth(1)
    .fill('note.txt');
  await page.getByTestId('task-verify').fill('node -e "process.exit(0)"');
  await page
    .locator('section.card', { hasText: '新建草案' })
    .getByRole('button', { name: '创建草案' })
    .click();
  const card = page.locator('section.card', { hasText: '写一条 note.txt' }).last();
  await card.getByRole('button', { name: '批准并排队' }).click();
  await card.getByRole('button', { name: /派发/ }).click();

  await expect(card).toContainText(`「Codex」这次不行（额度用完），由替补「${SECOND_LABEL}」来做`, {
    timeout: 60_000,
  });
  await expect(card).toContainText(
    SECOND_LABEL === 'Claude Code · sonnet'
      ? 'Claude Code'
      : SECOND_LABEL === 'DSH'
        ? 'DSH'
        : '合成甲',
    {
      timeout: 30_000,
    },
  );
});
