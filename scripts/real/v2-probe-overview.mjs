/**
 * V2 排查探针（本机临时，不入库）：复现 smoke 套件里「总览测试后应用退回
 * 首次设置向导」的现象，逐步 dump 状态定位触发点。
 * 用法：node scripts/real/v2-probe-overview.mjs（依赖先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ixaeon-v2probe-'));
const dataDir = join(root, 'data');
const logs = () => join(dataDir, 'logs');
const tailLogs = () => {
  try {
    const files = readdirSync(logs()).filter((f) => f.endsWith('.log'));
    return files
      .map((f) => readFileSync(join(logs(), f), 'utf8').split('\n').slice(-3).join(' | '))
      .join('\n');
  } catch {
    return '(no logs)';
  }
};

let app = null;
try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const state = async (tag) => {
    const r = await page.evaluate(() => ({
      url: location.hash,
      hasMainNav: !!document.querySelector('[data-testid="main-nav"]'),
      hasWizard: !!document.querySelector('[data-testid="setup-wizard"]'),
      hasStateCard: !!document.querySelector('[data-testid="state-card"]'),
      testids: Array.from(document.querySelectorAll('[data-testid]'))
        .map((e) => e.getAttribute('data-testid'))
        .slice(0, 12),
    }));
    console.log(`[${tag}]`, JSON.stringify(r));
    console.log(`[${tag}] app logs tail:`, tailLogs());
  };

  await state('just-launched');

  // 手动走完设置向导（与 smoke 第 1 条一致：空 key）
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('gpt-5.2');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('探针项目');
  await page.getByTestId('setup-finish').click();
  await page.waitForTimeout(800);
  await state('after-setup');

  await page.getByTestId('nav-overview').click();
  await page.waitForTimeout(800);
  await state('overview-0.8s');

  await page.waitForTimeout(3000);
  await state('overview-3.8s');

  await page.waitForTimeout(6000);
  await state('overview-9.8s');

  await page
    .getByTestId('nav-settings')
    .click()
    .catch((e) => console.log('[nav-settings click] FAILED:', String(e).split('\n')[0]));
  await page.waitForTimeout(800);
  await state('attempt-settings');

  // 服务端点在不在
  try {
    const r = await fetch('http://127.0.0.1:43191/api/mcp/prepare-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'x', project_id: 'y', max_chars: 10 }),
    });
    console.log('[prepare-task] status=', r.status);
  } catch (e) {
    console.log('[prepare-task] fetch error:', e.cause?.code ?? e.name);
  }
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  rmSync(root, { recursive: true, force: true });
}
