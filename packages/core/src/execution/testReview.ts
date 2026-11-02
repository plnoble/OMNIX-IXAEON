/**
 * D5b 契约第 3、4 条：验收测试锁定之前，让核心模型对照验收条件核一遍。
 *
 * 只做三件事：拼给模型看的话、按契约把模型说的话筛干净、把「要补测试」的交代拼出来。
 * 怎么调执行器、什么时候核、核几次，都在 executor.ts 里（那边有 D5a 的完整状态机）。
 */
import type { ModelProvider } from '../extraction/model/provider.js';

/** 契约第 3 条：system 原文，一个字都不改。 */
export const REVIEW_SYSTEM = [
  '你在检查一组验收测试写得够不够。只看测试和验收条件对不对得上，不评价代码风格，不提条件以外的要求。',
  '对每条验收条件判断：',
  '- missing：没有任何测试在检查这条条件；',
  '- loose：有测试，但条件不成立时这个测试照样会通过（比如只查文件存在、只查函数存在、断言的值和条件说的不一样、只测了条件的一部分）。',
  '没有问题就返回空列表。每个问题写清楚是第几条条件、哪个测试文件、差在哪里，一两句话。',
].join('\n');

/** 单个测试文件最多发这么多字；超了截断并在末尾加「…（后面截掉了）」。 */
export const MAX_FILE_CHARS = 20_000;
/** 所有文件合起来最多发这么多字；后面的文件只写路径和「（太长，没有发）」。 */
export const MAX_TOTAL_CHARS = 60_000;

export interface TestReviewProblem {
  condition: number;
  kind: 'missing' | 'loose';
  detail: string;
}

/**
 * 契约第 3 条：拼 `user`。
 * 形如 `要做的事：\n<goal>\n\n验收条件：\n1. …\n\n测试文件：` 然后每个文件
 * `--- <相对路径> ---\n<内容>`。`content` 里进来前已经过 `hideWorkspacePath`。
 */
export function reviewUser(
  goal: string,
  conditions: string[],
  files: Array<{ path: string; content: string }>,
): string {
  const parts: string[] = [
    `要做的事：\n${goal}`,
    ['验收条件：', ...conditions.map((c, i) => `${i + 1}. ${c}`)].join('\n'),
    '测试文件：',
  ];
  let total = parts.join('\n\n').length;
  for (const f of files) {
    if (total >= MAX_TOTAL_CHARS) {
      parts.push(`--- ${f.path} ---\n（太长，没有发）`);
      continue;
    }
    const clipped =
      f.content.length > MAX_FILE_CHARS
        ? `${f.content.slice(0, MAX_FILE_CHARS)}\n…（后面截掉了）`
        : f.content;
    parts.push(`--- ${f.path} ---\n${clipped}`);
    total += clipped.length;
  }
  return parts.join('\n\n');
}

/**
 * 契约第 3 条：模型说的话 → 干净的问题列表。
 * `condition` 不在 1..条件数里丢掉；`detail` 去首尾空白后为空丢掉。
 */
export function cleanProblems(raw: unknown, conditionCount: number): TestReviewProblem[] {
  const list = (raw as { problems?: unknown })?.problems;
  if (!Array.isArray(list)) return [];
  const out: TestReviewProblem[] = [];
  for (const p of list) {
    const condition = (p as { condition?: unknown })?.condition;
    const kind = (p as { kind?: unknown })?.kind;
    const detail = (p as { detail?: unknown })?.detail;
    if (typeof condition !== 'number' || !Number.isInteger(condition)) continue;
    if (condition < 1 || condition > conditionCount) continue;
    if (kind !== 'missing' && kind !== 'loose') continue;
    if (typeof detail !== 'string' || detail.trim() === '') continue;
    out.push({ condition, kind, detail: detail.trim() });
  }
  return out;
}

/** 一句话描述一条问题（「条件 N（漏了 | 太松）：detail」）。 */
export function problemLine(p: TestReviewProblem): string {
  return `条件 ${p.condition}（${p.kind === 'missing' ? '漏了' : '太松'}）：${p.detail}`;
}

/**
 * 契约第 4 条：让执行器「只补测试」的交代。
 * `howToWrite` 是 D5a `writeTestsBrief` 里「怎么写：」那一段原样。
 */
export function fixTestsBrief(
  goal: string,
  conditions: string[],
  problems: TestReviewProblem[],
  howToWrite: string,
  testDir: string,
): string {
  return [
    '这一步只改验收测试，不要写实现。',
    `要做的事：\n${goal}`,
    ['验收条件：', ...conditions.map((c, i) => `${i + 1}. ${c}`)].join('\n'),
    ['检查的人说这些测试有问题：', ...problems.map((p) => `- ${problemLine(p)}`)].join('\n'),
    `怎么改：照原来写测试的规矩（${howToWrite}），只改 ${testDir}/ 下的文件，把上面的问题补上。`,
  ].join('\n\n');
}

/** 契约第 5 条：两次还有问题时 failNow 的原因（整段截到 2000 字）。 */
export function twiceProblemsReason(problems: TestReviewProblem[]): string {
  return [
    '核心模型核了两次，验收测试还有问题，没有写实现：',
    ...problems.map((p) => `- ${problemLine(p)}`),
  ]
    .join('\n')
    .slice(0, 2000);
}

/** 契约第 3 条的 schema 形状（给调用方包成 zod 用；这里只描述）。 */
export const REVIEW_ANSWER_SHAPE = {
  problems: [
    {
      condition: 0,
      kind: 'missing',
      detail: '',
    },
  ],
} as const;

/** 契约第 3 条要用的 zod schema 由 executor 建（那边已经 import 了 zod）；这里只给形状说明。 */
export type ReviewProvider = ModelProvider;
