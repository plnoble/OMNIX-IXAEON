/**
 * D5a 真机检查（真模型网关，规格「真机检查」）。
 *
 *   node scripts/build.mjs && node scripts/real/d5a-acceptance-first.mjs
 *
 * 做什么：起一个临时的应用实例，把编码任务交给「我的模型」，对一个合成的小 git 项目
 * （一个不带依赖的 calc.mjs，只有 add；一个 README）跑两个带验收条件、没有验证命令的任务：
 *   1.「给 calc.mjs 加一个 multiply(a, b)」——能测的：看模型写的测试、锁没锁定、最后验证过没过、
 *      接受后分支里有什么；
 *   2.「把 README 写得更通顺」——测不了的：看模型在写测试那一步说了什么、最后怎么收的。
 *
 * 用到用户的什么、发出去什么、怎么不留痕，和 scripts/real/d7b-model-task.mjs 一样：
 * - 真实配置里只取五项（API 地址、Key 的密文、有没有 Key、已保存的模型清单、在用的模型名），
 *   写进临时数据目录；应用用户目录里只带 `Local State` 一个文件（解开 Key 密文的钥匙在里面），
 *   放进临时用户目录。不复制数据库。跑完两个临时目录都删掉。
 * - 发给模型网关的只有合成项目的文件和任务目标。不打印 Key、网关地址；模型名换成「<模型名>」。
 * - 用户的应用开着也能跑（数据目录、用户目录、端口都是另外的）。
 *
 * 任务怎么建：`createCodingTask` 的接口类型里没有验收条件这一项，但处理函数是把收到的东西
 * 原样交给 `coding.create` 的，多带一个 `acceptance` 就建得出「有验收条件、没有验证命令」的任务，
 * 不用往库里直接写。然后经 IPC 批准、派发——验收先行的五步都在派发里。
 * 没走聊天，所以对话里的回报不在这一步照（端到端测试照那一段）。
 *
 * 验证是真的：应用里跑验证用的是 Electron 自己（当 node 用），带权限模型和断网。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
const { _electron: electron } = createRequire(join(desktopApp, 'package.json'))('@playwright/test');

const fail = (code, why) => {
  console.log('RESULT', `没跑成：${why}`);
  process.exit(code);
};

// ---- 真实配置：只取五项 ----
const bootstrapFile = join(process.env.LOCALAPPDATA ?? '', 'OMNIX', 'IXAEON', 'bootstrap.json');
if (!existsSync(bootstrapFile)) fail(2, '找不到应用的数据目录指针');
const realDataDir = JSON.parse(readFileSync(bootstrapFile, 'utf8')).dataDir;
const real = JSON.parse(readFileSync(join(realDataDir, 'config.json'), 'utf8')).model ?? {};
if (!real.apiKeyPresent || !real.apiKeyEncrypted) fail(2, '应用里还没有保存 API Key');
const savedModels = Array.isArray(real.savedModels) ? real.savedModels : [];
const override = process.env.IXAEON_REAL_CODING_MODEL?.trim();
const modelName = override || real.modelName || savedModels[0] || '';
if (!modelName) fail(2, '应用里没有在用的模型，也没有已保存的模型');
const modelFrom = override ? '环境变量指定的' : real.modelName ? '在用的分析模型' : '清单第一个';

// ---- 解密钥匙：应用用户目录里的 Local State（只带这一个文件）----
const realLocalState = join(process.env.APPDATA ?? '', '@ixaeon', 'desktop', 'Local State');
if (!existsSync(realLocalState)) fail(2, '找不到应用用户目录里的 Local State');

const work = mkdtempSync(join(tmpdir(), 'ixa-d5a-real-'));
const dataDir = join(work, 'data');
const profileDir = join(work, 'profile');
const projectRoot = join(work, 'synth-repo');
for (const d of [dataDir, profileDir, projectRoot]) mkdirSync(d, { recursive: true });
copyFileSync(realLocalState, join(profileDir, 'Local State'));

const CALC = 'export function add(a, b) {\n  return a + b;\n}\n';
const README =
  '# 合成项目\n\n这个项目是真机检查用的合成项目，里面有一个 calc.mjs，它只有一个 add。\n';
writeFileSync(join(projectRoot, 'calc.mjs'), CALC);
writeFileSync(join(projectRoot, 'README.md'), README);
const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
git('init', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');

writeFileSync(
  join(dataDir, 'config.json'),
  JSON.stringify(
    {
      configVersion: 1,
      setupComplete: true,
      model: {
        provider: 'openai',
        modelName: real.modelName ?? '',
        chatModelName: '',
        apiBaseUrl: real.apiBaseUrl ?? '',
        apiKeyEncrypted: real.apiKeyEncrypted,
        apiKeyPresent: true,
        // 临时配置里保证选的模型在清单里（用户的清单为空时也能跑）
        savedModels: savedModels.includes(modelName) ? savedModels : [...savedModels, modelName],
        modelsCheckedAt: null,
      },
      capture: { enabled: false, autoAnalyze: false, pausedConversations: [], pausedSessions: [] },
      extension: { token: null, pairedAt: null },
      localToken: null,
      webSearch: { provider: 'none', apiKeyEncrypted: null, apiKeyPresent: false },
      hermesBridge: { enabled: false, token: null },
      coding: { executor: 'model', modelName },
    },
    null,
    2,
  ),
);
console.log(
  'CONFIG',
  `五项已取；已保存的模型 ${savedModels.length} 个；编码用的模型：${modelFrom}`,
);

/** 输出里不出现模型名、网关地址和本机的临时目录。 */
const gateway = String(real.apiBaseUrl ?? '').trim();
const gatewayHost = (() => {
  try {
    return new URL(gateway).host;
  } catch {
    return '';
  }
})();
const mask = (text) => {
  let out = String(text ?? '');
  for (const [secret, label] of [
    [gateway, '<网关>'],
    [gatewayHost, '<网关>'],
    [modelName, '<模型名>'],
    [work, '<临时目录>'],
    [work.replaceAll('\\', '/'), '<临时目录>'],
  ]) {
    if (secret) out = out.split(secret).join(label);
  }
  return out;
};

const env = { ...process.env };
delete env.IXAEON_FAKE_MODEL;
delete env.IXAEON_FAKE_MODEL_SCRIPT;
Object.assign(env, {
  IXAEON_DATA_DIR: dataDir,
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_TEST_DIALOG_RESPONSES: `directory|${projectRoot}`,
});

/** 起了应用之后要停下，一律抛这个：先走 finally 关应用、删临时目录，再退出。 */
class Stop extends Error {}
let app = null;
let passed = false;
let stopped = null;
const problems = [];
try {
  app = await electron.launch({
    args: [`--user-data-dir=${profileDir}`, join(desktopApp, 'out', 'main', 'index.js')],
    env,
  });
  // 先确认这个实例用的确实是临时用户目录，不是用户真实的那个
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  if (userData.toLowerCase() !== profileDir.toLowerCase()) {
    throw new Stop('临时实例没有用上临时用户目录，已停下（不碰真实的用户目录）');
  }
  const page = await app.firstWindow();
  await page.getByTestId('main-nav').waitFor({ timeout: 60_000 });
  const call = (name, ...args) => page.evaluate(([n, a]) => window.ixaeon[n](...a), [name, args]);

  // 项目 + 绑定文件夹（走真的票据与授权：对话框用测试钩子代答）
  const project = await call('createProject', {
    name: '合成项目',
    rootPath: null,
    description: null,
  });
  const picked = await call('pickFiles', 'directory');
  await call('bindProjectFolder', { ticket: picked.ticket, projectId: project.id });

  const before = await call('listCodingTasks');
  console.log('TASKS_NOTICE', mask(before.notice));
  if (before.executor !== 'model' || /API Key/.test(before.notice)) {
    throw new Stop('临时实例解不开已保存的 Key');
  }
  console.log('KEY_DECRYPT', '能解开');

  const runTask = async (goal, scope, acceptance) => {
    const draft = await call('createCodingTask', {
      projectId: project.id,
      goal,
      scope,
      allowedCommands: [],
      acceptance,
    });
    await call('approveCodingTask', draft.id);
    const started = Date.now();
    const done = await call('dispatchCodingTask', draft.id);
    const report = done.executor_report_json ? JSON.parse(done.executor_report_json) : {};
    return { task: done, report, seconds: Math.round((Date.now() - started) / 1000) };
  };
  const show = (label, r) =>
    console.log(
      label,
      mask(
        JSON.stringify({
          status: r.task.status,
          executor: r.task.executor_name,
          verify: r.task.verify_status,
          seconds: r.seconds,
          acceptanceTests: r.report.acceptanceTests ?? null,
          changed: r.report.changedPaths ?? [],
          testsModified: r.report.testsModified ?? null,
          summary: r.report.summary ?? null,
          error: r.task.error,
        }),
      ),
    );
  const showOutput = (label, r) =>
    console.log(label, mask(JSON.stringify((r.task.verify_output ?? '').slice(0, 1500))));

  // ===== 任务一：能测的 =====
  const one = await runTask(
    '给 calc.mjs 加一个 multiply(a, b)',
    ['calc.mjs'],
    ['multiply(2, 3) 等于 6', '原来的 add 不变'],
  );
  show('TASK1', one);
  showOutput('TASK1_VERIFY_OUTPUT', one);
  const tests1 = one.report.acceptanceTests ?? { files: [], locked: false, reason: null };
  // 模型写的测试原样打印：内容只和合成项目有关
  for (const rel of tests1.files) {
    const abs = one.task.workspace_path ? join(one.task.workspace_path, rel) : '';
    console.log(
      'TASK1_TEST_FILE',
      rel,
      JSON.stringify(existsSync(abs) ? readFileSync(abs, 'utf8') : '（副本里没有）'),
    );
  }
  // 实现前那一遍的退出码库里不存：锁定了，就是实现前至少有一个文件不通过
  console.log(
    'TASK1_RED_RUN',
    tests1.locked ? '实现前至少一个测试文件不通过（所以锁定了）' : `没锁定：${mask(tests1.reason)}`,
  );
  const copyCalc =
    one.task.workspace_path && existsSync(join(one.task.workspace_path, 'calc.mjs'))
      ? readFileSync(join(one.task.workspace_path, 'calc.mjs'), 'utf8')
      : '';
  console.log('TASK1_COPY_CALC', JSON.stringify(copyCalc));
  if (one.task.status !== 'pending_accept') problems.push('任务一没有做到等你验收');
  if (tests1.files.length === 0) problems.push('任务一没写出验收测试');
  if (!tests1.locked) problems.push('任务一的验收测试没锁定');
  if (one.task.verify_status !== 'passed') problems.push('任务一没有验证通过');
  if (!/multiply/.test(copyCalc)) problems.push('副本里的 calc.mjs 没有 multiply');
  if (!/export function add/.test(copyCalc)) problems.push('原来的 add 不见了');
  if (one.task.status === 'pending_accept') {
    const accepted = await call('acceptCodingTask', one.task.id);
    console.log(
      'TASK1_LANDING',
      JSON.stringify({ ref: accepted.applied_ref, error: accepted.apply_error }),
    );
    const branch = accepted.applied_ref ?? '';
    if (/^ixaeon\//.test(branch)) {
      const names = git('diff', '--name-only', 'main', branch).split('\n').filter(Boolean).sort();
      console.log('TASK1_BRANCH_DIFF', JSON.stringify(names));
      if (!names.includes('calc.mjs')) problems.push('分支里没有改 calc.mjs');
      for (const rel of tests1.files) {
        if (!names.includes(rel)) problems.push(`分支里没有验收测试 ${rel}`);
      }
    } else problems.push('接受后没有建出分支');
  }
  const untouched = readFileSync(join(projectRoot, 'calc.mjs'), 'utf8') === CALC;
  console.log('TASK1_WORKTREE_UNTOUCHED', untouched ? '是' : '否');
  if (!untouched) problems.push('用户工作区里的 calc.mjs 被动了');
  if (existsSync(join(projectRoot, 'ixaeon-acceptance'))) {
    problems.push('用户工作区里多出了 ixaeon-acceptance 目录');
  }

  // ===== 任务二：测不了的 =====
  const two = await runTask('把 README 写得更通顺', ['README.md'], ['读起来通顺']);
  show('TASK2', two);
  showOutput('TASK2_VERIFY_OUTPUT', two);
  const tests2 = two.report.acceptanceTests ?? null;
  // 怎么收的都如实打印；只有这几种算不对：没走验收先行、说验证通过却没有锁定的测试、没跑却不给原因
  if (!tests2 && two.task.status !== 'failed') problems.push('任务二没有走验收先行');
  if (two.task.verify_status === 'passed' && !tests2?.locked) {
    problems.push('任务二没有锁定的测试却写了验证通过');
  }
  if (two.task.verify_status === 'not_run' && !(two.task.verify_output ?? '').trim()) {
    problems.push('任务二验证没跑却没有原因');
  }
  if (!['pending_accept', 'failed'].includes(two.task.status)) {
    problems.push(`任务二停在了 ${two.task.status}`);
  }

  // 任务页上怎么显示
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('page-tasks').waitFor({ timeout: 20_000 });
  for (const id of [one.task.id, two.task.id]) {
    const card = await page.getByTestId(`task-${id}`).innerText();
    const line = card.split('\n').find((l) => l.includes('执行器')) ?? '';
    console.log('TASK_PAGE_LINE', mask(line.trim()));
  }
  passed = problems.length === 0;
} catch (err) {
  if (err instanceof Stop) stopped = err.message;
  else problems.push(`脚本出错：${mask(err instanceof Error ? err.message : String(err))}`);
} finally {
  if (app) await app.close().catch(() => undefined);
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(
    'CLEANUP',
    existsSync(work) ? `临时目录没删干净，请手动删：${work}` : '临时目录都已删掉',
  );
}
if (stopped) {
  console.log('RESULT', `没跑成：${stopped}`);
  process.exit(3);
}
console.log('RESULT', passed ? '通过' : `没通过：${problems.join('；')}`);
process.exit(passed ? 0 : 1);
