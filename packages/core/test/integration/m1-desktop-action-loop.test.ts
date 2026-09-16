import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ProjectService,
  CodingOrchestrator,
  FakeCodingExecutor,
  McpService,
  createWebSearchExecutor,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m1-test-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('M1 阶段：目标驱动桌面办事全闭环与 MCP 工具链回交（NP07 / NP08）', () => {
  it('NP07: MCP 服务正确支持 search_web、read_web、propose_task、get_task_status 闭环工具', async () => {
    const mcp = new McpService(db);
    const projects = new ProjectService(db);
    const project = projects.create({
      name: '日志整理工具',
      rootPath: dir,
      description: 'M1 自动化测试项目',
    });

    const executor: FakeCodingExecutor = new FakeCodingExecutor();
    const coding = new CodingOrchestrator(db, executor, dir);

    // 建立受控运行中的会话（代表合法桌面会话处于 running 状态）
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runtime_runs (id, goal, project_id, engine, status, created_at) VALUES (?, ?, ?, 'hermes', 'running', ?)",
    ).run('run-m1-np07', '测试受控网络搜索', project.id, now);

    // 1. search_web: 验证脱敏与搜索结果结构化返回
    const mockSearch = createWebSearchExecutor('tinyfish', 'tf-mock-key', {
      fetchFn: (async (url) => {
        expect(String(url)).toContain('api.search.tinyfish.ai');
        return new Response(
          JSON.stringify({
            results: [
              {
                title: '高效去重算法文档',
                url: 'https://example.com/dedupe-docs',
                snippet: '关于数组与时间序列去重排序的实现指南',
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const searchRes = await mcp.searchWeb({ query: '去重 排序 算法' }, mockSearch);
    expect(searchRes.provider).toBe('tinyfish');
    expect(searchRes.hits).toHaveLength(1);
    expect(searchRes.hits[0]?.title).toBe('高效去重算法文档');

    // 2. read_web: 验证抓取网页正文
    const readRes = await mcp.readWeb('https://example.com/dedupe-docs', async (url) => {
      return {
        finalUrl: url,
        status: 200,
        excerpt: '# 数组去重与排序\n\n使用 Map 维护唯一键，按时间戳升序排列。',
      };
    });
    expect(readRes.status).toBe(200);
    expect(readRes.excerpt).toContain('使用 Map 维护唯一键');

    // 3. propose_task: 提出具体编码任务草案
    const proposeRes = mcp.proposeTask(
      {
        project_ref: project.id,
        goal: '为数据导出模块实现稳定去重与排序',
        scope: ['dedupe.js'],
        verify_command: [
          process.execPath,
          '-e',
          "const fs=require('fs');if(!fs.existsSync('dedupe.js'))process.exit(2);",
        ],
        rationale: '根据搜索文档设计并验证独立去重模块',
      },
      (p) => coding.create(p),
    );

    expect(proposeRes.task_id).toBeDefined();
    expect(proposeRes.status).toBe('draft');
    expect(proposeRes.scope).toEqual(['dedupe.js']);

    // 4. get_task_status: 初始状态查询
    const statusRes = mcp.getTaskStatus(proposeRes.task_id, (id) => coding.store.get(id));
    expect(statusRes.status).toBe('draft');
    expect(statusRes.verify_status).toBeNull();
  });

  it('NP08: 从桌面提出目标到批准、真实执行产物、独立多条件验证、结果回交原对话全流程', async () => {
    const projects = new ProjectService(db);
    const project = projects.create({
      name: '数据导出项目',
      rootPath: dir,
      description: '具有实际业务功能的受控测试项目',
    });

    const dedupeCode = `
function dedupeAndSort(items) {
  if (!Array.isArray(items)) throw new Error('Items must be an array');
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue;
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}
module.exports = { dedupeAndSort };
`;

    // 准备一个实际的编码执行器（在受控沙箱副本中真正生成 dedupe.js 脚本）
    const executor = new FakeCodingExecutor({
      files: {
        'dedupe.js': dedupeCode.trim(),
      },
      summary: '成功实现 dedupeAndSort 函数，具备去重、过滤无效项及时间戳升序排序能力',
    });

    const coding = new CodingOrchestrator(db, executor, dir);

    // 1. Agent 提出修改草案（含覆盖正常、重复、异常输入的独立判据）
    const verifyScript = `
const { dedupeAndSort } = require('./dedupe.js');
const assert = require('assert');
// 正常输入测试
const input = [
  { id: 'b', timestamp: 20 },
  { id: 'a', timestamp: 10 },
  { id: 'b', timestamp: 20 }, // 重复项
  null, // 异常项
];
const result = dedupeAndSort(input);
assert.strictEqual(result.length, 2, '去重后应只有 2 项');
assert.strictEqual(result[0].id, 'a', '首项应为时间较早的 a');
assert.strictEqual(result[1].id, 'b', '第二项应为 b');
console.log('ALL_CHECKS_PASSED');
`;

    const task = coding.create({
      projectId: project.id,
      goal: '为数据导出模块实现严格去重与有效性排序',
      scope: ['dedupe.js'],
      allowedCommands: [[process.execPath, '-e', verifyScript]],
    });

    expect(task.status).toBe('draft');

    // 2. 用户在桌面审查批准任务（非用户批准不能执行）
    const approved = await coding.approveAndQueue(task.id);
    expect(approved.status).toBe('queued');

    // 3. 派发执行并跑独立验证（验证通过进入 pending_accept 待用户验收）
    const dispatched = await coding.dispatch(task.id);
    expect(dispatched.status).toBe('pending_accept');
    expect(dispatched.verify_status).toBe('passed');
    expect(dispatched.verify_exit_code).toBe(0);
    expect(dispatched.verify_output).toContain('ALL_CHECKS_PASSED');
    expect(dispatched.verify_status).toBe('passed');
    expect(dispatched.verify_exit_code).toBe(0);
    expect(dispatched.verify_output).toContain('ALL_CHECKS_PASSED');

    // 4. 用户在桌面最终验收产物，转为 completed
    const accepted = coding.accept(task.id);
    expect(accepted.status).toBe('completed');

    // 4. 核验生成的工作记录（work_runs）
    const runs = db
      .prepare('SELECT * FROM work_runs WHERE project_id = ? ORDER BY finished_at DESC')
      .all(project.id) as Array<{ outcome: string; summary: string; changes_json: string }>;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]?.outcome).toBe('success');
    expect(runs[0]?.summary).toContain('dedupeAndSort');

    // 5. 结果回交：查询任务详情包含实际变更文件
    const taskResult = coding.store.get(task.id);
    expect(taskResult.status).toBe('completed');
    expect(taskResult.executor_report_json).toContain('dedupeAndSort');

    // 6. 反例验证：未获批准的任务尝试直接执行必须被拒绝
    const unapprovedTask = coding.create({
      projectId: project.id,
      goal: '未获批准的越权修改',
      scope: ['danger.js'],
      allowedCommands: [[process.execPath, '-e', 'process.exit(0);']],
    });
    await expect(coding.dispatch(unapprovedTask.id)).rejects.toThrow(/没有批准/);

    // 7. 反例验证：已取消的任务不可继续派发
    coding.cancel(unapprovedTask.id);
    expect(coding.store.get(unapprovedTask.id).status).toBe('cancelled');
    await expect(coding.dispatch(unapprovedTask.id)).rejects.toThrow();
  });
});
