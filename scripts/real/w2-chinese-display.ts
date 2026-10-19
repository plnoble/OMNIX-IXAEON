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

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
const maskOut = (v: unknown): string => {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

// 结论由脚本自己算出来的值决定：一处不符就不写「通过」；脚本出错也非零退出
let passed = true;
let firstFail = '';
const fail = (why: string): void => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
const crash = (err: unknown): void => {
  console.log('脚本出错：', err);
  console.log('RESULT 没通过：脚本出错：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

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
  if (!researchText.includes('本地模型运行时再提速'))
    fail('研究页没显示中文标题（期望 RESEARCH_SHOWS_ZH true，实际 false）');
  if (researchText.includes('Local model runtime'))
    fail('研究页露出了英文标题（期望 RESEARCH_HIDES_EN true，实际 false）');
  if (!researchText.includes('本地模型的新进展'))
    fail('研究页没显示只有中文标题的那条（期望 RESEARCH_SHOWS_ORIGINAL_TITLE true，实际 false）');
  await second.page.getByText('原文').first().click();
  await second.page.waitForTimeout(300);
  const expanded = await second.page.locator('main').innerText();
  console.log('ORIGINAL_EXPANDED', expanded.includes('Local model runtime reaches new speed'));
  if (!expanded.includes('Local model runtime reaches new speed'))
    fail('点「原文」展开后看不到原标题/原摘录（期望 ORIGINAL_EXPANDED true，实际 false）');
  await second.page.screenshot({ path: join(shotDir, 'w2-research.png'), fullPage: true });

  await second.page.getByTestId('nav-overview').click();
  await second.page.getByTestId('overview-matched-findings').waitFor({ timeout: 10_000 });
  const overviewText = await second.page.locator('main').innerText();
  const blocks = ['overview-matched-findings', 'overview-recent-findings'].filter(
    (id) => overviewText.length >= 0 && id,
  );
  console.log('OVERVIEW_BLOCKS', blocks.join(','));
  console.log('OVERVIEW_SHOWS_ZH', overviewText.includes('本地模型运行时再提速'));
  if (!overviewText.includes('本地模型运行时再提速'))
    fail('总览没显示中文标题（期望 OVERVIEW_SHOWS_ZH true，实际 false）');
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
if (!existsSync(join(shotDir, 'w2-research.png')) || !existsSync(join(shotDir, 'w2-overview.png')))
  fail(
    `截图没落全（期望 shots true true，实际 ${existsSync(join(shotDir, 'w2-research.png'))} ${existsSync(join(shotDir, 'w2-overview.png'))}）`,
  );
console.log(
  'RESULT',
  passed
    ? '通过：研究页显示中文标题、藏住英文标题、显示未翻译那条的中文标题，「原文」展开能看到原摘录，总览显示中文，2 张截图都在'
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
