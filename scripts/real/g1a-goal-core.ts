/**
 * G1a 真机检查（统筹 2026-10-27 任务书 §6 组合场景里属于 Goal 核心的那一段）。
 *
 * 为什么要有这个脚本：G1a 交付说明一直写「真机没跑」，而 AGENTS 的规矩是**没跑的不能合并**。
 * 本支的实现不需要 UI、不需要真模型、不需要迁移登记，用**真实 SQLite 文件 + 草案 SQL** 就能真跑，
 * 所以不该继续拿「等实现支」当理由空着。
 *
 * 诚实边界（别把这份输出当成应用端到端）：
 * - 这是**核心逻辑在真实库上的真机跑**，不是应用界面端到端——实测 `packages/core/src/index.ts`
 *   尚未再导出 `goals/`（只有测试 import `src/goals/index.js`），即产品入口还没接上；
 * - Plan/Step、绑真实 Todo、weighted progress、task failure→watch、advanceStep 属 G1b/G1c，
 *   等它们并入 main 后由组合脚本补（见交付说明 §6 依赖）。
 *
 * 跑法：node scripts/real/run-batch.mjs scripts/real/g1a-goal-core.ts
 * 隐私：临时目录遮成 <临时目录>；只输出状态名与条数，不输出任何用户内容。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type CoreDatabase } from '../../packages/core/src/index.js';
import { GoalStore } from '../../packages/core/src/goals/index.js';
import { loadGoalDraft } from '../../packages/core/test/helpers/goalDraft.js';

const work = mkdtempSync(join(tmpdir(), 'ixa-g1a-real-'));
const log = (...args: unknown[]) =>
  console.log(
    ...args.map((v) => (typeof v === 'string' ? v.replaceAll(work, '<临时目录>') : String(v))),
  );

const dbPath = join(work, 'ixaeon.db');
let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** 打开带草案表的临时库（只开发用：不登记迁移、不替代迁移验收）。 */
const openDraftDb = (): CoreDatabase => {
  const db = openDatabase(dbPath);
  migrate(db);
  loadGoalDraft(db);
  return db;
};

const eventCount = (db: CoreDatabase): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM goal_events').get() as { n: number }).n;

const main = (): void => {
  log('== G1a 真机检查：Goal 核心链路（真实 SQLite 文件 + 草案 SQL）==');

  let db = openDraftDb();
  let goals = new GoalStore(db);

  // ── 1. 建 Goal：via 决定是否要用户确认（实现语义，先读代码再断言，不靠猜）
  const g = goals.create({ title: '合成目标：把周报自动化', description: '真机检查用', via: 'ui' });
  check(
    '界面亲手建的目标直接 active（via=ui 即用户确认）',
    g.status === 'active',
    `status=${g.status}`,
  );
  check('origin 默认 user', g.origin === 'user', `origin=${g.origin}`);
  check('confirmation 记为 ui', g.confirmation === 'ui', `confirmation=${g.confirmation}`);
  check('confirmed_at 有值', Boolean(g.confirmed_at));

  // ── 2. AI 提的目标：origin=agent + via=pending → proposed，必须等用户确认
  const proposal = goals.create({
    title: '合成目标：AI 提的想法',
    via: 'pending',
    origin: 'agent',
    fromConversationId: null,
  });
  check(
    'AI 提的目标是 proposed（不是 active）',
    proposal.status === 'proposed',
    `status=${proposal.status}`,
  );
  check('它的 origin 记为 agent', proposal.origin === 'agent');
  check('confirmation=pending', proposal.confirmation === 'pending');
  check('confirmed_at 为空（还没人确认）', proposal.confirmed_at === null);

  // AI 不许自己把它转正：未经确认的 proposed 不能直接 transition 到 active
  let bypassRejected = false;
  try {
    goals.transition(proposal.id, 'active', { decidedBy: 'agent', reason: 'AI 想自己转正' });
  } catch {
    bypassRejected = true;
  }
  check('未经用户确认，proposed 不能直跳 active（AI 无法绕过）', bypassRejected);

  const accepted = goals.confirm(proposal.id, { how: 'ui' });
  check('用户确认后转 active', accepted.status === 'active', `status=${accepted.status}`);
  check('confirmation 变成 ui', accepted.confirmation === 'ui');
  check('origin 仍是 agent（两维度正交，确认不改来源）', accepted.origin === 'agent');

  // ── 3. 子 Goal + 父权重
  const child = goals.create({
    title: '合成子目标：先做数据收集',
    via: 'ui',
    parentGoalId: g.id,
    parentWeight: 0.3,
  });
  check('子 Goal 的 parent_goal_id 指向父', child.parent_goal_id === g.id);
  check('子 Goal 的 parent_weight 记录为 0.3', child.parent_weight === 0.3);
  check(
    'childrenOf 能查到它',
    goals.childrenOf(g.id).some((c) => c.id === child.id),
  );

  // ── 4. 状态流转（合法路径）
  const paused = goals.transition(g.id, 'paused', { decidedBy: 'user', reason: '合成：等数据' });
  check('active → paused 合法', paused.status === 'paused');
  const resumed = goals.transition(g.id, 'active', { decidedBy: 'user', reason: '合成：继续' });
  check('paused → active 合法', resumed.status === 'active');

  let blockedWithoutReasonRejected = false;
  try {
    goals.transition(g.id, 'blocked', { decidedBy: 'user' });
  } catch {
    blockedWithoutReasonRejected = true;
  }
  check('转 blocked 必须给 blocked_reason（不给就拒）', blockedWithoutReasonRejected);

  const blocked = goals.transition(g.id, 'blocked', {
    decidedBy: 'user',
    reason: '需要用户拍板选哪个数据源',
  });
  check('active → blocked 合法', blocked.status === 'blocked');
  check('blocked_reason 被记下', Boolean(blocked.blocked_reason), blocked.blocked_reason ?? '');
  const unblocked = goals.transition(g.id, 'active', {
    decidedBy: 'user',
    reason: '合成：决定好了',
  });
  check('blocked → active 合法', unblocked.status === 'active');
  check('离开 blocked 后 blocked_reason 清空', unblocked.blocked_reason === null);

  // ── 5. 非法流转必须被拒
  const freshProposed = goals.create({ title: '合成非法探针', via: 'pending', origin: 'agent' });
  const illegalFromProposed: Array<'paused' | 'blocked' | 'completed'> = [
    'paused',
    'blocked',
    'completed',
  ];
  for (const to of illegalFromProposed) {
    let rejected = false;
    try {
      goals.transition(freshProposed.id, to, { decidedBy: 'user', reason: '合成：故意非法' });
    } catch {
      rejected = true;
    }
    check(`proposed → ${to} 被拒`, rejected);
  }

  const done = goals.transition(g.id, 'completed', { decidedBy: 'user', reason: '合成：真做完了' });
  check('active → completed 合法', done.status === 'completed');
  let reopenRejected = false;
  try {
    goals.transition(g.id, 'active', { decidedBy: 'user', reason: '合成：想复活' });
  } catch {
    reopenRejected = true;
  }
  check('completed → active 被拒（终态不可复活）', reopenRejected);

  // ── 6. 失败事务不留孤立 goal_event
  // 用**真正会失败**的路径来验证原子性：proposed 目标转 completed 被 ALLOWED 表挡下。
  // （原来这里用「completed + 空白 reason」当失败场景是错的——读完实现才知道
  //   reason 只对 blocked 必填，completed 配空白 reason 是合法成功路径。）
  const before = eventCount(db);
  const doomed = goals.create({ title: '合成失败事务探针', via: 'pending', origin: 'agent' });
  const afterCreate = eventCount(db);
  let failed = false;
  try {
    goals.transition(doomed.id, 'completed', { decidedBy: 'user', reason: '合成：非法跳级' });
  } catch {
    failed = true;
  }
  check('非法跳级确实抛错', failed);
  check('create 自身记了事件', afterCreate === before + 1, `before=${before} after=${afterCreate}`);
  check('被拒的 transition 不留事件', eventCount(db) === afterCreate, `now=${eventCount(db)}`);
  check(
    '被拒后目标状态没被改',
    goals.get(doomed.id)?.status === 'proposed',
    `status=${goals.get(doomed.id)?.status}`,
  );
  db.close();

  // ── 7. 重启（关库重开）：状态、子目标、事件全在
  db = openDraftDb();
  goals = new GoalStore(db);
  const reloaded = goals.get(g.id);
  check('重启后 Goal 还在', Boolean(reloaded));
  check('重启后状态仍是 completed', reloaded?.status === 'completed', `status=${reloaded?.status}`);
  check('重启后 origin=user 仍在', reloaded?.origin === 'user');
  check(
    '重启后子目标关系仍在',
    goals.childrenOf(g.id).some((c) => c.id === child.id),
  );
  check('重启后 AI 提的目标仍是 active+agent', goals.get(proposal.id)?.origin === 'agent');
  const restoredEvents = (
    db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id=?').get(g.id) as { n: number }
  ).n;
  check('重启后事件历史还在', restoredEvents > 0, `events=${restoredEvents}`);
  log(`   事件总数（所有目标合计）：${eventCount(db)}`);
  db.close();
};

try {
  main();
} catch (error) {
  log(`✗ 脚本异常：${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄可能还没放干净，清理失败不影响结论 */
  }
}

log(failures === 0 ? '== 真机检查通过（G1a 段）==' : `== 真机检查失败：${failures} 项 ==`);
process.exitCode = failures === 0 ? 0 : 1;
