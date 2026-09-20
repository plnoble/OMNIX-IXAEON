/**
 * N1 真机检查（合成数据）：临时数据目录启动应用，往库里塞合成的方向、要求与发现
 *（判定结果直接写表，不调用户加密存储里的模型 Key）。确认概览页「符合你要求的
 * 新发现」、理由显示、「都看过了」、侧栏角标。模型判定那段待用户在应用里验证。
 *   node_modules/.bin/jiti scripts/real/n1-matched-findings.ts
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
if (!electron) {
  throw new Error('no _electron: ' + Object.keys(pw).slice(0, 30).join(','));
}
const Database = require(require.resolve('better-sqlite3', { paths: [desktopDir, root] }));
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-n1-real-'));
const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');
console.log('dataDir', dataDir);

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};

async function launch() {
  const app = await electron.launch({
    args: [join(desktopDir, 'out', 'main', 'index.js')],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const first = await launch();
await first.page.getByTestId('setup-next-1').click();
await first.page.getByTestId('setup-model-name').fill('fake-model');
await first.page.getByTestId('setup-next-2').click();
await first.page.getByTestId('setup-project-name').fill('N1 合成项目');
await first.page.getByTestId('setup-finish').click();
await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await first.app.close();

const db = new Database(join(dataDir, 'ixaeon.db'));
const now = new Date().toISOString();
const topicId = randomUUID();
const sourceId = randomUUID();
const findingId = randomUUID();
const reqMem = randomUUID();
const reqModel = randomUUID();
db.prepare(
  `INSERT INTO research_topics (
     id, question, public_description, related_goal_id, related_project_id,
     enabled, paused, interval_ms, max_pages_per_run, paid_budget_mode, request_cap,
     generation, last_success_at, last_failure_at, last_failure, consecutive_failures,
     next_check_at, created_at, updated_at
   ) VALUES (?, ?, ?, NULL, NULL, 1, 0, ?, 10, 'none', 0, 1, NULL, NULL, NULL, 0, NULL, ?, ?)`,
).run(topicId, 'N1 真机合成方向', '合成', 86_400_000, now, now);
db.prepare(
  `INSERT INTO research_sources (id, topic_id, url, kind, last_fingerprint, last_checked_at, last_success_at, last_error, created_at)
   VALUES (?, ?, ?, 'page', NULL, NULL, NULL, NULL, ?)`,
).run(sourceId, topicId, 'https://example.com/n1', now);
db.prepare(
  `INSERT INTO research_findings (
     id, topic_id, source_id, title, url, excerpt, content_fingerprint, evidence_class,
     claimed_published_at, fetched_at, related_goal_id, related_project_id, speculation,
     action_worthy, action_reason, limitations, next_experiment, notified, created_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'publisher', NULL, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, ?)`,
).run(
  findingId,
  topicId,
  sourceId,
  'N1 真机合成发现',
  'https://example.com/n1-finding',
  '24GB 内存，能跑本地大模型',
  'n1-real-fp',
  now,
  now,
);
db.prepare(
  `INSERT INTO research_requirements (id, topic_id, text, sort_order, created_at)
   VALUES (?, ?, ?, 1, ?)`,
).run(reqMem, topicId, '内存 24GB 以上', now);
db.prepare(
  `INSERT INTO research_requirements (id, topic_id, text, sort_order, created_at)
   VALUES (?, ?, ?, 2, ?)`,
).run(reqModel, topicId, '能跑本地大模型', now);
db.prepare(
  `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at)
   VALUES (?, ?, 'meets', ?, ?)`,
).run(findingId, reqMem, '写了 24GB 内存', now);
db.prepare(
  `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at)
   VALUES (?, ?, 'meets', ?, ?)`,
).run(findingId, reqModel, '写了能跑本地大模型', now);
db.close();

const second = await launch();
try {
  const badge = await second.page.getByTestId('nav-research-badge').count();
  console.log('BADGE_COUNT', badge);
  if (badge > 0)
    console.log('BADGE_TEXT', await second.page.getByTestId('nav-research-badge').innerText());
  await second.page.getByTestId('nav-overview').click();
  await second.page.getByTestId('overview-matched-findings').waitFor({ timeout: 10_000 });
  const beforeText = await second.page.getByTestId('overview-matched-findings').innerText();
  console.log('MATCHED_BEFORE');
  console.log(beforeText);
  const recentCount = await second.page.getByTestId('overview-recent-findings').count();
  console.log('RECENT_BELOW', recentCount);
  await second.page.screenshot({ path: join(shotDir, 'n1-matched-before.png'), fullPage: true });
  await second.page.getByTestId('matched-findings-seen').click();
  await second.page.waitForTimeout(800);
  const afterNew = await second.page.locator('[data-testid^="matched-finding-new-"]').count();
  const afterText = await second.page.getByTestId('overview-matched-findings').innerText();
  console.log('AFTER_NEW_BADGES', afterNew);
  console.log('MATCHED_AFTER');
  console.log(afterText);
  await second.page.screenshot({ path: join(shotDir, 'n1-matched-after.png'), fullPage: true });
} finally {
  await second.app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(
  'shots',
  existsSync(join(shotDir, 'n1-matched-before.png')),
  existsSync(join(shotDir, 'n1-matched-after.png')),
);
console.log('done');
