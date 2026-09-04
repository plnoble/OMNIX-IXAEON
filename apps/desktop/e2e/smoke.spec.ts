import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 找到 desktop 应用目录（test-e2e.mjs 以 apps/desktop 为 cwd 运行）。 */
function findDesktopDir(): string {
  for (let dir = process.cwd(); ; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js（请先 build 并在 apps/desktop 下运行）');
    dir = parent;
  }
}

const desktopDir = findDesktopDir();

/** 启动打包后的桌面应用（先 build 再 e2e 是 verify 之外的独立步骤）。 */
async function launchApp(env: Record<string, string>): Promise<ElectronApplication> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  Object.assign(merged, env);
  return electron.launch({
    args: [join(desktopDir, 'out', 'main', 'index.js')],
    env: merged,
  });
}

test.describe('桌面应用冒烟（含修复回归）', () => {
  let app: ElectronApplication;
  let page: Page;
  let dataDir: string;
  let importDoc: string;

  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-e2e-'));
    // 准备一个待导入的文档（真实文件，走完整 vault + FTS 流程）
    importDoc = join(dataDir, 'seed-notes.md');
    writeFileSync(
      importDoc,
      [
        '# IXAEON 种子文档',
        '',
        'IXAEON（析衍）坚持两条原则：原文永久保留；当前理解可纠正。',
        '橙子计划第一周完成仓库骨架搭建。',
        '',
      ].join('\n'),
      'utf8',
    );
    app = await launchApp({
      IXAEON_DATA_DIR: dataDir,
      // 对话框 stub：documents 选择 seed-notes.md；directory 选择 dataDir
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${importDoc};directory|${dataDir}`,
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('应用启动 → 首次设置向导', async () => {
    await expect(page.getByTestId('app-root')).toBeVisible();
    await expect(page.getByTestId('setup-wizard')).toBeVisible();
    await expect(page.getByTestId('setup-step-dir')).toBeVisible();

    // 步骤 1：默认数据目录（环境变量注入，直接下一步）
    await page.getByTestId('setup-next-1').click();
    await expect(page.getByTestId('setup-step-model')).toBeVisible();

    // 步骤 2：模型（留空 key，允许稍后配置）
    await page.getByTestId('setup-model-name').fill('gpt-5.2');
    await page.getByTestId('setup-next-2').click();
    await expect(page.getByTestId('setup-step-project')).toBeVisible();

    // 步骤 3：第一个项目
    await page.getByTestId('setup-project-name').fill('橙子计划');
    await page.getByTestId('setup-pick-root').click();
    await expect(page.getByTestId('setup-project-root')).toHaveValue(dataDir);
    await page.getByTestId('setup-finish').click();

    // 完成后进入主界面（向导把用户带到来源页）
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
  });

  test('导入文档 → 来源列表与片段阅读器', async () => {
    await page.getByTestId('nav-sources').click();
    await expect(page.getByTestId('sources-card')).toBeVisible();
    // 首次设置已登记项目目录（快照来源已存在），列表非空

    await page.getByTestId('sources-import-docs').click();
    // stub 对话框直接返回 seed-notes.md → 导入 → 列表出现
    const row = page.locator('tbody tr').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('tbody tr').filter({ hasText: 'seed-notes.md' })).toHaveCount(1, {
      timeout: 20_000,
    });

    // 打开详情 → 片段阅读器
    await row.click();
    await expect(page.getByTestId('source-detail')).toBeVisible();
    await expect(page.getByTestId('segment-list')).toBeVisible();
    await expect(page.locator('.segment-text').first()).toContainText('IXAEON 种子文档');
  });

  test('全文检索命中导入内容', async () => {
    await page.getByTestId('nav-search').click();
    await expect(page.getByTestId('search-card')).toBeVisible();
    await page.getByTestId('search-input').fill('橙子计划');
    await page.getByTestId('search-run').click();
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.search-hit').first()).toContainText('仓库骨架');
  });

  test('项目页显示第一个项目', async () => {
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('projects-card')).toBeVisible();
    await expect(page.locator('.project-row').first()).toContainText('橙子计划');
    await expect(page.locator('.project-row').first()).toContainText('进行中');
  });

  test('总览显示状态与服务端口', async () => {
    await page.getByTestId('nav-overview').click();
    await expect(page.getByTestId('state-card')).toBeVisible();
    await expect(page.getByTestId('state-server')).toContainText('127.0.0.1:43191');
    await expect(page.getByTestId('state-setup')).toHaveText('已完成');
  });

  test('设置页 MCP 片段：命令可执行 + 入口文件存在 + 令牌经环境变量', async () => {
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-mcp')).toBeVisible();
    const snippet = page.getByTestId('settings-mcp-snippet');
    await expect(snippet).toContainText('ixaeon');
    // 修复 P1-3：命令必须是 Electron 可执行本身（不依赖全局 Node.js）
    await expect(snippet).toContainText('IXAEON_LOCAL_TOKEN');
    const text = await snippet.textContent();
    expect(text).toBeTruthy();
    // 解析片段中的 command 与 args，断言真实存在
    const parsed = JSON.parse(text!);
    const command = parsed.mcpServers.ixaeon.command;
    const entry = parsed.mcpServers.ixaeon.args[0];
    expect(existsSync(command)).toBe(true);
    expect(existsSync(entry)).toBe(true);
    // 令牌只经环境变量传入，不写进命令行参数
    expect(parsed.mcpServers.ixaeon.args.length).toBe(1);
    await expect(page.getByTestId('settings-data')).toContainText(dataDir);
  });

  test('MCP 片段命令真实握手（initialize + tools/list）', async () => {
    await page.getByTestId('nav-settings').click();
    const text = await page.getByTestId('settings-mcp-snippet').textContent();
    const parsed = JSON.parse(text!);
    const { command, args, env } = parsed.mcpServers.ixaeon;
    // 从安装产物环境模拟：用 IXAEON 可执行 + run-as-node 运行 MCP 入口，
    // 完成一次真实 STDIO initialize + tools/list（修复 P1-3 验收要求）
    const request = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ixaeon-e2e', version: '0.1.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    ];
    const result = spawnSync(command, args, {
      input: request.map((r) => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    expect(result.status).toBe(0);
    const output = result.stdout;
    expect(output).toContain('ixaeon');
    expect(output).toContain('prepare_task');
    expect(output).toContain('search_context');
    expect(output).toContain('get_source_excerpt');
    expect(output).toContain('record_work_result');
  });

  test('桌面服务运行时：MCP 端点真实调用 prepare_task + record_work_result', async () => {
    // 读取本地令牌（dataDir/config.json）
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as {
      localToken: string;
    };
    expect(config.localToken).toBeTruthy();

    const call = (path: string, body: unknown): { status: number; body: string } => {
      const bodyJson = JSON.stringify(body).replace(/'/g, "\\'");
      const res = spawnSync(
        process.execPath,
        [
          '-e',
          `const r = await fetch('http://127.0.0.1:43191${path}', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ${config.localToken}' },
            body: '${bodyJson}',
          });
          process.stdout.write(String(r.status) + '\\n' + JSON.stringify(await r.json()));
        `,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      const [status, bodyText] = (res.stdout ?? '').split('\n');
      return { status: Number(status), body: bodyText ?? '' };
    };

    // prepare_task（项目 ref = 橙子计划）
    const prep = call('/api/mcp/prepare-task', {
      project_ref: '橙子计划',
      task: 'e2e 验证任务',
      max_chars: 4000,
    });
    expect(prep.status).toBe(200);
    expect(prep.body).toContain('橙子计划');

    // record_work_result
    const record = call('/api/mcp/record-work-result', {
      project_ref: '橙子计划',
      agent_name: 'codex-e2e',
      task: 'e2e 写回验证',
      outcome: 'success',
      summary: '完成 MCP 闭环验证',
      changes: [],
      tests: [{ name: 'mcp handshake', result: 'passed' }],
      open_loops: [],
    });
    expect(record.status).toBe(200);
    expect(record.body).toContain('work_run_id');

    // 错误令牌 → 401 可操作错误
    const bad = spawnSync(
      process.execPath,
      [
        '-e',
        `const r = await fetch('http://127.0.0.1:43191/api/mcp/prepare-task', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer invalid-token' },
          body: '{}',
        });
        process.stdout.write(String(r.status));
        `,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(bad.stdout).toBe('401');
  });

  test('票据制：渲染层伪造路径导入被拒绝（修复 P1-5）', async () => {
    // 直接通过 evaluate 调用主进程 IPC：不带票据（旧 allowedPaths 通道已不存在）
    const result = await page.evaluate(async () => {
      try {
        // @ts-expect-error 测试注入：直接发原始 IPC（绕过 preload 类型）
        return await window.ixaeon.importPaths({
          ticket: 'forged-ticket-0000000000',
          projectId: null,
        });
      } catch (err) {
        return { rejected: String(err) };
      }
    });
    expect(JSON.stringify(result)).toContain('票据无效或已使用');
  });
});
