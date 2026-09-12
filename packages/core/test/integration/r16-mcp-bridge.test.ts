import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  TuiGatewaySession,
  locateHermes,
  hermesSpawnEnv,
  hermesGatewayArgs,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * 跑 hermes CLI 并喂 stdin（add/remove 有 [Y/n] 交互提示，EOF 会让 CLI 崩掉）。
 * 失败时把 stdout/stderr 带进异常，方便诊断。
 */
function hermesCliRun(
  exe: string,
  args: string[],
  env: Record<string, string>,
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hermes ${args.join(' ')} 超时（${timeoutMs}ms）\n${out}\n${err}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out + err);
      else reject(new Error(`hermes ${args.join(' ')} 退出码 ${code}\n${out}\n${err}`));
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/**
 * R16 Core↔Hermes MCP 工具桥真机验证（B1 收官）。
 *
 * 链路：Hermes（锁定 v2026.9.11，专属 home）在会话构建时从 config.yaml
 * 发现 mcp_servers.ixaeon → 拉起 apps/mcp dist（直连模式，IXAEON_MCP_DB_PATH
 * 指向本测试的合成库）→ 真模型调 search_context → 回答必须引用只有库里
 * 才有的种子目标。断言：
 * 1. 回答包含种子目标关键词（模型无法凭空编出）；
 * 2. 事件流出现真 tool_request（名字含 search_context）；
 * 3. 会话 terminal。
 *
 * 隔离：种子库为临时合成库（不是日用库）；测试结束后从 Hermes 配置移除
 * mcp_servers.ixaeon（config.yaml 恢复原样），不残留桥接入口。
 */
const run = process.env.IXAEON_REAL_HERMES === '1';
const repoRoot = resolve(__dirname, '../../../..');
// 直连入口（仓库场景）：不经桌面端 HTTP，直接打开测试合成库
const mcpEntry = join(repoRoot, 'apps', 'mcp', 'dist', 'direct.mjs');
const hermesExe = process.env.IXAEON_HERMES_EXE ?? '';
const SECRET = 'R16种子在花园里种九棵蓝莓';

describe.skipIf(!run || !existsSync(mcpEntry))('R16 Core↔Hermes MCP 工具桥（真模型）', () => {
  let db: CoreDatabase;
  let dir: string;
  let dbPath: string;
  let hermesCli: string;
  let cliEnv: Record<string, string>;
  let configPath: string;
  let configBackupPath: string;
  let hadServerBefore = false;

  beforeAll(() => {
    const locator = locateHermes();
    expect(locator.found).toBe(true);
    hermesCli =
      hermesExe ||
      locator.exe!.replace(/venv\\Scripts\\python\.exe$/, '') + '..\\..\\bin\\hermes.exe';
    // CLI 用 bin/hermes.exe（安装器放好的入口）；找不到就跳过而非猜路径
    const home = process.env.IXAEON_HERMES_HOME || locator.home || '';
    const candidate = join(home, 'bin', 'hermes.exe');
    hermesCli = existsSync(candidate) ? candidate : hermesCli;
    cliEnv = {
      ...process.env,
      HERMES_HOME: home,
    } as Record<string, string>;
    configPath = join(home, 'config.yaml');
    configBackupPath = join(home, 'config.yaml.r16-backup');

    dir = mkdtempSync(join(tmpdir(), 'ixaeon-r16-'));
    dbPath = join(dir, 'ixaeon.db');
    db = openDatabase(dbPath);
    migrate(db);
    const projects = new ProjectService(db);
    const items = new ItemService(db);
    const project = projects.create({
      name: 'R16 花园',
      rootPath: null,
      description: null,
    });
    items.createManual({
      projectId: project.id,
      type: 'goal',
      statement: SECRET,
      rationale: null,
    });
    hadServerBefore = readFileSync(configPath, 'utf8').includes('mcp_servers:');
    if (hadServerBefore) copyFileSync(configPath, configBackupPath);
    // 直连模式标记文件（避免误配日用库）：确认数据目录无关，无需 config.json
    writeFileSync(join(dir, 'README-r16.txt'), 'R16 合成验证库，测试后随目录删除');
  });

  afterAll(async () => {
    db?.close();
    // 从 Hermes 配置移除探针 MCP 服务器（无论成败），恢复原状
    try {
      await hermesCliRun(hermesCli, ['mcp', 'remove', 'ixaeon'], cliEnv, 'y\n', 60_000);
    } catch (err) {
      console.error('R16 清理 mcp remove 失败（手动确认 config.yaml）:', String(err));
    }
    if (hadServerBefore && existsSync(configBackupPath)) {
      copyFileSync(configBackupPath, configPath);
      rmSync(configBackupPath, { force: true });
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('真模型经 ixaeon MCP 调 search_context，回答引用种子目标', async () => {
    // 1) 注册 MCP 服务器（直连合成库）。
    // 注意：--args 是贪婪参数（必须最后），--env 放它前面，否则会被吞成服务器 argv。
    await hermesCliRun(
      hermesCli,
      [
        'mcp',
        'add',
        'ixaeon',
        '--command',
        process.execPath,
        '--env',
        `IXAEON_MCP_DB_PATH=${dbPath}`,
        '--args',
        mcpEntry,
      ],
      cliEnv,
      'y\n',
      150_000,
    );

    // 2) 连通性预检（诚实失败：服务器起不来就在这里报，不进真回合）
    await hermesCliRun(hermesCli, ['mcp', 'test', 'ixaeon'], cliEnv, '', 150_000);

    // 3) 真模型回合：必须用检索才能答出种子原文
    const locator = locateHermes();
    const session = new TuiGatewaySession(
      TuiGatewaySession.spawnProcess(locator.exe!, hermesGatewayArgs(), {
        cwd: locator.cwd,
        env: hermesSpawnEnv(locator),
      }),
      {
        runId: 'r16-bridge',
        goal:
          '调用 ixaeon MCP 服务器的 search_context 工具查询「蓝莓」' +
          '（query 填 蓝莓，不要问任何问题），然后只回答一句话：' +
          'IXAEON 里记的花园目标原文是什么？',
        contextRef: 'personal',
        allowedTools: ['search_context', 'prepare_task', 'get_source_excerpt'],
        permissionVersion: '1',
        budget: { maxToolCalls: 6, timeoutMs: 240_000 },
        idempotencyKey: 'r16-bridge',
      },
    );
    const result = await session.run();
    session.dispose();

    // 断言：真工具调用痕迹（名字含 search_context）
    const toolCalls = result.events.filter((e) => e.kind === 'tool_request');
    expect(
      toolCalls.some((e) => String(e.payload['name'] ?? '').includes('search_context')),
      `未见 search_context 工具调用；事件：${JSON.stringify(toolCalls.map((e) => e.payload['name']))}`,
    ).toBe(true);
    // 断言：回答引用种子目标（模型编不出来）
    expect(result.status).toBe('terminal');
    expect(result.answer).toContain('蓝莓');
    expect(result.answer).toContain('九棵');
  }, 300_000);
});
