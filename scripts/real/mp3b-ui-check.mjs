/**
 * MP3b 界面真机检查：临时数据目录起应用，在「模型」页配两家合成供应商
 * （指向本脚本起的两个假 OpenAI 兼容服务：一个 429、一个正常），排好替补，问一句。
 *
 *   node scripts/real/mp3b-ui-check.mjs
 *
 * 只打印：实际答的模型、那句提示、截图路径；临时目录整段遮成 <临时目录>；不连外网。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron } = requireDesktop('playwright');

const sse = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '来自替补的回答' } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const s1 = createServer((q, r) => {
  if (q.url?.includes('/models')) {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ data: [{ id: 'demo-a' }, { id: 'demo-b' }] }));
    return;
  }
  r.writeHead(429, { 'content-type': 'application/json' });
  r.end(JSON.stringify({ error: { message: '额度用完' } }));
});
const s2 = createServer((q, r) => {
  if (q.url?.includes('/models')) {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ data: [{ id: 'demo-a' }, { id: 'demo-b' }] }));
    return;
  }
  sse(r);
});
const p1 = await new Promise((r) => s1.listen(0, '127.0.0.1', () => r(s1.address().port)));
const p2 = await new Promise((r) => s2.listen(0, '127.0.0.1', () => r(s2.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3b-ui-'));
const mask = (s) => String(s).replaceAll(dir, '<临时目录>');
const log = (...a) => console.log(...a.map(mask));

const app = await electron.launch({
  args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
  env: { ...process.env, IXAEON_DATA_DIR: dir },
});
try {
  const page = await app.firstWindow();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });

  await page.getByTestId('nav-models').click();
  const add = async (name, port) => {
    await page.getByTestId('provider-add-name').fill(name);
    await page.getByTestId('provider-add-base').fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId('provider-add-key').fill('sk-synthetic');
    await page.getByTestId('provider-add-save').click();
    const card = page.locator('[data-testid^="provider-card-"]').filter({ hasText: name }).last();
    await card.waitFor({ state: 'visible', timeout: 20_000 });
    await card.getByTestId(/^provider-models-/).click();
    await card.getByTestId('model-row-demo-a').waitFor({ state: 'visible', timeout: 20_000 });
    await card.getByTestId('model-row-demo-a').locator('input[type="checkbox"]').check();
    await card.getByTestId('model-row-demo-b').locator('input[type="checkbox"]').check();
    await card.getByTestId(/^provider-save-/).click();
  };
  await add('合成甲', p1);
  await add('合成乙', p2);

  await page.getByTestId('uses-analysis').selectOption({ label: '合成甲 · demo-a' });
  await page.getByTestId('uses-chat').selectOption({ label: '合成甲 · demo-a' });
  const addBox = page.getByTestId('fallback-add-chat');
  await addBox.locator('select').selectOption({ label: '合成乙 · demo-b' });
  await addBox.getByRole('button', { name: '添加' }).click();
  await page.getByTestId('uses-save').click();
  await page.waitForTimeout(500);

  await page.getByTestId('nav-ask').click();
  await page.getByTestId('ask-input').fill('合成问题');
  await page.getByTestId('ask-run').click();
  await page.waitForFunction(
    () => (document.body.innerText ?? '').includes('来自替补的回答'),
    undefined,
    {
      timeout: 30_000,
    },
  );
  const info = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    const msg = list?.querySelectorAll('article') ?? [];
    const last = msg[msg.length - 1];
    const details = last?.querySelector('.ask-msg-details summary');
    return {
      text: String(last?.textContent ?? '').slice(0, 300),
      label: String(details?.textContent ?? ''),
    };
  });
  log('引擎/模型标签：', info.label);
  log('回答片段：', info.text.replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: '.logs/mp3b-ui-chat.png', fullPage: true });
  log('截图: .logs/mp3b-ui-chat.png');
} finally {
  await app.close().catch(() => undefined);
  s1.close();
  s2.close();
  rmSync(dir, { recursive: true, force: true });
}
