/**
 * CF3c 真机检查·甲：临时数据目录 + 真应用，两段。
 *
 *   A) 什么模型都不配（只填模型名，不填地址/Key）：问一句 → 看到「请到「模型」页…」的提示；hermes 进程数 0。
 *   B) 起假网关（scripts/real/cf3-fake-gateway.mjs）、配一家供应商、聊天模型留空：
 *      问一句 → 走直连，标签是后台分析的模型。
 *
 *   node scripts/real/cf3c-real-check.mjs
 *
 * 数据目录用临时目录，截图落 .logs/；临时目录整段遮成 <临时目录>；只打印合成的名字。
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const { _electron: electron } = createRequire(resolvePath('apps/desktop/package.json'))(
  'playwright',
);
const desktopMain = resolvePath('apps/desktop/out/main/index.js');

const mask = (dir, text) => String(text).replaceAll(dir, '<临时目录>');
function hermesProcessCount() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq hermes*', '/NH'], {
        encoding: 'utf8',
      });
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^hermes/i.test(l)).length;
    }
    const out = execFileSync('ps', ['-eo', 'comm'], { encoding: 'utf8' });
    return out.split('\n').filter((l) => /hermes/i.test(l)).length;
  } catch {
    return -1;
  }
}

async function launch(dir, extraEnv = {}) {
  const app = await electron.launch({
    args: [desktopMain, `--user-data-dir=${join(dir, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dir,
      HERMES_HOME: '',
      IXAEON_HERMES_HOME: '',
      IXAEON_HERMES_EXE: '',
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function setupApp(page, { base, key, model }) {
  await page.getByTestId('setup-next-1').click();
  if (base) await page.getByTestId('setup-api-base').fill(base);
  if (key) await page.getByTestId('setup-api-key').fill(key);
  await page.getByTestId('setup-model-name').fill(model);
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ state: 'visible', timeout: 30_000 });
}

// ---- A) 什么模型都不配 ----
{
  const dir = mkdtempSync(join(tmpdir(), 'ixa-cf3c-a-'));
  const log = (...a) => console.log(...a.map((x) => mask(dir, x)));
  log('【甲-A】临时数据目录：' + dir);
  const { app, page } = await launch(dir);
  try {
    await setupApp(page, { base: '', key: '', model: 'demo-a' });
    const before = hermesProcessCount();
    log(`提问前 hermes 进程数：${String(before)}`);
    await page.getByTestId('nav-ask').click();
    const box = page.getByTestId('ask-input');
    await box.fill('没配模型也问一句');
    await box.press('Enter');
    await page.waitForFunction(
      () => (document.body.innerText ?? '').includes('模型」页'),
      undefined,
      { timeout: 30_000 },
    );
    const hint = await page.evaluate(() => {
      const t = document.body.innerText ?? '';
      const i = t.indexOf('IXA0010');
      return i >= 0 ? t.slice(i, i + 90) : t.slice(0, 90);
    });
    log('看到的提示：' + hint.replace(/\s+/g, ' '));
    log(`提问后 hermes 进程数：${String(hermesProcessCount())}`);
    await page.screenshot({ path: join('.logs', 'cf3c-real-a.png'), fullPage: true });
    log('截图：.logs/cf3c-real-a.png');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- B) 假网关 + 聊天留空 ----
{
  const dir = mkdtempSync(join(tmpdir(), 'ixa-cf3c-b-'));
  const log = (...a) => console.log(...a.map((x) => mask(dir, x)));
  log('【甲-B】临时数据目录：' + dir);
  const gw = spawn(process.execPath, [resolvePath('scripts/real/cf3-fake-gateway.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('假网关没起来')), 15_000);
    gw.stdout.on('data', (d) => {
      buf += String(d);
      const m = /PORT=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${String(port)}/v1`;
  log('假网关就绪（端口 ' + String(port) + '）');
  const { app, page } = await launch(dir);
  try {
    await setupApp(page, { base, key: 'sk-synthetic', model: 'demo-a' });
    // 聊天模型留空：跟着后台分析
    await page.evaluate(async (b) => {
      const s = await window.ixaeon.getSettings();
      const current = s.model ?? s.config?.model ?? {};
      await window.ixaeon.saveModelSettings({
        ...current,
        apiBaseUrl: b,
        apiKey: 'sk-synthetic',
        modelName: 'demo-a',
        chatModelName: '',
        savedModels: ['demo-a'],
      });
    }, base);
    await page.getByTestId('nav-ask').click();
    const box = page.getByTestId('ask-input');
    await box.fill('我的回答风格偏好是什么？');
    await box.press('Enter');
    await page.waitForFunction(() => (document.body.innerText ?? '').includes('引擎'), undefined, {
      timeout: 40_000,
    });
    const details = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.ask-msg-details summary')];
      const last = nodes.at(-1);
      return { summary: String(last?.textContent ?? '').trim() };
    });
    log('引擎标签：' + details.summary);
    await page.screenshot({ path: join('.logs', 'cf3c-real-b.png'), fullPage: true });
    log('截图：.logs/cf3c-real-b.png');
  } finally {
    await app.close().catch(() => undefined);
    gw.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
