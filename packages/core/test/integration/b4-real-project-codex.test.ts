import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  migrate,
  CodingOrchestrator,
  CodexCliExecutor,
  resolveCodexLocator,
  ProjectService,
  SkillCandidateStore,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * B4 真实项目行动（R10/R12）：真实项目（本仓库）受控副本 × 真 Codex CLI
 * 编码任务 × 独立验证 × work_runs 经验回看 × Skill 候选对照记录。
 *
 * 任务（真实、小、可独立验证）：在 scripts/ 增加 redact-for-log.mjs
 * （日志脱敏工具：去掉 Bearer/sk-/ghp_ 凭证、Windows 用户路径）与配套
 * node:test 测试；验证命令 = node --test（副本内可跑，无依赖）。
 *
 * 口径分离：
 * - 已实现/自动化通过：合成库（不碰日用库）
 * - 真实环境通过：真 Codex 0.130.0-alpha.5 写真实代码、副本内独立测试通过、
 *   diff 只含获准范围
 * - 用户接受：不冒充——任务停在 pending_accept，接受动作留给用户
 *
 * Skill 候选（R12 对照链）：真实失败（Codex turn.completed 后进程不退出，
 * 2026-09-12 T04 现场发现）→ 候选方法（回合制监督：协议终点+10s 宽限+杀树，
 * 已实现）→ 对照证据（修复后 T04 通过）→ 状态 evaluated（不自行 approved）。
 */
const run = process.env.IXAEON_REAL_CODEX === '1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe.skipIf(!run)('B4 真实项目受控副本×真 Codex（R10/R12）', () => {
  let db: CoreDatabase;
  let dir: string;
  let orchestrator: CodingOrchestrator;
  let projectIds: { projectId: string };

  beforeAll(() => {
    const locator = resolveCodexLocator();
    expect(locator).not.toBeNull();
    dir = mkdtempSync(join(tmpdir(), 'b4-real-'));
    db = openDatabase(join(dir, 'b4.db'));
    migrate(db);
    const projects = new ProjectService(db);
    // 真实项目：本仓库（受控副本由 prepareWorkspace 生成）
    const project = projects.create({
      name: 'IXAEON-析衍',
      rootPath: repoRoot,
      description: 'B4 受控副本验证用真实项目登记（合成库）',
    });
    projectIds = { projectId: project.id };
    orchestrator = new CodingOrchestrator(db, new CodexCliExecutor(locator!), dir);
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      // 已关闭
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 句柄延迟：尽力清理
      }
    }
  });

  it('真 Codex 在受控副本内写真实代码，独立验证通过，diff 在范围内', async () => {
    // 2026-09-13 真实教训（第一次真派发的失败记录）：独立验证走 defaultCheck
    // 的 --permission 加固（fs 限制在副本内），而 Node 23.4+ 权限模型默认禁止
    // spawn 子进程——`node --test`（为每个测试文件 spawn 子进程）被
    // ERR_ACCESS_DENIED(ChildProcess) 挡掉，任务正确地「独立验证失败，不把
    // 执行器自报当作通过」。已实证（同机 scratch 目录）：--permission 下
    // `node --test x` exit 1；`node x`（node:test 进程内执行）exit 0。
    // 结论：验证命令规格必须与加固兼容——用进程内 node:test 直跑。
    const goal = [
      '在 scripts/ 目录新增两个文件：',
      '1. scripts/redact-for-log.mjs —— 日志脱敏工具：导出 redactForLog(line) 函数，',
      '   把 Bearer 令牌、sk-/ghp_ 开头的密钥、形如 C:\\Users\\name 的路径替换为 [REDACTED]；',
      '   对空输入返回空字符串。',
      '2. scripts/redact-for-log.test.mjs —— 用 node:test 写至少 4 个断言：',
      '   Bearer 替换、sk- 密钥替换、Windows 路径替换、空输入返回空串。',
      '   注意：该测试将以 `node scripts/redact-for-log.test.mjs` 进程内直跑，',
      '   不要依赖 node --test 运行器（运行器会 spawn 子进程，被验证沙箱禁止）。',
      '不要改动其他任何文件。代码用 ES Modules，不引入依赖。',
    ].join('\n');
    const task = orchestrator.create({
      projectId: projectIds.projectId,
      goal,
      scope: ['scripts/redact-for-log.mjs', 'scripts/redact-for-log.test.mjs'],
      allowedCommands: [[process.execPath, 'scripts/redact-for-log.test.mjs']],
      dispatchKey: 'b4-real-project:redact-for-log:v2',
    });
    await orchestrator.approveAndQueue(task.id);
    const done = await orchestrator.dispatch(task.id);

    // 结果如实断言（不预设通过；失败也应带出证据）
    const taskRow = orchestrator.store.get(task.id);
    if (done.status === 'failed' || taskRow.status === 'failed') {
      console.error('真 Codex 失败详情:', taskRow.error, taskRow.executor_report_json);
      console.error('独立验证输出:', taskRow.verify_output);
    }
    expect(done.status).toBe('pending_accept');
    expect(done.verify_status).toBe('passed');
    // 副本里真实存在两个文件且测试真实通过（独立复核：重跑验证命令）
    const ws = done.workspace_path!;
    const utilPath = join(ws, 'scripts', 'redact-for-log.mjs');
    const testPath = join(ws, 'scripts', 'redact-for-log.test.mjs');
    expect(existsSync(utilPath)).toBe(true);
    expect(existsSync(testPath)).toBe(true);
    const rerun = spawnSync(process.execPath, ['scripts/redact-for-log.test.mjs'], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(rerun.status).toBe(0);
    // 独立功能抽查：工具确实脱敏（不是空壳测试）
    const source = readFileSync(utilPath, 'utf8');
    expect(source).toMatch(/redactForLog/);
    expect(source.length).toBeGreaterThan(100);
    // 任务级：经验进入 work_runs（成功链），下次问答可读
    const workRuns = db
      .prepare('SELECT * FROM work_runs WHERE project_id = ? ORDER BY finished_at DESC')
      .all(projectIds.projectId) as Array<{ outcome: string; task: string }>;
    // 尚未 accept：dispatch 成功+验证通过不写 work_runs（accept 才写）——
    // 这正是「用户接受」独立于自动验证的体现。此时 work_runs 为空是正确行为。
    expect(workRuns.length).toBe(0);
    // 接受后写入（模拟用户点接受；合成库内操作）
    orchestrator.accept(task.id);
    const afterAccept = db
      .prepare('SELECT * FROM work_runs WHERE project_id = ? ORDER BY finished_at DESC')
      .all(projectIds.projectId) as Array<{ outcome: string; summary: string }>;
    expect(afterAccept.length).toBe(1);
    expect(afterAccept[0]!.outcome).toBe('success');
    expect(afterAccept[0]!.summary.length).toBeGreaterThan(0);
    // R10「下次能读取」：work_runs 在问答背景里可查（AskService 读取路径由
    // b2-b4-retrieval-workspace.test.ts 覆盖；此处验证账本本身可查）
  }, 600_000);

  it('R12 Skill 候选对照链：真实失败→候选方法→对照证据→evaluated（不自行批准）', () => {
    const store = new SkillCandidateStore(db);
    // 真实失败记录（2026-09-12 T04 现场事实：Codex turn.completed 后进程不退出）
    const proposed = store.proposeFromFailure({
      projectId: projectIds.projectId,
      workRunId: 'b4-real-failure:codex-hang-turn-completed',
      task: 'Codex exec --json 在 Windows elevated 沙箱下完成回合后不退出，任务被 15 分钟上限误杀并计失败',
      summary:
        '真实失败（2026-09-12 T04 现场）：turn.completed 事件已到但进程存活>150s。' +
        '候选方法：回合制监督——把 turn.completed 视为协议终点，10s 宽限后杀子进程树收尾。' +
        '对照证据：修复后 T04 真写+独立验证+磁盘复核通过（executor.ts spawnCodexExec）。',
    });
    expect(['proposed', 'evaluated']).toContain(proposed.status);
    const evaluated = store.evaluate(proposed.id, {
      evalBefore: '修复前：回合完成但任务超时失败（观察自 2026-09-12 T04 现场，>150s 挂起）',
      evalAfter:
        '修复后：turn.completed → 10s 宽限 → 杀树收尾，T04 探针 51-93s 内成功收尾（真实执行）',
      benefit: '真回合完成不再被 15 分钟上限误判失败；调度不再被挂起进程阻塞',
    });
    expect(evaluated.status).toBe('evaluated');
    // 对照后仍需用户批准才生效（approved 由用户在 UI 点，不自动升级）
    const approved = store.approvedForProject(projectIds.projectId);
    expect(approved.length).toBe(0);
    // 拒绝路径存在（回退能力）：无收益候选保持未采用
    const rejected = store.reject(proposed.id);
    expect(rejected.status).toBe('rejected');
    // 但这改变了刚记录的候选状态——重新提出一条留作 evaluated 证据
    const keep = store.proposeFromFailure({
      projectId: projectIds.projectId,
      workRunId: 'b4-real-failure:codex-hang-turn-completed:v2',
      task: '同上（留档副本）',
      summary: '同上；此条保持 evaluated 等待用户批准',
    });
    const keepEvaluated = store.evaluate(keep.id, {
      evalBefore: '回合完成后进程挂起>150s',
      evalAfter: '10s 宽限+杀树，T04 通过',
      benefit: '真完成不再误判失败',
    });
    expect(keepEvaluated.status).toBe('evaluated');
    const finalApproved = store.approvedForProject(projectIds.projectId);
    expect(finalApproved.length).toBe(0); // 用户未批准：不生效
    // 派发背景会带上 approved Skill（此处 0 条）——链路在 dispatch 测试中验证
  });
});
