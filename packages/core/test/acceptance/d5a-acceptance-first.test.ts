/**
 * D5a 验收（规格 docs/委派/D5a-验收先行-先写测试再写实现.md）。
 * 执行方先推了一版，整合方 2026-10-05 锁定前重写（规格末尾「整合方审测试时的改正与补充」）。
 *
 * 真的编排（CodingOrchestrator）、真的零依赖档（defaultCheck，带 V3 的断网）、真的 node:test
 * 文件；只有执行器是按脚本走的替身：每一步往副本里写什么、说成没成，由用例定。
 *
 * 与验收条件的对应写在每个 describe 上：条件 1–12 是规格原有的，条件 13–27 是整合方审测试时
 * 补的（规格的「验收条件」里逐条列着）。钉住的接缝：
 * - `ExecutorRunOptions { readScope?: string[] }`，`CodingExecutor.run` 的第 4 个参数；
 * - 测试目录 `ixaeon-acceptance/<任务号前 8 位>/`，导出 `ACCEPTANCE_DIR`；
 * - 执行报告里的 `acceptanceTests: { files, locked, reason }`；
 * - 给执行器的交代里的关键句（规格契约 5）；每种情况的原因文字（契约 3 里引号内的那几句）；
 * - 测试怎么跑：`runCheck([process.execPath, <相对路径>], 副本根目录, 取消信号, …)`。
 * 条件 24（桌面端把只读范围传下去）在 apps/desktop/test/acceptance/d5a-executor-options.test.ts。
 *
 * 原版里错的（改掉了）：
 * - 「实现前不通过、实现后通过」（条件 2、12）用的是一个永远不通过的测试（1 + 1 等于 3）。照规格
 *   实现的话，实现后那一遍照样不通过、任务失败，这条永远过不了；它只在「做完不重跑测试」的实现下
 *   才会绿。这里用真的会跟着实现变的测试（引入 calc.mjs，断言 multiply）。
 * - 条件 1 把测试文件写在了任务的测试目录外面，却指望执行器被调第二次（和条件 7 矛盾）。
 * - 条件 10 指望改只读范围里的文件时「返回没做成」，而 D7 锁定的行为是抛错。
 * - 条件 8 实现后那一遍写着「测不了」、条件 11 两头都算过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodingTask } from '@ixaeon/contracts';
import { openDatabase, type CoreDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrations.js';
import { PermissionService } from '../../src/permissions.js';
import { ProjectService } from '../../src/projects.js';
import { FakeProvider } from '../../src/extraction/model/fake.js';
import { ModelCodingExecutor } from '../../src/execution/modelExecutor.js';
import {
  ACCEPTANCE_DIR,
  CodingOrchestrator,
  EXECUTOR_CHANNEL_FILE,
  FakeCodingExecutor,
  defaultCheck,
  type CodingExecutor,
  type ExecutorReport,
  type IndependentCheck,
} from '../../src/execution/executor.js';

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // 隔开本机的 git 全局配置：提交签名、全局钩子不能影响合成仓库
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'nul';
  }
  dir = mkdtempSync(join(tmpdir(), 'ixa-d5a-'));
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

// ---- 合成项目里的文件 ----
const CALC = 'export function add(a, b) {\n  return a + b;\n}\n';
const CALC_WITH_MULTIPLY = `${CALC}export function multiply(a, b) {\n  return a * b;\n}\n`;
const CALC_WRONG_MULTIPLY = `${CALC}export function multiply(a, b) {\n  return a + b;\n}\n`;

// ---- 「执行器写的」验收测试（都是真的 node:test 文件，从测试目录往上两级就是项目根）----
const HEAD = `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`;
/** 实现前不通过（multiply 还没有），实现对了才通过。 */
const MUL_TEST = `${HEAD}test('条件 1：multiply(2, 3) 等于 6', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.multiply(2, 3), 6);
});
`;
/** 实现前就通过：测不出这次改动。 */
const ADD_TEST = `${HEAD}test('条件 2：原来的 add 不变', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.add(1, 2), 3);
});
`;
/** 一跑就往项目里写文件。 */
const WRITES_PROJECT_NOW = `${HEAD}import { writeFileSync } from 'node:fs';
test('条件 1：一跑就写项目文件', () => {
  writeFileSync(new URL('../../junk.txt', import.meta.url), 'x');
  assert.equal(1, 2);
});
`;
/** 自己要 45 秒才结束（用来看取消时验证进程有没有跟着停）。 */
const SLOW_TEST = `${HEAD}test('条件 1：一直不结束', async () => {
  await new Promise((resolve) => setTimeout(resolve, 45_000));
  assert.equal(1, 2);
});
`;
/** 实现前在断言处就停下（不写）；实现对了之后通过，并往项目里写文件。 */
const WRITES_PROJECT_AFTER_IMPL = `${HEAD}import { writeFileSync } from 'node:fs';
test('条件 1：multiply(2, 3) 等于 6', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.multiply(2, 3), 6);
  writeFileSync(new URL('../../junk.txt', import.meta.url), 'x');
});
`;

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
  /** 先后顺序：`执行器 1`、`跑 mul.test.mjs`、`执行器 2`…… */
  log: string[];
  /** 每次跑测试时编排给的命令和当前目录。 */
  checks: Array<{ argv: string[]; cwd: string }>;
  create(input: {
    goal?: string;
    scope?: string[];
    acceptance?: string[];
    commands?: string[][];
  }): Promise<CodingTask>;
}

/**
 * 真的编排 + 合成 git 项目（只有 calc.mjs）。执行器按 steps 的次序走（给的是一个现成的执行器
 * 时，原样转给它，只记下每次调用）；验证走真的零依赖档，`refuse` 返回一段话时改成
 * 「沙箱不肯跑」（第几次跑测试由 n 给出，从 1 起）。
 */
function setup(
  steps: Step[] | CodingExecutor,
  opts: { refuse?: (n: number) => string | null } = {},
): Harness {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'calc.mjs'), CALC);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');
  const project = new ProjectService(db).create({
    name: 'D5a 项目',
    rootPath: root,
    description: null,
  });
  new PermissionService(db).grantFolder(root);

  const calls: Call[] = [];
  const log: string[] = [];
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
  const checks: Array<{ argv: string[]; cwd: string }> = [];
  const runCheck = async (
    argv: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<IndependentCheck> => {
    checks.push({ argv, cwd });
    log.push(`跑 ${basename(argv[argv.length - 1]!)}`);
    const refused = opts.refuse?.(checks.length) ?? null;
    if (refused !== null) return { argv, exitCode: null, output: refused, ran: false };
    return defaultCheck(argv, cwd, signal);
  };
  const coding = new CodingOrchestrator(db, executor, join(dir, 'data'), runCheck);
  return {
    coding,
    root,
    calls,
    log,
    checks,
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
    acceptanceTests?: { files: string[]; locked: boolean; reason: string | null };
    changedPaths?: string[];
    testsModified?: boolean;
  };

// ---- 常用的两步 ----
const writeMulTest: Step = (c) => {
  c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
  return { summary: '写了一个测试' };
};
const implementMultiply: Step = (c) => {
  c.write('calc.mjs', CALC_WITH_MULTIPLY);
  return { summary: '加了 multiply', changedPaths: ['calc.mjs'] };
};

describe('条件 1：执行器被调两次——先写测试，再写实现', () => {
  it('两次调用各自的目标、能改的范围、只读的范围；五步的先后顺序', async () => {
    const h = setup([writeMulTest, implementMultiply]);
    const t = await h.create({});
    await h.coding.dispatch(t.id);
    const testDir = `ixaeon-acceptance/${t.id.slice(0, 8)}`;
    expect(ACCEPTANCE_DIR).toBe('ixaeon-acceptance');

    expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '执行器 2', '跑 mul.test.mjs']);

    const [first, second] = h.calls;
    // 第一次：只写测试；能改的只有测试目录，原来的批准范围只读
    expect(JSON.parse(first!.task.scope_json)).toEqual([testDir]);
    expect(first!.options?.readScope).toEqual(['calc.mjs']);
    const brief = first!.task.goal;
    expect(brief).toContain('这一步只写验收测试，不要写实现。');
    expect(brief).toContain('给 calc.mjs 加一个 multiply(a, b)');
    expect(brief).toContain('1. multiply(2, 3) 等于 6');
    expect(brief).toContain('2. 原来的 add 不变');
    expect(brief).toContain(`测试文件放在 ${testDir}/ 下，文件名以 .test.mjs 结尾。`);
    expect(brief).toContain('用 node:test 和 node:assert/strict，不用任何 npm 包。');
    // 条件 25：交代里写明测试从哪跑、怎么引入项目里的模块
    expect(brief).toContain('跑的时候当前目录是项目根目录');
    expect(brief).toContain('要从测试文件所在的目录往上两级（../../）');
    expect(brief).toContain('每条验收条件至少有一个测试，测试的名字以「条件 N：」开头。');
    expect(brief).toContain('不能联网、不能起别的进程');
    expect(brief).toContain('这些测试现在应该不通过，实现写对之后才通过。');
    expect(brief).toContain('一条都测不了就不要写文件，把 claimedSuccess 设为 false');

    // 第二次：原来派发时的那份目标 + 写实现的交代；能改的是原批准范围，测试目录只读
    expect(second!.workspace, '两步在同一个隔离副本里做').toBe(first!.workspace);
    expect(JSON.parse(second!.task.scope_json)).toEqual(['calc.mjs']);
    expect(second!.options?.readScope).toEqual([testDir]);
    const impl = second!.task.goal;
    expect(impl).toContain('给 calc.mjs 加一个 multiply(a, b)');
    expect(impl).toContain('可修改范围：calc.mjs');
    // 条件 26：写实现的人也看得到验收条件（原来只有回报里用到，执行器从没见过）
    expect(impl).toContain('1. multiply(2, 3) 等于 6');
    expect(impl).toContain('2. 原来的 add 不变');
    expect(impl).toContain(`验收测试已经写好并锁定：${testDir}/mul.test.mjs。`);
    expect(impl).toContain(`不许改这些文件，也不许在 ${testDir}/ 下增删文件`);
    expect(impl).toContain('做完的标准是它们全部通过');
    expect(impl, '写实现的那次不该再带「只写测试」的交代').not.toContain('这一步只写验收测试');
    expect(impl, '锁定了就不说「没有锁定」').not.toContain('没有锁定');

    // 条件 22：测试怎么跑——node 加相对路径，当前目录是副本的根（交代里就是这么告诉执行器的）
    expect(h.checks).toHaveLength(2);
    for (const check of h.checks) {
      expect(resolve(check.cwd)).toBe(resolve(first!.workspace));
      expect(check.argv).toHaveLength(2);
      expect(check.argv[0]).toBe(process.execPath);
      expect(check.argv[1]!.replaceAll('\\', '/')).toBe(`${testDir}/mul.test.mjs`);
    }
  });
});

describe('条件 2：测试实现前不通过、实现后通过', () => {
  it('等用户接受，验证通过；报告如实；接受后分支里测试和实现都有', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
        c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
        return { summary: '写了两个测试' };
      },
      implementMultiply,
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    const testDir = `ixaeon-acceptance/${t.id.slice(0, 8)}`;
    expect(row(t.id).error).toBeNull();
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    // 实现前、实现后各把每个测试文件跑了一遍
    expect(h.log.filter((l) => l === '跑 mul.test.mjs').length).toBe(2);
    expect(h.log.filter((l) => l === '跑 add.test.mjs').length).toBe(2);
    expect(h.log.indexOf('执行器 2')).toBe(3);
    // 条件 15：通过时也留下测试的输出（与现在验证通过的写法一样），用户看得到跑了哪些测试
    expect(row(t.id).verify_output).toContain('条件 1：multiply(2, 3) 等于 6');
    expect(row(t.id).verify_output).toContain('条件 2：原来的 add 不变');

    const r = report(t.id);
    expect(r.acceptanceTests!.files.slice().sort()).toEqual([
      `${testDir}/add.test.mjs`,
      `${testDir}/mul.test.mjs`,
    ]);
    expect(r.acceptanceTests!.locked).toBe(true);
    expect(r.acceptanceTests!.reason).toBeNull();
    expect(r.changedPaths!.slice().sort()).toEqual([
      'calc.mjs',
      `${testDir}/add.test.mjs`,
      `${testDir}/mul.test.mjs`,
    ]);
    expect(r.testsModified).toBe(false);

    const accepted = await h.coding.accept(t.id);
    expect(accepted.applied_ref).toMatch(/^ixaeon\//);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: h.root, encoding: 'utf8' }).trim();
    expect(git('diff', '--name-only', 'main', accepted.applied_ref!).split('\n').sort()).toEqual([
      'calc.mjs',
      `${testDir}/add.test.mjs`,
      `${testDir}/mul.test.mjs`,
    ]);
    expect(git('show', `${accepted.applied_ref}:calc.mjs`)).toContain('multiply');
  });
});

describe('条件 3：实现后测试仍不通过', () => {
  it('任务失败，验证失败，测试的输出在 verify_output 里', async () => {
    const h = setup([
      writeMulTest,
      (c) => {
        c.write('calc.mjs', CALC_WRONG_MULTIPLY);
        return { summary: '我做好了', changedPaths: ['calc.mjs'] };
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).verify_status).toBe('failed');
    expect(row(t.id).error).toContain('独立验证失败');
    expect(row(t.id).verify_output).toContain('条件 1：multiply(2, 3) 等于 6');
    expect(report(t.id).acceptanceTests!.locked).toBe(true);
  });
});

describe('条件 4：实现时动了验收测试', () => {
  const cases: Array<[string, (c: Call) => void, string]> = [
    ['改了测试的内容', (c) => c.write(`${c.testDir}/mul.test.mjs`, ADD_TEST), 'mul.test.mjs'],
    ['删了测试', (c) => rmSync(join(c.workspace, c.testDir, 'mul.test.mjs')), 'mul.test.mjs'],
    [
      '在测试目录里新加了文件',
      (c) => c.write(`${c.testDir}/extra.test.mjs`, ADD_TEST),
      'extra.test.mjs',
    ],
    [
      '改了测试目录里不是测试的文件',
      (c) => c.write(`${c.testDir}/data.json`, '{"x":2}'),
      'data.json',
    ],
  ];
  for (const [label, tamper, path] of cases) {
    it(`${label}：任务失败，原因里有那个路径；实现后不再跑测试`, async () => {
      const h = setup([
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
          c.write(`${c.testDir}/data.json`, '{"x":1}');
          return {};
        },
        (c) => {
          c.write('calc.mjs', CALC_WITH_MULTIPLY);
          tamper(c);
          return { changedPaths: ['calc.mjs'] };
        },
      ]);
      const t = await h.create({});
      const done = await h.coding.dispatch(t.id);
      expect(done.status).toBe('failed');
      expect(row(t.id).error).toContain('实现时改了验收测试');
      expect(row(t.id).error).toContain(`ixaeon-acceptance/${t.id.slice(0, 8)}/${path}`);
      expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '执行器 2']);
    });
  }

  it('条件 13：没锁定的时候也一样——实现动了测试目录，任务失败，原因里有那个路径', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
        return {};
      },
      (c) => {
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        c.write(`${c.testDir}/add.test.mjs`, MUL_TEST);
        return { changedPaths: ['calc.mjs'] };
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain(`ixaeon-acceptance/${t.id.slice(0, 8)}/add.test.mjs`);
  });

  it('条件 13：第一步没写出测试，实现却往测试目录里写了文件——任务失败，原因里有那个路径', async () => {
    const h = setup([
      () => ({ claimedSuccess: false, summary: '测不了' }),
      (c) => {
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
        return { changedPaths: ['calc.mjs'] };
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain(`ixaeon-acceptance/${t.id.slice(0, 8)}/mul.test.mjs`);
  });
});

describe('条件 18：写实现那一步其余的核对照旧，而且先于跑测试', () => {
  it('实现改了批准范围以外的文件：任务失败（超出批准范围），不跑测试', async () => {
    const h = setup([
      writeMulTest,
      (c) => {
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        c.write('other.txt', '顺手写的');
        return { changedPaths: ['calc.mjs'] };
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('超出批准范围');
    expect(row(t.id).error).toContain('other.txt');
    expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '执行器 2']);
  });

  it('执行器自己说没做成：任务失败，不拿测试结果当完成', async () => {
    const h = setup([writeMulTest, () => ({ claimedSuccess: false, summary: '没做成' })]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('执行器未声称成功');
    expect(row(t.id).verify_status).not.toBe('passed');
    expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '执行器 2']);
  });
});

describe('条件 17：执行器自己的报告通道文件不算改动', () => {
  it('两步都写了通道文件（Codex 就是这样）：不算「改了别的文件」，也不进改动清单', async () => {
    const h = setup([
      (c) => {
        c.write(EXECUTOR_CHANNEL_FILE, '写了一个测试');
        c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
        return {};
      },
      (c) => {
        c.write(EXECUTOR_CHANNEL_FILE, '加了 multiply');
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        return { changedPaths: ['calc.mjs'] };
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(row(t.id).error).toBeNull();
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    expect(report(t.id).changedPaths).not.toContain(EXECUTOR_CHANNEL_FILE);
  });
});

describe('条件 5：测试在实现之前就全部通过', () => {
  it('不锁定，照样写实现，等用户接受；验证没跑，原因写明测不出这次改动', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
        return {};
      },
      implementMultiply,
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('验收测试在实现之前就全部通过，测不出这次改动');
    expect(report(t.id).acceptanceTests).toMatchObject({ locked: false });
    expect(report(t.id).acceptanceTests!.reason).toContain('测不出这次改动');
    // 没锁定：写实现时不说「已经锁定」，做完也不拿这些测试当验证
    const testDir = `ixaeon-acceptance/${t.id.slice(0, 8)}`;
    const impl = h.calls[1]!.task.goal;
    expect(impl).not.toContain('验收测试已经写好并锁定');
    expect(h.log).toEqual(['执行器 1', '跑 add.test.mjs', '执行器 2']);
    // 条件 26、27：验收条件照样给；测试目录里有文件，就要告诉执行器别动（动了算失败，见条件 13）
    expect(impl).toContain('1. multiply(2, 3) 等于 6');
    expect(impl).toContain(`${testDir}/ 下是这次任务写的验收测试，没有锁定，不拿它们当验证。`);
    expect(impl).toContain(`不要改、不要删这些文件，也不要往 ${testDir}/ 下加文件`);
    expect(impl).toContain('动了这次任务就算失败');
    // 条件 14：写出来的测试没锁也照实记着、算这次的改动（用户在改动里看得到）
    expect(report(t.id).acceptanceTests!.files).toEqual([`${testDir}/add.test.mjs`]);
    expect(report(t.id).changedPaths!.slice().sort()).toEqual([
      'calc.mjs',
      `${testDir}/add.test.mjs`,
    ]);
  });
});

// 条件 20：规格的条件 6 只写了「自己说做不到」；契约里的另外两种（什么都没写、报错）一样算
describe('条件 6、20：第一步没写出测试', () => {
  const cases: Array<[string, Step, string]> = [
    [
      '执行器自己说做不到',
      () => ({ claimedSuccess: false, summary: '这些条件都要人看界面，自动测不了' }),
      '这些条件都要人看界面，自动测不了',
    ],
    ['说成了但一个文件都没写', () => ({ summary: '我看了看，没法测' }), '我看了看，没法测'],
    [
      '执行器报错',
      () => {
        throw new Error('合成的执行器错误');
      },
      '合成的执行器错误',
    ],
  ];
  for (const [label, firstStep, said] of cases) {
    it(`${label}：照样写实现，等用户接受；验证没跑，原因里有执行器说的话`, async () => {
      const h = setup([firstStep, implementMultiply]);
      const t = await h.create({});
      const done = await h.coding.dispatch(t.id);
      expect(done.status).toBe('pending_accept');
      expect(row(t.id).verify_status).toBe('not_run');
      expect(row(t.id).verify_output).toContain(said);
      expect(report(t.id).acceptanceTests).toMatchObject({ files: [], locked: false });
      expect(report(t.id).acceptanceTests!.reason).toContain(said);
      expect(h.log).toEqual(['执行器 1', '执行器 2']);
      expect(report(t.id).changedPaths).toEqual(['calc.mjs']);
      // 条件 26、27：验收条件照样给写实现的人；测试目录是空的，就不提验收测试
      const impl = h.calls[1]!.task.goal;
      expect(impl).toContain('给 calc.mjs 加一个 multiply(a, b)');
      expect(impl).toContain('1. multiply(2, 3) 等于 6');
      expect(impl).toContain('2. 原来的 add 不变');
      expect(impl).not.toContain('验收测试');
    });
  }
});

describe('条件 7：第一步改了测试目录以外的文件', () => {
  it('任务失败，原因里有那个路径；执行器没有被调第二次，测试也没跑', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        return { summary: '顺手把实现也写了' };
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('写验收测试时改了别的文件');
    expect(row(t.id).error).toContain('calc.mjs');
    expect(h.log).toEqual(['执行器 1']);
  });

  it('条件 21：测试文件没写进这个任务自己的目录（直接放在 ixaeon-acceptance/ 下）——一样算测试目录以外', async () => {
    const h = setup([
      (c) => {
        c.write(`${ACCEPTANCE_DIR}/mul.test.mjs`, MUL_TEST);
        return {};
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('写验收测试时改了别的文件');
    expect(row(t.id).error).toContain('ixaeon-acceptance/mul.test.mjs');
    expect(h.log).toEqual(['执行器 1']);
  });
});

describe('条件 8：测试跑的时候改了测试目录以外的文件', () => {
  it('实现前那一遍：任务失败，原因里有那个路径；执行器没有被调第二次', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/bad.test.mjs`, WRITES_PROJECT_NOW);
        return {};
      },
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('验收测试改了项目里的文件');
    expect(row(t.id).error).toContain('junk.txt');
    expect(h.log).toEqual(['执行器 1', '跑 bad.test.mjs']);
  });

  it('实现后那一遍：任务失败，原因里有那个路径', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/late.test.mjs`, WRITES_PROJECT_AFTER_IMPL);
        return {};
      },
      implementMultiply,
    ]);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(h.log).toEqual(['执行器 1', '跑 late.test.mjs', '执行器 2', '跑 late.test.mjs']);
    expect(done.status).toBe('failed');
    expect(row(t.id).error).toContain('验收测试改了项目里的文件');
    expect(row(t.id).error).toContain('junk.txt');
  });
});

describe('条件 9：别的任务与现在一模一样', () => {
  const noteCommand = [
    process.execPath,
    '-e',
    "if(!require('node:fs').existsSync('note.txt'))process.exit(2)",
  ];
  const writeNote: Step = (c) => {
    c.write('note.txt', '写了');
    return { changedPaths: ['note.txt'] };
  };

  it('有验收条件、也有验证命令：执行器只调一次，照旧跑验证命令', async () => {
    const h = setup([writeNote]);
    const t = await h.create({ scope: ['note.txt'], commands: [noteCommand] });
    const done = await h.coding.dispatch(t.id);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.task.goal).not.toContain('这一步只写验收测试');
    expect(h.calls[0]!.options?.readScope).toBeUndefined();
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('passed');
    expect(report(t.id).acceptanceTests).toBeUndefined();
  });

  it('没有验收条件、没有验证命令：执行器只调一次，「没有有效验证命令，保留未运行」', async () => {
    const h = setup([writeNote]);
    const t = await h.create({ scope: ['note.txt'], acceptance: [] });
    const done = await h.coding.dispatch(t.id);
    expect(h.calls).toHaveLength(1);
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('没有有效验证命令');
    expect(report(t.id).acceptanceTests).toBeUndefined();
    expect(h.log).toEqual(['执行器 1']);
  });
});

describe('条件 19：沙箱不肯跑', () => {
  it('实现前那一遍不肯跑：不锁定，原因是沙箱说的话；照样写实现，验证没跑', async () => {
    const h = setup([writeMulTest, implementMultiply], {
      refuse: () => '合成的说明：副本里有目录链接，零依赖档不跑',
    });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('合成的说明：副本里有目录链接');
    expect(report(t.id).acceptanceTests).toMatchObject({ locked: false });
    expect(h.calls).toHaveLength(2);
    // 条件 27：没锁定，但测试文件在副本里——告诉写实现的人别动
    const impl = h.calls[1]!.task.goal;
    expect(impl).not.toContain('验收测试已经写好并锁定');
    expect(impl).toContain(
      `ixaeon-acceptance/${t.id.slice(0, 8)}/ 下是这次任务写的验收测试，没有锁定`,
    );
  });

  it('实现后那一遍不肯跑：等用户接受，验证没跑，原因是沙箱说的话；不算通过也不算失败', async () => {
    const h = setup([writeMulTest, implementMultiply], {
      refuse: (n) => (n >= 2 ? '合成的说明：这一遍不肯跑' : null),
    });
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('pending_accept');
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('合成的说明：这一遍不肯跑');
    expect(report(t.id).acceptanceTests).toMatchObject({ locked: true });
  });
});

describe('条件 23：替身执行器（FakeCodingExecutor）写不出验收测试，照实说', () => {
  it('写测试那一步不动副本；任务照常做完等接受，验证没跑，原因里写明', async () => {
    const fake = new FakeCodingExecutor({ files: { 'calc.mjs': CALC_WITH_MULTIPLY } });
    const h = setup(fake);
    const t = await h.create({});
    const done = await h.coding.dispatch(t.id);
    expect(row(t.id).error).toBeNull();
    expect(done.status).toBe('pending_accept');
    expect(h.log).toEqual(['执行器 1', '执行器 2']);
    expect(row(t.id).verify_status).toBe('not_run');
    expect(row(t.id).verify_output).toContain('替身执行器不写验收测试');
    expect(row(t.id).verify_output).not.toContain('没有有效验证命令');
    expect(report(t.id).acceptanceTests).toMatchObject({ files: [], locked: false });
    expect(report(t.id).changedPaths).toEqual(['calc.mjs']);
    // 替身记下的目标是写实现的那一次，不是写测试的交代（别的测试靠 lastGoal 看派发了什么）
    expect(fake.lastGoal).toContain('给 calc.mjs 加一个 multiply(a, b)');
    expect(fake.lastGoal).not.toContain('这一步只写验收测试');
  });
});

describe('条件 10：ModelCodingExecutor 的只读范围', () => {
  const modelTask = (workspace: string, scope: string[]): CodingTask =>
    ({
      id: 't1',
      project_id: 'p1',
      goal: '照测试写实现',
      scope_json: JSON.stringify(scope),
      status: 'queued',
      timeout_ms: 30_000,
      workspace_path: workspace,
    }) as CodingTask;
  const workspaceWith = (): string => {
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'tests'), { recursive: true });
    writeFileSync(join(ws, 'calc.mjs'), 'CALC_BODY\n');
    writeFileSync(join(ws, 'tests', 'a.test.mjs'), 'TEST_BODY\n');
    writeFileSync(join(ws, 'other.txt'), 'OTHER_BODY\n');
    return ws;
  };
  const sent = (p: FakeProvider) =>
    `${p.structuredCalls[0]!.system}\n${p.structuredCalls[0]!.user}`;
  const signal = () => new AbortController().signal;

  it('只读范围里的文件发内容；范围外又不在只读范围里的照旧不发', async () => {
    const ws = workspaceWith();
    const provider = new FakeProvider('d5a');
    provider.enqueueStructured({ changes: [], summary: 'ok', claimedSuccess: true });
    await new ModelCodingExecutor(provider, 'm').run(modelTask(ws, ['calc.mjs']), ws, signal(), {
      readScope: ['tests'],
    });
    expect(sent(provider)).toContain('CALC_BODY');
    expect(sent(provider)).toContain('TEST_BODY');
    expect(sent(provider)).not.toContain('OTHER_BODY');
  });

  it('不传只读范围：与原来一样，不发', async () => {
    const ws = workspaceWith();
    const provider = new FakeProvider('d5a');
    provider.enqueueStructured({ changes: [], summary: 'ok', claimedSuccess: true });
    await new ModelCodingExecutor(provider, 'm').run(modelTask(ws, ['calc.mjs']), ws, signal());
    expect(sent(provider)).toContain('CALC_BODY');
    expect(sent(provider)).not.toContain('TEST_BODY');
  });

  it('只读范围里的文件看得到、改不了；同一批里合格的改动也不写', async () => {
    const ws = workspaceWith();
    const provider = new FakeProvider('d5a');
    provider.enqueueStructured({
      changes: [
        { path: 'calc.mjs', action: 'write', content: 'NEW_CALC\n' },
        { path: 'tests/a.test.mjs', action: 'write', content: '把测试改松\n' },
      ],
      summary: '改了测试',
      claimedSuccess: true,
    });
    await expect(
      new ModelCodingExecutor(provider, 'm').run(modelTask(ws, ['calc.mjs']), ws, signal(), {
        readScope: ['tests'],
      }),
    ).rejects.toThrow(/tests\/a\.test\.mjs/);
    expect(readFileSync(join(ws, 'tests', 'a.test.mjs'), 'utf8')).toBe('TEST_BODY\n');
    expect(readFileSync(join(ws, 'calc.mjs'), 'utf8')).toBe('CALC_BODY\n');
  });

  it('带着只读范围，能改的范围照常能改', async () => {
    const ws = workspaceWith();
    const provider = new FakeProvider('d5a');
    provider.enqueueStructured({
      changes: [{ path: 'calc.mjs', action: 'write', content: 'NEW_CALC\n' }],
      summary: 'ok',
      claimedSuccess: true,
    });
    const r = await new ModelCodingExecutor(provider, 'm').run(
      modelTask(ws, ['calc.mjs']),
      ws,
      signal(),
      { readScope: ['tests'] },
    );
    expect(r.changedPaths).toEqual(['calc.mjs']);
    expect(readFileSync(join(ws, 'calc.mjs'), 'utf8')).toBe('NEW_CALC\n');
  });
});

describe('条件 11：派发途中取消', () => {
  it('写实现的时候取消：状态是已取消，做完也不再跑测试', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = setup([
      writeMulTest,
      async (c) => {
        await gate;
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        return { changedPaths: ['calc.mjs'] };
      },
    ]);
    const t = await h.create({});
    const dispatched = h.coding.dispatch(t.id);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), { timeout: 10_000 });
    h.coding.cancel(t.id);
    release();
    const done = await dispatched;
    expect(done.status).toBe('cancelled');
    expect(row(t.id).status).toBe('cancelled');
    expect(h.log).toEqual(['执行器 1', '跑 mul.test.mjs', '执行器 2']);
  });

  it('写测试的时候取消：状态是已取消，执行器没有被调第二次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = setup([
      async (c) => {
        await gate;
        c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
        return {};
      },
    ]);
    const t = await h.create({});
    const dispatched = h.coding.dispatch(t.id);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), { timeout: 10_000 });
    h.coding.cancel(t.id);
    release();
    const done = await dispatched;
    expect(done.status).toBe('cancelled');
    expect(h.log).toEqual(['执行器 1']);
  });

  it('条件 16：实现前跑测试的时候取消——验证进程跟着停，状态是已取消，执行器没有被调第二次', async () => {
    const h = setup([
      (c) => {
        c.write(`${c.testDir}/slow.test.mjs`, SLOW_TEST);
        return {};
      },
    ]);
    const t = await h.create({});
    const dispatched = h.coding.dispatch(t.id);
    await vi.waitFor(() => expect(h.log).toContain('跑 slow.test.mjs'), { timeout: 10_000 });
    const cancelledAt = Date.now();
    h.coding.cancel(t.id);
    const done = await dispatched;
    // 测试自己要 45 秒才结束：取消信号接进了验证进程（照 A04），就不用等它
    expect(Date.now() - cancelledAt).toBeLessThan(20_000);
    expect(done.status).toBe('cancelled');
    expect(row(t.id).status).toBe('cancelled');
    expect(h.log).toEqual(['执行器 1', '跑 slow.test.mjs']);
  }, 60_000);
});

describe('条件 12：testsModified 不把本任务新写的验收测试算进去', () => {
  it('只多了验收测试和实现：false（见条件 2）；实现还改了别的测试文件：true', async () => {
    const h = setup([
      writeMulTest,
      (c) => {
        c.write('calc.mjs', CALC_WITH_MULTIPLY);
        c.write('calc.test.mjs', '// 项目里原有的测试，被实现改了\n');
        return { changedPaths: ['calc.mjs', 'calc.test.mjs'] };
      },
    ]);
    const t = await h.create({ scope: ['calc.mjs', 'calc.test.mjs'] });
    const done = await h.coding.dispatch(t.id);
    expect(done.status).toBe('pending_accept');
    expect(report(t.id).testsModified).toBe(true);
    expect(existsSync(join(row(t.id).workspace_path!, 'calc.test.mjs'))).toBe(true);
  });
});
