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

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
const maskOut = (v) => {
  let text;
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
const fail = (why) => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
const crash = (err) => {
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
  // 照现在的规矩隔离：随机端口、不载嵌入模型、不碰真 Codex / 真 Hermes
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};
// 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell 与门禁都带），Electron 会当普通 node
// 跑、主进程里 app 是 undefined、Playwright 报「Process failed to launch!」。照 p8 的写法清掉。
delete env.ELECTRON_RUN_AS_NODE;

async function launch() {
  const app = await electron.launch({
    args: [
      join(desktopDir, 'out', 'main', 'index.js'),
      `--user-data-dir=${join(dataDir, 'profile')}`,
    ],
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
if (!beforeText.includes('W1b 真机合成发现'))
  fail(
    '概览「最近的新发现」里没有刚写进去的合成发现（期望 BEFORE_BLOCK 里有「W1b 真机合成发现」，实际没有）',
  );
await second.page.getByTestId('recent-findings-seen').click();
await second.page.waitForTimeout(800);
const afterNew = await second.page.locator('[data-testid^="recent-finding-new-"]').count();
const afterText = await second.page.getByTestId('overview-recent-findings').innerText();
await second.page.screenshot({ path: join(shotDir, 'w1b-findings-after.png'), fullPage: true });
console.log('AFTER_NEW_BADGES', afterNew);
if (afterNew !== 0)
  fail(`点了「已看」之后还有 ${afterNew} 个「新」角标（期望 AFTER_NEW_BADGES 0）`);
console.log('AFTER_BLOCK');
console.log(afterText);
await second.app.close();
console.log(
  'shots',
  existsSync(join(shotDir, 'w1b-findings-before.png')),
  existsSync(join(shotDir, 'w1b-findings-after.png')),
);
if (
  !existsSync(join(shotDir, 'w1b-findings-before.png')) ||
  !existsSync(join(shotDir, 'w1b-findings-after.png'))
)
  fail(
    `截图没落全（期望 shots true true，实际 ${existsSync(join(shotDir, 'w1b-findings-before.png'))} ${existsSync(join(shotDir, 'w1b-findings-after.png'))}）`,
  );
console.log(
  'RESULT',
  passed
    ? '通过：概览「最近的新发现」里看到 1 条合成发现，点「已看」后「新」角标 0 个，2 张截图都在'
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
