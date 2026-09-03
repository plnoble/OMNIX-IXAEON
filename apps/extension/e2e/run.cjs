/**
 * M4 扩展 e2e（真实 Chromium + 真实扩展 + mock ChatGPT + 本地 mock 桌面端）。
 *
 * 为什么不用 Playwright Test runner / route.fulfill：
 * - Playwright Test worker 与扩展 SW 共存触发 Windows 0xC0000409 崩溃；
 * - route.fulfill 的合成导航不触发 content_scripts 注入。
 * 因此用纯 node + playwright 库 + host-resolver-rules + 自签 https mock。
 *
 * 覆盖（计划 5.4 / 5.5）：
 * 1. 配对流程：popup 6 位码 → 令牌保存 → 状态已连接
 * 2. 进入对话页：2s 稳定后提交两轮（角色/顺序/指纹/噪音剥离）
 * 3. 流式追加：未稳定不提交；稳定后提交完整新版本
 * 4. 未配对：不提交任何内容
 * 5. 非 chatgpt.com 页面不采集
 */
const { chromium } = require('playwright');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startConnectProxy } = require('./proxy.cjs');

const EXT_SRC = path.join(__dirname, '..', 'dist');
const MOCK_PAGE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'test-fixtures',
  'fixtures',
  'web',
  'chatgpt-mock.html',
);
// Chrome 152+ 稳定版对 --load-extension 有企业限制（静默不加载）；
// 用 Playwright 旧版 Chromium（chromium-1208）测试扩展。
// 存在即用；否则回落系统 Chrome（老版本可用）。
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
const CHATGPT_PORT = 8443;
const CONV_URL = `https://chatgpt.com/c/e2e-conv-001`;

// Windows：--load-extension 路径含非 ASCII（仓库名"析衍"）时 Chrome 静默不加载；
// 复制到 ASCII 临时目录（cpSync 在本机触发 Node 快速失败，逐文件复制）。
// 注意：本机 Chrome 对 C:\Users\...%TEMP% 下的扩展路径加载不稳定，统一用 D:\Agent\Temp。
const WORK = 'D:\\Agent\\Temp\\ixaeon-ext-e2e';
const EXT_DIR = path.join(WORK, 'ext');
const PROFILES = path.join(WORK, 'profiles');
const CERT_PFX = path.join(WORK, 'chatgpt-mock.pfx');
const CERT_PASS = 'ixaeon-e2e';

let failed = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`  ok ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  ok(actual === expected, label);
}

function includes(actual, needle, label) {
  ok(typeof actual === 'string' && actual.includes(needle), label);
}

const batches = [];
let authHeaderSeen = null;
let pairRequests = 0;

/** 准备自签证书（证书复用上次生成或用 PowerShell 现生成 PFX）。 */
function ensureCert() {
  if (fs.existsSync(CERT_PFX)) return;
  const tmpPfx = 'D:\\Agent\\Temp\\ixaeon-e2e-cert.pfx';
  if (fs.existsSync(tmpPfx)) {
    fs.copyFileSync(tmpPfx, CERT_PFX);
    return;
  }
  // 生成自签证书（chatgpt.com SAN）
  const ps = [
    `$c = New-SelfSignedCertificate -DnsName 'chatgpt.com','*.chatgpt.com','localhost' -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddYears(2) -FriendlyName 'IXAEON e2e self-signed'`,
    `$p = ConvertTo-SecureString -String '${CERT_PASS}' -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $c -FilePath '${tmpPfx}' -Password $p | Out-Null`,
  ].join('; ');
  const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`生成自签证书失败: ${res.stderr}`);
  }
  fs.copyFileSync(tmpPfx, CERT_PFX);
}

function startApiServer() {
  return new Promise((resolveStart) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1:43191');
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url.pathname === '/api/extension/pair') {
        pairRequests += 1;
        res.end(JSON.stringify({ token: 'e'.repeat(64) }));
        return;
      }
      if (url.pathname === '/api/extension/status') {
        res.end(
          JSON.stringify({
            paired: true,
            captureEnabled: true,
            serverTime: new Date().toISOString(),
          }),
        );
        return;
      }
      if (url.pathname === '/api/extension/capture') {
        authHeaderSeen = req.headers.authorization ?? null;
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          try {
            batches.push(JSON.parse(body));
            res.end(JSON.stringify({ accepted: 2, deduplicated: 0, sourceId: 'src-1' }));
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: 'IXA0102', message: 'bad json' }));
          }
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'IXA0000', message: 'not found' }));
    });
    srv.on('request', (req) => {
      console.log(`  [api] ${req.method} ${req.url}`);
    });
    srv.listen(43191, '127.0.0.1', () => resolveStart(srv));
  });
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

async function newContext(profileDir) {
  return chromium.launchPersistentContext(path.join(PROFILES, profileDir), {
    executablePath: BROWSER_EXE,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      // host-resolver-rules 会被 DoH 绕过（真实 chatgpt.com 触发 Cloudflare 挑战）；
      // 用本地 CONNECT 代理拦截 chatgpt.com，127.0.0.1（桌面端 mock）绕过
      '--proxy-server=http=127.0.0.1:8888;https=127.0.0.1:8888',
      '--proxy-bypass-list=127.0.0.1',
    ],
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

/** 取扩展 origin（Node 的 URL 对 chrome-extension 方案返回 null origin；手工拼接）。 */
async function captureExtOrigin(context, timeoutMs = 10_000) {
  const sw = await waitSw(context, timeoutMs);
  if (!sw) return { sw: null, origin: null };
  const url = sw.url();
  const m = /^(chrome-extension:\/\/[^/]+)/.exec(url);
  return { sw, origin: m ? m[1] : null };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  ok(false, `${label}（超时 ${timeoutMs}ms）`);
  return false;
}

async function main() {
  // 准备 ASCII 目录 + 证书
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(PROFILES, { recursive: true });
  fs.mkdirSync(EXT_DIR, { recursive: true });
  for (const f of fs.readdirSync(EXT_SRC)) {
    fs.copyFileSync(path.join(EXT_SRC, f), path.join(EXT_DIR, f));
  }
  ensureCert();

  const api = await startApiServer();
  const web = await startChatgptMock();
  const proxy = await startConnectProxy(CHATGPT_PORT);
  // 全流程复用一个浏览器上下文（同一 profile 的二次启动会触发真实
  // chatgpt.com 的 Cloudflare 挑战——host-resolver 在该场景下不可靠）
  const mainContext = await newContext('a');
  try {
    // ---- 1. 配对流程 ----
    console.log('pair: popup 6-digit code -> token + connected');
    {
      const context = mainContext;
      const page = await context.newPage();
      await page.bringToFront();
      await page.goto(CONV_URL, { waitUntil: 'domcontentloaded' });
      await page.title();
      const { sw, origin } = await captureExtOrigin(context);
      ok(sw !== null && origin !== null, 'service worker started');

      const popup = await context.newPage();
      await popup.goto(origin + '/popup.html');
      await popup.waitForSelector('#pair-code', { state: 'visible' });

      await popup.fill('#pair-code', '12');
      await popup.click('#pair-submit');
      await popup.waitForTimeout(300);
      includes(
        await popup.locator('#pair-result').textContent(),
        '6',
        'invalid pair code rejected with hint',
      );

      await popup.fill('#pair-code', '123456');
      await popup.click('#pair-submit');
      const deadline = Date.now() + 15_000;
      let connected = false;
      while (Date.now() < deadline) {
        const t = await popup.locator('#status-connected').textContent();
        if (t && t.includes('已连接')) {
          connected = true;
          break;
        }
        await popup.waitForTimeout(300);
      }
      ok(connected, 'popup shows connected');
      eq(pairRequests, 1, 'exactly one pair request');

      const hasToken = await sw
        .evaluate(async () => {
          const s = await chrome.storage.local.get(['token']);
          return typeof s.token === 'string' && s.token.length === 64;
        })
        .catch(() => false);
      ok(hasToken, 'token persisted in extension storage');
      await page.close();
    }

    // ---- 2. 稳定提交两轮（同一页面重载） ----
    console.log('visit conversation: submit two turns after 2s stability');
    {
      const context = mainContext;
      const page = await context.newPage();
      await page.bringToFront();
      await page.goto(CONV_URL, { waitUntil: 'domcontentloaded' });
      await waitFor(() => batches.length > 0, 20_000, 'initial batch submitted');
      ok(
        authHeaderSeen !== null && authHeaderSeen.includes('Bearer '),
        'capture carries Bearer token',
      );

      const batch = batches[0];
      includes(batch.conversation.externalId, '/c/e2e-conv-001', 'externalId from path');
      const texts = batch.turns.map((t) => t.text).join('\n');
      includes(texts, 'IXAEON 项目的第一版核心价值', 'user message captured');
      includes(texts, '项目连续性', 'assistant message captured');
      ok(!texts.includes('复制'), 'action buttons stripped');
      ok(!texts.includes('侧栏'), 'sidebar text excluded');
      eq(batch.turns[0].role, 'user', 'first turn role user');
      eq(batch.turns[1].role, 'assistant', 'second turn role assistant');
      eq(batch.turns[0].order, 0, 'order starts at 0');
      ok(
        batch.turns.every((t) => /^[0-9a-f]{64}$/.test(t.contentHash)),
        'every turn has 64-hex content hash',
      );
      await page.close();
    }

    // ---- 3. 流式稳定（同一页面继续） ----
    console.log('streaming: no submit until stable, then full new version');
    {
      const context = mainContext;
      const page = await context.newPage();
      await page.bringToFront();
      await page.goto(CONV_URL, { waitUntil: 'domcontentloaded' });
      await waitFor(() => batches.length > 0, 20_000, 'initial batch (profile reused)');
      const beforeStreaming = batches.length;

      await page.evaluate(() => {
        const thread = document.querySelector('main#thread');
        const turn = document.createElement('div');
        turn.setAttribute('data-message-author-role', 'assistant');
        const textDiv = document.createElement('div');
        textDiv.className = 'text';
        textDiv.textContent = '正在思考';
        turn.appendChild(textDiv);
        thread.appendChild(turn);
      });
      await page.waitForTimeout(800);
      eq(batches.length, beforeStreaming, 'no submit mid-stream (stability window)');
      await page.evaluate(() => {
        const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
        const last = turns[turns.length - 1];
        last.querySelector('.text').textContent =
          '正在思考。答案是：把原文与当前理解分开存储。';
      });
      await page.waitForTimeout(800);
      eq(batches.length, beforeStreaming, 'still no submit while streaming');
      await page.evaluate(() => {
        const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
        const last = turns[turns.length - 1];
        last.querySelector('.text').textContent =
          '正在思考。答案是：把原文与当前理解分开存储。这样可以做到可追溯。';
      });

      await waitFor(() => batches.length > beforeStreaming, 20_000, 'new batch after stability');
      const finalBatch = batches[batches.length - 1];
      eq(finalBatch.turns.length, 3, 'new batch contains 3 full turns');
      includes(finalBatch.turns[2].text, '可追溯', 'final streamed text fully captured');
      ok(
        finalBatch.turns.every((t) => /^[0-9a-f]{64}$/.test(t.contentHash)),
        'new batch hashes present',
      );
      await page.close();
    }

    // ---- 4. 未配对不提交（独立 context：全新 profile） ----
    console.log('unpaired profile: no submissions');
    {
      const before = batches.length;
      const context = await newContext('c');
      const page = await context.newPage();
      await page.bringToFront();
      await page.goto('https://chatgpt.com/c/unpaired-check', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      eq(batches.length, before, 'no batches when unpaired');
      await context.close();
    }

    // ---- 5. 非 chatgpt.com 不采集（同一 main context，但别的域名） ----
    console.log('non-chatgpt.com page: no capture');
    {
      const before = batches.length;
      const context = mainContext;
      const page = await context.newPage();
      const html =
        '<html><body><div data-message-author-role="user">机密内容 secret</div></body></html>';
      await page.route('https://example.com/secret', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: html }),
      );
      await page.goto('https://example.com/secret', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      eq(batches.length, before, 'no batches from other domain');
      const leaked = batches.some((b) => b.turns.some((t) => t.text.includes('机密内容')));
      ok(!leaked, 'other-site content never captured');
      await page.close();
    }
  } finally {
    await mainContext.close().catch(() => {});
    api.close();
    web.close();
    proxy.close();
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nPASS: extension e2e complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
