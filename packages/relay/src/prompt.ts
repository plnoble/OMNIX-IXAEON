/** 这一棒的交代（第 5 条）：只写这一次要做的形状，不把 AGENTS.md 的规矩另抄一份。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadingId } from './queue.js';
import type { Turn } from './types.js';

/** L2 契约第 3 条：要用户拍板的事不要自己定，写成「等用户：…」然后停。逐字照规格。 */
const ASK =
  '要用户拍板的事，不要自己定：把这一行的状态改成「等用户：<一句话说清要定什么>」，然后停。';

/** L6 契约第 3 条：标了 `pushByRelay` 的角色，推送由调度器替它做。逐字照规格（不带反引号）。 */
const PUSH =
  '这一棒的推送由调度器替你做：你只提交，不要 git push。要推的，在最后一行之前每条写一行：RELAY-PUSH <工作目录的绝对路径> <本地分支> <远端分支>。远端分支只能是 main 或者以 dev/ 开头。';

/** L6b 契约第 3 条：开发的仓库是 `<cwd>/repo`，工作目录建在 `<cwd>` 下面。逐字照规格（`<cwd>/repo` 字面拼接）。 */
const ownRepo = (cwd: string): string =>
  `你的仓库是 ${cwd}/repo：AGENTS.md 里说的「共用检出目录」换成它；工作目录照 AGENTS.md 用 node scripts/worktree.mjs 建，会落在 ${cwd} 下面。`;

/** L9 契约第 5 条：规划棒的交代开头那段，逐字。 */
const PLAN =
  '你是整合方（统筹）。这一棒是规划棒：队列里现在没有谁能接的活。照 docs/委派/整合方手册.md 第 11 节，从 docs/三周任务单.md 里挑下一批活，最多 3 件：每件写一页规格放进 docs/委派/，在 docs/委派/队列.md 主表末尾加一行，状态写「待领」；拿不准方向的，只加一行「等用户：<一句话的问题>」，不写规格。只改 docs/ 下面的文件，不动主表里已有的行。做完照手册推到 main。';

const buildPlanPrompt = (turnNumber: number): string =>
  `${PLAN}\n\n这是第 ${turnNumber} 棒。\n\n${ASK}\n\n停点：加完行、推上 main 就停。\n\n做完在最后一行输出：RELAY-DONE plan <加了几行>\n`;

/** L16 契约第 6 条：飞书回复棒的交代开头那段，逐字。 */
const INBOX =
  '你是整合方（统筹）。这一棒是飞书回复棒：用户在飞书里给调度器发了下面这些话，照 AGENTS.md 和 docs/委派/整合方手册.md 处理。多半是在回答队列里「等用户」的那几行：把用户的决定写进去（改那一行的状态、要的话写规格、加行），决定记进三周任务单（原话里有名字、地址、密钥这类个人信息的不要抄进仓库，只记决定）。看不懂的，或者用户要的事得动 docs/ 以外的东西，加一行「等用户：<你的问题>」问回去。只改 docs/ 下面的文件。做完照手册推到 main。';

/** ISO → 北京时间 `10月24日 14:03`（原话一行一条用的写法）。 */
const beijingMinute = (iso: string): string => {
  const t = new Date(Date.parse(iso) + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
};

const buildInboxPrompt = (messages: Array<{ at: string; text: string }>): string => {
  const lines = messages.map((m) => `- ${beijingMinute(m.at)}：${m.text}`);
  return `${INBOX}\n\n${lines.join('\n')}\n\n${ASK}\n\n停点：处理完这几条、推上 main 就停。\n\n做完在最后一行输出：RELAY-DONE inbox <一句话说你做了什么>\n`;
};

export function buildTurnPrompt(
  turn: Turn,
  opts: {
    turnNumber: number;
    pushByRelay?: boolean;
    cwd?: string;
    /** L16 契约第 6 条：飞书回复棒交代里要列的原话（按时间先后）；行为在实现阶段补。 */
    inboxMessages?: Array<{ at: string; text: string }>;
  },
): string {
  if (turn.kind === 'integrator-plan') return buildPlanPrompt(opts.turnNumber);
  if (turn.kind === 'integrator-inbox') return buildInboxPrompt(opts.inboxMessages ?? []);
  const integ = turn.role === 'integrator';
  const role = integ
    ? '你是整合方（统筹）。这一棒只做队列里的一行，照 AGENTS.md 做，并照 docs/委派/整合方手册.md 做。'
    : '你是开发 agent（名字 dev）。这一棒只做队列里的一行，照 AGENTS.md 做。';
  const stop = integ
    ? '停点：这一行复审完就停（并入 main，或者把状态改成你给的结论）。'
    : '停点：这一行到了 AGENTS.md 说的停点就停（B 档推了测试或实现、A 档审过合并，或者转给整合方）。';
  const push = opts.pushByRelay ? `\n\n${PUSH}` : '';
  const own = opts.pushByRelay && opts.cwd ? `\n\n${ownRepo(opts.cwd)}` : '';
  const head =
    `${role}\n\n这是第 ${opts.turnNumber} 棒。\n\n序号：${turn.taskId}\n` +
    `任务号：${leadingId(turn.task)}（分支、工作目录、交付说明都用它；序号只是它在队列里第几行）\n` +
    `任务：${turn.task}\n现在的状态：${turn.status}`;
  const tail = `${push}${own}\n\n只做这一件，做到它的停点就停，不要接着领别的。\n\n${ASK}\n\n${stop}\n\n做完在最后一行输出：RELAY-DONE ${turn.taskId} <这一行现在的状态>\n`;
  return head + tail;
}

export function writeTurnPrompt(
  turn: Turn,
  opts: {
    dataDir: string;
    turnNumber: number;
    pushByRelay?: boolean;
    cwd?: string;
    inboxMessages?: Array<{ at: string; text: string }>;
  },
): string {
  const dir = join(opts.dataDir, 'turns', String(opts.turnNumber));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'prompt.md');
  writeFileSync(
    file,
    buildTurnPrompt(turn, {
      turnNumber: opts.turnNumber,
      pushByRelay: opts.pushByRelay,
      cwd: opts.cwd,
      inboxMessages: opts.inboxMessages,
    }),
    'utf8',
  );
  return file;
}
