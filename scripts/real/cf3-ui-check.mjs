/**
 * CF3 真机检查·甲：假网关 + 真应用，看四样（流式出字 / 「直连 · demo-a」标签 / 用到的记忆 / 停止能停）。
 *
 *   node scripts/real/cf3-ui-check.mjs <假网关端口>
 *
 * 前置：先 `node scripts/real/cf3-fake-gateway.mjs` 起假网关，把它打印的端口传进来。
 * 数据目录用临时目录（IXAEON_DATA_DIR），截图落到 .logs/，全流程合成数据。
 * 不打印本机账户名：临时目录整段遮成 <临时目录>。
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// playwright 装在 apps/desktop 里，从那里解析（根 node_modules 没有）
const { _electron: electron } = createRequire(resolvePath('apps/desktop/package.json'))(
  'playwright',
);

const port = Number(process.argv[2] ?? 0);
if (!port) {
  console.error('用法：node scripts/real/cf3-ui-check.mjs <假网关端口>');
  process.exit(2);
}
const base = `http://127.0.0.1:${String(port)}/v1`;
const dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf3-ui-'));
const mask = (text) => String(text).replaceAll(dir, '<临时目录>');
const log = (...args) => console.log(...args.map(mask));

const app = await electron.launch({
  args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
  env: { ...process.env, IXAEON_DATA_DIR: dir },
});
try {
  const page = await app.firstWindow();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-api-base').fill(base);
  await page.getByTestId('setup-api-key').fill('sk-synthetic');
  await page.getByTestId('setup-model-name').fill('demo-a');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目甲');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });

  // 「聊天模型」也指到同一台假网关（设置页里就是这一项决定聊天走不走直连）
  const saved = await page.evaluate(async (b) => {
    const read = async () => {
      const s = await window.ixaeon.getSettings();
      return s.model ?? s.config?.model ?? {};
    };
    const current = await read();
    await window.ixaeon.saveModelSettings({
      ...current,
      apiBaseUrl: b,
      apiKey: 'sk-synthetic',
      modelName: 'demo-a',
      chatModelName: 'demo-a',
      savedModels: ['demo-a'],
    });
    const after = await read();
    return { mode: after.chatModelName, keys: Object.keys(after).slice(0, 8) };
  }, base);
  log(`设置已保存：chatModelName=${String(saved.mode)} 字段=${saved.keys.join(',')}`);

  // 问一句
  await page.getByTestId('nav-ask').click();
  const box = page.getByTestId('ask-input');
  await box.fill('我的回答风格偏好是什么？');
  await box.press('Enter');

  // 流式：先看到有字出现（不是一次性刷完）
  await page.waitForFunction(
    () => (document.body.innerText ?? '').includes('按记忆里的偏好'),
    undefined,
    { timeout: 30_000 },
  );
  log('流式出字：已看到第一段正文');

  // 等回答收尾，读引擎标签与用到的记忆
  await page.waitForFunction(() => document.body.innerText.includes('引擎'), undefined, {
    timeout: 30_000,
  });
  const details = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.ask-msg-details summary')];
    const summary = nodes.length > 0 ? nodes[nodes.length - 1].textContent : '';
    const all = document.querySelector('.ask-msg')?.textContent ?? '';
    return { summary: String(summary).trim(), tail: String(all).slice(0, 400) };
  });
  log(`引擎标签：${details.summary}`);
  await page.screenshot({ path: '.logs/cf3-ui-answer.png', fullPage: true });
  log('截图：.logs/cf3-ui-answer.png');

  log('回答正文前 120 字：' + details.tail.replace(/\s+/g, ' ').slice(0, 120));
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
