/**
 * G1e 真机检查（列表段）：真起 Electron、临时数据目录、合成数据，点开 Goals 列表看。
 *
 *   node scripts/build.mjs
 *   node scripts/real/run-batch.mjs scripts/real/g1e-goals-page.ts
 *
 * 只读边界（用户 2026-10-30 定）：界面上没有任何写控件；打开前后 goals 六张表逐行不变。
 * 详情段在 G1e-b 的脚本里补。
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { migrate, openDatabase, type CoreDatabase } from '../../packages/core/src/index.js';
import { GoalStore, PlanStore } from '../../packages/core/src/goals/index.js';

const { _electron: electron } = createRequire(
  join(process.cwd(), 'apps', 'desktop', 'package.json'),
)('@playwright/test');

const work = mkdtempSync(join(process.cwd(), '.logs', 'g1e-real-'));
const dataDir = join(work, 'data');
mkdirSync(dataDir, { recursive: true });
const log = (...args: unknown[]) =>
  console.log(...args.map((v) => (typeof v === 'string' ? v.replaceAll(work, '<临时目录>') : String(v))));

type ElectronApp = {
  firstWindow(): Promise<Page>;
  close(): Promise<void>;
};

const append = (line: string): void => {
  writeFileSync(join(work, 'notes.log'), `${line}\n`, { flag: 'a' });
};

const main = async (): Promise<void> => {
  const dbPath = join(dataDir, 'ixaeon.db');
  const db = openDatabase(dbPath);
  migrate(db);
  const goals = new GoalStore(db);
  const plans = new PlanStore(db);

  const parent = goals.create({
    title: '合成目标：把周报自动化',
    description: '每周五自动生成周报，先收集资料再写初稿',
    via: 'ui',
  });
  goals.setProgress(parent.id, 42);
  const child = goals.create({ title: '合成子目标：找模板', via: 'ui', parentGoalId: parent.id });
  goals.transition(child.id, 'completed', { decidedBy: 'user' });
  const blocked = goals.create({ title: '合成目标：换服务器', via: 'ui' });
  goals.transition(blocked.id, 'blocked', { decidedBy: 'user', reason: '预算还没批' });
  const proposed = goals.create({
    title: '合成候选目标：每天读论文',
    origin: 'agent',
    via: 'pending',
  });

  const plans1 = plans.addVersion(parent.id, {
    reason: '第一版太粗',
    steps: [{ title: '旧步骤' }],
  });
  void plans1;
  plans.addVersion(parent.id, {
    reason: '拆细一点',
    steps: [{ title: '收集资料' }, { title: '写初稿' }, { title: '收尾' }],
  });
  const steps = plans.stepsOf(parent.id, 2);
  plans.setStepStatus(steps[0]!.id, 'done');
  plans.setDeps(parent.id, 2, steps[1]!.id, [steps[0]!.id]);
  plans.setDeps(parent.id, 2, steps[2]!.id, [steps[1]!.id]);
  db.prepare('UPDATE goals SET watch = 1, watch_reason = ?, next_review_at = ? WHERE id = ?').run(
    '编码任务失败：生成脚本没跑通',
    '2026-09-01T00:00:00.000Z',
    parent.id,
  );
  db.prepare('UPDATE goals SET watch = 1, watch_reason = ? WHERE id = ?').run(
    '同一个目标提了两次',
    proposed.id,
  );

  const tables = ['goals', 'goal_events', 'goal_plans', 'goal_steps', 'goal_step_deps', 'goal_links'];
  const snap = (database: CoreDatabase): string =>
    JSON.stringify(tables.map((t) => database.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const before = snap(db);
  db.close();

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

  const env = {
    ...process.env,
    IXAEON_DATA_DIR: dataDir,
    IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
    IXAEON_EMBED_MODEL: 'none',
    IXAEON_CODEX_EXE: 'none',
    IXAEON_HERMES_EXE: '',
    IXAEON_HERMES_HOME: '',
    HERMES_HOME: '',
  };
  delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE;

  const launch = async (): Promise<ElectronApp> =>
    (await electron.launch({
      executablePath: join(
        process.cwd(),
        'apps',
        'desktop',
        'node_modules',
        'electron',
        'dist',
        'electron.exe',
      ),
      args: [
        '--no-sandbox',
        join(process.cwd(), 'apps', 'desktop', 'out', 'main', 'index.js'),
        `--user-data-dir=${join(work, 'profile')}`,
      ],
      artifactsDir: join(work, 'playwright'),
      env,
    })) as unknown as ElectronApp;

  let app: ElectronApp | null = null;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.getByTestId('main-nav').waitFor({ timeout: 60_000 });
    await page.getByTestId('nav-goals').click();
    await page.getByTestId(`goal-${parent.id}`).waitFor({ timeout: 20_000 });

    const activeText = (await page.getByTestId(`goal-${parent.id}`).innerText()).replaceAll(work, '<临时目录>');
    const reviewClass = await page.getByTestId(`goal-review-${parent.id}`).getAttribute('class');
    const blockedText = (await page.getByTestId(`goal-blocked-${blocked.id}`).innerText()).replaceAll(work, '<临时目录>');
    const watchText = (await page.getByTestId(`goal-watch-${parent.id}`).innerText()).replaceAll(work, '<临时目录>');
    const proposedText = (await page.getByTestId('goals-proposed').innerText()).replaceAll(work, '<临时目录>');
    const writeButtons = await page.locator('main button').count();

    log('== G1e 真机检查（列表段）==');
    log('列表：active 卡片');
    log(activeText);
    log(`过期复核的 class：${reviewClass ?? ''}`);
    log('列表：blocked 卡片');
    log(blockedText);
    log('列表：watch');
    log(watchText);
    log('顶部 proposed 块');
    log(proposedText);
    log(`界面上的按钮数（导航外）：${writeButtons}`);

    const pass =
      activeText.includes('合成目标：把周报自动化') &&
      activeText.includes('进行中') &&
      activeText.includes('42%') &&
      activeText.includes('2026-09-01') &&
      activeText.includes('已过期') &&
      (reviewClass ?? '').includes('warn') &&
      activeText.includes('有疑点') &&
      activeText.includes('编码任务失败：生成脚本没跑通') &&
      activeText.includes('下一步：2. 写初稿') &&
      blockedText.includes('预算还没批') &&
      proposedText.includes('合成候选目标：每天读论文') &&
      proposedText.includes('待你确认') &&
      proposedText.includes('同一个目标提了两次') &&
      writeButtons === 0;

    await app.close();
    app = null;

    const db2 = openDatabase(dbPath);
    const afterRows = snap(db2);
    db2.close();
    log(before === afterRows ? '只读：打开列表前后 goals 六张表逐行不变' : '只读：六张表变了（失败）');

    app = await launch();
    page = await app.firstWindow();
    await page.getByTestId('main-nav').waitFor({ timeout: 60_000 });
    await page.getByTestId('nav-goals').click();
    await page.getByTestId(`goal-${parent.id}`).waitFor({ timeout: 20_000 });
    const reopened = await page.getByTestId(`goal-${parent.id}`).isVisible();
    log(`重开应用后列表还在：${reopened ? '是' : '否'}`);

    if (!pass || !reopened || before !== afterRows) {
      append('FAIL');
      console.log('RESULT 没通过');
      process.exitCode = 1;
      return;
    }
    append('PASS');
    console.log('== G1e 列表段真机检查通过 ==');
    console.log('RESULT 通过');
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
  }
};

await main();