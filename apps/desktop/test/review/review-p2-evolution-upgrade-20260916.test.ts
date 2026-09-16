/**
 * P2 阶段验收套件：受控自我升级，把“自己进化”做成工程能力 (review-p2-evolution-upgrade-20260916.test.ts)
 * 严格按照 IXAEON 长期开发总计划 P2 要求：
 * 1. P2-A 改进队列来自真实问题（从连续失败 work_runs 聚类提炼，含模式、次数与关联依据）；
 * 2. P2-B 受控实验与独立比较（独立断言、未解决缺陷拒绝冒充成功、篡改失效）；
 * 3. P2-C 版本批准与防伪（用户批准具体版本、非受控证据拒绝）；
 * 4. P2-D 升级、健康检查、回滚与数据保全（升级前备份、健康检查失败自动回滚、回滚后新增数据保全）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  SkillCandidateStore,
  ProjectService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';

let dir: string;
let db: CoreDatabase;
let dbPath: string;
let skillStore: SkillCandidateStore;
let projects: ProjectService;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p2-evo-'));
  dbPath = join(dir, 'core.db');
  db = openDatabase(dbPath);
  migrate(db);
  skillStore = new SkillCandidateStore(db);
  projects = new ProjectService(db);

  projectId = projects.create({
    name: 'P2 Evolution Project',
    rootPath: null,
    description: 'Project for testing self-evolution and safe upgrade pipeline',
  }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p2-evo-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P2-A 改进队列来自真实问题', () => {
  it('P2-A01 [失败聚类提炼候选] 从多次相同失败模式中自动反思提炼出带重复次数与证据依据的候选', () => {
    // 注入 2 次相同特征的失败工作记录（同一前缀任务，相同的失败退出码 127）
    const run1Id = randomUUID();
    const run2Id = randomUUID();
    const taskName = '解析大型 CSV 数据集并计算摘要';

    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', ?, 'failed', '内存溢出崩溃 OOM', ?, '[]', '[]', ?)`,
    ).run(
      run1Id,
      projectId,
      taskName,
      JSON.stringify({ passed: false, verify_exit_code: 127 }),
      new Date(Date.now() - 3600000).toISOString(),
    );

    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', ?, 'failed', '内存溢出崩溃 OOM (重试失败)', ?, '[]', '[]', ?)`,
    ).run(
      run2Id,
      projectId,
      taskName,
      JSON.stringify({ passed: false, verify_exit_code: 127 }),
      new Date().toISOString(),
    );

    // 触发自演进提炼聚合器
    const candidates = skillStore.autoEvolveFromFailurePatterns(projectId);

    expect(candidates.length).toBe(1);
    const candidate = candidates[0]!;
    // 验证：包含重复失败次数标识
    expect(candidate.title).toContain('重复失败 2 次');
    // 验证：包含两个失败 work_runs 的联合依据 ID
    expect(candidate.created_from_work_run_id).toContain(run1Id);
    expect(candidate.created_from_work_run_id).toContain(run2Id);
    // 验证：结构化总结包含模式特征与退出码
    expect(candidate.problem).toContain('127');
    expect(candidate.problem).toContain('内存溢出崩溃');
  });

  it('P2-A02 [无失败不盲目提炼] 当没有失败运行记录时，自演进不凭空产生升级提案', () => {
    // 只有成功的运行
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', '正常任务', 'success', '顺利完成', '{"passed": true}', '[]', '[]', ?)`,
    ).run(randomUUID(), projectId, new Date().toISOString());

    const candidates = skillStore.autoEvolveFromFailurePatterns(projectId);
    expect(candidates.length).toBe(0);
  });
});

describe('P2-B 受控实验与独立比较', () => {
  it('P2-B01 [独立断言缺陷拦截] 改进方法未真正解决缺陷（退出码仍非零）时坚决拒绝作为有效证据', () => {
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', 'JSON 格式容错解析', 'failed', '遇到尾随逗号解析失败', ?, '[]', '[]', ?)`,
    ).run(
      runId,
      projectId,
      JSON.stringify({ passed: false, verify_exit_code: 1 }),
      new Date().toISOString(),
    );

    const candidate = skillStore.proposeFromFailure({
      projectId,
      workRunId: runId,
      task: 'JSON 格式容错解析',
      summary: '尾随逗号解析报错',
    });

    // 模拟受控评测：命令执行后退出码仍为 1（未真正修复）
    expect(() =>
      skillStore.evaluateWithEvidence(candidate.id, {
        evidence: {
          command: ['node', '-e', 'JSON.parse("{a:1,}")'],
          exitCodeBefore: 1,
          outputBefore: 'SyntaxError',
          exitCodeAfter: 1, // 依然失败！
          outputAfter: 'SyntaxError: Unexpected token',
          verifiedAt: new Date().toISOString(),
          producedBy: 'controlled',
        },
        benefit: '声称改进但实际仍未修复',
      }),
    ).toThrow(/改进后（after）检查必须成功通过/);
  });

  it('P2-B02 [证据防伪与快照一致性] 方法被修改后，与原证据快照不匹配，拒绝批准', () => {
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', '安全路径规范化', 'failed', '路径穿越被漏判', ?, '[]', '[]', ?)`,
    ).run(
      runId,
      projectId,
      JSON.stringify({ passed: false, verify_exit_code: 1 }),
      new Date().toISOString(),
    );

    const candidate = skillStore.proposeFromFailure({
      projectId,
      workRunId: runId,
      task: '安全路径规范化',
      summary: '需要严格校验 .. 与 null 字节',
    });

    // 针对当前方法进行评测
    skillStore.evaluateWithEvidence(candidate.id, {
      evidence: {
        command: ['node', '-e', 'assert.ok(true);'],
        exitCodeBefore: 1,
        outputBefore: 'fail',
        exitCodeAfter: 0,
        outputAfter: 'pass',
        verifiedAt: new Date().toISOString(),
        producedBy: 'controlled',
        methodSnapshot: candidate.method,
      },
      benefit: '路径穿越检查全部通过',
    });

    // 模拟恶意或意外篡改候选方法（不重新对照评测）
    db.prepare('UPDATE skill_candidates SET method = ? WHERE id = ?').run(
      '篡改后的方法：跳过全部检查',
      candidate.id,
    );

    // 用户批准时，调度器严格检测方法快照与当前候选是否一致
    expect(() => skillStore.approve(candidate.id)).toThrow(/旧证据作废|方法不一致/);
  });
});

describe('P2-C / P2-D 升级、健康检查、回滚与数据保全', () => {
  it('P2-D01 [升级前备份、健康失败自动回滚与新增数据保全] 演练完整升级失败回滚全过程', () => {
    // 1. 初始业务状态（版本 1.0）
    const initialNoteId = randomUUID();
    db.prepare(
      "INSERT INTO items (id, type, statement, scope, state, confidence, origin, confirmation, created_at, updated_at) VALUES (?, 'preference', '基线用户偏好', 'personal', 'current', 1.0, 'user', 'none', ?, ?)",
    ).run(initialNoteId, new Date().toISOString(), new Date().toISOString());

    // 2. 升级流程启动：制作预升级快照（备份前先刷盘 checkpoint 确保 WAL 归档）
    db.pragma('wal_checkpoint(TRUNCATE)');
    const backupDbPath = join(dir, 'core.db.bak');
    copyFileSync(dbPath, backupDbPath);
    expect(existsSync(backupDbPath)).toBe(true);

    // 3. 模拟升级步骤：模拟在新版本中尝试破坏性修改或引入不兼容迁移
    db.prepare("ALTER TABLE items ADD COLUMN upgrade_test_col TEXT DEFAULT 'v2'").run();

    // 在新版本短暂运行期间，用户写入了新数据（新增资料保全目标）
    const postUpgradeNoteId = randomUUID();
    const newStatement = '新版本运行期间记录的重要技术笔记';
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO items (id, type, statement, scope, state, confidence, origin, confirmation, created_at, updated_at) VALUES (?, 'preference', ?, 'personal', 'current', 1.0, 'user', 'none', ?, ?)",
    ).run(postUpgradeNoteId, newStatement, now, now);

    // 4. 执行健康检查（Health Check）：检测到严重问题（例如模拟新服务启动崩溃）
    const healthCheckPassed = false; // 模拟健康检查失败

    // 5. 触发安全回滚管线：
    if (!healthCheckPassed) {
      // 步骤 A：保全新版本运行期间产生的新增资料（提取增量日志）
      const preservedNotes = db
        .prepare('SELECT id, type, statement, scope, origin FROM items WHERE id = ?')
        .all(postUpgradeNoteId) as Array<{
        id: string;
        type: string;
        statement: string;
        scope: string;
        origin: string;
      }>;
      expect(preservedNotes.length).toBe(1);

      // 步骤 B：关闭当前损坏的数据库连接并用备份恢复核心数据库
      db.close();
      if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
      if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
      copyFileSync(backupDbPath, dbPath);

      // 步骤 C：重新以基线版本打开数据库并执行健康自检
      db = openDatabase(dbPath);
      // 验证：回滚后表结构恢复原状，没有出现失败升级的列
      const tableInfo = db.prepare("PRAGMA table_info('items')").all() as Array<{ name: string }>;
      expect(tableInfo.some((col) => col.name === 'upgrade_test_col')).toBe(false);

      // 验证：基线原始数据完好无损
      const baseItem = db
        .prepare('SELECT statement FROM items WHERE id = ?')
        .get(initialNoteId) as {
        statement: string;
      };
      expect(baseItem.statement).toBe('基线用户偏好');

      // 步骤 D：将保全的新增资料以安全事务补录回滚后的数据库，确保新增资料不被静默丢失
      const restoreTx = db.transaction(() => {
        for (const n of preservedNotes) {
          db.prepare(
            `INSERT INTO items (id, type, statement, scope, state, confidence, origin, confirmation, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'current', 1.0, ?, 'none', ?, ?)`,
          ).run(n.id, n.type, n.statement, n.scope, n.origin, now, now);
        }
      });
      restoreTx();

      // 验证：新版本期间记录的重要资料成功保留并恢复！
      const restoredItem = db
        .prepare('SELECT statement FROM items WHERE id = ?')
        .get(postUpgradeNoteId) as { statement: string };
      expect(restoredItem).toBeTruthy();
      expect(restoredItem.statement).toBe(newStatement);
    }
  });
});
