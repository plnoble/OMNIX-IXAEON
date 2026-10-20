/**
 * L1 验收测试（二）：这一棒的交代（规格条件 4，对应规格第 5 条）。
 *
 * 逐条对应：三种 kind（integrator-review / developer-claim / developer-continue）的 `turns/<编号>/prompt.md`
 * 都要有——角色和名字（整合方 / 开发 agent，名字 dev）、「照 AGENTS.md 做」（整合方那份另加
 * 「照 docs/委派/整合方手册.md 做」）、只做这一行（序号、任务、当前状态原样在）、
 * 「只做这一件，做到它的停点就停，不要接着领别的」、停点是什么、最后一行的 RELAY-DONE 格式；
 * **不要把 AGENTS.md 的规矩另抄一份进来**。
 *
 * 纯函数 + 临时目录，不调模型。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnPrompt, writeTurnPrompt, type Turn } from '../../src/index.js';

const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l1-prompt-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const turn = (over: Partial<Turn> = {}): Turn => ({
  role: 'developer',
  kind: 'developer-claim',
  taskId: '60',
  task: 'L1 接力调度器核心：看队列定下一棒、跑一棒、核对有没有越界',
  status: '待领',
  ...over,
});

describe('条件 4：三种交代都要有的东西', () => {
  const kinds: Turn[] = [
    turn({
      role: 'integrator',
      kind: 'integrator-review',
      taskId: '1',
      status: '待复审（整合方）',
    }),
    turn({ kind: 'developer-claim' }),
    turn({ kind: 'developer-continue', taskId: '2', status: '进行中（dev）' }),
  ];

  it.each(kinds)('$kind：序号、任务、状态原样写进去', (t) => {
    const p = buildTurnPrompt(t, { turnNumber: 1 });
    expect(p).toContain(t.taskId);
    expect(p).toContain(t.task);
    expect(p).toContain(t.status);
  });

  it.each(kinds)('$kind：都写「照 AGENTS.md 做」和「只做这一件…」', (t) => {
    const p = buildTurnPrompt(t, { turnNumber: 1 });
    expect(p).toContain('AGENTS.md');
    expect(p).toContain('只做这一件，做到它的停点就停，不要接着领别的');
  });

  it('开发那两份：写清是「开发 agent」、名字 dev', () => {
    for (const t of [turn({ kind: 'developer-claim' }), turn({ kind: 'developer-continue' })]) {
      const p = buildTurnPrompt(t, { turnNumber: 1 });
      expect(p).toContain('开发');
      expect(p).toContain('dev');
    }
  });

  it('整合方那份：写清角色，并让它照 docs/委派/整合方手册.md 做', () => {
    const p = buildTurnPrompt(kinds[0]!, { turnNumber: 1 });
    expect(p).toContain('整合方');
    expect(p).toContain('docs/委派/整合方手册.md');
  });

  it('开发那份的停点写到 AGENTS.md 说的停点；整合方那份写到「复审完」', () => {
    const dev = buildTurnPrompt(turn(), { turnNumber: 1 });
    expect(dev).toContain('停点');
    const integ = buildTurnPrompt(kinds[0]!, { turnNumber: 1 });
    expect(integ).toMatch(/复审/);
    expect(integ).toMatch(/并入 main|把状态改成/);
  });

  it('最后一行要的是 RELAY-DONE <序号> <这一行现在的状态>', () => {
    for (const t of kinds) {
      const p = buildTurnPrompt(t, { turnNumber: 1 });
      expect(p).toContain(`RELAY-DONE ${t.taskId}`);
    }
  });

  it('不把 AGENTS.md 的规矩另抄一份进来', () => {
    for (const t of kinds) {
      const p = buildTurnPrompt(t, { turnNumber: 1 });
      expect(p).not.toContain('三条硬规矩');
      expect(p).not.toContain('300 行');
      expect(p).not.toContain('不许自己写自己的验收标准');
    }
  });
});

describe('条件 4 / 条件 5：交代写进 turns/<编号>/prompt.md', () => {
  it('写进 <数据目录>/turns/7/prompt.md，内容就是 buildTurnPrompt 那份', () => {
    const dataDir = mkTmp();
    const t = turn({ kind: 'developer-claim' });
    const path = writeTurnPrompt(t, { dataDir, turnNumber: 7 });
    expect(path).toBe(join(dataDir, 'turns', '7', 'prompt.md'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(buildTurnPrompt(t, { turnNumber: 7 }));
  });

  it('编号不同的两棒写在不同的目录里，互不覆盖', () => {
    const dataDir = mkTmp();
    const a = writeTurnPrompt(turn({ taskId: '1', task: '第一行的任务' }), {
      dataDir,
      turnNumber: 1,
    });
    const b = writeTurnPrompt(turn({ taskId: '2', task: '第二行的任务' }), {
      dataDir,
      turnNumber: 2,
    });
    expect(a).not.toBe(b);
    expect(readFileSync(a, 'utf8')).toContain('第一行的任务');
    expect(readFileSync(b, 'utf8')).toContain('第二行的任务');
  });
});
