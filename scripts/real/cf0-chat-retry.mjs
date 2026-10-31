/**
 * CF0 真机检查甲（规格 docs/委派/CF0-聊天先能用.md）：
 * 本机起一个合成的 OpenAI 兼容假网关，用构建好的应用走一遍
 * 「模型没渠道 → 说清是哪个模型 → 在聊天里换一个已保存的模型重问」。
 *
 * - 假网关：`demo-a` 回 503 `No available channel for model demo-a …`；`demo-b` 正常回答；
 *   `demo-c` 正常回答；GET /v1/models 列出这三个。地址是 127.0.0.1 的临时端口，合成数据。
 * - Hermes：用**临时 HERMES_HOME**（里面只有一份合成的 config.yaml 指向假网关），
 *   `IXAEON_HERMES_EXE` 用本机已装的 venv python。不读、不改用户 Hermes 的 config.yaml /
 *   会话 / 凭据；临时目录收尾删掉。
 * - 首次向导 + 设置页都填假网关的地址与合成 Key；检测并保存 demo-a/demo-b/demo-c，
 *   聊天模型选 demo-a。
 * - 问一句：失败说明里要有 demo-a、「没有可用渠道」「换一个模型」，不能有「稍后再试」；
 *   失败消息下面出现下拉框，选项正好是 demo-b、demo-c。
 * - 选 demo-b 点「用这个模型重问」：同一个对话里答出来；失败的那条还在、状态还是 failed。
 * - 输出与截图；打印遮掉本机账户名与临时目录。退出码与 RESULT 一致。
 *
 *   node scripts/real/cf0-chat-retry.mjs      （先 node scripts/build.mjs）
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
// DSH 给工作区打了低完整性标签（IXAEON_ELECTRON_NO_SANDBOX=1）时，Electron 的
// TEMP/APPDATA 要放在工作区里才写得进（L14 的同一道坎）；截图另放，不随运行目录删。
const runDir = join(root, '.logs', `cf0-real-run-${Date.now()}`);
const dataDir = join(runDir, 'data');
const profileDir = join(runDir, 'profile');
const shotsDir = join(root, '.logs', 'cf0-real');
mkdirSync(dataDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
const safeEnv = {
  TEMP: join(runDir, 'temp'),
  TMP: join(runDir, 'temp'),
  APPDATA: join(runDir, 'appdata'),
  LOCALAPPDATA: join(runDir, 'localappdata'),
};
for (const d of Object.values(safeEnv)) mkdirSync(d, { recursive: true });

const TEST_KEY = 'sk-cf0-synthetic';
const ASK = 'CF0 合成问题：这条消息应该先被网关拒绝，再用另一个模型答出来。';
const ANSWER = '这是 demo-b 对 CF0 合成问题的回答。';

/** 假网关：合成的 OpenAI 兼容服务，只认 demo-a / demo-b / demo-c。 */
function startFakeGateway() {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'demo-a' }, { id: 'demo-b' }, { id: 'demo-c' }],
        }),
      );
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 合成网关：解析不出就按空对象处理 */
      }
      const model = String(body.model ?? '');
      const stream = body.stream === true;
      seen.push({ model, stream });
      if (model === 'demo-a') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'No available channel for model demo-a under group default (distributor)',
              type: 'new_api_error',
            },
          }),
        );
        return;
      }
      const text = model === 'demo-b' ? ANSWER : `这是 ${model || '未知模型'} 的回答。`;
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-cf0',
            object: 'chat.completion.chunk',
            created: 1,
            model: model || 'demo-b',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        res.write(chunk({ role: 'assistant', content: text }, null));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-cf0',
          object: 'chat.completion',
          created: 1,
          model: model || 'demo-b',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

/** 本机已装 Hermes 的 venv python（不读用户配置，只按 HERMES_HOME 布局找可执行文件）。 */
function findHermesPython() {
  const home = process.env.HERMES_HOME?.trim() || process.env.IXAEON_HERMES_HOME?.trim() || '';
  if (!home) return null;
  const exe = join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe');
  return existsSync(exe) ? exe : null;
}

let app = null;
let gateway = null;
let passed = true;
let result = '没通过：脚本没跑完';
const fail = (why) => {
  passed = false;
  console.log('不符：', why);
  result = `没通过：${why}`;
};
const shots = [];
async function shot(page, name) {
  const file = join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  console.log('截图：', file);
}

try {
  gateway = await startFakeGateway();
  console.log('FAKE_GATEWAY', gateway.base);

  // Hermes 用临时 home：只写一份合成 config.yaml，provider 指到假网关。
  const hermesHome = join(runDir, 'hermes-home');
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(
    join(hermesHome, 'config.yaml'),
    [
      'model:',
      '  provider: custom',
      '  default: demo-a',
      '  api_mode: chat_completions',
      `  base_url: "${gateway.base}"`,
      `  api_key: "${TEST_KEY}"`,
      '',
    ].join('\n'),
    'utf8',
  );
  const hermesPython = findHermesPython();

  const env = {
    ...process.env,
    ...safeEnv,
    IXAEON_DATA_DIR: dataDir,
    IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
    IXAEON_EMBED_MODEL: 'none',
    IXAEON_CODEX_EXE: 'none',
    IXAEON_HERMES_HOME: hermesHome,
    ...(hermesPython ? { IXAEON_HERMES_EXE: hermesPython } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HERMES_HOME; // 只用临时 home；用户自己的 Hermes 配置不读
  const args = [
    join(root, 'apps', 'desktop', 'out', 'main', 'index.js'),
    `--user-data-dir=${profileDir}`,
  ];
  // 接力里的 DSH 给工作区打了低完整性标签，Electron 沙箱起不来（L14 的同一道坎）。
  if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  app = await electron.launch({
    executablePath: join(
      root,
      'apps',
      'desktop',
      'node_modules',
      'electron',
      'dist',
      'electron.exe',
    ),
    args,
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.waitForLoadState('domcontentloaded');

  // 首次向导：地址/Key 都指向假网关；模型先填 demo-a
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-api-base').fill(gateway.base);
  await page.getByTestId('setup-api-key').fill(TEST_KEY);
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 30_000 });

  // 设置页：检测并保存三个模型、聊天模型选 demo-a
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-model').waitFor({ timeout: 30_000 });
  await page.getByTestId('settings-fetch-models').click();
  await page.getByTestId('settings-model-checklist').waitFor({ timeout: 30_000 });
  for (const id of ['demo-a', 'demo-b', 'demo-c']) {
    const box = page.locator(`[data-testid="settings-model-check"][data-model-id="${id}"]`);
    if (!(await box.isChecked())) await box.check();
  }
  // 先保存清单：聊天模型下拉框只列已保存的模型；存完再选 demo-a、再存一次。
  await page.getByTestId('settings-model-save').click();
  await page.locator('.ok-banner').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await page.getByTestId('settings-chat-model').selectOption('demo-a');
  await page.getByTestId('settings-model-save').click();
  await page.waitForTimeout(800);
  const saved = await page.getByTestId('settings-chat-model').inputValue();
  console.log('SETTINGS_CHAT_MODEL', saved);
  if (saved !== 'demo-a') fail(`保存后聊天模型不是 demo-a，而是 ${saved}`);

  // 提问：demo-a 应该被假网关 503 拒绝
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('page-ask').waitFor({ timeout: 30_000 });
  await page.getByTestId('ask-input').fill(ASK);
  await page.getByTestId('ask-run').click();
  const failed = page.locator('[data-testid="message-item"][data-status="failed"]');
  await failed.waitFor({ timeout: 180_000 });
  await shot(page, 'cf0-1-model-unavailable');

  const failureText = (await failed.innerText()).replace(/\s+/g, ' ').trim();
  console.log('FAILURE_TEXT', failureText);
  if (!failureText.includes('demo-a')) fail('失败说明里没写是哪个模型（没有 demo-a）');
  if (!failureText.includes('没有可用渠道')) fail('失败说明里没有「没有可用渠道」');
  if (!failureText.includes('换一个模型')) fail('失败说明里没有「换一个模型」');
  if (failureText.includes('稍后再试')) fail('失败说明里还写着「稍后再试」');

  const select = page.getByTestId('model-retry-select');
  await select.waitFor({ timeout: 30_000 });
  const options = await select
    .locator('option')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('value') ?? ''));
  console.log('RETRY_OPTIONS', JSON.stringify(options));
  if (JSON.stringify(options) !== JSON.stringify(['demo-b', 'demo-c'])) {
    fail(`下拉框选项不是正好 demo-b、demo-c：${JSON.stringify(options)}`);
  }

  // 换 demo-b 重问：同一个对话答出来；失败的那条还在
  await select.selectOption('demo-b');
  await page.getByTestId('model-retry-run').click();
  await page
    .locator('pre.answer-text')
    .filter({ hasText: ANSWER })
    .first()
    .waitFor({ timeout: 180_000 });
  await shot(page, 'cf0-2-retry-answered');

  const stillFailed = await page
    .locator('[data-testid="message-item"][data-status="failed"]')
    .count();
  console.log('FAILED_MESSAGE_STILL_THERE', stillFailed);
  if (stillFailed !== 1) fail(`失败的那条消息没留住（failed 条数 ${stillFailed}）`);

  const askText = await page.getByTestId('message-list').innerText();
  const askedTwice = askText.split(ASK).length - 1;
  console.log('SAME_QUESTION_TIMES', askedTwice);
  if (askedTwice < 2) fail('同一个对话里没有用原话重新问一遍');

  console.log('GATEWAY_REQUESTS', JSON.stringify(gateway.seen));
  const models = gateway.seen.map((r) => r.model);
  if (!models.includes('demo-a')) fail('假网关没收到 demo-a 的请求');
  if (!models.includes('demo-b')) fail('假网关没收到 demo-b 的请求（重问没用上新模型）');
  if (!passed) {
    if (result === '没通过：脚本没跑完') result = '没通过：有对照项不符';
  } else {
    result =
      '通过：没渠道说清了 demo-a、失败下面能换 demo-b 在同一个对话里重问出答案，失败消息仍留着';
  }
} catch (err) {
  passed = false;
  result = `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`;
  console.log('脚本出错：', maskOut(result));
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  if (gateway) gateway.server.close();
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(runDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
console.log('RESULT', maskOut(result));
if (shots.length > 0) console.log('SCREENSHOTS', shots.map((s) => maskOut(s)).join(' , '));
process.exit(passed ? 0 : 1);
