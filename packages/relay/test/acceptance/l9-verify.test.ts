/**
 * L9 验收测试（三）：规划棒之后的核对（规格条件 3，对应契约第 6 条）。
 *
 * 逐条对应（都是合成仓库：临时裸仓库当 origin、整合方一个克隆、开发一个克隆；先在整合方克隆里
 * 造出这一棒的提交再推 main，然后调 `verifyTurn`）：
 * - (a) 主表末尾加 2 行（一行「待领」、一行「等用户：…」），只改 `docs/` → 不停；
 * - (b) 改了 `packages/` 下（以及仓库根上）的文件 → 停，`plan-touched-code`；
 * - (c) 改了已有一行的状态 → `plan-changed-rows`；
 * - (d) 加了 4 行 → `plan-changed-rows`（正好 3 行则放行）；
 * - (e) 新加的行状态是「进行中（dev）」→ `plan-changed-rows`；
 * - (f) 删了已有的一行 → `plan-changed-rows`。
 *
 * 另有一条从命令行走一遍「越界就停下」：替身顺手改了 `packages/` 下的文件 → `relay once` 之后
 * `stoppedReason` 是「第 N 棒越界（integrator）：…」，并给假飞书发了一条 stopped。
 *
 * 不调真模型、不连 GitHub。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTurn } from '../../src/index.js';
import type { RelayConfig, RelayState, Turn } from '../../src/index.js';
import { formatEvent } from '../../src/notify/feishu.js';
import { addRows, DONE_ROWS, fakeFeishu, makeL9World, type World } from './l9-harness.js';

const worlds: World[] = [];
const closers: Array<() => Promise<void>> = [];
const world = (opts: Parameters<typeof makeL9World>[0] = {}) => {
  const w = makeL9World(opts);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

const PLAN_TURN: Turn = {
  role: 'integrator',
  kind: 'integrator-plan',
  taskId: 'plan',
  task: '找下一批活',
  status: 'queue-empty',
};

function setup() {
  const w = world();
  const base = w.originSha('main');
  const config = JSON.parse(readFileSync(join(w.dataDir, 'config.json'), 'utf8')) as RelayConfig;
  const state: RelayState = { stoppedReason: null, pausedUntil: {}, turns: 1 };
  state.mainShaAtTurnStart = base;
  return { w, config, state, base };
}

/** 改整合方克隆里的队列文件（保留末尾换行）。 */
function editQueue(dir: string, change: (md: string) => string) {
  const p = join(dir, 'docs', '委派', '队列.md');
  writeFileSync(p, change(readFileSync(p, 'utf8')), 'utf8');
}

describe('条件 3：规划棒的核对', () => {
  it('(a) 末尾加 2 行、只改 docs/ → 不越界', async () => {
    const s = setup();
    s.w.commitPushInInteg('规划：排两件', (dir) => {
      editQueue(dir, (md) =>
        addRows(md, [
          { no: '73', task: 'L11 合成的第一件', status: '待领' },
          { no: '74', task: 'L12 合成的第二件', status: '等用户：要不要这样排' },
        ]),
      );
      writeFileSync(join(dir, 'docs', '委派', 'L11-合成规格.md'), '# 合成的规格\n', 'utf8');
      writeFileSync(
        join(dir, 'docs', '三周任务单.md'),
        '# 三周任务单\n\n合成的任务单：这次排了两件。\n',
        'utf8',
      );
    });
    const r = await verifyTurn(PLAN_TURN, s.config, s.state);
    expect(r.violations).toEqual([]);
  }, 120_000);

  it('(b) 改了 packages/ 下的文件 → plan-touched-code', async () => {
    const s = setup();
    s.w.commitPushInInteg('规划：顺手改了代码', (dir) => {
      writeFileSync(join(dir, 'packages', 'core', 'src', 'chain-plan.ts'), 'export const x = 1;\n');
    });
    const r = await verifyTurn(PLAN_TURN, s.config, s.state);
    expect(r.violations).toContain('plan-touched-code');
    expect(r.violations).not.toContain('plan-changed-rows');
  }, 120_000);

  it('(b) 改了仓库根上的文件（docs/ 以外都算）→ plan-touched-code', async () => {
    const s = setup();
    s.w.commitPushInInteg('规划：顺手改了 AGENTS', (dir) => {
      writeFileSync(join(dir, 'AGENTS.md'), '# 合成的 AGENTS（被改了）\n', 'utf8');
    });
    const r = await verifyTurn(PLAN_TURN, s.config, s.state);
    expect(r.violations).toContain('plan-touched-code');
  }, 120_000);

  it('(c) 改了已有一行的状态 → plan-changed-rows', async () => {
    const s = setup();
    s.w.commitPushInInteg('规划：动了已有的行', (dir) => {
      editQueue(dir, (md) => md.replace('| 已完成（2026-10-22） |', '| 待复审（整合方） |'));
    });
    const r = await verifyTurn(PLAN_TURN, s.config, s.state);
    expect(r.violations).toContain('plan-changed-rows');
  }, 120_000);

  it('(d) 加了 4 行 → plan-changed-rows；正好 3 行放行', async () => {
    const four = setup();
    four.w.commitPushInInteg('规划：排了四件', (dir) => {
      editQueue(dir, (md) =>
        addRows(
          md,
          [73, 74, 75, 76].map((no) => ({
            no: String(no),
            task: `L${no} 合成的一件`,
            status: '待领',
          })),
        ),
      );
    });
    const bad = await verifyTurn(PLAN_TURN, four.config, four.state);
    expect(bad.violations).toContain('plan-changed-rows');

    const three = setup();
    three.w.commitPushInInteg('规划：排了三件', (dir) => {
      editQueue(dir, (md) =>
        addRows(
          md,
          [73, 74, 75].map((no) => ({
            no: String(no),
            task: `L${no} 合成的一件`,
            status: '待领',
          })),
        ),
      );
    });
    const ok = await verifyTurn(PLAN_TURN, three.config, three.state);
    expect(ok.violations).toEqual([]);
  }, 120_000);

  it('(e) 新加的行状态是「进行中（dev）」→ plan-changed-rows', async () => {
    const s = setup();
    s.w.commitPushInInteg('规划：加了一行不该加的状态', (dir) => {
      editQueue(dir, (md) =>
        addRows(md, [{ no: '73', task: 'L11 合成的一件', status: '进行中（dev）' }]),
      );
    });
    const r = await verifyTurn(PLAN_TURN, s.config, s.state);
    expect(r.violations).toContain('plan-changed-rows');
  }, 120_000);

  it('(f) 删了已有的一行 → plan-changed-rows', async () => {
    const s = setup();
    s.w.commitPushInInteg('规划：删了一行', (dir) => {
      editQueue(dir, (md) =>
        md
          .split('\n')
          .filter((l) => !l.includes('L8 合成的一行'))
          .join('\n'),
      );
    });
    const r = await verifyTurn(PLAN_TURN, s.config, s.state);
    expect(r.violations).toContain('plan-changed-rows');
  }, 120_000);
});

describe('条件 3 / 契约第 6 条：越界就停下并发 stopped', () => {
  it('替身改了 packages/ → stoppedReason 写清第几棒、谁越界、哪一条；飞书发一条 stopped', async () => {
    const fake = await fakeFeishu();
    closers.push(fake.close);
    const w = world({ rows: DONE_ROWS, planPerDay: 2, feishu: fake });
    w.writePlan({
      code: [{ file: 'packages/core/src/chain-plan.ts', content: 'export const x = 1;\n' }],
      message: '规划：顺手改了代码',
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const st = w.state() as { stoppedReason?: string };
    expect(st.stoppedReason).toContain('第 1 棒越界（integrator）');
    expect(st.stoppedReason).toContain('plan-touched-code');
    const stopped = fake.texts.filter((t) => t.includes('停下来了'));
    expect(stopped).toEqual([
      formatEvent({
        kind: 'stopped',
        reason: st.stoppedReason ?? '',
        taskId: 'plan',
        task: '找下一批活',
      }),
    ]);
    expect(w.ledger()).toHaveLength(1);
  }, 120_000);
});
