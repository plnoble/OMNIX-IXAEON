/** 这一棒的交代（第 5 条）：只写这一次要做的形状，不把 AGENTS.md 的规矩另抄一份。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Turn } from './types.js';

/** L2 契约第 3 条：要用户拍板的事不要自己定，写成「等用户：…」然后停。逐字照规格。 */
const ASK =
  '要用户拍板的事，不要自己定：把这一行的状态改成「等用户：<一句话说清要定什么>」，然后停。';

/** L6 契约第 3 条：标了 `pushByRelay` 的角色，推送由调度器替它做。逐字照规格（不带反引号）。 */
const PUSH =
  '这一棒的推送由调度器替你做：你只提交，不要 git push。要推的，在最后一行之前每条写一行：RELAY-PUSH <工作目录的绝对路径> <本地分支> <远端分支>。远端分支只能是 main 或者以 dev/ 开头。';

export function buildTurnPrompt(
  turn: Turn,
  opts: { turnNumber: number; pushByRelay?: boolean },
): string {
  const integ = turn.role === 'integrator';
  const role = integ
    ? '你是整合方（统筹）。这一棒只做队列里的一行，照 AGENTS.md 做，并照 docs/委派/整合方手册.md 做。'
    : '你是开发 agent（名字 dev）。这一棒只做队列里的一行，照 AGENTS.md 做。';
  const stop = integ
    ? '停点：这一行复审完就停（并入 main，或者把状态改成你给的结论）。'
    : '停点：这一行到了 AGENTS.md 说的停点就停（B 档推了测试或实现、A 档审过合并，或者转给整合方）。';
  const push = opts.pushByRelay ? `\n\n${PUSH}` : '';
  const head = `${role}\n\n这是第 ${opts.turnNumber} 棒。\n\n序号：${turn.taskId}\n任务：${turn.task}\n现在的状态：${turn.status}`;
  const tail = `${push}\n\n只做这一件，做到它的停点就停，不要接着领别的。\n\n${ASK}\n\n${stop}\n\n做完在最后一行输出：RELAY-DONE ${turn.taskId} <这一行现在的状态>\n`;
  return head + tail;
}

export function writeTurnPrompt(
  turn: Turn,
  opts: { dataDir: string; turnNumber: number; pushByRelay?: boolean },
): string {
  const dir = join(opts.dataDir, 'turns', String(opts.turnNumber));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'prompt.md');
  writeFileSync(
    file,
    buildTurnPrompt(turn, { turnNumber: opts.turnNumber, pushByRelay: opts.pushByRelay }),
    'utf8',
  );
  return file;
}
