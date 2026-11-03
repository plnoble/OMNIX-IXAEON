/**
 * MP2b 真机检查脚本（甲 / 乙）。
 *
 *   node scripts/real/mp2b-ui-check.mjs magpie     # 乙：本机 magpie，只打印三个数
 *   node scripts/real/mp2b-ui-check.mjs two        # 甲：两个假 OpenAI 服务，两家供应商
 *
 * 两种模式都用真应用（`apps/desktop/out/main/index.js`）+ 临时数据目录，
 * 走「模型」页的真实操作。合成数据；不打印模型名、账号、额度数值、本机账户名。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { _electron: electron } = createRequire(resolve('apps/desktop/package.json'))('playwright');

const mode = process.argv[2] ?? 'magpie';
const MODEL = 'demo-a';
const KEY = 'sk-synthetic';
const MAGPIE_BASE = 'http://127.0.0.1:3425/v1';

/** 起一个假 OpenAI 兼容服务：/models 回固定清单，chat 回固定流式正文；记录聊天请求次数。 */
function fakeGateway(models, answer) {
  const stats = { models: 0, chat: 0, chatModels: [] };
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      stats.models += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      stats.chat += 1;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          stats.chatModels.push(JSON.parse(body).model ?? '?');
        } catch {
          stats.chatModels.push('?');
        }
      });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunks = answer.split('，');
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
        i += 1;
      }, 60);
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      done({ server, stats, base: `http://127.0.0.1:${String(addr.port)}/v1` });
    });
  });
}

async function launch(tmp) {
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(tmp, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: tmp },
  });
  const page = await app.firstWindow();
  return { app, page };
}

async function completeWizard(page, base, key, model) {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-api-base').fill(base);
  await page.getByTestId('setup-api-key').fill(key);
  await page.getByTestId('setup-model-name').fill(model);
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });
}

async function openModels(page) {
  await page.getByTestId('nav-models').click();
  await page.getByTestId('models-page').waitFor({ state: 'visible', timeout: 20_000 });
}

/** 加一家供应商：填名字/地址/Key，点添加。 */
async function addProvider(page, name, base, key) {
  await page.getByTestId('provider-add-name').fill(name);
  await page.getByTestId('provider-add-base').fill(base);
  await page.getByTestId('provider-add-key').fill(key);
  await page.getByTestId('provider-add-save').click();
}

async function providerIds(page) {
  return page.$$eval('[data-testid^="provider-card-"]', (els) =>
    els.map((el) => el.getAttribute('data-testid')?.replace('provider-card-', '') ?? ''),
  );
}

async function magpieMode() {
  const tmp = mkdtempSync(join(tmpdir(), 'ixaeon-mp2b-'));
  let app;
  try {
    const probe = await fetch(`${MAGPIE_BASE}/models`, {
      headers: { authorization: 'Bearer magpie' },
    }).catch(() => null);
    if (!probe?.ok) {
      console.log('没跑：magpie 未运行');
      return;
    }
    ({ app } = await launch(tmp));
    const page = await app.firstWindow();
    await completeWizard(page, 'http://127.0.0.1:9/v1', KEY, MODEL);
    await openModels(page);

    // 「用本机 magpie」预设 → 添加
    await page.getByTestId('provider-magpie-preset').click();
    await page.getByTestId('provider-add-save').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="provider-card-"]').length >= 2,
      undefined,
      { timeout: 20_000 },
    );
    const ids = await providerIds(page);
    const magpieId = ids.find((id) => id !== 'default') ?? '';
    await page.getByTestId(`provider-models-${magpieId}`).click();
    await page
      .waitForFunction(
        () => document.querySelectorAll('[data-testid^="model-row-"]').length > 0,
        undefined,
        { timeout: 30_000 },
      )
      .catch(() => undefined);

    const counts = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid^="model-row-"]')].map(
        (el) => el.getAttribute('data-testid') ?? '',
      );
      const models = rows.map((r) => r.replace('model-row-', ''));
      return {
        models: models.length,
        groups: models.filter((m) => m.startsWith('group/')).length,
        quotaCards: document.querySelectorAll('[data-testid^="provider-quota-"]').length,
      };
    });
    console.log(`模型个数=${String(counts.models)}`);
    console.log(`分组个数=${String(counts.groups)}`);
    console.log(`额度卡片张数=${String(counts.quotaCards)}`);
  } finally {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function twoMode() {
  const tmp = mkdtempSync(join(tmpdir(), 'ixaeon-mp2b-two-'));
  const a = await fakeGateway(['demo-a'], '这是甲家的回答，用来验证聊天走到了第二家。');
  const b = await fakeGateway(['demo-b'], '这是乙家的回答，说明聊天确实切到了第二家。');
  let app;
  try {
    ({ app } = await launch(tmp));
    const page = await app.firstWindow();
    await completeWizard(page, a.base, KEY, 'demo-a');
    await openModels(page);

    // 第二家
    await addProvider(page, '合成乙', b.base, 'sk-synthetic-b');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="provider-card-"]').length >= 2,
      undefined,
      { timeout: 20_000 },
    );
    const ids = await providerIds(page);
    const bId = ids.find((id) => id !== 'default') ?? '';

    // 两家各自获取模型并保存勾选
    for (const id of ['default', bId]) {
      await page.getByTestId(`provider-models-${id}`).click();
      await page.waitForTimeout(600);
      const row = page.getByTestId(`model-row-${id === 'default' ? 'demo-a' : 'demo-b'}`);
      if (await row.count()) await row.locator('input[type="checkbox"]').check();
      await page.getByTestId(`provider-save-${id}`).click();
      await page.waitForTimeout(300);
    }

    // 聊天切到第二家
    await page.evaluate(async (id) => {
      const sel = document.querySelector('[data-testid="uses-chat"]');
      const opt = sel ? [...sel.options].find((o) => o.value === `${id}::demo-b`) : null;
      if (opt && sel) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, bId);
    await page.getByTestId('uses-save').click();
    await page.waitForTimeout(400);
    const savedUses = await page.evaluate(async () => {
      const s = await window.ixaeon.getSettings();
      return JSON.stringify(s.config.uses ?? {});
    });
    console.log('保存后的 uses=' + savedUses);

    // 问一句（先把计数清零：预热/重试的请求不该算进「这一问」）
    a.stats.chat = 0;
    b.stats.chat = 0;
    await page.getByTestId('nav-ask').click();
    const input = page.getByTestId('ask-input');
    await input.fill('用一句话说明你是谁');
    await input.press('Enter');
    await page.waitForTimeout(4000);

    const answer = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="ask-answer"]');
      const details = document.querySelector('.ask-msg-details summary');
      return {
        text: (el?.textContent ?? '').slice(0, 40),
        summary: (details?.textContent ?? '').trim(),
      };
    });
    console.log('回答前 40 字=' + answer.text);
    console.log('引擎标签=' + answer.summary);
    console.log(`第一家收到聊天请求=${String(a.stats.chat)}`);
    console.log(`第二家收到聊天请求=${String(b.stats.chat)}`);
    console.log('第一家的 chat 模型=' + a.stats.chatModels.join(','));
    console.log('第二家的 chat 模型=' + b.stats.chatModels.join(','));
    const quotaOnFirst = await page.evaluate(
      () => document.querySelectorAll('[data-testid="provider-quota-default"]').length,
    );
    console.log(`第一家有额度区=${String(quotaOnFirst)}`);

    // 删第二家：它正被聊天用着，应当被拒
    await page.getByTestId('nav-models').click();
    await page.waitForTimeout(300);
    await page.getByTestId(`provider-delete-${bId}`).click();
    await page.waitForTimeout(600);
    const refused = await page.evaluate(
      () => document.querySelector('[data-testid="models-error"]')?.textContent ?? '',
    );
    console.log(`删除被拒=${refused.length > 0 ? '是' : '否'}`);
    console.log(`拒绝原因含「聊天」=${refused.includes('聊天') ? '是' : '否'}`);
    await page.screenshot({ path: '.logs/mp2b-ui.png', fullPage: true });
    console.log('截图=.logs/mp2b-ui.png');
  } finally {
    if (app) await app.close();
    a.server.close();
    b.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (mode === 'two') await twoMode();
else await magpieMode();
