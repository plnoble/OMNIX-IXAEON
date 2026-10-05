/**
 * U2 真机检查：任务在后台跑的时候开着任务页，做完后页面自己变，不用点任何东西。
 *
 *   node scripts/build.mjs && node scripts/real/u2-tasks-page-live.mjs
 *
 * 真的应用、临时数据目录、假模型（回答前故意等几秒，好看到「执行中」）、合成的小 git 项目。
 * 不联网，不碰用户的数据。用户的应用开着也能跑。
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

const MODEL = 'fake-model-v1';
const DELAY_MS = 6000;
const work = mkdtempSync(join(tmpdir(), 'ixa-u2-real-'));
const dataDir = join(work, 'data');
const projectRoot = join(work, 'synth-repo');
for (const d of [dataDir, projectRoot]) mkdirSync(d, { recursive: true });
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
      modelName: MODEL,
      chatModelName: '',
      apiBaseUrl: '',
      apiKeyEncrypted: null,
      apiKeyPresent: false,
      savedModels: [MODEL],
      modelsCheckedAt: null,
    },
    capture: { enabled: false, autoAnalyze: false, pausedConversations: [], pausedSessions: [] },
    extension: { token: null, pairedAt: null },
    localToken: null,
    webSearch: { provider: 'none', apiKeyEncrypted: null, apiKeyPresent: false },
    hermesBridge: { enabled: false, token: null },
    coding: { executor: 'model', modelName: MODEL },
  }),
);
const scriptPath = join(work, 'model-script.json');
writeFileSync(
  scriptPath,
  JSON.stringify({
    structured: [
      {
        changes: [{ path: 'README.md', action: 'write', content: '# 合成项目\n加了一行\n' }],
        summary: 'README 加了一行',
        claimedSuccess: true,
      },
    ],
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
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
      IXAEON_TEST_MODEL_DELAY_MS: String(DELAY_MS),
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
    goal: '在 README.md 末尾加一行',
    scope: ['README.md'],
    allowedCommands: [['node', '-e', "if(!require('fs').existsSync('README.md'))process.exit(2)"]],
  });
  await call('approveCodingTask', draft.id);

  // 像聊天里点「要做」那样：任务在后台开工，这里不等它
  await page.evaluate((id) => {
    void window.ixaeon.dispatchCodingTask(id);
  }, draft.id);
  const started = Date.now();
  await page.getByTestId('nav-tasks').click();
  const card = page.getByTestId(`task-${draft.id}`);
  await card.waitFor({ timeout: 20_000 });
  const statusLine = async () =>
    (await card.innerText()).split('\n').find((l) => l.includes('版本')) ?? '';
  const first = await statusLine();
  console.log('刚打开任务页时：', first.trim());

  // 之后什么都不点，只看这张卡片
  let last = first;
  let changedAt = null;
  while (Date.now() - started < 40_000) {
    await page.waitForTimeout(500);
    last = await statusLine();
    if (last.includes('待用户接受')) {
      changedAt = Date.now() - started;
      break;
    }
  }
  console.log('没点任何东西，之后变成：', last.trim());
  const final = (await call('listCodingTasks')).tasks.find((t) => t.id === draft.id);
  console.log('任务实际状态：', final?.status);
  if (!first.includes('执行中'))
    result = '没通过：打开任务页时任务已经不在执行中，没照到要查的情形';
  else if (changedAt === null) result = '没通过：任务做完了，页面还停在原来的状态';
  else result = `通过：${(changedAt / 1000).toFixed(1)} 秒时页面自己变成了「待用户接受」`;
} catch (err) {
  result = `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`;
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
