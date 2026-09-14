import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '@ixaeon/contracts';
import {
  openDatabase,
  migrate,
  ProjectService,
  SkillCandidateStore,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a09-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

describe('A09 Skill 经验成长（证据绑定不可改写 + 真实入口版本批准）', () => {
  it('失败任务自动提案候选：初始版本为 1，状态为 proposed', () => {
    const projects = new ProjectService(db);
    const p = projects.create({ name: '测试项目', rootPath: null, description: null });
    const store = new SkillCandidateStore(db);

    const candidate = store.proposeFromFailure({
      projectId: p.id,
      task: '使用严格模式编译前端模块',
      summary: 'tsc 报告 3 个未定义属性错误',
    });

    expect(candidate.status).toBe('proposed');
    expect(candidate.version).toBe(1);
    expect(candidate.eval_before).toBeNull();
    expect(candidate.eval_after).toBeNull();
    expect(candidate.eval_evidence_json).toBeNull();
    expect(candidate.approved_version).toBeNull();
  });

  it('方法编辑递增版本号，状态重置为 proposed（需重新验证）', () => {
    const store = new SkillCandidateStore(db);
    const candidate = store.proposeFromFailure({
      projectId: null,
      task: '任务A',
      summary: '失败A',
    });

    const updated = store.updateMethod(
      candidate.id,
      '在编译前先运行类型声明生成脚本 generate-types.sh',
    );
    expect(updated.version).toBe(2);
    expect(updated.method).toContain('generate-types.sh');
    expect(updated.status).toBe('proposed');
  });

  it('S01 校验防御：空证据、伪造成功、无收益一律拒绝批准', () => {
    const store = new SkillCandidateStore(db);
    const c = store.proposeFromFailure({
      projectId: null,
      task: '防御用例',
      summary: '失败',
    });

    // 1. 基线非失败案例（exitCodeBefore === 0）拒绝
    expect(() =>
      store.evaluateWithEvidence(c.id, {
        evidence: {
          exitCodeBefore: 0,
          exitCodeAfter: 0,
          outputBefore: 'success',
          outputAfter: 'success',
          verifiedAt: new Date().toISOString(),
          command: ['test'],
        },
        benefit: 'improved',
      }),
    ).toThrow();

    // 2. 改进后仍失败（exitCodeAfter !== 0）拒绝
    expect(() =>
      store.evaluateWithEvidence(c.id, {
        evidence: {
          exitCodeBefore: 1,
          exitCodeAfter: 1,
          outputBefore: 'failed',
          outputAfter: 'failed',
          verifiedAt: new Date().toISOString(),
          command: ['test'],
        },
        benefit: 'improved',
      }),
    ).toThrow();

    // 3. 无收益标记拒绝
    store.evaluate(c.id, {
      evalBefore: '失败',
      evalAfter: '同样失败',
      benefit: '无收益，表现相同',
    });
    expect(() => store.approve(c.id)).toThrow();
  });

  it('真实前后对照评测：记录不可由候选改写的客观证据，批准具体版本', () => {
    const projects = new ProjectService(db);
    const p = projects.create({ name: '重构项目', rootPath: null, description: null });
    const store = new SkillCandidateStore(db);

    const c = store.proposeFromFailure({
      projectId: p.id,
      task: '运行单元测试',
      summary: '缺失 mock 导致抛错',
    });

    // 绑定不可改写的客观证据
    const evaluated = store.evaluateWithEvidence(c.id, {
      method: '自动注入隔离环境的 mock 服务实例',
      evidence: {
        exitCodeBefore: 1,
        exitCodeAfter: 0,
        outputBefore: 'Error: Database connection refused (exit 1)',
        outputAfter: 'Test suite passed: 10/10 (exit 0)',
        verifiedAt: new Date().toISOString(),
        command: ['npm', 'test'],
      },
      benefit: '从报错退出 1 改善为测试全量通过退出 0',
    });

    expect(evaluated.status).toBe('evaluated');
    expect(evaluated.eval_evidence_json).toContain('"exitCodeBefore":1');
    expect(evaluated.eval_evidence_json).toContain('"exitCodeAfter":0');
    expect(evaluated.version).toBe(2);

    // 过时版本批准拦截
    expect(() => store.approve(c.id, { version: 1 })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFLICT }),
    );

    // 真实版本批准
    const approved = store.approve(c.id, { version: 2 });
    expect(approved.status).toBe('approved');
    expect(approved.approved_version).toBe(2);

    // 批准后在项目注入中可用
    const projectSkills = store.approvedForProject(p.id);
    expect(projectSkills.some((s) => s.id === c.id)).toBe(true);

    // 撤回（retire）后不再注入
    const retired = store.retire(c.id);
    expect(retired.status).toBe('retired');
    const projectSkillsAfter = store.approvedForProject(p.id);
    expect(projectSkillsAfter.some((s) => s.id === c.id)).toBe(false);
  });
});
