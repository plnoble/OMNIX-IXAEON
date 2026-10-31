/**
 * K4 真机：临时数据目录 + 合成 QuotaHub（本机 HTTP 服务）+ 合成手动登记，启动应用看驾驶舱额度区。
 * 1. 截一张驾驶舱额度区的图（合成账号，不用真实账号截图）；
 * 2. 检查卡片上该有的字：账号、状态、用量、数据旧了、手动 · 登记于 N 天前、可能已重置。
 *
 * 只写合成数据；截图落到 apps/desktop/release/screenshots/。输出只有数字和布尔值。
 * 跑法（需要先 node scripts/build.mjs）：
 *   node scripts/real/k4-cockpit-quota.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩）
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
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

let passed = true;
let firstFail = '';
const fail = (why) => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) throw new Error('no _electron: ' + Object.keys(pw).slice(0, 30).join(','));
const Database = require(require.resolve('better-sqlite3', { paths: [desktopDir, root] }));
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });
const shot = join(shotDir, 'k4-cockpit-quotas.png');
rmSync(shot, { force: true });

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// 合成 QuotaHub：两个账号，一个的 collected_at 是一小时前（页面要标「数据旧了」）。
const accounts = [
  {
    provider: 'codex',
    account_name: '合成 Codex 账号',
    status: 'ok',
    plan: { name: 'Plus', expires_at: iso(now + 30 * DAY) },
    quota_windows: [
      { name: '5 小时', used: 42.5, reset_at: iso(now + 3 * HOUR) },
      { name: '每周', used: null, reset_at: null },
    ],
    collected_at: iso(now - HOUR),
    cookie: 'COOKIE-不该出现',
  },
  {
    provider: 'volcengine',
    account_name: '合成火山账号',
    status: 'cookie_expired',
    plan: { name: 'coding_plan', expires_at: null },
    quota_windows: [{ name: '每周', used: 0, reset_at: iso(now + 2 * DAY) }],
    collected_at: iso(now - 5 * 60_000),
  },
];
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/api/snapshots') {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.stringify({ server_time: iso(now), refreshing: false, accounts });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const dataDir = mkdtempSync(join(root, '.logs', 'k4-real-'));
const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');

const electronEnv = {};
if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') {
  const base = join(root, '.logs', 'k4-electron-env');
  Object.assign(electronEnv, {
    TEMP: join(base, 'temp'),
    TMP: join(base, 'temp'),
    APPDATA: join(base, 'appdata'),
    LOCALAPPDATA: join(base, 'localappdata'),
  });
  for (const dir of Object.values(electronEnv)) mkdirSync(dir, { recursive: true });
}
const env = {
  ...process.env,
  ...electronEnv,
  IXAEON_DATA_DIR: dataDir,
  IXAEON_RELAY_DIR: join(dataDir, 'relay'),
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};
mkdirSync(env.IXAEON_RELAY_DIR, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;

async function launch() {
  const args = [
    join(desktopDir, 'out', 'main', 'index.js'),
    `--user-data-dir=${join(dataDir, 'profile')}`,
  ];
  if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const app = await electron.launch({ args, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

try {
  const first = await launch();
  await first.page.getByTestId('setup-next-1').click();
  await first.page.getByTestId('setup-model-name').fill('fake-model');
  await first.page.getByTestId('setup-next-2').click();
  await first.page.getByTestId('setup-project-name').fill('K4 合成项目');
  await first.page.getByTestId('setup-finish').click();
  await first.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await first.app.close();

  const db = new Database(join(dataDir, 'ixaeon.db'));
  const set = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  set.run('cockpit.quotahub_url', `http://127.0.0.1:${port}`, iso(now));
  set.run(
    'cockpit.manual_quotas',
    JSON.stringify([
      {
        account: 'Claude 合成账号',
        window: '5 小时',
        resetAt: iso(now - HOUR),
        expiresAt: iso(now + 20 * DAY),
        registeredAt: iso(now - 2 * DAY),
        note: '合成备注',
      },
      {
        account: 'Claude 合成账号',
        window: '每周',
        resetAt: iso(now + 2 * DAY),
        expiresAt: iso(now + 20 * DAY),
        registeredAt: iso(now - 2 * DAY),
      },
    ]),
    iso(now),
  );
  db.close();

  const second = await launch();
  await second.page.getByTestId('page-cockpit').waitFor({ timeout: 20_000 });
  await second.page.getByTestId('cockpit-quotas').waitFor({ timeout: 20_000 });
  const text = await second.page.getByTestId('page-cockpit').innerText();
  await second.page.screenshot({ path: shot, fullPage: true });

  const cards = await second.page.getByTestId('cockpit-quota-card').count();
  const windows = await second.page.getByTestId('cockpit-quota-window').count();
  console.log('QUOTA_CARDS', cards);
  console.log('QUOTA_WINDOWS', windows);
  if (!text.includes('合成 Codex 账号')) fail('没看到 QuotaHub 的合成 Codex 账号');
  if (!text.includes('合成火山账号')) fail('没看到 QuotaHub 的合成火山账号');
  if (!text.includes('Claude 合成账号')) fail('没看到手动登记的合成 Claude 账号');
  if (!text.includes('已用 42.5%')) fail('没看到用量');
  if (!text.includes('数据旧了')) fail('半小时前的 QuotaHub 数据没标「数据旧了」');
  if (!text.includes('手动 · 登记于 2 天前')) fail('手动条目没写登记时间');
  if (!text.includes('可能已重置，请更新')) fail('重置时间已过的手动条目没提示');
  if (text.includes('COOKIE-不该出现')) fail('QuotaHub 返回里的 cookie 进了页面');
  // 同一账号两个窗口合成一张卡：2 张 QuotaHub + 1 张手动 = 3 张，窗口 2+1+2 = 5 个。
  if (cards !== 3) fail(`额度卡片 ${cards} 张，期望 3`);
  if (windows !== 5) fail(`窗口 ${windows} 个，期望 5`);
  console.log('SHOT', existsSync(shot));
  if (!existsSync(shot)) fail('截图没落下来');
  await second.app.close();
} finally {
  server.close();
}

console.log(
  'RESULT',
  passed
    ? '通过：额度区三张合成卡与手动合并、数据旧了、可能已重置、截图都在'
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
