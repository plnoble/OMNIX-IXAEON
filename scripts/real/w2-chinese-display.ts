/**
 * W2 真机检查（合成数据）：临时数据目录启动应用，往库里塞合成的英文发现，
 * 翻译结果直接写 title_zh / summary_zh（不调用户加密存储里的模型 Key）。
 * 确认研究页和总览显示中文、「原文」展开能看到原标题和原摘录。
 * 模型翻译那段待用户在应用里验证。
 *   node_modules/.bin/jiti scripts/real/w2-chinese-display.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) throw new Error('no _electron');
const Database = require(require.resolve('better-sqlite3', { paths: [desktopDir, root] }));
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-w2-real-'));
writeFileSync(join(dataDir, 'model-script.json'), JSON.stringify({ structured: [] }), 'utf8');
console.log('dataDir', dataDir);

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: join(dataDir, 'model-script.json'),
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};

async function launch() {
  const app = await electron.launch({ args: [join(desktopDir, 'out', 'main', 'index.js')], env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const first = await launch();
await first.page.getByTestId('setup-next-1').click();
await first.page.getByTestId('setup-model-name').fill('fake-model');
await first.page.getByTestId('setup-next-2').click();
await first.page.getByTestId('setup-project-name').fill('W2 合成项目');
await first.page.getByTestId('setup-finish').click();
await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await first.app.close();

const db = new Database(join(dataDir, 'ixaeon.db'));
const now = new Date().toISOString();
const topicId = randomUUID();
const sourceId = randomUUID();
const translatedId = randomUUID();
const originalId = randomUUID();
db.prepare(
  `INSERT INTO research_topics (
     id, question, public_description, related_goal_id, related_project_id,
     enabled, paused, interval_ms, max_pages_per_run, paid_budget_mode, request_cap,
     generation, last_success_at, last_failure_at, last_failure, consecutive_failures,
     next_check_at, created_at, updated_at
   ) VALUES (?, ?, ?, NULL, NULL, 1, 0, ?, 10, 'none', 0, 1, NULL, NULL, NULL, 0, NULL, ?, ?)`,
).run(topicId, 'W2 真机合成方向', '合成', 86_400_000, now, now);
db.prepare(
  `INSERT INTO research_sources (id, topic_id, url, kind, last_fingerprint, last_checked_at, last_success_at, last_error, created_at)
   VALUES (?, ?, ?, 'page', NULL, NULL, NULL, NULL, ?)`,
).run(sourceId, topicId, 'https://example.com/w2', now);
const insertFinding = db.prepare(
  `INSERT INTO research_findings (
     id, topic_id, source_id, title, url, excerpt, content_fingerprint, evidence_class,
     claimed_published_at, fetched_at, related_goal_id, related_project_id, speculation,
     action_worthy, action_reason, limitations, next_experiment, notified, created_at,
     title_zh, summary_zh
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'publisher', NULL, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
);
insertFinding.run(
  translatedId,
  topicId,
  sourceId,
  'Local model runtime reaches new speed',
  'https://example.com/w2-translated',
  'A runtime for local models with a long enough excerpt.',
  'w2-real-translated',
  now,
  1,
  '值得试试',
  now,
  '本地模型运行时再提速',
  '一篇讲本地模型运行时的文章，摘录足够长。',
);
insertFinding.run(
  originalId,
  topicId,
  sourceId,
  '本地模型的新进展',
  'https://example.com/w2-original',
  '这篇讲的是本地模型怎么跑起来。',
  'w2-real-original',
  now,
  0,
  null,
  now,
  null,
  null,
);
db.prepare(
  `INSERT INTO research_requirements (id, topic_id, text, sort_order, created_at) VALUES (?, ?, ?, 1, ?)`,
).run(randomUUID(), topicId, '能跑本地模型', now);
db.prepare(
  `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at)
   VALUES (?, (SELECT id FROM research_requirements WHERE topic_id = ?), 'meets', ?, ?)`,
).run(translatedId, topicId, '写了能跑本地模型', now);
db.close();

const second = await launch();
try {
  await second.page.getByTestId('nav-research').click();
  await second.page.getByText('本地模型运行时再提速').waitFor({ timeout: 10_000 });
  const researchText = await second.page.locator('main').innerText();
  console.log('RESEARCH_SHOWS_ZH', researchText.includes('本地模型运行时再提速'));
  console.log('RESEARCH_HIDES_EN', !researchText.includes('Local model runtime'));
  console.log('RESEARCH_SHOWS_ORIGINAL_TITLE', researchText.includes('本地模型的新进展'));
  await second.page.getByText('原文').first().click();
  await second.page.waitForTimeout(300);
  const expanded = await second.page.locator('main').innerText();
  console.log('ORIGINAL_EXPANDED', expanded.includes('Local model runtime reaches new speed'));
  await second.page.screenshot({ path: join(shotDir, 'w2-research.png'), fullPage: true });

  await second.page.getByTestId('nav-overview').click();
  await second.page.getByTestId('overview-matched-findings').waitFor({ timeout: 10_000 });
  const overviewText = await second.page.locator('main').innerText();
  const blocks = ['overview-matched-findings', 'overview-recent-findings'].filter(
    (id) => overviewText.length >= 0 && id,
  );
  console.log('OVERVIEW_BLOCKS', blocks.join(','));
  console.log('OVERVIEW_SHOWS_ZH', overviewText.includes('本地模型运行时再提速'));
  await second.page.screenshot({ path: join(shotDir, 'w2-overview.png'), fullPage: true });
} finally {
  await second.app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(
  'shots',
  existsSync(join(shotDir, 'w2-research.png')),
  existsSync(join(shotDir, 'w2-overview.png')),
);
