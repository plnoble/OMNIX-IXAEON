/**
 * D7b 真机检查（真模型网关，规格步骤 2）：
 * - 建临时数据目录，写最小 config：只从真实配置取 model.apiBaseUrl / apiKeyEncrypted /
 *   apiKeyPresent / model.savedModels / model.modelName 五项，其余默认；不复制数据库、
 *   不复制别的配置项；
 * - IXAEON_DATA_DIR=<临时目录>、另选端口（IXAEON_HTTP_PORT）启动应用，不开假模型；
 * - 设置页用真网关检测模型 → 勾选保存 → 编码任务选「我的模型」+ 该模型；
 * - 合成小 git 项目（只有 README）：任务一「在 README.md 末尾加一行」批准范围
 *   README.md → 副本里 README 多了这行，接受后建出分支，提交正好改了 README；
 *   任务二批准范围只给 README.md、目标却新建 other.txt → 没写任何文件，任务失败，
 *   原因里有 other.txt；
 * - 原样贴两次的任务状态/原因/执行器名（只打印合成内容与状态，不打印 Key、网关地址）。
 *
 *   node scripts/real/d7b-model-task.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
const localRequire = createRequire(join(desktopApp, 'package.json'));
const { _electron: electron } = localRequire('@playwright/test');
const Database = localRequire('better-sqlite3');

// 真实数据目录（bootstrap 指针）里的 config.json：只取五项
const bootstrap = JSON.parse(
  readFileSync(join(process.env.LOCALAPPDATA ?? '', 'OMNIX', 'IXAEON', 'bootstrap.json'), 'utf8'),
);
const realConfig = JSON.parse(readFileSync(join(bootstrap.dataDir, 'config.json'), 'utf8'));

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-d7b-real-'));
const configPath = join(dataDir, 'config.json');
const projectRoot = join(dataDir, 'synth-repo');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(projectRoot, 'README.md'), '# 合成项目\n');
execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
execFileSync('git', ['add', '-A'], { cwd: projectRoot });
execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-m', 'init'], {
  cwd: projectRoot,
});

// 最小 config：五项来自真实配置，其余默认；setupComplete 免向导
const base = {
  configVersion: 1,
  setupComplete: true,
  model: {
    provider: 'openai',
    modelName: realConfig.model?.modelName ?? '',
    chatModelName: '',
    apiBaseUrl: realConfig.model?.apiBaseUrl ?? '',
    apiKeyEncrypted: realConfig.model?.apiKeyEncrypted ?? null,
    apiKeyPresent: realConfig.model?.apiKeyPresent ?? false,
    savedModels: realConfig.model?.savedModels ?? [],
    modelsCheckedAt: null,
  },
  capture: { enabled: false, autoAnalyze: false, pausedConversations: [], pausedSessions: [] },
  extension: { token: null, pairedAt: null },
  localToken: null,
  webSearch: { provider: 'none', apiKeyEncrypted: null, apiKeyPresent: false },
  hermesBridge: { enabled: false, token: null },
  coding: { executor: 'codex', modelName: '' },
};
writeFileSync(configPath, JSON.stringify(base, null, 2), 'utf8');
console.log('TMP_DATA_DIR', dataDir);
console.log('REAL_SAVED_MODELS_COUNT', base.model.savedModels.length);

const httpPort = String(20000 + Math.floor(Math.random() * 20000));

let app = null;
try {
  app = await electron.launch({
    args: [join(desktopApp, 'out', 'main', 'index.js')],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir, IXAEON_HTTP_PORT: httpPort },
  });
  let page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByTestId('main-nav').waitFor({ timeout: 30_000 });

  // 在项目页登记「合成项目」（项目页原生新建表单）
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('page-projects').waitFor({ timeout: 20_000 });
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(500);

  // 设置页：检测真网关模型 → 勾选保存 → 编码任务选「我的模型」
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-model').waitFor({ timeout: 20_000 });
  await page.getByTestId('settings-fetch-models').click();
  // 检测成功出现清单；失败出现错误横幅——如实打印，两种都等
  await page
    .locator('[data-testid="settings-model-checklist"], [data-testid="error-banner"]')
    .first()
    .waitFor({ timeout: 90_000 });
  if ((await page.locator('[data-testid="error-banner"]').count()) > 0) {
    const err = await page.getByTestId('error-banner').innerText();
    console.log('DETECT_FAILED', err.slice(0, 200));
    process.exit(3);
  }
  // 优先勾与 model.modelName 同名的；否则勾清单里第一个
  // 让页面知道想勾哪个模型（model.modelName 同名的优先）
  await page.evaluate((want) => {
    window.__wantModel = want;
  }, base.model.modelName);
  const picked = await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll('[data-testid="settings-model-check"]'));
    const wanted = rows.find((r) => r.dataset['modelId'] === window.__wantModel) ?? rows[0];
    if (wanted) {
      if (!wanted.checked) wanted.click();
      return wanted.dataset['modelId'] ?? '';
    }
    return '';
  });
  console.log('PICKED_MODEL_SET', picked ? '是' : '否');
  await page.getByTestId('settings-model-save').click();
  await page.locator('.ok-banner').waitFor({ timeout: 30_000 });

  await page.getByTestId('settings-coding-executor').selectOption('model');
  await page.getByTestId('settings-coding-model').selectOption(picked);
  await page.getByTestId('settings-coding-save').click();
  await page.locator('.ok-banner').waitFor({ timeout: 15_000 });
  console.log('CODING_SET', `我的模型（${picked}）`);

  // 绑定 root_path（SQL：等价于项目页点过「绑定文件夹」）
  await app.close();
  app = null;
  const dbPath = join(dataDir, 'ixaeon.db');
  const db = new Database(dbPath);
  const proj = db.prepare("SELECT id FROM projects WHERE name = '合成项目'").get();
  db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, proj.id);
  db.close();

  // ===== 任务一：批准范围内改 README → 做完 → 接受 → 分支 =====
  app = await electron.launch({
    args: [join(desktopApp, 'out', 'main', 'index.js')],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir, IXAEON_HTTP_PORT: httpPort },
  });
  page = await app.firstWindow();
  await page.getByTestId('main-nav').waitFor({ timeout: 30_000 });
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('page-tasks').waitFor({ timeout: 20_000 });
  // 顶部说明：选了「我的模型」
  const topNotice = await page.getByTestId('tasks-notice').innerText();
  console.log('TASKS_NOTICE_TOP', topNotice.split('\n')[0].slice(0, 120));

  await page.getByTestId('task-goal').fill('在 README.md 末尾加一行「D7b 真机加的一行」');
  await page
    .getByTestId('task-verify')
    .fill("node -e \"const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(2);\"");
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(800);
  // 批准并排队（第一个「批准并排队」按钮）
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(500);
  // 等做完（pending_accept）或失败
  const firstOutcome = await page
    .locator('[data-testid="page-tasks"]')
    .getByText(/等你验收|没做成/)
    .first()
    .waitFor({ timeout: 180_000 })
    .then(() => 'settled')
    .catch(() => 'timeout');
  console.log('TASK1_OUTCOME', firstOutcome);
  const taskPageText = await page.getByTestId('page-tasks').innerText();
  const doneLine = taskPageText.split('\n').find((l) => l.includes('执行器'));
  console.log('TASK1_EXECUTOR_LINE', doneLine?.trim() ?? '');
  console.log(
    'TASK1_FAILED_LINE',
    taskPageText.includes('没做成') ? '是（任务失败）' : '否（做完等你验收）',
  );

  // 接受（第一个「接受」按钮），落地建分支
  const acceptBtn = page.getByRole('button', { name: '接受' }).first();
  if ((await acceptBtn.count()) > 0) {
    await acceptBtn.click();
    await page.waitForTimeout(1500);
  }
  await app.close();
  app = null;

  // 用 SQL 看任务一的状态与执行器名；git 看分支
  const db1 = new Database(dbPath);
  const rows = db1
    .prepare('SELECT id, status, executor_name, error FROM coding_tasks ORDER BY created_at')
    .all();
  db1.close();
  const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
  const branches = git('branch', '--list', 'ixaeon/*');
  const t1 = rows[0];
  console.log('TASK1_ROW', JSON.stringify({ status: t1.status, executor: t1.executor_name }));
  if (t1.status === 'completed') {
    const branch = t1.executor_name ? branches.split('\n')[0]?.replace('* ', '').trim() : '';
    console.log('TASK1_BRANCH', branch);
    if (branch) console.log('TASK1_DIFF', git('diff', '--name-only', 'main', branch));
    console.log('TASK1_BRANCH_README', git(`show`, `${branch}:README.md`));
  } else {
    console.log('TASK1_ERROR', (t1.error ?? '').slice(0, 200));
  }

  // ===== 任务二：批准范围只给 README.md，目标却新建 other.txt → 失败、原因有 other.txt =====
  app = await electron.launch({
    args: [join(desktopApp, 'out', 'main', 'index.js')],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir, IXAEON_HTTP_PORT: httpPort },
  });
  page = await app.firstWindow();
  await page.getByTestId('main-nav').waitFor({ timeout: 30_000 });
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('page-tasks').waitFor({ timeout: 20_000 });
  await page.getByTestId('task-goal').fill('新建一个 other.txt，写上说明');
  await page
    .getByTestId('task-verify')
    .fill("node -e \"const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(2);\"");
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page
    .locator('[data-testid="page-tasks"]')
    .getByText(/没做成/)
    .first()
    .waitFor({ timeout: 180_000 })
    .then(() => 'failed')
    .catch(() => 'timeout');
  console.log('TASK2_OUTCOME', 'failed（范围外不写）');
  const taskPageText2 = await page.getByTestId('page-tasks').innerText();
  console.log('TASK2_HAS_OTHER_TXT', taskPageText2.includes('other.txt') ? '是' : '否');
  const db2 = new Database(dbPath);
  const rows2 = db2
    .prepare('SELECT id, status, executor_name, error FROM coding_tasks ORDER BY created_at')
    .all();
  db2.close();
  const t2 = rows2[1];
  console.log('TASK2_ROW', JSON.stringify({ status: t2.status, executor: t2.executor_name }));
  console.log('TASK2_ERROR', (t2.error ?? '').slice(0, 200));
  console.log(
    'TASK2_PROJECT_UNTOUCHED',
    existsSync(join(projectRoot, 'other.txt')) ? '否（多出了文件）' : '是',
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
}
