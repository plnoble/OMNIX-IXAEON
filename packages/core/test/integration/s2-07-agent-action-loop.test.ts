import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  ContextSelector,
  CodingOrchestrator,
  FakeCodingExecutor,
  SkillCandidateStore,
  runControlledVerifyCommand,
  CoreToolBroker,
  SearchService,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s2-07-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄释放延迟 */
  }
});

describe('S2-07 桌面办事全链路（目标→上下文选材→提案→批准→执行→独立验证→失败提炼→受控评测→上架）', () => {
  it('端到端跑通完整办事闭环与能力成长', async () => {
    const projects = new ProjectService(db);
    const items = new ItemService(db);
    const skills = new SkillCandidateStore(db);

    // 1. 创建项目与用户已确认目标
    const project = projects.create({
      name: '核心算法库',
      rootPath: dir,
      description: '离线测试项目',
    });
    const now = new Date().toISOString();
    const userGoalId = randomUUID();
    db.prepare(
      `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence, origin, observed_at, created_at, updated_at)
       VALUES (?, ?, 'project', 'goal', '实现安全的版本比对函数', NULL, 'current', 1.0, 'user', ?, ?, ?)`,
    ).run(userGoalId, project.id, now, now, now);

    // 显式披露给 model 受众
    items.grantDisclosure({ itemId: userGoalId, audience: 'model' });

    // 2. 上下文选材器基于生产路径选材
    const selector = new ContextSelector(db);
    const selection = selector.selectForQuestion('关于版本比对的目标', project.id);
    expect(selection.items.some((i) => i.id === userGoalId)).toBe(true);

    // 3. Broker 提炼任务提案（带自定义验证命令，不再死锁 note.txt）
    const search = new SearchService(db);
    const coding = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({
        claimedSuccess: true,
        files: { 'version.js': 'module.exports = { compare: () => 0 };' },
      }),
      dir,
    );
    const broker = new CoreToolBroker(
      db,
      items,
      search,
      coding,
      projects,
      {},
      {
        provider: 'brave',
        search: async () => ({ provider: 'brave', hits: [], query: '' }),
      },
    );

    // 目标工作区路径验证脚本：检查 version.js 包含 valid 关键字，否则 exit 2
    const verifyScript = [
      process.execPath,
      '-e',
      "const fs=require('fs');const c=fs.readFileSync('version.js','utf8');if(!c.includes('valid'))process.exit(2);",
    ];

    const draft = (await broker.invoke(
      'propose_task',
      {
        projectId: project.id,
        goal: '根据获准目标实现 version.js',
        scope: ['version.js'],
        verifyCommand: verifyScript,
      },
      { audience: 'model', runId: 'run-s2-07-test', projectId: project.id },
    )) as { id: string; status: string };
    expect(draft.id).toBeDefined();
    expect(draft.status).toBe('draft');

    // 4. 用户在桌面显式批准任务（批准具体范围与命令）
    const approved = await coding.approveAndQueue(draft.id);
    expect(approved.status).toBe('queued');

    // 5. 模拟一次在范围内但内容未达到验收条件的执行（产出 version.js 缺少 valid 关键字）
    const failingCoding = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({
        claimedSuccess: true,
        files: { 'version.js': 'module.exports = { broken: true };' },
      }),
      dir,
    );
    // 重启派发
    const runResult = await failingCoding.dispatch(approved.id);
    // 独立验证器核对后判定失败（缺少 valid 关键字 → exit 2）
    expect(runResult.status).toBe('failed');
    expect(runResult.verify_exit_code).toBe(2);

    // 6. 失败运行自动提炼 Skill 候选（带 created_from_work_run_id）
    const projectSkills = skills.list(project.id);
    expect(projectSkills.length).toBeGreaterThan(0);
    const candidate = projectSkills[0]!;
    expect(candidate.status).toBe('proposed');
    expect(candidate.created_from_work_run_id).toBeDefined();

    // 7. 受控评测执行器在真实沙箱中验证新方法：
    // 在真实测试工作区写入修复产物（包含 valid），再运行验证命令
    const evalDir = mkdtempSync(join(dir, 'eval-sandbox-'));
    writeFileSync(
      join(evalDir, 'version.js'),
      'module.exports = { valid: true, compare: () => 0 };',
      'utf8',
    );

    const evaluated = await skills.runControlledEvaluation(candidate.id, {
      method: '先创建 version.js 再执行编译流程',
      benefit: '通过独立验证器检查，退出码由 2 转为 0',
      command: verifyScript,
      cwd: evalDir,
      runVerify: (argv, cwd) => runControlledVerifyCommand(argv, cwd),
    });
    expect(evaluated.status).toBe('evaluated');
    expect(evaluated.eval_evidence_json).toContain('"producedBy":"controlled"');

    // 8. 批准该技能上架
    const approvedSkill = skills.approve(candidate.id, { version: evaluated.version });
    expect(approvedSkill.status).toBe('approved');

    // 9. 下次创建任务时自动带出获准 Skill
    const activeSkills = skills.approvedForProject(project.id);
    expect(activeSkills.some((s) => s.id === approvedSkill.id)).toBe(true);
  });
});
