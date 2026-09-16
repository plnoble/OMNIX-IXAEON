/**
 * P0 可信基础相邻输入检查与全边界验收套件 (review-p0-boundaries-20260916.test.ts)
 * 验证 P0-A/B/C/D：不是死记某句测试字符串，而是全面验证契约级规则：
 * 包含正向合法成功对照、相邻负向阻断对照、同项目/跨项目/状态时效/流式限额等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ipcMain } from 'electron';
import { defaultAppConfig } from '../../../../packages/contracts/src/index.js';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  SkillCandidateStore,
  SourceStore,
  Vault,
  createTinyFishFetcher,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';
import { LocalServer } from '../../src/main/server/localServer.js';

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  shell: {},
  safeStorage: {},
  net: {},
  ipcMain: { handle: vi.fn() },
}));

let dir: string;
let db: CoreDatabase;
let projectId: string;
let skills: SkillCandidateStore;
let coding: CodingOrchestrator;
const apps: FastifyInstance[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p0-boundaries-'));
  db = openDatabase(join(dir, 'p0.db'));
  migrate(db);
  projectId = new ProjectService(db).create({
    name: 'P0 Synthetic Project A',
    rootPath: null,
    description: null,
  }).id;
  skills = new SkillCandidateStore(db);
  coding = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p0-boundaries-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

function candidate(proj = projectId, exitCode = 2) {
  const id = randomUUID();
  const ref = `p0-ref:${randomUUID()}`;
  db.prepare(
    `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at, client_ref)
    VALUES (?, ?, 'synthetic', 'broken sorting', 'failed', 'known failed case', ?, '[]', '[]', ?, ?)`,
  ).run(id, proj, JSON.stringify({ verify_exit_code: exitCode }), new Date().toISOString(), ref);
  return skills.proposeFromFailure({
    projectId: proj,
    workRunId: ref,
    task: 'broken sorting',
    summary: 'known failed case',
  });
}

function ipcRuntime() {
  const dataDir = join(dir, 'app-data');
  mkdirSync(dataDir, { recursive: true });
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db, dataDir });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async (name: string, arg: unknown) => {
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === `ixaeon:${name}`);
    if (!entry) throw new Error(`Missing IPC ${name}`);
    return entry[1]({} as never, arg);
  };
}

async function workspace(project = projectId) {
  const task = coding.create({
    projectId: project,
    goal: 'Synthetic authorized file task',
    scope: ['artifact.txt'],
    allowedCommands: [[process.execPath, '-e', "require('fs').existsSync('artifact.txt')"]],
  });
  const queued = await coding.approveAndQueue(task.id);
  if (!queued.workspace_path) throw new Error('Missing fixture workspace');
  return queued;
}

async function httpFixture() {
  let config = { ...defaultAppConfig(), localToken: 'synthetic-local-token'.padEnd(64, 'x') };
  const search = vi.fn(async (query: string) => ({ provider: 'synthetic', query, hits: [] }));
  const read = vi.fn(async (url: string) => ({
    finalUrl: url,
    status: 200,
    excerpt: 'synthetic public page',
  }));
  const server = new LocalServer({
    db,
    permissions: new PermissionService(db),
    sources: new SourceStore(db),
    vault: new Vault(join(dir, 'vault')),
    getConfig: () => config,
    updateConfig: (fn) => {
      config = fn(config) as typeof config;
    },
    getWebSearchExecutor: () => ({ provider: 'synthetic', search }) as never,
    fetchWebPage: read,
    getCodingOrchestrator: () => coding,
  });
  const app = Fastify();
  apps.push(app);
  await server.register(app);
  return { app, search, read, headers: { authorization: `Bearer ${config.localToken}` } };
}

describe('P0 可信基础相邻输入检查与全边界验收 (P0-A 至 P0-D)', () => {
  // --- 1. 技能评测真实同题对照与防伪边界 (P0-B) ---
  it('P0-B01 [正向对照] 实质检验真实产物且退出码为 0 的合法命令，成功受控评测并批准', async () => {
    const s = candidate();
    const task = await workspace();
    // 在任务工作区生成预期目标产物
    writeFileSync(join(task.workspace_path!, 'artifact.txt'), 'fixed content', 'utf8');

    const invoke = ipcRuntime();
    await invoke('evaluateSkillWithEvidence', {
      id: s.id,
      taskId: task.id,
      method: 'Legitimate fix method',
      benefit: 'Artifact successfully produced and verified',
      command: [
        process.execPath,
        '-e',
        "const fs = require('fs'); const assert = require('assert'); assert.ok(fs.existsSync('artifact.txt'));",
      ],
    });

    const evaluated = skills.get(s.id);
    expect(evaluated.status).toBe('evaluated');
    expect(evaluated.eval_evidence_json).toBeTruthy();

    const approvedResult = (await invoke('approveSkillCandidate', {
      id: s.id,
      version: evaluated.version,
    })) as { ok: boolean };
    expect(approvedResult.ok).toBe(true);
    expect(skills.get(s.id).status).toBe('approved');
  });

  it('P0-B02 [负向对照] 修改方法后旧证据失效，版本与方法快照失配时拒绝批准', async () => {
    const s = candidate();
    const task = await workspace();
    writeFileSync(join(task.workspace_path!, 'artifact.txt'), 'fixed content', 'utf8');
    const invoke = ipcRuntime();

    await invoke('evaluateSkillWithEvidence', {
      id: s.id,
      taskId: task.id,
      method: 'Initial method',
      benefit: 'Solves baseline issue',
      command: [
        process.execPath,
        '-e',
        "const fs = require('fs'); require('assert').ok(fs.existsSync('artifact.txt'));",
      ],
    });

    // 用户在没有重新评测的情况下更新了方法内容
    db.prepare('UPDATE skill_candidates SET method = ? WHERE id = ?').run(
      'Tampered method after eval',
      s.id,
    );

    await expect(
      invoke('approveSkillCandidate', { id: s.id, version: skills.get(s.id).version }),
    ).rejects.toThrow(/证据绑定的方法与当前方法不一致/);
  });

  it('P0-B03 [负向对照] 纯打印变体（console.warn/info）无实质产物检验，坚决拒绝', async () => {
    const s = candidate();
    const task = await workspace();
    const invoke = ipcRuntime();

    await expect(
      invoke('evaluateSkillWithEvidence', {
        id: s.id,
        taskId: task.id,
        method: 'Fake print method',
        benefit: 'Claims improvement without check',
        command: [process.execPath, '-e', "console.warn('assert'); console.info('ok');"],
      }),
    ).rejects.toThrow(/验证命令必须实质检验任务产物或状态/);
  });

  it('P0-B04 [负向对照] 基线退出码为 0 的正常运行，禁止伪造为失败改进基线', async () => {
    const runId = randomUUID();
    const ref = `zero-base:${randomUUID()}`;
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at, client_ref)
      VALUES (?, ?, 'synthetic', 'already working task', 'failed', 'falsified failure', ?, '[]', '[]', ?, ?)`,
    ).run(runId, projectId, JSON.stringify({ verify_exit_code: 0 }), new Date().toISOString(), ref);

    const s = skills.proposeFromFailure({
      projectId,
      workRunId: ref,
      task: 'already working task',
      summary: 'falsified failure',
    });

    const task = await workspace();
    const invoke = ipcRuntime();
    await expect(
      invoke('evaluateSkillWithEvidence', {
        id: s.id,
        taskId: task.id,
        method: 'Fake method on clean baseline',
        benefit: 'Falsified improvement',
        command: [
          process.execPath,
          '-e',
          "const fs = require('fs'); require('assert').ok(fs.existsSync('artifact.txt'));",
        ],
      }),
    ).rejects.toThrow(/失败基线缺少非零验证退出码/);
  });

  // --- 2. 隔离、跨项目保护与工作区绑定边界 (P0-C / P0-D) ---
  it('P0-C01 [负向对照] 候选尝试绑定另一个项目的工作区执行，抛出 SCOPE_DENIED', async () => {
    const s = candidate();
    const otherProject = new ProjectService(db).create({
      name: 'Unrelated Project B',
      rootPath: null,
      description: null,
    });
    const taskB = await workspace(otherProject.id);
    const invoke = ipcRuntime();

    await expect(
      invoke('evaluateSkillWithEvidence', {
        id: s.id,
        taskId: taskB.id,
        method: 'Cross project attack',
        benefit: 'Cross project write',
        command: [
          process.execPath,
          '-e',
          "const fs = require('fs'); fs.writeFileSync('foreign.txt', 'danger');",
        ],
      }),
    ).rejects.toThrow(/不属于该技能候选所属的项目/);

    expect(existsSync(join(taskB.workspace_path!, 'foreign.txt'))).toBe(false);
  });

  it('P0-C02 [负向对照] 缺失 taskId 绑定时严格拒绝，杜绝在 app-data 目录中执行', async () => {
    const s = candidate();
    const invoke = ipcRuntime();

    await expect(
      invoke('evaluateSkillWithEvidence', {
        id: s.id,
        method: 'Missing taskId call',
        benefit: 'No workspace bound',
        command: [
          process.execPath,
          '-e',
          "const fs = require('fs'); fs.writeFileSync('leak.txt', 'leak');",
        ],
      }),
    ).rejects.toThrow(/受控评测必须绑定有效的编码任务工作区/);
  });

  // --- 3. MCP 搜索与任务数据受众边界 (P0-C) ---
  it('P0-C03 [负向对照] 仅有已结束（succeeded/failed）的会话，不能向 MCP 授予网络搜索权限', async () => {
    const f = await httpFixture();
    // 注入一个已完成的非 running 会话
    db.prepare(
      "INSERT INTO runtime_runs (id, goal, project_id, engine, status, created_at, finished_at) VALUES (?, ?, ?, 'hermes', 'succeeded', ?, ?)",
    ).run(
      randomUUID(),
      'Past finished run',
      projectId,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const res = await f.app.inject({
      method: 'POST',
      url: '/api/mcp/search-web',
      headers: f.headers,
      payload: { query: 'adjacent boundary query' },
    });

    expect(res.statusCode).toBe(403);
    expect(f.search).not.toHaveBeenCalled();
  });

  it('P0-C04 [正向对照] 存在处于 running 状态的活跃受控会话时，MCP 搜索获准并执行脱敏', async () => {
    const f = await httpFixture();
    // 注入当前正在运行的活跃会话
    db.prepare(
      "INSERT INTO runtime_runs (id, goal, project_id, engine, status, created_at) VALUES (?, ?, ?, 'hermes', 'running', ?)",
    ).run(randomUUID(), 'Active run', projectId, new Date().toISOString());

    const res = await f.app.inject({
      method: 'POST',
      url: '/api/mcp/search-web',
      headers: f.headers,
      payload: { query: 'adjacent public keyword' },
    });

    expect(res.statusCode).toBe(200);
    expect(f.search).toHaveBeenCalledOnce();
    const data = JSON.parse(res.body) as { provider: string };
    expect(data.provider).toBe('synthetic');
  });

  it('P0-C05 [负向对照] 通用 MCP 客户端查询未获准项目的任务状态，拒绝暴露任何私密内容', async () => {
    const f = await httpFixture();
    const task = coding.create({
      projectId,
      goal: 'SECRET_TRADE_ALGORITHM',
      scope: ['trade.ts'],
      allowedCommands: [],
    });
    db.prepare(
      'UPDATE coding_tasks SET verify_output = ?, executor_report_json = ? WHERE id = ?',
    ).run(
      'SECRET_ALGO_VERIFY_LOG',
      JSON.stringify({ summary: 'SECRET_ALGO_SUMMARY', changedPaths: ['trade.ts'] }),
      task.id,
    );

    const res = await f.app.inject({
      method: 'POST',
      url: '/api/mcp/get-task-status',
      headers: f.headers,
      payload: { task_id: task.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SECRET_TRADE_ALGORITHM');
    expect(res.body).not.toContain('SECRET_ALGO_SUMMARY');
  });

  // --- 4. 流式大小上限与空结果真实报错边界 (P0-D) ---
  it('P0-D01 [负向对照] 云端动态渲染正文超过 2 MiB 立即中止并抛出超限错误', async () => {
    const oversizedBody = 'A'.repeat(2 * 1024 * 1024 + 256);
    const fetcher = createTinyFishFetcher('p0-key', {
      fetchFn: (async () => {
        return new Response(
          JSON.stringify({
            results: [{ url: 'https://example.com/huge', content: oversizedBody }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    await expect(fetcher.fetchRendered('https://example.com/huge')).rejects.toThrow(
      /响应超过 2097152 字节限制/,
    );
  });

  it('P0-D02 [负向对照] 云端动态渲染结果为空 results: [] 时抛出异常，绝不伪造 200 成功', async () => {
    const fetcher = createTinyFishFetcher('p0-key', {
      fetchFn: (async () => {
        return new Response(JSON.stringify({ results: [], errors: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    await expect(fetcher.fetchRendered('https://example.com/empty')).rejects.toThrow(
      /TinyFish 动态抓取未取得有效正文内容/,
    );
  });

  it('P0-D03 [正向对照] 云端动态渲染返回有效 Markdown 正文时正确解析', async () => {
    const fetcher = createTinyFishFetcher('p0-key', {
      fetchFn: (async () => {
        return new Response(
          JSON.stringify({
            results: [
              {
                url: 'https://example.com/doc',
                title: 'Valid Document Title',
                content: '# Title\n\nValid rendered markdown content.',
                status: 200,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const result = await fetcher.fetchRendered('https://example.com/doc');
    expect(result.title).toBe('Valid Document Title');
    expect(result.content).toContain('Valid rendered markdown content');
    expect(result.status).toBe(200);
  });
});
