import { describe, it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  SkillCandidateStore,
  ProjectService,
  TuiGatewaySession,
  JsonRpcStdio,
  type TuiTransport,
} from '../../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

describe('借鉴 vermes 与 Mobius 的系统稳定性与自演进增强', () => {
  describe('vermes 进程网关：异常退出即刻捕获与超时保护', () => {
    it('当子进程异常退出时，session 立即捕获失败并附带 stderr 摘要，不永久挂起', async () => {
      const readStream = new PassThrough();
      const writeStream = new PassThrough();
      const rpc = new JsonRpcStdio(readStream, writeStream);

      let exitCb: ((code: number | null, signal: string | null, stderr: string) => void) | null =
        null;
      const transport: TuiTransport = {
        rpc,
        kill: () => {
          rpc.close();
        },
        onUnexpectedExit: (cb) => {
          exitCb = cb;
        },
      };

      const session = new TuiGatewaySession(transport, {
        runId: 'r-vermes-1',
        goal: '测试异常退出即刻中断',
        contextRef: 'c1',
        allowedTools: [],
        idempotencyKey: 'k1',
        permissionVersion: 'v1',
        budget: { timeoutMs: 30_000, maxToolCalls: 5 },
      });

      // 模拟进程异步开始运行后突然异常崩溃（exit code 127，stderr 报错）
      setTimeout(() => {
        exitCb?.(127, null, 'Fatal Python Exception: module not found');
      }, 50);

      await expect(session.run()).rejects.toThrow(/Hermes 进程异常退出 \(code 127/);
      expect(session.isDead).toBe(true);
      const snap = session.snapshot();
      expect(snap.status).toBe('failed');
    });
  });

  describe('Mobius 自演进：历史多失败模式聚类与自动提炼', () => {
    it('自动聚类多次类似失败并提炼自演进 Skill 候选，不重复提案', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mobius-test-'));
      const db = openDatabase(join(dir, 'ixaeon.db'));
      migrate(db);
      const store = new SkillCandidateStore(db);

      const projects = new ProjectService(db);
      const project = projects.create({
        name: '测试项目',
        rootPath: null,
        description: '自演进测试',
      });
      const projectId = project.id;
      const now = new Date().toISOString();

      // 在 work_runs 中插入 3 次相似的任务失败（相同类型、相同 exit code 2）
      const insertRun = db.prepare(`
        INSERT INTO work_runs (
          id, project_id, agent_name, task, outcome,
          summary, tests_json, changes_json, open_loops_json, finished_at
        ) VALUES (?, ?, ?, ?, 'failed', ?, ?, '[]', '[]', ?)
      `);

      const run1 = randomUUID();
      const run2 = randomUUID();
      const run3 = randomUUID();

      insertRun.run(
        run1,
        projectId,
        'codex',
        '编写数据导出脚本',
        'AssertionError: Expected valid format, got undefined',
        JSON.stringify({ verify_exit_code: 2 }),
        now,
      );
      insertRun.run(
        run2,
        projectId,
        'codex',
        '编写数据导出脚本第二次尝试',
        'AssertionError: Expected valid format, got null',
        JSON.stringify({ verify_exit_code: 2 }),
        now,
      );

      // 另一类不同特征的失败（exit code 127，命令缺失）
      insertRun.run(
        run3,
        projectId,
        'codex',
        '构建生产包任务',
        '/bin/sh: pnpm: command not found',
        JSON.stringify({ verify_exit_code: 127 }),
        now,
      );

      // 运行自动演进聚合器
      const evolved = store.autoEvolveFromFailurePatterns(projectId);
      expect(evolved.length).toBe(2);

      // 检查重复失败（coding_task 出现 2 次）的提案标题标记了重复次数
      const codingEvolved = evolved.find((c) => c.title.includes('重复失败 2 次'));
      expect(codingEvolved).toBeDefined();
      expect(codingEvolved?.problem).toContain('验证退出码 2');
      expect(codingEvolved?.problem).toContain('AssertionError');

      // 幂等测试：再次调用不再为已关联的失败记录重复生成
      const secondRun = store.autoEvolveFromFailurePatterns(projectId);
      expect(secondRun.length).toBe(0);

      // 自演进候选依然是 proposed 状态，未经受控对照评测坚决不能被批准（遵守 S2-02 规则）
      expect(codingEvolved?.status).toBe('proposed');
      expect(() => store.approve(codingEvolved!.id)).toThrow(/没有对照评测结果/);

      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
