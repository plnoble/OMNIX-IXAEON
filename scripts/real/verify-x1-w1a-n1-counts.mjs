/**
 * X1 / W1a / N1 用户验证的对账（只输出统计数字）。
 *
 * 用户在真实应用里点完之后，整合方要知道后台到底发生了什么，但不能看内容。
 * 本脚本：只读打开用户的库 → 用 SQLite 备份接口做一份临时副本 → 在副本上数数 → 删副本。
 * 不打印任何标题、正文、记忆、错误原文；失败原因只按固定类别计数。
 *
 *   node scripts/real/verify-x1-w1a-n1-counts.mjs [--since 2026-09-24T06:00:00Z]
 *
 * 数据目录：环境变量 IXAEON_DATA_DIR，否则 %LOCALAPPDATA%\OMNIX\IXAEON\bootstrap.json。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'packages', 'core', 'package.json'));
const Database = require('better-sqlite3');

function dataDir() {
  if (process.env.IXAEON_DATA_DIR) return process.env.IXAEON_DATA_DIR;
  const local = process.env.LOCALAPPDATA;
  const bootstrap = local ? join(local, 'OMNIX', 'IXAEON', 'bootstrap.json') : null;
  if (bootstrap && existsSync(bootstrap)) {
    const parsed = JSON.parse(readFileSync(bootstrap, 'utf8'));
    if (typeof parsed.dataDir === 'string' && parsed.dataDir.trim()) return parsed.dataDir.trim();
  }
  throw new Error('找不到数据目录（IXAEON_DATA_DIR 或 bootstrap.json）');
}

const sinceArg = process.argv.indexOf('--since');
const since =
  sinceArg > 0 ? process.argv[sinceArg + 1] : new Date(Date.now() - 6 * 3600_000).toISOString();

const dbPath = join(dataDir(), 'ixaeon.db');
const work = mkdtempSync(join(tmpdir(), 'ixa-counts-'));
const copyPath = join(work, 'copy.db');
const live = new Database(dbPath, { readonly: true, fileMustExist: true });
await live.backup(copyPath);
live.close();
const db = new Database(copyPath, { readonly: true });

const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const tally = (rows, key) =>
  rows.reduce((acc, r) => ((acc[r[key] ?? '无'] = (acc[r[key] ?? '无'] ?? 0) + 1), acc), {});

try {
  const out = { since, migration: one('SELECT MAX(id) AS v FROM schema_migrations').v };

  // ---- X1：来源的最近一次分析 ----
  const sources = all(`
    SELECT s.id, s.archived_at IS NOT NULL AS archived,
      (SELECT count(*) FROM items i WHERE i.extracted_from_source_id = s.id) AS items,
      (SELECT status FROM jobs WHERE kind = 'extract' AND payload_json LIKE '%' || s.id || '%'
        ORDER BY created_at DESC LIMIT 1) AS status,
      (SELECT error FROM jobs WHERE kind = 'extract' AND payload_json LIKE '%' || s.id || '%'
        ORDER BY created_at DESC LIMIT 1) AS error,
      (SELECT note FROM jobs WHERE kind = 'extract' AND payload_json LIKE '%' || s.id || '%'
        ORDER BY created_at DESC LIMIT 1) AS note,
      (SELECT created_at FROM jobs WHERE kind = 'extract' AND payload_json LIKE '%' || s.id || '%'
        ORDER BY created_at DESC LIMIT 1) AS job_at
    FROM sources s`);
  const active = sources.filter((s) => !s.archived);
  const category = (e) => {
    if (!e) return '无原因';
    if (/依据对不上原文|无效引用\/依据/.test(e)) return '依据对不上（X1 按钮认的）';
    if (/引用|依据|excerpt|segment/i.test(e)) return '其它引用/依据类';
    if (/429|限流|rate|quota|额度/i.test(e)) return '限流/额度';
    if (/timeout|超时|ECONN|fetch failed|网络|network|50[0-9]/i.test(e)) return '网络/超时/服务端';
    if (/未配置|not configured|api key|密钥|Key/i.test(e)) return '模型未配置/密钥';
    if (/JSON|schema|解析|parse/i.test(e)) return '输出格式/解析';
    return '其它';
  };
  out.x1 = {
    sources: sources.length,
    archived: sources.length - active.length,
    activeLatestJobStatus: tally(active, 'status'),
    activeWithNoItems: active.filter((s) => s.items === 0).length,
    noItemsByLatestStatus: tally(
      active.filter((s) => s.items === 0),
      'status',
    ),
    failedLatestByReason: tally(
      active.filter((s) => s.status === 'failed').map((s) => ({ c: category(s.error) })),
      'c',
    ),
    noItemsSucceededWithNote: active.filter(
      (s) => s.items === 0 && s.status === 'succeeded' && s.note,
    ).length,
    latestNoteSalvaged: active.filter((s) => (s.note ?? '').includes('按原文截短后保留')).length,
    latestJobsSince: active.filter((s) => s.job_at && s.job_at >= since).length,
    extractJobsSinceByStatus: tally(
      all(`SELECT status FROM jobs WHERE kind = 'extract' AND created_at >= ?`, since),
      'status',
    ),
    itemsCreatedSince: one('SELECT count(*) AS n FROM items WHERE created_at >= ?', since).n,
  };
  // 排队的为什么不走：建于哪天、重试了几次、下次最早什么时候、上一次的失败类别
  const nowIso = new Date().toISOString();
  const pendingJobs = all(
    `SELECT status, substr(created_at, 1, 10) AS day, retry_count, not_before, error, updated_at
       FROM jobs WHERE kind = 'extract' AND status IN ('queued', 'running')`,
  );
  out.x1.pendingJobs = {
    byStatus: tally(pendingJobs, 'status'),
    byCreatedDay: tally(pendingJobs, 'day'),
    byRetryCount: tally(pendingJobs, 'retry_count'),
    notBefore: tally(
      pendingJobs.map((j) => ({
        k: !j.not_before ? '无' : j.not_before > nowIso ? '在将来' : '已到期',
      })),
      'k',
    ),
    lastErrorCategory: tally(
      pendingJobs.map((j) => ({ c: category(j.error) })),
      'c',
    ),
    runningMinutesSinceUpdate: pendingJobs
      .filter((j) => j.status === 'running')
      .map((j) => Math.round((Date.parse(nowIso) - Date.parse(j.updated_at)) / 60000)),
  };

  // ---- W1a：关注有没有建出主题 ----
  out.w1a = {
    topics: one('SELECT count(*) AS n FROM research_topics').n,
    topicsCreatedSince: one(
      'SELECT count(*) AS n FROM research_topics WHERE created_at >= ?',
      since,
    ).n,
    researchAuditSinceByKind: tally(
      all(
        `SELECT kind FROM audit_events WHERE created_at >= ? AND (kind LIKE 'research%' OR kind LIKE 'watch%')`,
        since,
      ),
      'kind',
    ),
  };

  // ---- N1：要求与判定 ----
  const window = new Date(Date.now() - 7 * 86400_000).toISOString();
  out.n1 = {
    requirements: one('SELECT count(*) AS n FROM research_requirements').n,
    topicsWithRequirements: one('SELECT count(DISTINCT topic_id) AS n FROM research_requirements')
      .n,
    findingsOnThoseTopics: one(
      `SELECT count(*) AS n FROM research_findings
        WHERE topic_id IN (SELECT topic_id FROM research_requirements)`,
    ).n,
    findingsOnThoseTopicsIn7Days: one(
      `SELECT count(*) AS n FROM research_findings
        WHERE topic_id IN (SELECT topic_id FROM research_requirements) AND fetched_at >= ?`,
      window,
    ).n,
    matchesByVerdict: tally(all('SELECT verdict FROM research_finding_matches'), 'verdict'),
    matchesJudgedSince: one(
      'SELECT count(*) AS n FROM research_finding_matches WHERE judged_at >= ?',
      since,
    ).n,
    runsSinceByStatus: tally(
      all('SELECT status FROM research_runs WHERE started_at >= ?', since),
      'status',
    ),
    runsSinceFindingsNew: one(
      'SELECT COALESCE(SUM(findings_new), 0) AS n FROM research_runs WHERE started_at >= ?',
      since,
    ).n,
  };

  console.log(JSON.stringify(out, null, 2));
} finally {
  db.close();
  rmSync(work, { recursive: true, force: true });
}
