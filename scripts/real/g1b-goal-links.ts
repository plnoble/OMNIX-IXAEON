/**
 * G1b 真机检查（统筹 2026-10-27 任务书 §4：Goal ↔ Task 关联与 weighted progress）。
 *
 * 与 G1a 同一套路：真实 SQLite 文件 + 草案 SQL，不登记迁移、不替代迁移验收。
 * 重点不是「接口能调通」，而是**统筹 §4.3 的加权规则真的成立**：
 *   直接任务权重 + 直接子目标 parent_weight；
 *   子目标内部任务**不得再次计入父目标**（不递归、不重复计数）。
 *
 * 跑法：node scripts/real/run-batch.mjs scripts/real/g1b-goal-links.ts
 * 隐私：临时目录遮成 <临时目录>；只输出状态名与数字。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type CoreDatabase } from '../../packages/core/src/index.js';
import { GoalStore } from '../../packages/core/src/goals/index.js';
import {
  linkTask,
  noteTaskFailure,
  recompute,
  unlinkTask,
} from '../../packages/core/src/goals/links.js';
import { TodoStore } from '../../packages/core/src/storage/todoStore.js';
import { ResearchStore } from '../../packages/core/src/research/researchStore.js';

const work = mkdtempSync(join(tmpdir(), 'ixa-g1b-real-'));
const log = (...args: unknown[]) =>
  console.log(
    ...args.map((v) => (typeof v === 'string' ? v.replaceAll(work, '<临时目录>') : String(v))),
  );

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const openDraftDb = (): CoreDatabase => {
  const db = openDatabase(join(work, 'ixaeon.db'));
  migrate(db);
  return db;
};

const main = (): void => {
  log('== G1b 真机检查：Goal↔Task 关联与 weighted progress（真实 SQLite）==');
  const db = openDraftDb();
  const goals = new GoalStore(db);
  const todos = new TodoStore(db);

  // ── 1. 真值来源：任务状态一律以自带 Store 为准（不新增后门）
  const parent = goals.create({ title: '合成目标：父目标', via: 'ui', progressMode: 'weighted' });
  const t1 = todos.add({ title: '合成任务一' });
  const t2 = todos.add({ title: '合成任务二' });
  check('TodoStore.add 直接是 accepted', t1.status === 'accepted', `status=${t1.status}`);

  linkTask(db, parent.id, { kind: 'todo', refId: t1.id, weight: 2 });
  linkTask(db, parent.id, { kind: 'todo', refId: t2.id, weight: 1 });
  let p = recompute(db, parent.id);
  check('刚绑定时进度 0', p.progress === 0, `progress=${p.progress}`);

  // ── 2. 完成一个任务，按权重算：2/(2+1) = 67
  todos.complete(t1.id);
  p = recompute(db, parent.id);
  check('完成权重 2 的任务后进度 67（2/3）', p.progress === 67, `progress=${p.progress}`);

  // ── 3. 同一状态重复 recompute 不重复记事件
  const evBefore = (
    db
      .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE goal_id=? AND kind='progress'")
      .get(parent.id) as { n: number }
  ).n;
  recompute(db, parent.id);
  const evAfter = (
    db
      .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE goal_id=? AND kind='progress'")
      .get(parent.id) as { n: number }
  ).n;
  check(
    '状态没变时 recompute 不重复记 progress 事件',
    evBefore === evAfter,
    `${evBefore}→${evAfter}`,
  );

  // ── 4. 统筹 §4.3 核心：子目标内部任务不得再次计入父目标
  const child = goals.create({
    title: '合成目标：子目标',
    via: 'ui',
    progressMode: 'weighted',
    parentGoalId: parent.id,
    parentWeight: 3,
  });
  const t3 = todos.add({ title: '合成任务三（挂在子目标下）' });
  linkTask(db, child.id, { kind: 'todo', refId: t3.id, weight: 100 });
  todos.complete(t3.id);
  const childRow = recompute(db, child.id);
  check('子目标自己算到 100', childRow.progress === 100, `progress=${childRow.progress}`);

  p = recompute(db, parent.id);
  // 按实现规则手算（links.ts:154-167）：total = 2+1(直接任务) + 3(子目标 parent_weight) = 6；
  // done = 2（t1 完成）+ 0（子目标仍 active）= 2 → round(100*2/6) = 33。
  // 子目标内部那个 weight=100 的任务**完全不进父目标的分母**——这就是 §4.3 的不递归。
  check(
    '子目标内部任务不进父目标分母（子目标未 completed 时只计 parent_weight=3）',
    p.progress === 33,
    `progress=${p.progress}`,
  );

  // ── 5. 子目标 completed 后，才按 parent_weight 记入父目标一次
  goals.transition(child.id, 'completed', { decidedBy: 'user', reason: '合成：子目标收工' });
  p = recompute(db, parent.id);
  // total = 2+1+3 = 6, done = 2 + 3 = 5 → 83
  check(
    '子目标 completed 后按 parent_weight 计入父目标一次',
    p.progress === 83,
    `progress=${p.progress}`,
  );

  // ── 6. 不递归：子目标里那 100 权重的任务不会再单独进父目标
  const parentTotal = (
    db.prepare('SELECT COUNT(*) AS n FROM goal_links WHERE goal_id=?').get(parent.id) as {
      n: number;
    }
  ).n;
  check('父目标只认自己的直接链接（2 条）', parentTotal === 2, `links=${parentTotal}`);

  // ── 7. 拒绝子目标走 link 表达（只能用 parent_goal_id）
  let subgoalRejected = false;
  try {
    linkTask(db, parent.id, { kind: 'todo', refId: `goal:${child.id}` });
  } catch {
    subgoalRejected = true;
  }
  check('用 refId="goal:xxx" 表达子目标被拒（须用 parent_goal_id）', subgoalRejected);

  // ── 8. 一个任务可同时服务多个 Goal
  linkTask(db, child.id, { kind: 'todo', refId: t1.id, weight: 1 });
  recompute(db, child.id);
  // 断言看「链接真的建成了」而不是看进度：t1 早已完成，挂上去 total 与 done 各 +1，
  // 进度仍是 100——进度不变并不等于关联失败。
  const shared = (
    db
      .prepare('SELECT COUNT(DISTINCT goal_id) AS n FROM goal_links WHERE kind=? AND ref_id=?')
      .get('todo', t1.id) as { n: number }
  ).n;
  check('同一 Todo 可同时服务多个 Goal（不被独占）', shared === 2, `distinct_goals=${shared}`);

  // ── 9. task failure 只是 observation：写事件 + watch，不等于 Goal blocked
  const goalForFail = goals.create({
    title: '合成目标：失败观察',
    via: 'ui',
    progressMode: 'weighted',
  });
  const t4 = todos.add({ title: '合成任务四' });
  linkTask(db, goalForFail.id, { kind: 'todo', refId: t4.id, weight: 1 });
  let todoFailRejected = false;
  try {
    // Todo 没有失败态：对它报失败必须被拒（不许造无校验后门）
    noteTaskFailure(db, goalForFail.id, { kind: 'todo', refId: t4.id });
  } catch {
    todoFailRejected = true;
  }
  check('对没有失败态的 Todo 报失败被拒（不造后门）', todoFailRejected);
  check(
    'Goal 仍 active（失败观察不机械转 blocked）',
    goals.get(goalForFail.id)?.status === 'active',
    `status=${goals.get(goalForFail.id)?.status}`,
  );

  // ── 10. research_topic（整合方改，用户 2026-10-29 定）：可以挂，但不进 weighted 的分子分母，挂着不让重算出错；
  //        挂不存在的话题照样被拒。原来这一步挂的是不存在的话题，「被拒」是因为话题不存在，没验到口径。
  const topic = new ResearchStore(db).createTopic({
    question: '合成研究话题：要不要加一台节点',
    publicDescription: 'g1b real check topic',
    sources: [],
  });
  todos.complete(t4.id); // 先让「之前」是 100：研究话题（权重 5）要是进了分母就会掉到 17
  const progressBeforeTopic = recompute(db, goalForFail.id).progress;
  check('挂研究话题之前进度 100', progressBeforeTopic === 100, `progress=${progressBeforeTopic}`);
  linkTask(db, goalForFail.id, { kind: 'research_topic', refId: topic.id, weight: 5 });
  let recomputeOk = true;
  let progressWithTopic = -1;
  try {
    progressWithTopic = recompute(db, goalForFail.id).progress;
  } catch {
    recomputeOk = false;
  }
  check('研究话题能挂上、挂着重算不出错', recomputeOk);
  check(
    '研究话题不进分子分母（进度和挂之前一样）',
    progressWithTopic === progressBeforeTopic,
    `${progressBeforeTopic}→${progressWithTopic}`,
  );
  let missingTopicRejected = false;
  try {
    linkTask(db, goalForFail.id, { kind: 'research_topic', refId: 'nonexistent' });
  } catch {
    missingTopicRejected = true;
  }
  check('挂不存在的研究话题被拒', missingTopicRejected);

  // ── 11. unlink 后进度回落
  unlinkTask(db, parent.id, { kind: 'todo', refId: t2.id });
  const afterUnlink = recompute(db, parent.id);
  check(
    '解绑未完成任务后进度上升（分母变小）',
    afterUnlink.progress > p.progress,
    `${p.progress}→${afterUnlink.progress}`,
  );
  db.close();

  // ── 12. 重启后链接与进度都在
  const db2 = openDraftDb();
  const p2 = new GoalStore(db2).get(parent.id);
  check('重启后父目标进度保持', p2?.progress === afterUnlink.progress, `progress=${p2?.progress}`);
  check('重启后子目标关系还在', new GoalStore(db2).childrenOf(parent.id).length === 1);
  db2.close();
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
    /* Windows 句柄清理失败不影响结论 */
  }
}

log(failures === 0 ? '== 真机检查通过（G1b 段）==' : `== 真机检查失败：${failures} 项 ==`);
process.exitCode = failures === 0 ? 0 : 1;
