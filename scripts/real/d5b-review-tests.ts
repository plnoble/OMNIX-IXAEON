/**
 * D5b 真机检查（规格「真机检查」）：
 *
 *   node scripts/real/run-batch.mjs scripts/real/d5b-review-tests.ts
 *   node scripts/real/run-batch.mjs scripts/real/d5b-review-tests.ts -- --real
 *
 * 甲（不花钱，开发跑）：替身执行器 + 替身模型，按顺序演两条路——
 *   1. 核出一条太松 → 补 → 核过 → 锁定 → 实现 → 通过；
 *   2. 两次都有问题 → 失败。
 *   任何一步和规格不符就写「结论：不通过」，退出码 1。
 *
 * 乙（用用户的模型网关，整合方合并前跑，花一点钱）：核心模型用真的、执行器用替身。
 *   任务「给 calc.mjs 加一个 multiply」、两条验收条件；替身执行器第 1 步只写条件 1 的测试
 *   （漏条件 2），第 2 步补上。看真模型第 1 次核不核得出「条件 2 漏了」、第 2 次核过、
 *   锁定、实现、通过。Key / 网关地址 / 模型名不出现在输出里。
 *
 * 只用合成项目和一个临时数据目录，不碰用户的数据库、项目和真实记忆。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { CodingTask } from '@ixaeon/contracts';
import {
  ACCEPTANCE_DIR,
  CodingOrchestrator,
  OpenAIResponsesProvider,
  PermissionService,
  ProjectService,
  defaultCheck,
  migrate,
  openDatabase,
  type CodingExecutor,
  type ExecutorReport,
  type IndependentCheck,
  type ModelProvider,
} from '../../packages/core/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const realMode = process.argv.includes('--real');

/** 输出里要遮掉的值（后面读真配置时才填；Key 走这里，万一带进错误话里也不打印）。 */
const SECRETS: Array<[string, string]> = [];
const addSecret = (value: string | null | undefined, label: string) => {
  if (value && value.trim().length > 0) SECRETS.push([value.trim(), label]);
};

/** 输出里不出现本机账户名、临时目录、Key、网关地址、模型名（照 p5-unbind-folder.mjs）。 */
const maskOut = (v: unknown): string => {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  for (const [secret, label] of SECRETS) s = s.split(secret).join(label);
  return s;
};
for (const k of ['log', 'error', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => orig(...a.map(maskOut));
}

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (repo: string, args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// 隔开本机 git 全局配置（签名、钩子）：合成仓库不带任何用户痕迹。
for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const) {
  const empty = join(tempDir('ixa-d5b-cfg-'), 'empty');
  writeFileSync(empty, '');
  process.env[key] = empty;
}

const CALC = 'export function add(a, b) {\n  return a + b;\n}\n';
const CALC_WITH_MULTIPLY = `${CALC}export function multiply(a, b) {\n  return a * b;\n}\n`;
const HEAD = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
/** 松的那条：只查函数存在，不查乘出来的值（条件 1 的「太松」）。 */
const LOOSE_TEST = `${HEAD}test('条件 1：multiply(2, 3) 等于 6', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(typeof calc.multiply, 'function');
});
`;
/** 补过之后：查值。 */
const MUL_TEST = `${HEAD}test('条件 1：multiply(2, 3) 等于 6', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.multiply(2, 3), 6);
});
`;
/** 条件 2：实现前就通过（add 本来就在）。 */
const ADD_TEST = `${HEAD}test('条件 2：原来的 add 不变', async () => {
  const calc = await import('../../calc.mjs');
  assert.equal(calc.add(1, 2), 3);
});
`;

interface Call {
  task: CodingTask;
  workspace: string;
  testDir: string;
  /** 往副本里写一个文件（相对路径，正斜杠）。 */
  write(rel: string, body: string): void;
}
type Step = (call: Call) => Partial<ExecutorReport> | Promise<Partial<ExecutorReport>>;

interface Review {
  status: string;
  rounds: number;
  problems: Array<{ condition: number; kind: string; detail: string }>;
  note: string | null;
}
interface Acceptance {
  files: string[];
  locked: boolean;
  reason: string | null;
  review?: Review;
}
interface ScenarioResult {
  task: CodingTask;
  row: { status: string; error: string | null; verify_status: string | null };
  acceptance: Acceptance | null;
  executorCalls: number;
  /** 每次调执行器时 goal 的开头，用来看补测试那一步的交代。 */
  goals: string[];
  modelCalls: Array<{ system: string; user: string }>;
  /** 模型每次拿回的原始回答（合成测试内容）。 */
  rawAnswers: unknown[];
}

interface ReviewerHandle {
  provider: ModelProvider;
  calls: Array<{ system: string; user: string }>;
  raw: unknown[];
}

/**
 * 起一个合成项目（只有 calc.mjs），执行器按 steps 的次序走、核心模型按预置回答答；
 * 返回跑完的任务与报告。`reviewer` 给了才当第 5 个构造参数传进去。
 */
async function runScenario(input: {
  name: string;
  steps: Step[];
  reviewer?: () => ReviewerHandle;
  acceptance?: string[];
}): Promise<ScenarioResult> {
  const dataDir = tempDir(`ixa-d5b-${input.name}-data-`);
  const projectRoot = tempDir(`ixa-d5b-${input.name}-proj-`);
  git(projectRoot, ['init', '-b', 'main']);
  writeFileSync(join(projectRoot, 'calc.mjs'), CALC);
  git(projectRoot, ['add', '-A']);
  git(projectRoot, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '-m',
    '初始',
  ]);

  const db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const project = new ProjectService(db).create({
    name: 'D5b 合成项目',
    rootPath: projectRoot,
    description: null,
  });
  new PermissionService(db).grantFolder(projectRoot);

  const calls: Call[] = [];
  const goals: string[] = [];
  const executor: CodingExecutor = {
    name: 'scripted',
    async run(task, workspace) {
      const call: Call = {
        task,
        workspace,
        testDir: `${ACCEPTANCE_DIR}/${task.id.slice(0, 8)}`,
        write(rel, body) {
          const abs = join(workspace, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, body);
        },
      };
      calls.push(call);
      goals.push(task.goal);
      const step = input.steps[calls.length - 1];
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
  ): Promise<IndependentCheck> => defaultCheck(argv, cwd, signal);

  const handle = input.reviewer?.();
  const coding = handle
    ? new CodingOrchestrator(db, executor, dataDir, runCheck, () => handle.provider)
    : new CodingOrchestrator(db, executor, dataDir, runCheck);

  const task = coding.create({
    projectId: project.id,
    goal: '给 calc.mjs 加一个 multiply(a, b)',
    scope: ['calc.mjs'],
    allowedCommands: [],
    acceptance: input.acceptance ?? ['multiply(2, 3) 等于 6', '原来的 add 不变'],
  });
  await coding.approveAndQueue(task.id);
  const done = await coding.dispatch(task.id);
  const row = db
    .prepare('SELECT status, error, verify_status FROM coding_tasks WHERE id = ?')
    .get(task.id) as ScenarioResult['row'];
  const reportJson = (
    db.prepare('SELECT executor_report_json FROM coding_tasks WHERE id = ?').get(task.id) as {
      executor_report_json: string | null;
    }
  ).executor_report_json;
  const acceptance =
    (JSON.parse(reportJson ?? '{}') as { acceptanceTests?: Acceptance }).acceptanceTests ?? null;
  db.close();
  return {
    task: done,
    row,
    acceptance,
    executorCalls: calls.length,
    goals,
    modelCalls: handle?.calls ?? [],
    rawAnswers: handle?.raw ?? [],
  };
}

/** 替身核心模型：按顺序消费预置回答；回答是 Error 就抛出去。 */
class ScriptedModel implements ModelProvider {
  readonly modelName = 'd5b-fake-review';
  readonly calls: Array<{ system: string; user: string }> = [];
  readonly raw: unknown[] = [];
  constructor(private readonly answers: unknown[]) {}
  async chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    this.calls.push({ system: input.system, user: input.user });
    if (this.answers.length === 0) throw new Error('D5b 替身模型没有预置回答');
    const answer = this.answers.shift();
    this.raw.push(answer);
    if (answer instanceof Error) throw answer;
    return input.schema.parse(answer);
  }
  async chatText(): Promise<string> {
    throw new Error('D5b 的核对不该走 chatText');
  }
}

/** 包一层真的核心模型：记下每次拿回的问题，供乙打印。 */
class RecordingModel implements ModelProvider {
  readonly calls: Array<{ system: string; user: string }> = [];
  readonly raw: unknown[] = [];
  constructor(private readonly inner: ModelProvider) {}
  get modelName(): string {
    return this.inner.modelName;
  }
  async chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    this.calls.push({ system: input.system, user: input.user });
    const answer = await this.inner.chatStructured(input);
    this.raw.push(answer);
    return answer;
  }
  chatText(input: { system: string; user: string }): Promise<string> {
    return this.inner.chatText(input);
  }
}

/** 读用户应用里已保存的模型五项（只读；不复制数据库、不碰真实记忆）。 */
function readRealModel(): { modelName: string; apiBaseUrl: string; apiKeyEncrypted: string } {
  const bootstrapFile = join(process.env.LOCALAPPDATA ?? '', 'OMNIX', 'IXAEON', 'bootstrap.json');
  if (!existsSync(bootstrapFile)) throw new Error('找不到应用的 dataDir 指针（bootstrap.json）');
  const boot = JSON.parse(readFileSync(bootstrapFile, 'utf8')) as { dataDir?: string };
  if (!boot.dataDir) throw new Error('bootstrap.json 里没有 dataDir');
  const configFile = join(boot.dataDir, 'config.json');
  if (!existsSync(configFile)) throw new Error('找不到应用的 config.json');
  const model = (
    JSON.parse(readFileSync(configFile, 'utf8')) as {
      model?: {
        modelName?: string;
        apiBaseUrl?: string;
        apiKeyEncrypted?: string | null;
        apiKeyPresent?: boolean;
      };
    }
  ).model;
  if (!model) throw new Error('应用的配置里没有 model 一段');
  if (!model.apiKeyPresent || !model.apiKeyEncrypted) throw new Error('应用里还没有保存 API Key');
  if (!model.modelName) throw new Error('应用里没有在用的模型');
  const gateway = model.apiBaseUrl?.trim() ?? '';
  addSecret(gateway, '<网关>');
  try {
    addSecret(new URL(gateway).host, '<网关>');
  } catch {
    /* 地址不是 URL 时只遮整串 */
  }
  addSecret(model.modelName, '<模型名>');
  return {
    modelName: model.modelName,
    apiBaseUrl: gateway,
    apiKeyEncrypted: model.apiKeyEncrypted,
  };
}

/**
 * 用应用自己的 safeStorage 解开已保存的 Key：起一个只做解密、不开窗口的 Electron 临时实例，
 * 只把 Key 通过管道交给本进程（不打印、不落盘；临时目录跑完就删）。
 */
function decryptSavedKey(encrypted: string): string {
  const work = tempDir('ixa-d5b-key-');
  const profileDir = join(work, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const localState = join(process.env.APPDATA ?? '', '@ixaeon', 'desktop', 'Local State');
  if (!existsSync(localState)) throw new Error('找不到应用用户目录里的 Local State');
  copyFileSync(localState, join(profileDir, 'Local State'));
  const helper = join(work, 'decrypt-key.cjs');
  writeFileSync(
    helper,
    [
      "const { app, safeStorage } = require('electron');",
      'app.whenReady().then(() => {',
      '  try {',
      '    if (!safeStorage.isEncryptionAvailable()) {',
      "      process.stdout.write(JSON.stringify({ ok: false, why: '系统加密不可用' }), () => app.exit(0));",
      '    } else {',
      "      const key = safeStorage.decryptString(Buffer.from(process.argv.at(-1), 'base64'));",
      '      process.stdout.write(JSON.stringify({ ok: true, key }), () => app.exit(0));',
      '    }',
      '  } catch (err) {',
      '    process.stdout.write(JSON.stringify({ ok: false, why: String((err && err.message) || err) }), () => app.exit(0));',
      '  }',
      '});',
    ].join('\n'),
    'utf8',
  );
  const desktopRequire = createRequire(join(root, 'apps', 'desktop', 'package.json'));
  const electronExe = desktopRequire('electron') as string;
  const r = spawnSync(
    electronExe,
    [`--user-data-dir=${profileDir}`, '--no-sandbox', helper, encrypted],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (r.error) throw new Error(`解密用的 Electron 起不来：${r.error.message}`);
  const line = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.includes('"ok"'))
    .at(-1);
  if (!line) throw new Error('解不开已保存的 Key（Electron 没有给出结果）');
  const parsed = JSON.parse(line) as { ok?: boolean; key?: string; why?: string };
  if (!parsed.ok || !parsed.key) throw new Error(`解不开已保存的 Key：${parsed.why ?? '未知原因'}`);
  return parsed.key;
}

function makeRealProvider(): ModelProvider {
  const real = readRealModel();
  const key = decryptSavedKey(real.apiKeyEncrypted);
  addSecret(key, '<Key>');
  return new OpenAIResponsesProvider({
    apiKey: key,
    modelName: real.modelName,
    ...(real.apiBaseUrl ? { baseUrl: real.apiBaseUrl } : {}),
  });
}

const problems: string[] = [];
const check = (ok: boolean, why: string): boolean => {
  if (!ok) problems.push(why);
  return ok;
};
const isReview = (r: ScenarioResult, status: string, rounds: number): boolean =>
  r.acceptance?.review?.status === status && r.acceptance.review.rounds === rounds;

let passed = true;
const bail = (err: unknown): never => {
  console.log('RESULT', `没跑成：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

try {
  // ===== 甲 1：核出一条太松 → 补 → 核过 → 锁定 → 实现 → 通过 =====
  {
    const model = new ScriptedModel([
      { problems: [{ condition: 1, kind: 'loose', detail: '只查了函数存在，没查乘出来的值' }] },
      { problems: [] },
    ]);
    const r = await runScenario({
      name: 'loose',
      steps: [
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, LOOSE_TEST);
          return { summary: '写了条件 1 的测试' };
        },
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
          c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
          return { summary: '补好了' };
        },
        (c) => {
          c.write('calc.mjs', CALC_WITH_MULTIPLY);
          return { summary: '加了 multiply', changedPaths: ['calc.mjs'] };
        },
      ],
      reviewer: () => ({ provider: model, calls: model.calls, raw: model.raw }),
    });
    console.log('\n=== 甲 1：核出一条太松 → 补 → 核过 → 锁定 → 实现 → 通过');
    console.log(
      '结果',
      JSON.stringify({
        status: r.task.status,
        verify: r.row.verify_status,
        acceptanceTests: r.acceptance,
        executorCalls: r.executorCalls,
        modelCalls: r.modelCalls.length,
      }),
    );
    const fixHasProblem =
      r.goals[1]?.includes('条件 1（太松）：只查了函数存在，没查乘出来的值') ?? false;
    console.log('补测试的交代里有那条问题', fixHasProblem);
    const calc = r.task.workspace_path
      ? readFileSync(join(r.task.workspace_path, 'calc.mjs'), 'utf8')
      : '';
    const hasMultiply = /export function multiply/.test(calc);
    console.log('副本里的 calc.mjs 有 multiply', hasMultiply);
    const ok =
      check(r.task.status === 'pending_accept', '甲 1：任务没有停在等你验收') &&
      check(r.row.verify_status === 'passed', '甲 1：验证没有通过') &&
      check(r.acceptance?.locked === true, '甲 1：验收测试没有锁定') &&
      check(isReview(r, 'passed', 2), '甲 1：review 不是 { passed, rounds: 2 }') &&
      check(r.executorCalls === 3, `甲 1：执行器被调了 ${r.executorCalls} 次（期望 3）`) &&
      check(r.modelCalls.length === 2, `甲 1：模型被调了 ${r.modelCalls.length} 次（期望 2）`) &&
      check(fixHasProblem, '甲 1：补测试的交代里没有那条问题') &&
      check(hasMultiply, '甲 1：副本里没有 multiply');
    if (!ok) passed = false;
  }

  // ===== 甲 2：两次都有问题 → 失败 =====
  {
    const second = [
      { condition: 1, kind: 'loose', detail: '还是只查函数存在，没查乘出来的值' },
      { condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' },
    ];
    const model = new ScriptedModel([
      { problems: [{ condition: 2, kind: 'missing', detail: '没有测试检查原来的 add 不变' }] },
      { problems: second },
    ]);
    const r = await runScenario({
      name: 'twice',
      steps: [
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, LOOSE_TEST);
          return { summary: '写了条件 1 的测试' };
        },
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
          return { summary: '补过了，但条件 2 还是没测' };
        },
      ],
      reviewer: () => ({ provider: model, calls: model.calls, raw: model.raw }),
    });
    const expected = [
      '核心模型核了两次，验收测试还有问题，没有写实现：',
      '- 条件 1（太松）：还是只查函数存在，没查乘出来的值',
      '- 条件 2（漏了）：没有测试检查原来的 add 不变',
    ].join('\n');
    console.log('\n=== 甲 2：两次都有问题 → 失败');
    console.log(
      '结果',
      JSON.stringify({
        status: r.task.status,
        verify: r.row.verify_status,
        review: r.acceptance?.review ?? null,
        executorCalls: r.executorCalls,
        modelCalls: r.modelCalls.length,
      }),
    );
    console.log('失败原因', JSON.stringify(r.row.error));
    const ok =
      check(r.task.status === 'failed', '甲 2：任务没有失败') &&
      check(r.row.error === expected, '甲 2：失败原因和规格第 5 条对不上') &&
      check(isReview(r, 'failed', 2), '甲 2：review 不是 { failed, rounds: 2 }') &&
      check(
        r.executorCalls === 2,
        `甲 2：执行器被调了 ${r.executorCalls} 次（期望 2，没写实现）`,
      ) &&
      check(r.modelCalls.length === 2, `甲 2：模型被调了 ${r.modelCalls.length} 次（期望 2）`);
    if (!ok) passed = false;
  }

  // ===== 乙：真核心模型（整合方合并前跑） =====
  if (!realMode) {
    console.log('\n=== 乙：没跑（要 --real：用用户的模型网关，整合方合并前跑，花一点钱）');
  } else {
    const recording = new RecordingModel(makeRealProvider());
    const r = await runScenario({
      name: 'real',
      steps: [
        (c) => {
          c.write(`${c.testDir}/mul.test.mjs`, MUL_TEST);
          return { summary: '只写了条件 1 的测试' };
        },
        (c) => {
          c.write(`${c.testDir}/add.test.mjs`, ADD_TEST);
          return { summary: '补上条件 2 的测试' };
        },
        (c) => {
          c.write('calc.mjs', CALC_WITH_MULTIPLY);
          return { summary: '加了 multiply', changedPaths: ['calc.mjs'] };
        },
      ],
      reviewer: () => ({ provider: recording, calls: recording.calls, raw: recording.raw }),
    });
    const answers = r.rawAnswers as Array<{
      problems?: Array<{ condition: number; kind: string }>;
    }>;
    console.log('\n=== 乙：真核心模型');
    console.log(
      '结果',
      JSON.stringify({
        status: r.task.status,
        verify: r.row.verify_status,
        review: r.acceptance?.review
          ? {
              status: r.acceptance.review.status,
              rounds: r.acceptance.review.rounds,
              problems: r.acceptance.review.problems.length,
            }
          : null,
        executorCalls: r.executorCalls,
        modelCalls: r.modelCalls.length,
        error: r.row.error,
      }),
    );
    for (const [i, a] of answers.entries()) {
      console.log(
        `第 ${i + 1} 次核出`,
        JSON.stringify((a.problems ?? []).map((p) => ({ condition: p.condition, kind: p.kind }))),
      );
    }
    const first = answers[0]?.problems ?? [];
    const calc = r.task.workspace_path
      ? readFileSync(join(r.task.workspace_path, 'calc.mjs'), 'utf8')
      : '';
    const ok =
      check(
        first.some((p) => p.condition === 2 && p.kind === 'missing'),
        '乙：真模型第 1 次没核出「条件 2 漏了」',
      ) &&
      check(r.task.status === 'pending_accept', '乙：任务没有停在等你验收') &&
      check(isReview(r, 'passed', 2), '乙：第 2 次核没通过') &&
      check(r.acceptance?.locked === true, '乙：验收测试没有锁定') &&
      check(r.row.verify_status === 'passed', '乙：验证没有通过') &&
      check(r.executorCalls === 3, `乙：执行器被调了 ${r.executorCalls} 次（期望 3）`) &&
      check(/export function multiply/.test(calc), '乙：副本里没有 multiply');
    if (!ok) passed = false;
  }
} catch (err) {
  problems.push(`脚本出错：${err instanceof Error ? err.message : String(err)}`);
  passed = false;
}

for (const d of dirs.splice(0)) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* 删不干净不影响结论 */
  }
}
if (!passed) {
  console.log(`\n结论：不通过\n- ${problems.join('\n- ')}`);
  console.log('RESULT', `没通过：${problems.join('；')}`);
  process.exit(1);
}
console.log(
  '\nRESULT',
  realMode
    ? '通过：甲 1、甲 2 都照规格走完；乙 真模型核出条件 2 漏了并在第 2 次通过'
    : '通过：甲 1、甲 2 都照规格走完；乙 没跑（要 --real）',
);
process.exit(0);
