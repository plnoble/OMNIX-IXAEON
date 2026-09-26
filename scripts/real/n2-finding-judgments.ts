/**
 * N2 真机检查（合成数据）：临时数据目录启动应用，往库里塞合成的主题、要求、发现和判定
 *（直接写表，不调模型）。确认研究页的摘要行与展开内容。
 *   node_modules/.bin/jiti scripts/real/n2-finding-judgments.ts
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

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-n2-real-'));
writeFileSync(join(dataDir, 'model-script.json'), JSON.stringify({ structured: [] }), 'utf8');
console.log('dataDir', dataDir);

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_HTTP_PORT: '43291',
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

let first: Awaited<ReturnType<typeof launch>> | null = null;
let second: Awaited<ReturnType<typeof launch>> | null = null;
try {
  first = await launch();
  await first.page.getByTestId('setup-next-1').click();
  await first.page.getByTestId('setup-model-name').fill('fake-model');
  await first.page.getByTestId('setup-next-2').click();
  await first.page.getByTestId('setup-project-name').fill('N2 合成项目');
  await first.page.getByTestId('setup-finish').click();
  await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await first.app.close();
  first = null;

  const db = new Database(join(dataDir, 'ixaeon.db'));
  const now = new Date().toISOString();
  const topicId = randomUUID();
  const sourceId = randomUUID();
  const findingId = randomUUID();
  const reqs = [randomUUID(), randomUUID(), randomUUID()];
  db.prepare(
    `INSERT INTO research_topics (
     id, question, public_description, related_goal_id, related_project_id,
     enabled, paused, interval_ms, max_pages_per_run, paid_budget_mode, request_cap,
     generation, last_success_at, last_failure_at, last_failure, consecutive_failures,
     next_check_at, created_at, updated_at
   ) VALUES (?, ?, ?, NULL, NULL, 1, 0, ?, 10, 'none', 0, 1, NULL, NULL, NULL, 0, NULL, ?, ?)`,
  ).run(topicId, 'N2 真机合成方向', '合成', 86_400_000, now, now);
  db.prepare(
    `INSERT INTO research_sources (id, topic_id, url, kind, last_fingerprint, last_checked_at, last_success_at, last_error, created_at)
   VALUES (?, ?, ?, 'page', NULL, NULL, NULL, NULL, ?)`,
  ).run(sourceId, topicId, 'https://example.com/n2', now);
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
    'N2 真机合成发现',
    'https://example.com/n2-finding',
    '合成摘录',
    'n2-real-fp',
    now,
    now,
  );
  ['内存 24GB 以上', '能跑本地大模型', '价格 3000 以内'].forEach((text, i) => {
    db.prepare(
      `INSERT INTO research_requirements (id, topic_id, text, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(reqs[i], topicId, text, i + 1, now);
  });
  db.prepare(
    `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at) VALUES (?, ?, 'meets', ?, ?)`,
  ).run(findingId, reqs[0], '写了 24GB 内存', now);
  db.prepare(
    `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at) VALUES (?, ?, 'unknown', ?, ?)`,
  ).run(findingId, reqs[1], '没提本地模型', now);
  db.close();

  second = await launch();
  await second.page.getByTestId('nav-research').click();
  const line = second.page.getByTestId(`finding-judgments-${findingId}`);
  await line.waitFor({ timeout: 10_000 });
  const summary = await line.innerText();
  console.log('SUMMARY', summary);
  const detail = second.page.getByTestId(`finding-judgments-detail-${findingId}`);
  await detail.locator('summary').click();
  await second.page.waitForTimeout(300);
  const expanded = await detail.innerText();
  console.log('DETAIL', expanded.replace(/\n/g, ' | '));
  await second.page.screenshot({ path: join(shotDir, 'n2-judgments.png'), fullPage: true });
  console.log('SHOT', existsSync(join(shotDir, 'n2-judgments.png')));
} finally {
  await first?.app.close();
  await second?.app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
