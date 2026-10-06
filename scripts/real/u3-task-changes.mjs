/**
 * U3 真机检查：任务页「看改动」在真应用里走一遍。
 *
 *   node scripts/build.mjs && node scripts/real/u3-task-changes.mjs
 *
 * 真的应用、临时数据目录、替身执行器（IXAEON_CODEX_EXE=none）、合成的 git 项目
 * （note.txt 十来行，替身执行器会把它整份改写）。不联网，不碰用户的数据。
 *
 * 步骤（照规格）：建任务 → 等做完 → 任务页点「看改动」打印清单与 +/- 行数 →
 * 点「接受」（分支建好没合并，差异应当还在）再打印 → 合成项目里把分支合并 →
 * 再打印（应当是「没有变化」）。结果不对以非零码退出。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
const { _electron: electron } = createRequire(join(desktopApp, 'package.json'))('@playwright/test');

const work = mkdtempSync(join(tmpdir(), 'ixa-u3-real-'));
const dataDir = join(work, 'data');
const projectRoot = join(work, 'synth-repo');
for (const d of [dataDir, projectRoot]) mkdirSync(d, { recursive: true });
// 十来行的合成 note.txt
const NOTE_LINES = [
  '合成项目笔记',
  '',
  '一、今天做的事',
  '写了一点界面。',
  '二、明天要做的事',
  '还没想好。',
  '三、备注',
  '这里是一个占位行。',
  '继续占位。',
  '',
  '结尾。',
  '',
];
writeFileSync(join(projectRoot, 'note.txt'), `${NOTE_LINES.join('\n')}\n`);
writeFileSync(join(projectRoot, 'README.md'), '# 合成项目\n');
const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
git('init', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');

writeFileSync(
  join(dataDir, 'config.json'),
  JSON.stringify({
    configVersion: 1,
    setupComplete: true,
    model: {
      provider: 'openai',
      modelName: 'fake-model-v1',
      chatModelName: '',
      apiBaseUrl: '',
      apiKeyEncrypted: null,
      apiKeyPresent: false,
      savedModels: ['fake-model-v1'],
      modelsCheckedAt: null,
    },
    capture: { enabled: false, autoAnalyze: false, pausedConversations: [], pausedSessions: [] },
    extension: { token: null, pairedAt: null },
    localToken: null,
    webSearch: { provider: 'none', apiKeyEncrypted: null, apiKeyPresent: false },
    hermesBridge: { enabled: false, token: null },
    coding: { executor: 'codex', modelName: '' },
  }),
);

let app = null;
let result = '没通过：脚本没跑完';
let passed = true;
const fail = (why) => {
  console.log('不符：', why);
  result = `没通过：${why}`;
  passed = false;
};
try {
  app = await electron.launch({
    args: [join(desktopApp, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      IXAEON_EMBED_MODEL: 'none',
      IXAEON_CODEX_EXE: 'none',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${projectRoot}`,
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('main-nav').waitFor({ timeout: 60_000 });
  const call = (name, ...args) => page.evaluate(([n, a]) => window.ixaeon[n](...a), [name, args]);

  // ---- 1. 建任务，等它做完 ----
  const project = await call('createProject', {
    name: '合成项目',
    rootPath: null,
    description: null,
  });
  const picked = await call('pickFiles', 'directory');
  await call('bindProjectFolder', { ticket: picked.ticket, projectId: project.id });
  const draft = await call('createCodingTask', {
    projectId: project.id,
    goal: '把 note.txt 重写成一句话',
    scope: ['note.txt'],
    allowedCommands: [['node', '-e', "if(!require('fs').existsSync('note.txt'))process.exit(2)"]],
  });
  await call('approveCodingTask', draft.id);
  await page.evaluate((id) => {
    void window.ixaeon.dispatchCodingTask(id);
  }, draft.id);

  await page.getByTestId('nav-tasks').click();
  const card = page.getByTestId(`task-${draft.id}`);
  await card.waitFor({ timeout: 20_000 });
  const statusLine = async () =>
    (await card.innerText()).split('\n').find((l) => l.includes('版本')) ?? '';
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 60_000) {
    await page.waitForTimeout(500);
    last = await statusLine();
    if (last.includes('待用户接受')) break;
  }
  console.log('等任务做完：', last.trim());

  const describe = async (label) => {
    console.log(`--- ${label} ---`);
    const toggle = page.getByTestId(`task-changes-toggle-${draft.id}`);
    // 保证是「收起」之后重新点开（重新读一次）
    if ((await toggle.textContent())?.includes('收起')) await toggle.click();
    await toggle.click();
    const box = page.getByTestId(`task-changes-${draft.id}`);
    await box.waitFor({ timeout: 10_000 });
    await page.waitForFunction(
      ([tid]) => {
        const el = document.querySelector(`[data-testid="${tid}"]`);
        return el !== null && !(el.textContent ?? '').includes('加载中');
      },
      [`task-changes-${draft.id}`],
      { timeout: 10_000 },
    );
    const boxText = await box.innerText();
    console.log('卡片里看到的清单：');
    console.log(
      boxText
        .split('\n')
        .slice(0, 12)
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    const data = await call('getCodingTaskChanges', draft.id);
    console.log(`文件 ${data.files.length} 个 / 总数 ${data.total}：`);
    for (const f of data.files) {
      const plus = f.diff ? f.diff.split('\n').filter((l) => l.startsWith('+')).length : 0;
      const minus = f.diff ? f.diff.split('\n').filter((l) => l.startsWith('-')).length : 0;
      console.log(`  ${f.path} ${f.kind}${f.note ? `（${f.note}）` : ''} +${plus}/-${minus}`);
    }
    return data;
  };

  // ---- 2. 做完后点「看改动」 ----
  if (!last.includes('待用户接受')) fail('任务没做完，看不到结果');
  const first = await describe('做完之后');
  console.log('完整 diff（逐行）：');
  for (const l of (first.files[0]?.diff ?? '').split('\n')) console.log(`  ${JSON.stringify(l)}`);
  const f0 = first.files[0];
  if (first.files.length !== 1 || f0?.path !== 'note.txt' || !f0 || f0.diff === null)
    fail(`清单不对：文件 ${first.files.length} 个（该是 1 个 note.txt 且有差异）`);
  else if (f0.kind !== 'modified') fail(`种类不对：${f0.kind}（该是 modified）`);
  else if (!f0.diff.includes('+') || !f0.diff.includes('-')) fail('差异里该有 + 行也有 - 行');
  else console.log('步骤 2 通过：note.txt 是 modified，+/- 都有');

  // ---- 3. 点「接受」，再点开一次 ----
  if (passed) {
    await card.getByRole('button', { name: '接受结果（不部署）' }).click();
    await page.getByTestId(`task-landing-${draft.id}`).waitFor({ timeout: 20_000 });
    const landingText = await page.getByTestId(`task-landing-${draft.id}`).innerText();
    console.log('接受之后：', landingText.trim());
  }
  let branch = null;
  let second = { files: [] };
  if (passed) {
    const fresh = (await call('listCodingTasks')).tasks.find((t) => t.id === draft.id);
    branch = fresh?.applied_ref ?? null;
    second = await describe('接受之后（分支建好、还没合并）');
    const s0 = second.files[0];
    if (s0?.kind !== 'modified' || s0.diff === null) fail('接受之后差异该还在（仍是 modified）');
    else console.log('步骤 3 通过：分支建好没合并，差异还在');
  }
  // ---- 4. 合并分支，再点开一次 ----
  let third = { files: [] };
  if (passed) {
    if (!branch || !/^ixaeon\//.test(branch)) fail(`没建出分支：applied_ref=${String(branch)}`);
    git('merge', branch);
    console.log('已合并分支：', branch);
    third = await describe('合并之后');
    const t0 = third.files[0];
    // 合并后内容就是同一份：note 是「一样」（工作区换行符也一致）或「只有换行符不同」
    // （Windows autocrlf 让合并进工作区的是 CRLF，副本是 LF——内容行完全一致，也是「没有变化」）。
    if (t0?.kind !== 'same' || t0.diff !== null) fail(`合并之后该是「没有变化」，实际 ${t0?.kind}`);
    else if (!/一样|换行符不同/.test(t0.note ?? '')) fail(`合并之后 note 该写明：${t0.note}`);
    else console.log('步骤 4 通过：合并之后是「没有变化」，note 写明');
  }
  if (!passed) throw new Error(result);
  result = '通过：做完 modified（+/- 都有）→ 接受后差异还在 → 合并后「没有变化」';
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('脚本出错：', msg);
  if (!result.startsWith('没通过')) result = `没通过：脚本出错：${msg}`;
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
  if (existsSync(work)) console.log('临时目录没删干净：', work);
}
console.log('RESULT', result);
process.exit(result.startsWith('通过') ? 0 : 1);
