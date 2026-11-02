/**
 * D5b 验收（规格 docs/委派/D5b-锁定前核心模型核测试.md）。
 *
 * 真的编排（CodingOrchestrator）、真的零依赖档（defaultCheck，带 V3 的断网）、真的 node:test
 * 文件；执行器是按脚本走的替身，核心模型也是替身（ReviewModel）：第一次核出什么问题、第二次
 * 核出什么问题、哪一次抛错，都由用例预置。
 *
 * 与验收条件的对应：
 * - 1：不传 testReviewer；
 * - 2：testReviewer 返回 null；
 * - 3：第 1 次核没问题，锁定，executor 只调 2 次；
 * - 4：发给模型的 system 逐字、user 里有什么、副本绝对路径换成 <副本>；
 * - 5：第 1 次有问题 → 补 → 第 2 次没问题；补的交代、范围、锁的是补过之后的那份；
 * - 6：两次都有问题 → failed，原因逐字；
 * - 7：补测试时改了测试目录以外的文件；
 * - 8：补过之后实现前全部通过 → 不锁定、不再核；
 * - 9：补测试时执行器抛错；
 * - 10：第 1 次核抛错 / 第 2 次核抛错；
 * - 11：问题里的 condition 越界、detail 空白都丢掉；
 * - 12：单个文件 20000 字截断、全部合起来 60000 字后面的文件不发；
 * - 13：核的时候、补的时候取消；
 * - 14：走不到「要锁定」的任务，模型一次都不调，结果照 D5a。
 *
 * 钉住的接缝：`CodingOrchestrator` 第 5 个构造参数 `testReviewer?: () => ModelProvider | null`、
 * `ExecutorReport['acceptanceTests'].review` 的形状、核的 system 原文、补测试的交代原文。
 * 规格契约第 7 条说 `review` 挂在 `acceptanceTests` 上（不是在 `acceptanceTests` 旁边）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import type { CodingTask } from '@ixaeon/contracts';
import { openDatabase, type CoreDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrations.js';
import type { ModelProvider } from '../../src/extraction/model/provider.js';
import { PermissionService } from '../../src/permissions.js';
import { ProjectService } from '../../src/projects.js';
import {
  ACCEPTANCE_DIR,
  CodingOrchestrator,
  defaultCheck,
  type CodingExecutor,
  type ExecutorReport,
  type IndependentCheck,
} from '../../src/execution/executor.js';

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // 隔开本机的 git 全局配置：提交签名、全局钩子不能影响合成仓库（照 D5a）
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'nul';
  }
  dir = mkdtempSync(join(tmpdir(), 'ixa-d5b-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(async () => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (db.open) db.close();
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

// ---- 规格契约第 3 条：核的 system 原文（逐字）----
const REVIEW_SYSTEM = [
  '你在检查一组验收测试写得够不够。只看测试和验收条件对不对得上，不评价代码风格，不提条件以外的要求。',
  '对每条验收条件判断：',
  '- missing：没有任何测试在检查这条条件；',
  '- loose：有测试，但条件不成立时这个测试照样会通过（比如只查文件存在、只查函数存在、断言的值和条件说的不一样、只测了条件的一部分）。',
  '没有问题就返回空列表。每个问题写清楚是第几条条件、哪个测试文件、差在哪里，一两句话。',
].join('\n');

// ---- 合成项目里的文件（照 D5a）----
const CALC = 'export function add(a, b) {\n  return a + b;\n}\n';
const CALC_WITH_MULTIPLY = `${CALC}export function multiply(a, b) {\n  return a * b;\n}\n`;
const HEAD = `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`;
/** 实现前不通过（multiply 还没有），实现对了才通过。 */
const MUL_TEST = `${HEAD}test('条件 1：multiply(2, 3) 等于 6', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.multiply(2, 3), 6);
});
`;
/** 一跑就往项目里写文件。 */
const WRITES_PROJECT_NOW = `${HEAD}import { writeFileSync } from 'node:fs';
test('条件 1：一跑就写项目文件', () => {
  writeFileSync(new URL('../../junk.txt', import.meta.url), 'x');
  assert.equal(1, 2);
});
`;

/** 实现前就通过：补测试时用它把某条条件补上。 */
const ADD_TEST = `${HEAD}test('条件 2：原来的 add 不变', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.add(1, 2), 3);
});
`;

/** D5a 交代里「怎么写：」那一段（照 executor.ts 的 writeTestsBrief）。 */
function writeTestsHow(testDir: string): string {
  return [
    '怎么写：',
    `- 测试文件放在 ${testDir}/ 下，文件名以 .test.mjs 结尾。别的文件一个都不要动。`,
    '- 用 node:test 和 node:assert/strict，不用任何 npm 包。每个文件要能用「node 文件名」直接跑；有测试不通过时退出码不是 0。',
    '- 跑的时候当前目录是项目根目录；引入项目里的模块，要从测试文件所在的目录往上两级（../../）。',
    '- 每条验收条件至少有一个测试，测试的名字以「条件 N：」开头。',
    '- 测试跑的时候不能联网、不能起别的进程，只能读项目目录里的文件；不要改项目里的文件。',
    '- 实现现在还没有写：这些测试现在应该不通过，实现写对之后才通过。',
    '- 有的条件没法这样自动测（比如要人看界面、要联网）：不要硬凑，在 summary 里写明是哪几条、为什么。一条都测不了就不要写文件，把 claimedSuccess 设为 false，在 summary 里说明。',
  ].join('\n');
}

/** 规格契约第 3 条的 schema：核出来的问题。 */
interface ReviewProblem {
  condition: number;
  kind: 'missing' | 'loose';
  detail: string;
}
interface Review {
  status: 'passed' | 'skipped' | 'error' | 'failed';
  rounds: number;
  problems: ReviewProblem[];
  note: string | null;
}

/**
 * 替身核心模型：按顺序消费预置响应；响应是 Error 就抛出去（网络、额度、格式不对都走这一条）。
 * 记下每次收到的 system/user，供断言用。
 */
class ReviewModel implements ModelProvider {
  readonly modelName = 'd5b-review';
  readonly calls: Array<{ system: string; user: string }> = [];
  private readonly queue: unknown[] = [];

  enqueue(response: unknown): this {
    this.queue.push(response);
    return this;
  }

  async chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    this.calls.push({ system: input.system, user: input.user });
    if (this.queue.length === 0) throw new Error('D5b 替身模型没有预置响应');
    const raw = this.queue.shift();
    if (raw instanceof Error) throw raw;
    return input.schema.parse(raw);
  }

  async chatText(): Promise<string> {
    throw new Error('D5b 的核对不该走 chatText');
  }
}

/** 会卡住的替身模型：核到一半等 release()，用来测取消。 */
class GatedReviewModel implements ModelProvider {
  readonly modelName = 'd5b-gated';
  readonly calls: Array<{ system: string; user: string }> = [];
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;

  constructor(private readonly response: unknown) {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate();
  }

  async chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    this.calls.push({ system: input.system, user: input.user });
    await this.gate;
    return input.schema.parse(this.response);
  }

  async chatText(): Promise<string> {
    throw new Error('D5b 的核对不该走 chatText');
  }
}

interface Call {
  task: CodingTask;
  workspace: string;
  options: { readScope?: string[] } | undefined;
  /** 往副本里写一个文件（相对路径，正斜杠）。 */
  write(rel: string, body: string): void;
  /** 这个任务的测试目录（相对路径）。 */
  testDir: string;
}
type Step = (call: Call) => Partial<ExecutorReport> | Promise<Partial<ExecutorReport>>;

interface Harness {
  coding: CodingOrchestrator;
  root: string;
  /** 每次调用执行器时收到的东西。 */
  calls: Call[];
  /** 先后顺序：`执行器 1`、`跑 mul.test.mjs`、`核 1`…… */
  log: string[];
  /** `testReviewer` 被调了几次（每次要核时现调一次）。 */
  readonly reviewerCalls: number;
  create(input: {
    goal?: string;
    scope?: string[];
    acceptance?: string[];
    commands?: string[][];
  }): Promise<CodingTask>;
}

/**
 * 真的编排 + 合成 git 项目（只有 calc.mjs）。执行器按 steps 的次序走；验证走真的零依赖档；
 * 传了 reviewer 就当第 5 个构造参数传进去，并记下它被调了几次。
 */
function setup(
  steps: Step[] | CodingExecutor,
  opts: { reviewer?: () => ModelProvider | null; refuse?: (n: number) => string | null } = {},
): Harness {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'calc.mjs'), CALC);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');
  const project = new ProjectService(db).create({
    name: 'D5b 项目',
    rootPath: root,
    description: null,
  });
  new PermissionService(db).grantFolder(root);

  const calls: Call[] = [];
  const log: string[] = [];
  const counts = { reviewer: 0 };
  const executor: CodingExecutor = {
    name: 'scripted',
    async run(task, workspace, signal, options) {
      const call: Call = {
        task,
        workspace,
        options,
        testDir: `${ACCEPTANCE_DIR}/${task.id.slice(0, 8)}`,
        write(rel, body) {
          const abs = join(workspace, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, body);
        },
      };
      calls.push(call);
      log.push(`执行器 ${calls.length}`);
      if (!Array.isArray(steps)) return steps.run(task, workspace, signal, options);
      const step = steps[calls.length - 1];
      if (!step) throw new Error(`执行器被多调了一次（第 ${calls.length} 次）`);
      const partial = await step(call);
      return {
        claimedSuccess: true,
        summary: '',
        changedPaths: [],
        testsModified: false,
        raw: '',
        ...partial,
      };
    },
  };

  const runCheck = async (
    argv: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<IndependentCheck> => {
    log.push(`跑 ${basename(argv[argv.length - 1]!)}`);
    const refused = opts.refuse?.(log.filter((l) => l.startsWith('跑 ')).length) ?? null;
    if (refused !== null) return { argv, exitCode: null, output: refused, ran: false };
    return defaultCheck(argv, cwd, signal);
  };

  let coding: CodingOrchestrator;
  if (opts.reviewer) {
    const reviewer = (): ModelProvider | null => {
      counts.reviewer += 1;
      log.push(`核 ${counts.reviewer}`);
      return opts.reviewer!();
    };
    coding = new CodingOrchestrator(db, executor, join(dir, 'data'), runCheck, reviewer);
  } else {
    coding = new CodingOrchestrator(db, executor, join(dir, 'data'), runCheck);
  }

  return {
    coding,
    root,
    calls,
    log,
    get reviewerCalls() {
      return counts.reviewer;
    },
    async create(input) {
      const task = coding.create({
        projectId: project.id,
        goal: input.goal ?? '给 calc.mjs 加一个 multiply(a, b)',
        scope: input.scope ?? ['calc.mjs'],
        allowedCommands: input.commands ?? [],
        ...(input.acceptance === undefined
          ? { acceptance: ['multiply(2, 3) 等于 6', '原来的 add 不变'] }
          : input.acceptance.length > 0
            ? { acceptance: input.acceptance }
            : {}),
      });
      await coding.approveAndQueue(task.id);
      return task;
    },
  };
}

interface Row {
  status: string;
  error: string | null;
  verify_status: string | null;
  verify_output: string | null;
  executor_report_json: string | null;
  workspace_path: string | null;
}
const row = (id: string) =>
  db
    .prepare(
      'SELECT status, error, verify_status, verify_output, executor_report_json, workspace_path FROM coding_tasks WHERE id = ?',
    )
    .get(id) as Row;
const report = (id: string) =>
  JSON.parse(row(id).executor_report_json ?? '{}') as {
    acceptanceTests?: {
      files: string[];
      locked: boolean;
      reason: string | null;
      review?: Review;
    };
    changedPaths?: string[];
    testsChanged?: boolean;
  };
const reviewOf = (id: string): Review | undefined => report(id).acceptanceTests?.review;
const testDirOf = (t: CodingTask): string => `${ACCEPTANCE_DIR}/${t.id.slice(0, 8)}`;

// ---- 常用的三步 ----
const writeMulTest: Step = (c) => {
  c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
  return { summary: '写了一个测试' };
};
const writeAddTest: Step = (c) => {
  c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
  return { summary: '把条件 2 的测试补上' };
};
const implementMultiply: Step = (c) => {
  c.write('calc.mjs', CALC_WITH_MULTIPLY);
  return { summary: '加了 multiply', changedPaths: ['calc.mjs'] };
};

describe('条件 1：不传 testReviewer', () => {
  it('和 D5a 一样锁定；报告里 acceptanceTests 没有 review 字段；模型一次都没被调用', async () => {
    const h = setup([writeMulTest, implementMultiply]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).error).toBeNull();
    expect(row(t.id).verify_status).toBe('passed');
    expect(h.calls).toHaveLength(2);
    expect(h.reviewerCalls).toBe(0);

    const acceptance = report(t.id).acceptanceTests!;
    expect(acceptance.locked).toBe(true);
    expect(acceptance.reason).toBeNull();
    expect('review' in acceptance).toBe(false);
    expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '执行器 2', '跑 mul.test.mjs']);
  });
});

describe('条件 2：testReviewer 返回 null', () => {
  it('照样锁定，review 记 skipped、rounds 0、note「没有配置核心模型」', async () => {
    const h = setup([writeMulTest, implementMultiply], { reviewer: () => null });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    expect(h.calls).toHaveLength(2);
    expect(h.reviewerCalls).toBe(1);
    expect(reviewOf(t.id)).toEqual({
      status: 'skipped',
      rounds: 0,
      problems: [],
      note: '没有配置核心模型',
    });
  });
});

describe('条件 3：第 1 次核没问题', () => {
  it('锁定，review 为 { passed, rounds: 1, problems: [], note: null }；执行器一共被调 2 次', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup([writeMulTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    expect(report(t.id).acceptanceTests!.locked).toBe(true);
    expect(reviewOf(t.id)).toEqual({
      status: 'passed',
      rounds: 1,
      problems: [],
      note: null,
    });
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
    // 核在「实现前跑一遍」之后、「写实现」之前
    expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '核 1', '执行器 2', '跑 mul.test.mjs']);
  });
});

describe('条件 4：发给核心模型的内容', () => {
  it('system 逐字相等；user 里有 goal、编号条件、每个文件的路径和内容；副本绝对路径换成 <副本>', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup(
      [
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, `${MUL_TEST}// 副本在这里：${c.workspace}\n`);
          return {};
        },
        implementMultiply,
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    const sent = model.calls[0]!;
    expect(sent.system).toBe(REVIEW_SYSTEM);
    expect(sent.user).toContain('要做的事：');
    expect(sent.user).toContain('给 calc.mjs 加一个 multiply(a, b)');
    expect(sent.user).toContain('1. multiply(2, 3) 等于 6');
    expect(sent.user).toContain('2. 原来的 add 不变');
    expect(sent.user).toContain('测试文件：');
    expect(sent.user).toContain(`--- ${testDir}/mul.test.mjs ---`);
    expect(sent.user).toContain('条件 1：multiply(2, 3) 等于 6');
    expect(sent.user).toContain('assert.equal(calc.multiply(2, 3), 6)');
    expect(sent.user).toContain('// 副本在这里：<副本>');
    expect(sent.user).not.toContain(h.calls[0]!.workspace);
    // 发的是任务的 goal，不是派发时又拼了范围/背景的那一份
    expect(sent.user).not.toContain('可修改范围');
    expect(sent.user).not.toContain('获准背景');
  });
});

describe('条件 5：第 1 次有问题、补过之后第 2 次没问题', () => {
  it('锁定，rounds 2、passed；执行器调 3 次；第 2 次的交代和范围照契约第 4 条；锁的是补过之后的那份', async () => {
    const firstProblem = {
      condition: 2,
      kind: 'missing' as const,
      detail: '没有测试检查原来的 add 不变',
    };
    const model = new ReviewModel().enqueue({ problems: [firstProblem] }).enqueue({ problems: [] });
    const h = setup([writeMulTest, writeAddTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    expect(h.calls).toHaveLength(3);
    expect(model.calls).toHaveLength(2);
    // 第 2 次核的是补过之后的那份：新补的 add.test.mjs 也在里面
    expect(model.calls[1]!.user).toContain(`--- ${testDir}/add.test.mjs ---`);
    expect(model.calls[1]!.user).toContain('条件 2：原来的 add 不变');
    expect(reviewOf(t.id)).toEqual({
      status: 'passed',
      rounds: 2,
      problems: [],
      note: null,
    });
    expect(report(t.id).acceptanceTests!.locked).toBe(true);
    expect(report(t.id).acceptanceTests!.files).toEqual([
      `${testDir}/add.test.mjs`,
      `${testDir}/mul.test.mjs`,
    ]);

    // 第 2 次调用执行器：补测试。能改的只有测试目录，原来的批准范围只读。
    const fix = h.calls[1]!;
    expect(fix.workspace).toBe(h.calls[0]!.workspace);
    expect(JSON.parse(fix.task.scope_json)).toEqual([testDir]);
    expect(fix.options?.readScope).toEqual(['calc.mjs']);
    expect(fix.task.goal).toContain('这一步只改验收测试，不要写实现。');
    expect(fix.task.goal).toContain('要做的事：\n给 calc.mjs 加一个 multiply(a, b)');
    expect(fix.task.goal).toContain('验收条件：\n1. multiply(2, 3) 等于 6\n2. 原来的 add 不变');
    expect(fix.task.goal).toContain(
      '检查的人说这些测试有问题：\n- 条件 2（漏了）：没有测试检查原来的 add 不变',
    );
    expect(fix.task.goal).toContain(
      `怎么改：照原来写测试的规矩（${writeTestsHow(testDir)}），只改 ${testDir}/ 下的文件，把上面的问题补上。`,
    );
    expect(fix.task.goal, '补测试不是第一次写测试，不用「只写」那份交代').not.toContain(
      '这一步只写验收测试，不要写实现。',
    );

    // 补完照 D5a 第 1、2 步再核一遍：重新列文件、重跑实现前的检查，再核第 2 次。
    expect(h.log).toEqual([
      '执行器 1',
      '跑 mul.test.mjs',
      '核 1',
      '执行器 2',
      '跑 add.test.mjs',
      '跑 mul.test.mjs',
      '核 2',
      '执行器 3',
      '跑 add.test.mjs',
      '跑 mul.test.mjs',
    ]);
  });

  it('锁定的是补过之后的文件：写实现时改补过的 add.test.mjs → 实现时改了验收测试', async () => {
    const model = new ReviewModel()
      .enqueue({
        problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
      })
      .enqueue({ problems: [] });
    const h = setup(
      [
        writeMulTest,
        writeAddTest,
        (c) => {
          c.write('calc.mjs', CALC_WITH_MULTIPLY);
          c.write(`${c.testDir}/add.test.mjs`, `${ADD_TEST}// 把补过的测试改松\n`);
          return { changedPaths: ['calc.mjs'] };
        },
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('实现时改了验收测试');
    expect(row(t.id).error).toContain(`${testDir}/add.test.mjs`);
    expect(h.calls).toHaveLength(3);
    expect(model.calls).toHaveLength(2);
  });
});

describe('条件 6：两次都有问题', () => {
  it('任务 failed，原因逐字；写实现那一步没被调；报告里 review 为 failed、rounds 2', async () => {
    const secondProblems = [
      { condition: 1, kind: 'loose' as const, detail: '只查了 multiply 存在，没查值' },
      { condition: 2, kind: 'missing' as const, detail: '还是没有测试' },
    ];
    const model = new ReviewModel()
      .enqueue({
        problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
      })
      .enqueue({ problems: secondProblems });
    const h = setup([writeMulTest, writeAddTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('failed');
    expect(row(t.id).error).toBe(
      [
        '核心模型核了两次，验收测试还有问题，没有写实现：',
        '- 条件 1（太松）：只查了 multiply 存在，没查值',
        '- 条件 2（漏了）：还是没有测试',
      ].join('\n'),
    );
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(2);
    expect(h.log).not.toContain('执行器 3');

    const acceptance = report(t.id).acceptanceTests!;
    expect(acceptance.review?.status).toBe('failed');
    expect(acceptance.review?.rounds).toBe(2);
    expect(acceptance.review?.problems).toEqual(secondProblems);
  });
});

describe('条件 7：补测试时改了测试目录以外的文件', () => {
  it('failed，原因「写验收测试时改了别的文件：…」；不再核、不写实现', async () => {
    const model = new ReviewModel().enqueue({
      problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    });
    const h = setup(
      [
        writeMulTest,
        (c) => {
          c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
          c.write('calc.mjs', CALC_WITH_MULTIPLY);
          return { summary: '顺手把实现也写了' };
        },
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('failed');
    expect(row(t.id).error).toBe('写验收测试时改了别的文件：calc.mjs');
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
    expect(h.log).not.toContain('执行器 3');
  });

  it('补过之后跑测试时改了项目里的文件：failed，照 D5a 的原因，不再核', async () => {
    const model = new ReviewModel().enqueue({
      problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    });
    const h = setup(
      [
        writeMulTest,
        (c) => {
          c.write(`${c.testDir}/bad.test.mjs`, WRITES_PROJECT_NOW);
          return { summary: '补好了' };
        },
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('验收测试改了项目里的文件');
    expect(row(t.id).error).toContain('junk.txt');
    expect(model.calls).toHaveLength(1);
    expect(h.log).not.toContain('核 2');
  });
});

describe('条件 8：补过之后实现前全部通过', () => {
  it('不锁定、不再核，原因照 D5a；模型一共只被调 1 次', async () => {
    const model = new ReviewModel().enqueue({
      problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    });
    const h = setup(
      [
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
          c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
          return {};
        },
        (c) => {
          // 补测试：把实现前就不通过的那条删掉，只剩一条实现前就通过的
          rmSync(join(c.workspace, c.testDir, 'mul.test.mjs'));
          return { summary: '补好了' };
        },
        implementMultiply,
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('验收测试在实现之前就全部通过，测不出这次改动');
    const acceptance = report(t.id).acceptanceTests!;
    expect(acceptance.locked).toBe(false);
    expect(acceptance.reason).toContain('验收测试在实现之前就全部通过，测不出这次改动');
    expect(acceptance.files).toEqual([`${testDirOf(t)}/add.test.mjs`]);
    expect(model.calls).toHaveLength(1);
    expect(h.calls).toHaveLength(3);
    expect(h.log).toEqual([
      '执行器 1',
      '跑 add.test.mjs',
      '跑 mul.test.mjs',
      '核 1',
      '执行器 2',
      '跑 add.test.mjs',
      '执行器 3',
    ]);
  });

  it('补过之后实现前沙箱不肯跑：不锁定、不再核，原因用沙箱说的话，照样写实现', async () => {
    const model = new ReviewModel().enqueue({
      problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    });
    const h = setup([writeMulTest, writeAddTest, implementMultiply], {
      reviewer: () => model,
      refuse: (n) => (n >= 2 ? '合成的说明：补过之后不肯跑' : null),
    });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('合成的说明：补过之后不肯跑');
    const acceptance = report(t.id).acceptanceTests!;
    expect(acceptance.locked).toBe(false);
    expect(acceptance.reason).toContain('合成的说明：补过之后不肯跑');
    expect(acceptance.files).toEqual([
      `${testDirOf(t)}/add.test.mjs`,
      `${testDirOf(t)}/mul.test.mjs`,
    ]);
    expect(model.calls).toHaveLength(1);
    expect(h.calls).toHaveLength(3);
    expect(h.log).not.toContain('核 2');
  });
});

describe('条件 9：补测试时执行器抛错', () => {
  it('failed，原因以「补验收测试时执行器出错：」开头；不写实现', async () => {
    const model = new ReviewModel().enqueue({
      problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    });
    const h = setup(
      [
        writeMulTest,
        () => {
          throw new Error('合成的补测试错误');
        },
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('failed');
    expect(row(t.id).error).toBe('补验收测试时执行器出错：合成的补测试错误');
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
    expect(h.log).not.toContain('执行器 3');
  });
});

describe('条件 10：核的时候模型抛错', () => {
  it('第 1 次就抛错：锁定原来的测试，review 为 error、rounds 0、note 是错误的话', async () => {
    const model = new ReviewModel().enqueue(new Error('合成的模型错误：连不上'));
    const h = setup([writeMulTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    const acceptance = report(t.id).acceptanceTests!;
    expect(acceptance.locked).toBe(true);
    expect(acceptance.files).toEqual([`${testDir}/mul.test.mjs`]);
    expect(reviewOf(t.id)).toEqual({
      status: 'error',
      rounds: 0,
      problems: [],
      note: '合成的模型错误：连不上',
    });
    expect(h.calls).toHaveLength(2);
    expect(model.calls, '抛错后不重试').toHaveLength(1);
  });

  it('第 1 次有问题、补过、第 2 次抛错：锁定补过之后的测试，review 为 error、rounds 1、problems 是上次的', async () => {
    const firstProblems = [
      { condition: 2, kind: 'missing' as const, detail: '没有测试检查原来的 add 不变' },
    ];
    const model = new ReviewModel()
      .enqueue({ problems: firstProblems })
      .enqueue(new Error('第二次核出错'));
    const h = setup([writeMulTest, writeAddTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    const acceptance = report(t.id).acceptanceTests!;
    expect(acceptance.locked).toBe(true);
    expect(acceptance.files).toEqual([`${testDir}/add.test.mjs`, `${testDir}/mul.test.mjs`]);
    expect(reviewOf(t.id)).toEqual({
      status: 'error',
      rounds: 1,
      problems: firstProblems,
      note: '第二次核出错',
    });
    expect(h.calls).toHaveLength(3);
    expect(model.calls).toHaveLength(2);
  });
});

describe('条件 11：问题里的条件号、空 detail 都丢掉', () => {
  it('condition 是 0、超过条件数、detail 是空白 → 全丢掉，就算没问题（照条件 3 锁定）', async () => {
    const model = new ReviewModel().enqueue({
      problems: [
        { condition: 0, kind: 'missing', detail: '零号' },
        { condition: 3, kind: 'loose', detail: '超过条件数' },
        { condition: 1, kind: 'loose', detail: '   ' },
      ],
    });
    const h = setup([writeMulTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(reviewOf(t.id)).toEqual({
      status: 'passed',
      rounds: 1,
      problems: [],
      note: null,
    });
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
  });

  it('只留合法的那些：补测试的交代里只有条件 2 的问题，没有 0、3 和空 detail', async () => {
    const valid = {
      condition: 2,
      kind: 'missing' as const,
      detail: '有效的问题：缺 add 的测试',
    };
    const model = new ReviewModel()
      .enqueue({
        problems: [
          { condition: 0, kind: 'missing', detail: '不存在的零号' },
          { condition: 1, kind: 'loose', detail: '   ' },
          { condition: 3, kind: 'missing', detail: '不存在三号' },
          valid,
        ],
      })
      .enqueue({ problems: [] });
    const h = setup([writeMulTest, writeAddTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    expect(done.status).toBe('pending_accept');
    expect(reviewOf(t.id)?.status).toBe('passed');
    expect(reviewOf(t.id)?.rounds).toBe(2);
    const fixGoal = h.calls[1]!.task.goal;
    expect(fixGoal).toContain('- 条件 2（漏了）：有效的问题：缺 add 的测试');
    expect(fixGoal).not.toContain('不存在的零号');
    expect(fixGoal).not.toContain('不存在三号');
    expect(fixGoal).toContain(`只改 ${testDir}/ 下的文件`);
    expect(model.calls).toHaveLength(2);
  });
});

describe('条件 12：发给模型的测试内容有大小上限', () => {
  it('单个文件超过 20000 字：截断，并在末尾带「…（后面截掉了）」', async () => {
    const tail = 'D5B_TAIL_SINGLE';
    const huge = `${MUL_TEST}// ${'x'.repeat(20_050)}\n// ${tail}\n`;
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup(
      [
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, huge);
          return {};
        },
        implementMultiply,
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    await h.coding.dispatch(t.id);

    const sent = model.calls[0]!.user;
    expect(sent).toContain('…（后面截掉了）');
    expect(sent).toContain("test('条件 1：multiply(2, 3) 等于 6'");
    expect(sent).not.toContain(tail);
    expect(sent.length).toBeLessThan(21_000);
  });

  it('合起来超过 60000 字：后面的文件只写路径和「（太长，没有发）」', async () => {
    const letters = ['a', 'b', 'c', 'd', 'e'];
    const body = (letter: string) => `${MUL_TEST}// D5B_SENT_${letter} ${'x'.repeat(15_000)}\n`;
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup(
      [
        (c) => {
          for (const letter of letters) {
            c.write(`${c.testDir}/${letter}.test.mjs`, body(letter));
          }
          return {};
        },
        implementMultiply,
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    await h.coding.dispatch(t.id);
    const testDir = testDirOf(t);

    const sent = model.calls[0]!.user;
    expect(sent).toContain('D5B_SENT_a');
    expect(sent).toContain('（太长，没有发）');
    for (const letter of letters) {
      expect(sent).toContain(`--- ${testDir}/${letter}.test.mjs ---`);
    }
    expect(sent).not.toContain('D5B_SENT_e');
  });
});

describe('条件 13：核的时候、补的时候取消', () => {
  it('核的时候取消：任务 cancelled，不再调模型、不再调执行器', async () => {
    const model = new GatedReviewModel({ problems: [] });
    const h = setup([writeMulTest, implementMultiply], { reviewer: () => model });
    const t = await h.create({});
    const dispatched = h.coding.dispatch(t.id);
    await vi.waitFor(() => expect(h.log).toContain('核 1'), { timeout: 10_000 });
    h.coding.cancel(t.id);
    model.release();
    const done = await dispatched;

    expect(done.status).toBe('cancelled');
    expect(row(t.id).status).toBe('cancelled');
    expect(h.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    expect(h.log).not.toContain('执行器 2');
  });

  it('补测试的时候取消：任务 cancelled，不再核第 2 次', async () => {
    const model = new ReviewModel().enqueue({
      problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }],
    });
    let releaseFix!: () => void;
    const fixGate = new Promise<void>((resolve) => {
      releaseFix = resolve;
    });
    const h = setup(
      [
        writeMulTest,
        async (c) => {
          await fixGate;
          c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
          return { summary: '补好了' };
        },
        implementMultiply,
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const dispatched = h.coding.dispatch(t.id);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), { timeout: 10_000 });
    h.coding.cancel(t.id);
    releaseFix();
    const done = await dispatched;

    expect(done.status).toBe('cancelled');
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
    expect(h.log).not.toContain('核 2');
  });
});

describe('条件 14：走不到「要锁定」的任务，模型一次都不调', () => {
  it('没写出测试：照 D5a 不锁定，照常写实现', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup([() => ({ claimedSuccess: false, summary: '测不了' }), implementMultiply], {
      reviewer: () => model,
    });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(h.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(0);
    expect(h.reviewerCalls).toBe(0);
    expect(report(t.id).acceptanceTests).toMatchObject({ files: [], locked: false });
    expect(reviewOf(t.id)).toBeUndefined();
  });

  it('实现前全部通过：照 D5a 不锁定、不核', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup(
      [
        (c) => {
          c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
          return {};
        },
        implementMultiply,
      ],
      { reviewer: () => model },
    );
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('验收测试在实现之前就全部通过');
    expect(model.calls).toHaveLength(0);
    expect(h.reviewerCalls).toBe(0);
    expect(reviewOf(t.id)).toBeUndefined();
  });

  it('沙箱拒跑：照 D5a 不锁定、不核', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup([writeMulTest, implementMultiply], {
      reviewer: () => model,
      refuse: () => '合成的说明：零依赖档不跑',
    });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('合成的说明：零依赖档不跑');
    expect(model.calls).toHaveLength(0);
    expect(h.reviewerCalls).toBe(0);
    expect(reviewOf(t.id)).toBeUndefined();
  });

  it('带验证命令的任务：不走验收先行、不核', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup(
      [
        (c) => {
          c.write('note.txt', '写了');
          return { changedPaths: ['note.txt'] };
        },
      ],
      { reviewer: () => model },
    );
    const t = await h.create({
      scope: ['note.txt'],
      commands: [
        [process.execPath, '-e', "if(!require('node:fs').existsSync('note.txt'))process.exit(2)"],
      ],
    });
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    expect(h.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(h.reviewerCalls).toBe(0);
    expect(report(t.id).acceptanceTests).toBeUndefined();
  });

  it('没有验收条件的任务：不核', async () => {
    const model = new ReviewModel().enqueue({ problems: [] });
    const h = setup(
      [
        (c) => {
          c.write('note.txt', '写了');
          return { changedPaths: ['note.txt'] };
        },
      ],
      { reviewer: () => model },
    );
    const t = await h.create({ scope: ['note.txt'], acceptance: [] });
    const done = await h.coding.dispatch(t.id);

    expect(done.status).toBe('pending_accept');
    expect(h.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(h.reviewerCalls).toBe(0);
    expect(report(t.id).acceptanceTests).toBeUndefined();
  });
});
