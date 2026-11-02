/**
 * D5b（第一支）：`testReview.ts` 导出的提示词与判定（规格契约第 3、4、5 条）。
 *
 * 这是本支另加的单元测试：任务的 14 条验收条件由 `d5b-review-tests.test.ts` 逐条覆盖，
 * 那份在第二支（D5c，要接线才跑得动）。这里只钉住本支这 128 行纯函数本身——
 * 原文一个字不差、截断与上限照契约、问题筛得干净，免得它没有测试。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  REVIEW_SYSTEM,
  cleanProblems,
  fixTestsBrief,
  problemLine,
  reviewUser,
  twiceProblemsReason,
} from '../../src/execution/testReview.js';

/** 规格契约第 3 条 system 原文（照抄规格，逐字）。 */
const SYSTEM = [
  '你在检查一组验收测试写得够不够。只看测试和验收条件对不对得上，不评价代码风格，不提条件以外的要求。',
  '对每条验收条件判断：',
  '- missing：没有任何测试在检查这条条件；',
  '- loose：有测试，但条件不成立时这个测试照样会通过（比如只查文件存在、只查函数存在、断言的值和条件说的不一样、只测了条件的一部分）。',
  '没有问题就返回空列表。每个问题写清楚是第几条条件、哪个测试文件、差在哪里，一两句话。',
].join('\n');

const conditions = ['multiply(2, 3) 等于 6', '原来的 add 不变'];

describe('契约第 3 条：system 原文', () => {
  it('与规格逐字相等', () => {
    expect(REVIEW_SYSTEM).toBe(SYSTEM);
  });

  it('两个上限就是规格写的 20000 / 60000 字', () => {
    expect(MAX_FILE_CHARS).toBe(20_000);
    expect(MAX_TOTAL_CHARS).toBe(60_000);
  });
});

describe('契约第 3 条：user 的拼法', () => {
  it('要做的事、编号条件、每个文件的路径与内容，段与段之间空一行', () => {
    const user = reviewUser('给 calc.mjs 加一个 multiply', conditions, [
      {
        path: 'ixaeon-acceptance/abcd1234/mul.test.mjs',
        content: "test('条件 1：multiply', () => {});",
      },
      {
        path: 'ixaeon-acceptance/abcd1234/add.test.mjs',
        content: "test('条件 2：add', () => {});",
      },
    ]);
    expect(user).toBe(
      [
        '要做的事：\n给 calc.mjs 加一个 multiply',
        '验收条件：\n1. multiply(2, 3) 等于 6\n2. 原来的 add 不变',
        '测试文件：',
        '--- ixaeon-acceptance/abcd1234/mul.test.mjs ---\ntest(\'条件 1：multiply\', () => {});',
        '--- ixaeon-acceptance/abcd1234/add.test.mjs ---\ntest(\'条件 2：add\', () => {});',
      ].join('\n\n'),
    );
  });

  it('单个文件超过 20000 字：截断，并在末尾带「…（后面截掉了）」', () => {
    const long = 'x'.repeat(MAX_FILE_CHARS + 17);
    const user = reviewUser('目标', ['条件一'], [{ path: 'a.test.mjs', content: long }]);
    expect(user).toContain(`${'x'.repeat(MAX_FILE_CHARS)}\n…（后面截掉了）`);
    expect(user).not.toContain('x'.repeat(MAX_FILE_CHARS + 1));
    // 截断后的正文之后、标记之前没有别的东西
    expect(user.endsWith('…（后面截掉了）')).toBe(true);
  });

  it('合起来超过 60000 字：后面的文件只写路径和「（太长，没有发）」', () => {
    const body = (ch: string) => ch.repeat(MAX_FILE_CHARS);
    const files = ['b', 'c', 'd', 'e', 'f'].map((ch) => ({
      path: `${ch}.test.mjs`,
      content: body(ch),
    }));
    const user = reviewUser('目标', ['条件一'], files);
    expect(user).toContain('--- f.test.mjs ---\n（太长，没有发）');
    // 被跳过的那个文件，内容一个字都没发
    expect(user).not.toContain('f'.repeat(100));
    // 前面的文件照常发内容
    expect(user).toContain('b'.repeat(100));
  });
});

describe('契约第 3 条：模型说的话筛干净', () => {
  it('condition 为 0、超过条件数、不是整数，detail 空白，kind 不认识 → 都丢掉', () => {
    expect(
      cleanProblems(
        {
          problems: [
            { condition: 0, kind: 'missing', detail: '零' },
            { condition: 3, kind: 'loose', detail: '超过两条' },
            { condition: 1.5, kind: 'missing', detail: '不是整数' },
            { condition: 1, kind: 'unknown', detail: 'kind 不认识' },
            { condition: 2, kind: 'missing', detail: '   ' },
            { condition: 2, kind: 'loose', detail: ' 留下的这条 ' },
          ],
        },
        2,
      ),
    ).toEqual([{ condition: 2, kind: 'loose', detail: '留下的这条' }]);
  });

  it('不是数组、没有 problems、null → 空列表（算没问题）', () => {
    expect(cleanProblems({ problems: [] }, 2)).toEqual([]);
    expect(cleanProblems({}, 2)).toEqual([]);
    expect(cleanProblems(null, 2)).toEqual([]);
    expect(cleanProblems({ problems: 'x' }, 2)).toEqual([]);
  });

  it('每条问题写成「条件 N（漏了 | 太松）：detail」', () => {
    expect(problemLine({ condition: 2, kind: 'missing', detail: '没有测试' })).toBe(
      '条件 2（漏了）：没有测试',
    );
    expect(problemLine({ condition: 1, kind: 'loose', detail: '只查了文件存在' })).toBe(
      '条件 1（太松）：只查了文件存在',
    );
  });
});

describe('契约第 4 条：让执行器只补测试的交代', () => {
  const howToWrite = '怎么写：\n- 测试文件放在测试目录下';
  const brief = fixTestsBrief(
    '给 calc.mjs 加一个 multiply',
    conditions,
    [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    howToWrite,
    'ixaeon-acceptance/abcd1234',
  );

  it('开头是「这一步只改验收测试，不要写实现。」', () => {
    expect(brief.startsWith('这一步只改验收测试，不要写实现。\n\n')).toBe(true);
  });

  it('有 goal、编号条件、问题列表、「怎么写」原文与只改测试目录的收口', () => {
    expect(brief).toContain('要做的事：\n给 calc.mjs 加一个 multiply');
    expect(brief).toContain('验收条件：\n1. multiply(2, 3) 等于 6\n2. 原来的 add 不变');
    expect(brief).toContain(
      '检查的人说这些测试有问题：\n- 条件 2（漏了）：没有测试检查原来的 add 不变',
    );
    expect(brief).toContain(howToWrite);
    expect(brief).toContain('只改 ixaeon-acceptance/abcd1234/ 下的文件，把上面的问题补上。');
  });
});

describe('契约第 5 条：两次还有问题的失败原因', () => {
  it('第一行写死，每条问题一行', () => {
    expect(
      twiceProblemsReason([
        { condition: 1, kind: 'loose', detail: '只查了文件存在' },
        { condition: 2, kind: 'missing', detail: '没有测试' },
      ]),
    ).toBe(
      [
        '核心模型核了两次，验收测试还有问题，没有写实现：',
        '- 条件 1（太松）：只查了文件存在',
        '- 条件 2（漏了）：没有测试',
      ].join('\n'),
    );
  });

  it('整段截到 2000 字', () => {
    const reason = twiceProblemsReason([
      { condition: 1, kind: 'loose', detail: 'y'.repeat(5000) },
    ]);
    expect(reason).toHaveLength(2000);
  });
});