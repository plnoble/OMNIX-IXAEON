/**
 * v0.1.1 串联验收（四次报告放行条件 2）：
 * 真实浏览器扩展（Chromium + MV3 加载）→ 真实桌面应用本地服务（127.0.0.1:43191）
 * → 真实 SQLite 数据库。
 *
 * 覆盖：配对（真实配对码）→ 正式对话采集 → 刷新不重复建档 → 追加内容增量入库
 * → 暂停当前对话停止采集 → 继续恢复 → 草稿转正合并。
 * chatgpt.com 用本地自签 mock 页面（与 run.cjs 同一套基础设施）；
 * 模型不调用（autoAnalyze 默认关闭）。不访问真实账户。
 *
 * 运行：node apps/extension/e2e/serial-real.cjs（需先构建 out/ 与扩展 dist/）。
 */
const { chromium, _electron } = require('playwright');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startConnectProxy } = require('./proxy.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const EXT_SRC = path.join(__dirname, '..', 'dist');
const MOCK_PAGE = path.join(
  ROOT,
  'packages',
  'test-fixtures',
  'fixtures',
  'web',
  'chatgpt-mock.html',
);
const WORK = 'D:\\Agent\\Temp\\ixaeon-serial-real';
const EXT_DIR = path.join(WORK, 'ext');
const PROFILES = path.join(WORK, 'profiles');
const CERT_PFX = path.join(WORK, 'chatgpt-mock.pfx');
const CERT_PASS = 'ixaeon-e2e';
const CHATGPT_PORT = 8443;
const CHROMIUM_1208 = path.join(
  os.homedir(),
  'AppData',
  'Local',
  'ms-playwright',
  'chromium-1208',
  'chrome-win64',
  'chrome.exe',
);
const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BROWSER_EXE = fs.existsSync(CHROMIUM_1208) ? CHROMIUM_1208 : SYSTEM_CHROME;

let failed = 0;
function ok(cond, label) {
  if (cond) console.log(`  ok ${label}`);
  else {
    failed += 1;
    console.error(`  FAIL ${label}`);
  }
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  ok(false, `${label}（超时 ${timeoutMs}ms）`);
  return false;
}

function ensureCert() {
  fs.mkdirSync(path.dirname(CERT_PFX), { recursive: true });
  if (fs.existsSync(CERT_PFX)) return;
  const tmpPfx = 'D:\\Agent\\Temp\\ixaeon-e2e-cert.pfx';
  if (fs.existsSync(tmpPfx)) {
    fs.copyFileSync(tmpPfx, CERT_PFX);
    return;
  }
  const ps = [
    `$c = New-SelfSignedCertificate -DnsName 'chatgpt.com','*.chatgpt.com','localhost' -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddYears(2) -FriendlyName 'IXAEON serial e2e'`,
    `$p = ConvertTo-SecureString -String '${CERT_PASS}' -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $c -FilePath '${tmpPfx}' -Password $p | Out-Null`,
  ].join('; ');
  const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`生成自签证书失败: ${res.stderr}`);
  fs.copyFileSync(tmpPfx, CERT_PFX);
}

function startChatgptMock() {
  const html = fs.readFileSync(MOCK_PAGE, 'utf8');
  return new Promise((resolveStart) => {
    const srv = https.createServer(
      { pfx: fs.readFileSync(CERT_PFX), passphrase: CERT_PASS },
      (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(html);
      },
    );
    srv.listen(CHATGPT_PORT, '127.0.0.1', () => resolveStart(srv));
  });
}

async function waitSw(context, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sws = context.serviceWorkers();
    if (sws.length > 0 && sws[0].url().includes('background')) return sws[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main() {
  // 0) 端口占用检查：不触碰用户运行中的实例
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1500),
  }).then(
    () => true,
    () => false,
  );
  if (occupied) {
    console.error('检测到 127.0.0.1:43191 已有服务；停止测试，不触碰用户进程。');
    process.exit(1);
  }

  // 每次全新开始：清掉上次运行的 profile（残留扩展令牌会让弹窗跳过配对）
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(PROFILES, { recursive: true });
  fs.mkdirSync(EXT_DIR, { recursive: true });
  for (const f of fs.readdirSync(EXT_SRC)) {
    fs.copyFileSync(path.join(EXT_SRC, f), path.join(EXT_DIR, f));
  }
  ensureCert();

  // 1) 启动真实桌面应用（独立临时数据目录；对话框 stub 提供设置所需的目录选择）
  const dataDir = path.join(WORK, 'app-data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const seedMd = path.join(dataDir, 'seed.md');
  fs.writeFileSync(seedMd, '# 串联验收种子\n\nSERIAL_SEED_MARKER\n', 'utf8');
  const desktopDir = path.join(ROOT, 'apps', 'desktop');
  const app = await _electron.launch({
    args: [path.join(desktopDir, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${seedMd};directory|${dataDir}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // 2) 通过公开 IPC 完成首次设置并开启采集（模型不配置、自动分析保持关闭）
  const setupResult = await page.evaluate(async () => {
    const state = await window.ixaeon.getState();
    if (!state.setupComplete) {
      await window.ixaeon.completeSetup({
        dataDir: null,
        modelName: 'gpt-5.2',
        apiKey: '',
        projectName: 'SerialTest',
        projectRootPath: null,
      });
    }
    await window.ixaeon.setCaptureEnabled(true);
    return { setupComplete: (await window.ixaeon.getState()).setupComplete };
  });
  console.log(`  [serial] setupComplete=${setupResult.setupComplete}`);
  const pairCode = await page.evaluate(() => {
    const r = window.ixaeon.generatePairingCode();
    return r instanceof Promise ? r.then((x) => x.code) : r.code;
  });
  console.log(`  [serial] pairing code obtained: ${typeof pairCode === 'string'}`);
  if (typeof pairCode !== 'string') throw new Error('配对码获取失败');

  // 直接读真实 SQLite（断言强度高于经渲染层转发；避免 evaluate 通道竞态）
  const Database = require(
    path.join(ROOT, 'apps', 'desktop', 'node_modules', 'better-sqlite3'),
  );
  const dbPath = path.join(dataDir, 'ixaeon.db');
  const chatgptSources = async () => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare(
          `SELECT s.id, s.external_id,
                  (SELECT COUNT(*) FROM segments sg WHERE sg.source_id = s.id) AS segments
           FROM sources s WHERE s.provider = 'chatgpt_web'`,
        )
        .all()
        .map((r) => ({ id: r.id, externalId: r.external_id, segments: r.segments }));
    } finally {
      db.close();
    }
  };
  const sourcesLogged = async (label) => {
    const list = await chatgptSources().catch((e) => ({ error: String(e) }));
    console.log(`  [serial] sources@${label}: ${JSON.stringify(list)}`);
    return list;
  };

  // 3) 启动 chatgpt.com mock + 代理；启动带扩展的 Chromium
  const web = await startChatgptMock();
  const proxy = await startConnectProxy(CHATGPT_PORT);
  const context = await chromium.launchPersistentContext(path.join(PROFILES, 'serial'), {
    executablePath: BROWSER_EXE,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--proxy-server=http=127.0.0.1:8888;https=127.0.0.1:8888',
      '--proxy-bypass-list=127.0.0.1',
    ],
  });
  const sw = await waitSw(context);
  ok(sw !== null, '扩展 service worker 启动');
  const origin = /^(chrome-extension:\/\/[^/]+)/.exec(sw.url())[1];

  // 4) 真实配对（真实桌面端配对码）
  const popup = await context.newPage();
  await popup.goto(`${origin}/popup.html`);
  await popup.waitForSelector('#pair-code', { state: 'visible' });
  await popup.fill('#pair-code', pairCode);
  await popup.click('#pair-submit');
  const paired = await waitFor(async () => {
    const t = await popup.locator('#status-connected').textContent();
    return typeof t === 'string' && t.includes('已连接');
  }, 15_000, '真实配对成功（popup 已连接）');
  ok(paired, '真实配对成功');
  await popup.close();

  // 5) 正式对话采集 → 真实数据库
  const browserPage = await context.newPage();
  await browserPage.goto('https://chatgpt.com/c/serial-formal-001', { waitUntil: 'domcontentloaded' });
  await waitFor(
    async () => (await chatgptSources()).some((s) => s.externalId === '/c/serial-formal-001'),
    25_000,
    '正式对话进入真实数据库',
  );
  let first = (await sourcesLogged('after-first-capture')).find(
    (s) => s.externalId === '/c/serial-formal-001',
  );
  if (!first) {
    await waitFor(
      async () => (await chatgptSources()).some((s) => s.externalId === '/c/serial-formal-001'),
      15_000,
      'first source visible (retry)',
    );
    first = (await chatgptSources()).find((s) => s.externalId === '/c/serial-formal-001');
  }
  ok(first && first.segments >= 2, '正式对话片段入库');

  // 6) 刷新（真实浏览器 reload，sessionId 必然变化）→ 不重复建档
  await browserPage.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 4000));
  const afterReload = await chatgptSources();
  const formalSources = afterReload.filter((s) => s.externalId === '/c/serial-formal-001');
  ok(formalSources.length === 1, '刷新后不重复建档（单一来源）');
  ok(formalSources[0].id === first.id, '刷新后 sourceId 不变');

  // 7) 追加一轮回答 → 增量入库
  const segmentsBefore = formalSources[0].segments;
  await browserPage.evaluate(() => {
    const thread = document.querySelector('main#thread');
    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'user');
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = '串联验收追加轮次 SERIAL_APPEND_MARKER';
    turn.appendChild(textDiv);
    thread.appendChild(turn);
  });
  await waitFor(
    async () => (await chatgptSources()).find((s) => s.id === first.id).segments > segmentsBefore,
    25_000,
    '追加内容增量入库',
  );

  // 8) 暂停当前对话 → 新内容不再入库；继续后恢复
  const popup2 = await context.newPage();
  await popup2.goto(`${origin}/popup.html`);
  await popup2.waitForSelector('#pause-current', { state: 'visible' });
  await popup2.click('#pause-current');
  await popup2.waitForTimeout(500);
  const segAtPause = (await chatgptSources()).find((s) => s.id === first.id).segments;
  await browserPage.evaluate(() => {
    const thread = document.querySelector('main#thread');
    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'assistant');
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = '暂停期间的内容 SERIAL_PAUSED_MARKER';
    turn.appendChild(textDiv);
    thread.appendChild(turn);
  });
  await new Promise((r) => setTimeout(r, 5000));
  ok(
    (await chatgptSources()).find((s) => s.id === first.id).segments === segAtPause,
    '暂停期间新内容不入库',
  );
  await popup2.click('#pause-current'); // 继续
  await popup2.waitForTimeout(500);
  await popup2.close();
  await browserPage.evaluate(() => {
    const thread = document.querySelector('main#thread');
    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'user');
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = '继续后的内容 SERIAL_RESUMED_MARKER';
    turn.appendChild(textDiv);
    thread.appendChild(turn);
  });
  await waitFor(
    async () => (await chatgptSources()).find((s) => s.id === first.id).segments > segAtPause,
    25_000,
    '继续后恢复采集',
  );

  // 9) 草稿转正：先以草稿身份（无 /c/ 路径）采集，再进入正式 URL（同一 DOM）
  //    → 同一 sessionId 延续 → 服务端合并为单一正式来源
  const beforeDraft = (await chatgptSources()).length;
  // 真实浏览器整页导航（新文档 → 内容脚本重新注入 → 新采集会话）建立草稿
  await browserPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await chatgptSources()).length > beforeDraft, 25_000, '草稿来源建立');
  // 等待扩展提交冷却（3s）结束，避免转正批次的触发被冷却丢弃
  await new Promise((r) => setTimeout(r, 5000));
  // 模拟 ChatGPT 为草稿分配正式 ID：SPA pushState（不重载页面，同一内容脚本
  // 上下文延续会话身份）+ 新一轮 DOM 变化触发提交
  await browserPage.evaluate(() => {
    window.history.pushState({}, '', '/c/serial-formal-002');
    const thread = document.querySelector('main#thread');
    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'user');
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = '草稿转正后的新消息 SERIAL_PROMOTED_MARKER';
    turn.appendChild(textDiv);
    thread.appendChild(turn);
  });
  await waitFor(
    async () => (await chatgptSources()).some((s) => s.externalId === '/c/serial-formal-002'),
    25_000,
    '草稿转正为正式来源',
  );
  const afterPromotion = await chatgptSources();
  const draftLeftovers = afterPromotion.filter((s) => s.externalId.startsWith('page:'));
  ok(
    draftLeftovers.length === 0,
    '转正后临时来源已合并（不重复建档）',
  );
  ok(afterPromotion.length === beforeDraft + 1, '转正后来源总数正确');

  // 汇总
  await context.close().catch(() => {});
  web.close();
  proxy.close();
  await app.close().catch(() => {});

  if (failed > 0) {
    console.error(`\nFAIL: ${failed} 项断言失败`);
    process.exit(1);
  }
  console.log('\nPASS: 串联验收完成（真扩展 → 真实本地服务 → 真实数据库）');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
