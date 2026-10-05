/**
 * D7b 真机检查（真模型网关，规格「真机检查」第 2 步）。
 *
 *   node scripts/build.mjs && node scripts/real/d7b-model-task.mjs
 *
 * 做什么：起一个临时的应用实例，把编码任务交给「我的模型」，对一个合成的小 git 项目
 * （只有 README）跑两个任务——范围内加一行、范围外新建文件——再把结果打印出来。
 *
 * 用到用户的什么（都只读，跑完两个临时目录都删掉）：
 * - 真实配置里的五项：API 地址、Key 的密文、有没有 Key、已保存的模型清单、在用的模型名。
 *   写进临时数据目录的一份最小配置；不复制数据库，不复制别的配置项。
 * - 应用用户目录里的 `Local State` 一个文件，复制进临时用户目录。已保存的 Key 是 Electron
 *   safeStorage 的密文，解密钥匙就在这个文件里（它本身由 Windows 按当前登录用户加密，
 *   换一个用户或换一台机器都打不开）。执行方头一版只带了五项配置，临时实例用的是另一个
 *   用户目录，拿不到钥匙，所以解不开、没跑成。
 *
 * 发出去的：合成 README 和任务目标，发给用户自己配置的模型网关。不打印 Key、网关地址；
 * 模型名在输出里换成「<模型名>」，输出可以原样贴进公开仓库。
 * 用户的应用开着也能跑（数据目录、用户目录、端口都是另外的）。
 *
 * 整条链路是真的：IPC → 运行时 → 编排 → 网关执行器 → 模型网关 → 验证 → 接受后建分支。
 * 没走聊天（任务直接经 IPC 建），所以对话里的回报不在这一步照——那一段由端到端测试照。
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

const work = mkdtempSync(join(tmpdir(), 'ixa-d7b-real-'));
const dataDir = join(work, 'data');
const profileDir = join(work, 'profile');
const projectRoot = join(work, 'synth-repo');
for (const d of [dataDir, profileDir, projectRoot]) mkdirSync(d, { recursive: true });
copyFileSync(realLocalState, join(profileDir, 'Local State'));

writeFileSync(join(projectRoot, 'README.md'), '# 合成项目\n\n这是真机检查用的合成项目。\n');
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

/** 输出里不出现模型名和网关地址。 */
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

const VERIFY = ['node', '-e', "if(!require('fs').existsSync('README.md'))process.exit(2)"];
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

  const runTask = async (goal) => {
    const draft = await call('createCodingTask', {
      projectId: project.id,
      goal,
      scope: ['README.md'],
      allowedCommands: [VERIFY],
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
          changed: r.report.changedPaths ?? [],
          summary: r.report.summary ?? null,
          error: r.task.error,
        }),
      ),
    );

  // ===== 任务一：范围内加一行 → 做完 → 接受 → 分支 =====
  const LINE = 'D7b 真机检查加的一行';
  const one = await runTask(`在 README.md 末尾加一行「${LINE}」，别的内容不动`);
  show('TASK1', one);
  const copyReadme = one.task.workspace_path
    ? readFileSync(join(one.task.workspace_path, 'README.md'), 'utf8')
    : '';
  console.log('TASK1_COPY_README', JSON.stringify(copyReadme));
  if (one.task.status !== 'pending_accept') problems.push('任务一没有做到等你验收');
  if (!copyReadme.includes(LINE)) problems.push('副本里的 README 没有多出那一行');
  if (!copyReadme.includes('这是真机检查用的合成项目')) problems.push('README 原来的内容被改掉了');
  if (one.task.status === 'pending_accept') {
    const accepted = await call('acceptCodingTask', one.task.id);
    console.log(
      'TASK1_LANDING',
      JSON.stringify({ ref: accepted.applied_ref, error: accepted.apply_error }),
    );
    const branch = accepted.applied_ref ?? '';
    if (/^ixaeon\//.test(branch)) {
      console.log('TASK1_BRANCH_DIFF', git('diff', '--name-only', 'main', branch));
      console.log('TASK1_BRANCH_README', JSON.stringify(git('show', `${branch}:README.md`)));
      if (git('diff', '--name-only', 'main', branch) !== 'README.md') {
        problems.push('分支上的提交不是正好改了 README');
      }
    } else problems.push('接受后没有建出分支');
  }
  const untouched = readFileSync(join(projectRoot, 'README.md'), 'utf8');
  console.log('TASK1_WORKTREE_UNTOUCHED', untouched.includes(LINE) ? '否' : '是');
  if (untouched.includes(LINE)) problems.push('用户工作区里的 README 被动了');

  // ===== 任务二：批准范围只给 README.md，目标却要新建 other.txt → 不写、失败 =====
  const two = await runTask('新建一个 other.txt，里面写一句说明');
  show('TASK2', two);
  const wrote =
    existsSync(join(projectRoot, 'other.txt')) ||
    (two.task.workspace_path ? existsSync(join(two.task.workspace_path, 'other.txt')) : false);
  console.log('TASK2_NO_FILE_WRITTEN', wrote ? '否（多出了 other.txt）' : '是');
  // 两种都算对：模型照做被执行器拦下（原因里有 other.txt），或者模型自己说范围里做不到
  const how = /other\.txt/.test(two.task.error ?? '')
    ? '执行器拦下（原因里有 other.txt）'
    : two.report.claimedSuccess === false
      ? '模型自己说做不到'
      : '别的原因';
  console.log('TASK2_HOW', how);
  if (two.task.status !== 'failed') problems.push('任务二没有失败');
  if (wrote) problems.push('任务二写出了范围外的文件');
  if (how === '别的原因') problems.push('任务二失败的原因不是预期的两种');

  // 任务页上怎么显示
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('page-tasks').waitFor({ timeout: 20_000 });
  for (const id of [one.task.id, two.task.id]) {
    const card = await page.getByTestId(`task-${id}`).innerText();
    const line = card.split('\n').find((l) => l.includes('执行器')) ?? '';
    console.log('TASK_PAGE_LINE', mask(line.trim()));
    if (!line.includes(`我的模型（${modelName}）`)) {
      problems.push('任务页卡片没有写「我的模型（…）」');
    }
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
