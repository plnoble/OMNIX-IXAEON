/**
 * U5 真机检查：做完一个任务，打开任务页，打印卡片状态那一行，
 * 核对里面没有英文状态词（not_run / passed / failed）。
 * 再做一个带验收条件的任务，打印它的状态行、验收条件那一块、验收测试那一行。
 *
 *   node scripts/real/u5-card-words.mjs
 * （先构建桌面端）
 *
 * 照 scripts/real/u2-tasks-page-live.mjs：临时数据目录、替身执行器、合成项目。
 * 不联网，不碰用户的数据。不对就以非零码退出。
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

const work = mkdtempSync(join(tmpdir(), 'ixa-u5-real-'));
const dataDir = join(work, 'data');
const projectRoot = join(work, 'synth-repo');
for (const d of [dataDir, projectRoot]) mkdirSync(d, { recursive: true });
writeFileSync(join(projectRoot, 'note.txt'), '合成文件\n');
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
  const project = await call('createProject', {
    name: '合成项目',
    rootPath: null,
    description: null,
  });
  const picked = await call('pickFiles', 'directory');
  await call('bindProjectFolder', { ticket: picked.ticket, projectId: project.id });
  const draft = await call('createCodingTask', {
    projectId: project.id,
    goal: '把 note.txt 改成一句话',
    scope: ['note.txt'],
    allowedCommands: [['node', '-e', "if(!require('fs').existsSync('note.txt'))process.exit(2)"]],
  });
  await call('approveCodingTask', draft.id);
  // 第二个任务（整合方复审时加的）：带验收条件、没有验证命令。替身执行器不写验收测试，
  // 所以卡片上应当是：验证没跑、验收条件列出来、验收测试没锁定和原因。
  // 先建好、批准好再打开任务页（打开之后才建的任务，页面上不会自己多出一张卡片）；等第一个做完再派发它。
  const second = await call('createCodingTask', {
    projectId: project.id,
    goal: '在 note.txt 里写一句话',
    scope: ['note.txt'],
    allowedCommands: [],
    acceptance: ['note.txt 里有一句话'],
  });
  await call('approveCodingTask', second.id);
  await page.evaluate((id) => {
    void window.ixaeon.dispatchCodingTask(id);
  }, draft.id);
  await page.getByTestId('nav-tasks').click();
  const card = page.getByTestId(`task-${draft.id}`);
  await card.waitFor({ timeout: 20_000 });
  const statusLine = async () =>
    (await card.innerText()).split('\n').find((l) => l.includes('版本')) ?? '';
  const started = Date.now();
  let line = '';
  while (Date.now() - started < 60_000) {
    await page.waitForTimeout(500);
    line = await statusLine();
    if (line.includes('待用户接受')) break;
  }
  console.log('卡片状态那一行：', line.trim());
  if (!line.includes('待用户接受')) throw new Error('任务没做完');
  if (!line.includes('验证通过')) throw new Error('状态行没有「验证通过」');
  for (const word of ['not_run', 'passed', 'failed']) {
    if (line.includes(word)) throw new Error(`状态行里还有英文状态词 ${word}`);
  }

  await page.evaluate((id) => {
    void window.ixaeon.dispatchCodingTask(id);
  }, second.id);
  const card2 = page.getByTestId(`task-${second.id}`);
  await card2.waitFor({ timeout: 20_000 });
  const started2 = Date.now();
  let line2 = '';
  while (Date.now() - started2 < 60_000) {
    await page.waitForTimeout(500);
    line2 = (await card2.innerText()).split('\n').find((l) => l.includes('版本')) ?? '';
    if (line2.includes('待用户接受')) break;
  }
  console.log('第二张卡片状态那一行：', line2.trim());
  if (!line2.includes('待用户接受')) throw new Error('第二个任务没做完');
  if (!line2.includes('验证没跑')) throw new Error('第二张卡片的状态行没有「验证没跑」');
  for (const word of ['not_run', 'passed', 'failed']) {
    if (line2.includes(word)) throw new Error(`第二张卡片的状态行里还有英文状态词 ${word}`);
  }
  const conditions = (
    await page.getByTestId(`task-acceptance-${second.id}`).innerText({ timeout: 10_000 })
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  console.log('验收条件那一块：', conditions.join(' / '));
  if (conditions[0] !== '验收条件：' || conditions[1] !== 'note.txt 里有一句话') {
    throw new Error('验收条件那一块不对');
  }
  const testsLine = (
    await page.getByTestId(`task-acceptance-tests-${second.id}`).innerText({ timeout: 10_000 })
  ).trim();
  console.log('验收测试那一行：', testsLine);
  if (!testsLine.startsWith('验收测试没锁定：')) throw new Error('验收测试那一行不对');
  result = '通过：状态行是人话，没有 not_run / passed / failed；验收条件和验收测试的情况都在卡片上';
} catch (err) {
  result = `没通过：${err instanceof Error ? err.message : String(err)}`;
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
