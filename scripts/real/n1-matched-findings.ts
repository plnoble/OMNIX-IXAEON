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

/** 逐条对照，只有全都符合才写「通过」；出错非零（照 p5/p7 的规矩）。 */
let passed = true;
const fail = (why: string) => {
  passed = false;
  console.log('不符：', why);
};
// 起动应用、过首次设置这些在 try 之外的步骤出错时，也要留一行 RESULT 并以非零退出
// （否则异常直接把进程带走，看不到结论行）
const failHard = (err: unknown): never => {
  console.log('脚本出错：', err instanceof Error ? (err.stack ?? err.message) : err);
  console.log('RESULT', `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
};
process.on('uncaughtException', failHard);
process.on('unhandledRejection', failHard);

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
// 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell / 门禁都带），Electron 会当普通 node
// 跑、主进程里 app 是 undefined、窗口起不来。照 scripts/real/p8-delete-project.mjs 清掉。
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
  for (const want of [
    'N1 真机合成发现',
    '内存 24GB 以上：写了 24GB 内存',
    '能跑本地大模型：写了能跑本地大模型',
  ]) {
    if (!beforeText.includes(want)) fail(`「符合你要求的新发现」里没有「${want}」`);
  }
  if (!beforeText.includes('都看过了')) fail('「符合你要求的新发现」里没有「都看过了」');
  const recentCount = await second.page.getByTestId('overview-recent-findings').count();
  console.log('RECENT_BELOW', recentCount);
  await second.page.screenshot({ path: join(shotDir, 'n1-matched-before.png'), fullPage: true });
  await second.page.getByTestId('matched-findings-seen').click();
  await second.page.waitForTimeout(800);
  const afterNew = await second.page.locator('[data-testid^="matched-finding-new-"]').count();
  const afterText = await second.page.getByTestId('overview-matched-findings').innerText();
  console.log('AFTER_NEW_BADGES', afterNew);
  if (afterNew !== 0) fail(`点过「都看过了」之后还剩 ${afterNew} 条「新」标记（期望 0）`);
  console.log('MATCHED_AFTER');
  console.log(afterText);
  if (!afterText.includes('N1 真机合成发现')) fail('点过「都看过了」之后那条发现不见了');
  for (const want of ['内存 24GB 以上：写了 24GB 内存', '能跑本地大模型：写了能跑本地大模型']) {
    if (!afterText.includes(want)) fail(`点过「都看过了」之后少了「${want}」`);
  }
  await second.page.screenshot({ path: join(shotDir, 'n1-matched-after.png'), fullPage: true });
} catch (err) {
  passed = false;
  console.log('脚本出错：', err instanceof Error ? err.message : String(err));
} finally {
  await second.app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
const shots = [
  existsSync(join(shotDir, 'n1-matched-before.png')),
  existsSync(join(shotDir, 'n1-matched-after.png')),
];
console.log('shots', shots[0], shots[1]);
if (!shots[0] || !shots[1]) fail('两张截图没都写出来');
console.log(
  'RESULT',
  passed
    ? '通过：对上要求的那条发现显示在「符合你要求的新发现」里（两条要求的判定与理由都在），点「都看过了」后「新」标记清零、内容还在'
    : '没通过：上面有不符或脚本出错的那条',
);
process.exit(passed ? 0 : 1);
