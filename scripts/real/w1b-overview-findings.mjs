/**
 * W1b 真机：临时数据目录启动应用，写入合成研究主题/发现，看概览「最近的新发现」。
 * 只写合成数据。截图落到 apps/desktop/release/screenshots/。
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-w1b-real-'));
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
await first.page.getByTestId('setup-project-name').fill('W1b 合成项目');
await first.page.getByTestId('setup-finish').click();
await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
await first.app.close();

const db = new Database(join(dataDir, 'ixaeon.db'));
const now = new Date().toISOString();
const topicId = randomUUID();
const sourceId = randomUUID();
const findingId = randomUUID();
db.prepare(
  `INSERT INTO research_topics (
     id, question, public_description, related_goal_id, related_project_id,
     enabled, paused, interval_ms, max_pages_per_run, paid_budget_mode, request_cap,
     generation, last_success_at, last_failure_at, last_failure, consecutive_failures,
     next_check_at, created_at, updated_at
   ) VALUES (?, ?, ?, NULL, NULL, 1, 0, ?, 10, 'none', 0, 1, NULL, NULL, NULL, 0, NULL, ?, ?)`,
).run(topicId, 'W1b 真机合成方向', '合成', 86_400_000, now, now);
db.prepare(
  `INSERT INTO research_sources (id, topic_id, url, kind, last_fingerprint, last_checked_at, last_success_at, last_error, created_at)
   VALUES (?, ?, ?, 'page', NULL, NULL, NULL, NULL, ?)`,
).run(sourceId, topicId, 'https://example.com/w1b', now);
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
  'W1b 真机合成发现',
  'https://example.com/w1b-finding',
  '合成摘录',
  'w1b-real-fp',
  now,
  now,
);
db.close();

const second = await launch();
await second.page.getByTestId('nav-overview').click();
await second.page.getByTestId('overview-recent-findings').waitFor({ timeout: 10_000 });
const beforeText = await second.page.getByTestId('overview-recent-findings').innerText();
await second.page.screenshot({ path: join(shotDir, 'w1b-findings-before.png'), fullPage: true });
console.log('BEFORE_BLOCK');
console.log(beforeText);
await second.page.getByTestId('recent-findings-seen').click();
await second.page.waitForTimeout(800);
const afterNew = await second.page.locator('[data-testid^="recent-finding-new-"]').count();
const afterText = await second.page.getByTestId('overview-recent-findings').innerText();
await second.page.screenshot({ path: join(shotDir, 'w1b-findings-after.png'), fullPage: true });
console.log('AFTER_NEW_BADGES', afterNew);
console.log('AFTER_BLOCK');
console.log(afterText);
await second.app.close();
console.log(
  'shots',
  existsSync(join(shotDir, 'w1b-findings-before.png')),
  existsSync(join(shotDir, 'w1b-findings-after.png')),
);
