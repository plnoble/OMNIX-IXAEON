/**
 * V4 真机检查（规格 docs/委派/V4-依赖档验证的授权入口.md「真机检查」1–4 条）。
 *
 * 照 scripts/real/p7-revoke-reading.mjs 的规矩：临时数据目录、随机端口、IXAEON_EMBED_MODEL=none、
 * 打印遮掉临时目录与本机账户目录、只有全都符合才写「通过」、RESULT 和退出码一致、脚本出错非零。
 *
 * **全程不点「授权」**（那会在用户电脑上弹管理员确认、装系统账户和服务），
 * 也**不让真的 Codex 执行任何任务**：第 4 步只跑 `codex … --help` 核对参数名。
 *
 *   node scripts/build.mjs && node scripts/real/v4-verify-sandbox.mjs
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');

const work = mkdtempSync(join(tmpdir(), 'ixa-v4-real-'));
// 打印遮掉：临时目录（应用里存的是规范化过的路径，两种都遮）与本机账户目录
const masks = [
  ...new Set(
    [work, realpathSync.native(work), homedir(), realpathSync.native(homedir())].filter(
      (m) => typeof m === 'string' && m.length > 0,
    ),
  ),
];
const mask = (s) => masks.reduce((acc, m) => acc.replaceAll(m, '<本机>'), s);
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const projDir = join(work, 'synproj');
mkdirSync(join(projDir, 'node_modules', 'vitest'), { recursive: true });
writeFileSync(join(projDir, 'note.txt'), '合成项目文件\n');
// 占位 vitest：让依赖档验证走到「沙箱授权检查」那一步（真实跑测试要授权，这里不跑）
writeFileSync(join(projDir, 'node_modules', 'vitest', 'vitest.mjs'), '// 占位\n');

const UNAUTHORIZED_PREFIX = '还没授权（Codex ';
const UNAUTHORIZED_SUFFIX =
  '）。带 npm 依赖的项目，验收测试现在跑不了。授权一次就行；Codex 升级之后要再授权一次。';
const CODEX_MISSING_TEXT = '没找到 Codex 命令行，依赖档验证跑不了。';
const CODEX_MISSING_VERIFY = '没找到 Codex 命令行，依赖档验证跑不了（这一档要用 Codex 的沙箱）。';

let result = '没通过：脚本没跑完';
let passed = true;
const fail = (why) => {
  log('不符：', why);
  if (passed) result = `没通过：${why}`;
  passed = false;
};

const apps = [];
const dbs = [];

// 宿主（开发 agent 的 shell / CI 门禁）可能带着 ELECTRON_RUN_AS_NODE：那样 Electron 会当
// 普通的 node 跑，主进程里 `app` 是 undefined，窗口起不来（门禁脚本也清这一条）。
const hostEnv = { ...process.env };
delete hostEnv.ELECTRON_RUN_AS_NODE;

/** 起一次应用（合成分数据目录；每次一个独立 profile）。 */
async function launchApp(dataDir, extraEnv) {
  const n = apps.length;
  const app = await electron.launch({
    args: [
      resolve('apps/desktop/out/main/index.js'),
      `--user-data-dir=${join(work, `profile-${n}`)}`,
    ],
    env: {
      ...hostEnv,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      IXAEON_EMBED_MODEL: 'none',
      IXAEON_FAKE_MODEL: '1',
      ...extraEnv,
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** 过一遍首次设置向导。 */
async function completeSetup(page) {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('syn-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目 V4');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
}

const textOf = async (page, testId) =>
  (
    (await page
      .getByTestId(testId)
      .textContent({ timeout: 3000 })
      .catch(() => null)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();

const openSettings = async (page) => {
  await page.getByTestId('nav-settings').click();
  await page.waitForTimeout(800);
};

function openDb(dataDir) {
  const db = new Database(join(dataDir, 'ixaeon.db'), { readonly: true });
  dbs.push(db);
  return db;
}

/** 问一个 codex.exe 的版本（真机、只问版本，不执行任务）。 */
function codexVersionOf(exe) {
  try {
    const r = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    const m = /(\d+\.\d+\.\d+\S*)/.exec(String(r.stdout ?? ''));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 本机 bin 下的候选（和 IXAEON 的找法一样：顶层 + 每个子目录）。 */
function codexCandidates() {
  const base = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const list = [];
  const top = join(base, 'codex.exe');
  if (existsSync(top)) list.push(top);
  try {
    for (const d of readdirSync(base)) {
      if (d === 'codex.exe') continue;
      const p = join(base, d, 'codex.exe');
      if (existsSync(p)) list.push(p);
    }
  } catch {
    // 没有安装目录
  }
  return list;
}

const rank = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
};
const newer = (a, b) => {
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** 用帮助文本核一个参数名在不在（长短名都认）。 */
const hasArg = (help, name) => {
  if (name.startsWith('--')) return help.includes(name);
  // 单字母：要求它出现在选项位置（如 `-c, --config`）
  return new RegExp(`(^|[\\s,])${name.replace('-', '\\-')}[,\\s]`, 'm').test(help);
};

try {
  // ---- 1. IXAEON_CODEX_EXE=none：那句话是「没找到 Codex 命令行」，没有「授权」按钮 ----
  const data1 = join(work, 'data1');
  mkdirSync(data1, { recursive: true });
  const one = await launchApp(data1, { IXAEON_CODEX_EXE: 'none' });
  await completeSetup(one.page);
  await openSettings(one.page);
  const status1 = await textOf(one.page, 'settings-verify-sandbox-status');
  const button1 = await one.page.getByTestId('settings-verify-sandbox-authorize').count();
  log('[1] IXAEON_CODEX_EXE=none 时「依赖档验证」那句话：', status1);
  log('[1] 「授权」按钮个数：', button1);
  if (status1 !== CODEX_MISSING_TEXT) fail('步骤 1：那句话不是「没找到 Codex 命令行」');
  if (button1 !== 0) fail('步骤 1：没找到 Codex 时不该有「授权」按钮');
  await one.app.close();

  // ---- 2. 不指定：用这台机器上的 Codex，临时数据目录里没有授权记录 ----
  const data2 = join(work, 'data2');
  mkdirSync(data2, { recursive: true });
  const two = await launchApp(data2, {});
  await completeSetup(two.page);
  await openSettings(two.page);
  const status2 = await textOf(two.page, 'settings-verify-sandbox-status');
  const button2 = await two.page.getByTestId('settings-verify-sandbox-authorize').count();
  log('[2] 不指定时那句话：', status2);
  log('[2] 「授权」按钮个数：', button2, '（有，但这一步不点）');
  const shown = /^还没授权（Codex (.+)）/.exec(status2)?.[1] ?? null;
  const candidates = codexCandidates();
  const versions = candidates.map((exe) => ({ exe, version: codexVersionOf(exe) }));
  log('[2] 本机 bin 下的 codex.exe 与版本：');
  for (const c of versions) log(`    - ${c.exe} → ${c.version ?? '（问不出版本号）'}`);
  let newest = versions[0] ?? null;
  for (const c of versions) {
    if (c.version !== null && (newest?.version == null || newer(c.version, newest.version)))
      newest = c;
  }
  log('[2] 按数字比出来的最新版：', newest ? `${newest.exe} → ${newest.version}` : '（没有）');
  log('[2] 设置页显示的版本号：', shown);
  log('[2] 和最新版一样吗：', shown !== null && shown === newest?.version ? '一样' : '不一样');
  if (!status2.startsWith(UNAUTHORIZED_PREFIX) || !status2.endsWith(UNAUTHORIZED_SUFFIX))
    fail('步骤 2：那句话不是「还没授权」那句');
  if (button2 !== 1) fail('步骤 2：没授权时应当有「授权」按钮');
  if (shown === null || shown !== newest?.version) fail('步骤 2：显示的版本号不是本机最新版');
  await two.app.close();

  // ---- 3. IXAEON_CODEX_EXE=none + 执行器替身：依赖档验证没跑成的原因是那句话 ----
  const data3 = join(work, 'data3');
  mkdirSync(data3, { recursive: true });
  const three = await launchApp(data3, {
    IXAEON_CODEX_EXE: 'none',
    IXAEON_TEST_DIALOG_RESPONSES: `directory|${projDir}`,
  });
  await completeSetup(three.page);
  const page = three.page;
  // 项目页：新建项目 + 绑定合成文件夹（走界面的目录对话框替身，等于发一次读取授权）
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 V4');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(800);
  const row = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await row.getAttribute('data-testid')).replace('project-row-', '');
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(1200);
  // 任务页：新建草案（验证命令是依赖档伪命令）→ 批准 → 派发（执行器是替身）
  await page.getByTestId('nav-tasks').click();
  await page.waitForTimeout(800);
  await page
    .locator('[data-testid="page-tasks"] select')
    .first()
    .selectOption({ label: '合成项目 V4' });
  await page.getByTestId('task-goal').fill('过一个依赖档验证');
  await page.getByLabel('可修改范围（相对工作区，逗号分隔）').fill('note.txt');
  await page.getByTestId('task-verify').fill('ixaeon:vitest run note.test.ts');
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(1000);
  const dispatch = page.getByRole('button', { name: /^派发（/ }).first();
  log('[3] 派发按钮上写的执行器：', (await dispatch.textContent())?.trim() ?? '（没有）');
  await dispatch.click();
  await page.waitForTimeout(3000);
  const db = openDb(data3);
  const taskRow = db
    .prepare(
      'SELECT id, status, verify_status, verify_output FROM coding_tasks ORDER BY rowid DESC LIMIT 1',
    )
    .get();
  const card = page.locator(`[data-testid="task-${taskRow?.id}"]`);
  const cardText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  log('[3] 任务库里那一行：', JSON.stringify(taskRow));
  log('[3] 任务卡片上显示（合成数据）：', cardText);
  // 这条任务不是从对话里派的（没有 origin_run_id），库里不会有回报消息；
  // 回报里那一行由 verify_output 拼出来（taskReport.verifyLine）
  const reportLine = `验证没跑：${String(taskRow?.verify_output ?? '').trim()}`;
  log('[3] 回报里那一行（按 taskReport 的拼法）：', reportLine);
  const reportRows = db
    .prepare(
      "SELECT count(*) AS n FROM messages WHERE json_extract(meta_json,'$.kind')='task_report'",
    )
    .get();
  log('[3] 库里 task_report 消息条数（不是从对话派的任务所以是 0）：', reportRows?.n);
  if (taskRow?.verify_status !== 'not_run') fail('步骤 3：verify_status 不是 not_run');
  if (taskRow?.verify_output !== CODEX_MISSING_VERIFY) fail('步骤 3：验证输出不是那句话');
  if (reportLine !== `验证没跑：${CODEX_MISSING_VERIFY}`) fail('步骤 3：回报那一行不对');
  if (cardText.includes('依赖档沙箱检查未过') || cardText.includes('unauthorized'))
    fail('步骤 3：卡片上还写着英文代码');
  if (!cardText.includes('没找到 Codex 命令行')) fail('步骤 3：卡片上没显示那句话');
  await three.app.close();

  // ---- 4. 换成最新版之后参数还认不认（只跑 --help，不跑任务）----
  const newest4 = newest;
  log('[4] IXAEON 找到的（=本机 bin 下最新版）：', newest4 ? newest4.exe : '（没有）');
  if (!newest4?.exe) {
    fail('步骤 4：本机没找到 codex.exe');
  } else {
    log('[4] 版本：', newest4.version);
    const helpOf = (args) => {
      const r = spawnSync(newest4.exe, args, {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    };
    const execHelp = helpOf(['exec', '--help']);
    // 只问 `codex sandbox --help`：新版把 `sandbox windows` 当成了「要跑的命令」，
    // 跑 `codex sandbox windows --help` 会真的去起沙箱（试过了：报 helper_sandbox_lock_failed、
    // 访问被拒，没执行任何命令）。这一步只核对参数名，绝不让真 Codex 跑东西。
    const sandboxHelp = helpOf(['sandbox', '--help']);
    log('[4] `codex exec --help` 头一行：', execHelp.split('\n')[0] ?? '');
    log('[4] `codex sandbox --help` 头一行：', sandboxHelp.split('\n')[0] ?? '');
    const execArgs = [
      '-c',
      '-C',
      '--sandbox',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--color',
      '--json',
      '-o',
    ];
    const sandboxArgs = ['-c', '-C', '--permissions-profile'];
    const missing = [];
    log('[4] 执行器（CodexCliExecutor）传的参数：');
    for (const a of execArgs) {
      const ok = hasArg(execHelp, a);
      log(`    ${a}：${ok ? '在' : '不在'}`);
      if (!ok) missing.push(`exec ${a}`);
    }
    log('[4] 依赖档派生传给 sandbox 的参数：');
    for (const a of sandboxArgs) {
      const ok = hasArg(sandboxHelp, a);
      log(`    ${a}：${ok ? '在' : '不在'}`);
      if (!ok) missing.push(`sandbox ${a}`);
    }
    const commandsSection = /Commands:\n([\s\S]*?)\n\s*\n/.exec(sandboxHelp)?.[1] ?? '';
    const windowsSub = /^\s*windows\b/m.test(commandsSection);
    log('[4] `windows`（依赖档调用里的子命令）：', windowsSub ? '在' : '不在');
    if (!windowsSub) missing.push('sandbox 子命令 windows');
    log('[4] `codex sandbox` 的帮助里列出的子命令：', commandsSection.replace(/\s+/g, ' ').trim());
    if (missing.length > 0) fail(`步骤 4：帮助里没有这些参数：${missing.join('、')}`);
  }

  if (passed)
    result =
      '通过：没指定 Codex 时是「没找到 Codex 命令行」且无「授权」按钮（未点）；指定时是「还没授权（Codex <最新版>）」且有按钮（未点）；依赖档任务停在「验证没跑：没找到 Codex 命令行…」、卡片无英文代码；最新版 codex 认执行器与依赖档派生的全部参数';
} catch (err) {
  passed = false;
  result = `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`;
  log('脚本出错：', result);
} finally {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
  for (const app of apps) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
log('RESULT', result);
process.exit(passed ? 0 : 1);
