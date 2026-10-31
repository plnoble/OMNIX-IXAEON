/**
 * G1c 真机检查（统筹 2026-10-27 任务书 §5：Plan / Step / Replan）。
 *
 * 与 G1a/G1b 同套路：真实 SQLite 文件 + 草案 SQL。重点验证 §5 那几条**容易做假**的要求：
 *   - 旧版本永久保留、新版产生后旧版 superseded + superseded_by 正确、同 Goal 只有一版 current；
 *   - Step ID 永久稳定；重排后 ID 集合/行数/依赖/绑定/状态全不变（**不是删了重建**）；
 *   - 重排用两阶段正数临时序号，撞 UNIQUE 不炸；
 *   - advanceStep：依赖没完成拒绝推进；满足后 pending→doing 且写 started_at；
 *   - Replan 不改 Goal 状态、不激活 proposed Goal。
 *
 * 跑法：node scripts/real/run-batch.mjs scripts/real/g1c-goal-plans.ts
 * 隐私：临时目录遮成 <临时目录>；只输出状态名、版本号与行数。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type CoreDatabase } from '../../packages/core/src/index.js';
import { GoalStore } from '../../packages/core/src/goals/index.js';
import { PlanStore } from '../../packages/core/src/goals/plans.js';
import { TodoStore } from '../../packages/core/src/storage/todoStore.js';

const work = mkdtempSync(join(tmpdir(), 'ixa-g1c-real-'));
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
  log('== G1c 真机检查：Plan/Step/Replan（真实 SQLite）==');
  const db = openDraftDb();
  const goals = new GoalStore(db);
  const plans = new PlanStore(db);

  const todos = new TodoStore(db);
  const realTodo = todos.add({ title: '合成：给步骤绑的真任务' });
  const goal = goals.create({ title: '合成目标：带方案的目标', via: 'ui' });

  // ── 1. v1 建版
  const v1 = plans.addVersion(goal.id, {
    reason: '合成：初始方案',
    assumptions: ['合成假设一'],
    steps: [{ title: '第一步' }, { title: '第二步' }, { title: '第三步' }],
  });
  check('v1 版本号为 1', v1.version === 1, `version=${v1.version}`);
  check('v1 是 current', v1.status === 'current', `status=${v1.status}`);
  const v1Steps = plans.stepsOf(goal.id, 1);
  check('v1 有三步', v1Steps.length === 3, `n=${v1Steps.length}`);
  check(
    'seq 从 1 递增',
    v1Steps.map((s) => s.seq).join(',') === '1,2,3',
    v1Steps.map((s) => s.seq).join(','),
  );
  const v1Ids = v1Steps.map((s) => s.id);
  check('每步都有稳定 id', new Set(v1Ids).size === 3);
  check(
    '新步骤状态是 pending',
    v1Steps.every((s) => s.status === 'pending'),
  );

  // ── 2. 依赖门控：第二步依赖第一步时，第二步不能先推进
  plans.setDeps(goal.id, 1, v1Ids[1]!, [v1Ids[0]!]);
  check('依赖写入成功', plans.depsOf(v1Ids[1]!).join(',') === v1Ids[0]);
  let depRejected = false;
  try {
    plans.advanceStep(v1Ids[1]!);
  } catch {
    depRejected = true;
  }
  check('依赖没完成时 advanceStep 被拒', depRejected);

  plans.advanceStep(v1Ids[0]!);
  const started = plans.stepsOf(goal.id, 1).find((s) => s.id === v1Ids[0])!;
  check('第一步推进后是 doing', started.status === 'doing', `status=${started.status}`);
  check('推进时写了 started_at', Boolean(started.started_at));

  plans.finishStep(v1Ids[0]!);
  const finished = plans.stepsOf(goal.id, 1).find((s) => s.id === v1Ids[0])!;
  check('finishStep 后是 done', finished.status === 'done', `status=${finished.status}`);
  plans.advanceStep(v1Ids[1]!);
  check(
    '依赖完成后第二步可推进',
    plans.stepsOf(goal.id, 1).find((s) => s.id === v1Ids[1])?.status === 'doing',
  );

  // ── 3. 重排：ID 集合/行数/依赖/绑定/状态全不变（不是删了重建）
  plans.bindStep(goal.id, 1, v1Ids[2]!, { kind: 'todo', refId: realTodo.id });
  const beforeReorder = plans.stepsOf(goal.id, 1);
  const snapshot = beforeReorder.map((s) => ({
    id: s.id,
    status: s.status,
    linkedKind: s.linked_kind,
    linkedId: s.linked_id,
    started: s.started_at,
  }));
  const reversed = [...beforeReorder].reverse().map((s) => s.id);
  plans.reorderSteps(goal.id, 1, reversed);
  const afterReorder = plans.stepsOf(goal.id, 1);

  check(
    '重排后行数不变',
    afterReorder.length === beforeReorder.length,
    `${beforeReorder.length}→${afterReorder.length}`,
  );
  check(
    '重排后 ID 集合不变',
    JSON.stringify([...afterReorder.map((s) => s.id)].sort()) ===
      JSON.stringify([...beforeReorder.map((s) => s.id)].sort()),
  );
  check('重排后顺序真的变了', afterReorder.map((s) => s.id).join() === reversed.join());
  check(
    '重排后 Step 状态没被重置',
    afterReorder.every((s) => {
      const old = snapshot.find((x) => x.id === s.id);
      return old && old.status === s.status && old.started === s.started_at;
    }),
  );
  check(
    '重排后 task 绑定没丢',
    afterReorder.find((s) => s.id === v1Ids[2])?.linked_id === realTodo.id,
  );
  check('重排后依赖没丢', plans.depsOf(v1Ids[1]!).join(',') === v1Ids[0]);

  // ── 4. v2 建版：旧版保留、superseded、superseded_by 指向新版
  const v2 = plans.addVersion(goal.id, {
    reason: '合成：需求变了，重规划',
    assumptions: [],
    steps: [{ title: '新的第一步' }],
  });
  check('v2 版本号为 2', v2.version === 2, `version=${v2.version}`);
  check('v2 是 current', v2.status === 'current');
  const v1After = plans.getPlan(goal.id, 1);
  check('v1 被标 superseded', v1After.status === 'superseded', `status=${v1After.status}`);
  check(
    'v1 的 superseded_by 指向 2',
    v1After.superseded_by === 2,
    `superseded_by=${v1After.superseded_by}`,
  );
  check('v1 的历史步骤行还在（旧版永久保留）', plans.stepsOf(goal.id, 1).length === 3);
  const currents = plans.plansOf(goal.id).filter((p) => p.status === 'current');
  check('同一 Goal 只有一版 current', currents.length === 1, `current=${currents.length}`);

  // ── 5. 历史版本只读：改 v1 的步骤必须被拒
  let historyReadonlyRejected = false;
  try {
    plans.advanceStep(plans.stepsOf(goal.id, 1).find((s) => s.status === 'pending')?.id ?? 'x');
  } catch {
    historyReadonlyRejected = true;
  }
  check('历史版本不可推进（只读）', historyReadonlyRejected);

  // ── 6. Replan 不改 Goal 状态
  check(
    'Replan 没改 Goal 状态（仍 active）',
    goals.get(goal.id)?.status === 'active',
    `status=${goals.get(goal.id)?.status}`,
  );

  // ── 7. 不激活 proposed Goal
  const proposed = goals.create({ title: '合成：AI 提的目标', via: 'pending', origin: 'agent' });
  plans.addVersion(proposed.id, {
    reason: '给提案也排个方案',
    assumptions: [],
    steps: [{ title: '试探步' }],
  });
  check(
    '给 proposed 目标排方案不会把它激活',
    goals.get(proposed.id)?.status === 'proposed',
    `status=${goals.get(proposed.id)?.status}`,
  );
  db.close();

  // ── 8. 重启后版本与步骤都在
  const db2 = openDraftDb();
  const plans2 = new PlanStore(db2);
  check('重启后 v2 仍是 current', plans2.getPlan(goal.id, 2).status === 'current');
  check('重启后 v1 的 3 步还在', plans2.stepsOf(goal.id, 1).length === 3);
  check('重启后 v2 的 1 步还在', plans2.stepsOf(goal.id, 2).length === 1);
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

log(failures === 0 ? '== 真机检查通过（G1c 段）==' : `== 真机检查失败：${failures} 项 ==`);
process.exitCode = failures === 0 ? 0 : 1;
