/**
 * M3 真机检查：两个本地假上游（不同端口，各自记下收到的 Authorization），
 * 用构建好的应用走一遍「换地址 → Key 被清 → 新地址收不到旧 Key」。
 * 全部合成数据，输出只含地址与请求计数（Key 是合成的）。
 *
 *   node scripts/real/m3-address-scope.mjs
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
const localRequire = createRequire(join(desktopApp, 'package.json'));
const { _electron: electron } = localRequire('@playwright/test');

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-m3-real-'));
const TEST_KEY = 'sk-m3-synthetic';

function startUpstream(name) {
  const auths = [];
  const server = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ''));
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: `${name}-model-a` }, { id: `${name}-model-b` }] }));
      return;
    }
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}/v1`, auths });
    });
  });
}

const a = await startUpstream('甲');
const b = await startUpstream('乙');
console.log('UPSTREAM_A', a.base, 'UPSTREAM_B', b.base);

let app = null;
try {
  app = await electron.launch({
    args: [join(desktopApp, 'out', 'main', 'index.js')],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // 首次向导
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('m');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('M3 真机项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-model').waitFor({ timeout: 20_000 });

  // 1) 地址甲 + Key 保存、检测：甲收到这个 Key
  await page.getByTestId('settings-api-base').fill(a.base);
  await page.getByTestId('settings-api-key').fill(TEST_KEY);
  await page.getByTestId('settings-model-save').click();
  await page.locator('.ok-banner').waitFor({ timeout: 15_000 });
  await page.getByTestId('settings-fetch-models').click();
  await page.getByTestId('settings-model-checklist').waitFor({ timeout: 20_000 });
  console.log('A_AUTHS', JSON.stringify(a.auths));

  // 2) 地址改成乙、Key 留空、保存：界面「未配置」+ 提示
  await page.getByTestId('settings-api-base').fill(b.base);
  await page.getByTestId('settings-api-key').fill('');
  await page.getByTestId('settings-model-save').click();
  await page.getByTestId('settings-apikey-cleared').waitFor({ timeout: 15_000 });
  const cardText = await page.getByTestId('settings-model').innerText();
  console.log('B_KEY_STATUS', cardText.includes('未配置') ? '未配置（提示已显示）' : '异常');
  console.log('B_HINT', await page.getByTestId('settings-apikey-cleared').innerText());

  // 3) Key 留空检测：乙没收到带旧 Key 的请求（主进程照「还没有保存过 API Key」拒绝）
  await page.getByTestId('settings-fetch-models').click();
  await page.getByTestId('error-banner').waitFor({ timeout: 20_000 });
  console.log('B_AUTHS', JSON.stringify(b.auths));
  console.log('B_SAW_OLD_KEY', b.auths.includes(`Bearer ${TEST_KEY}`) ? '是（不该发生）' : '否');
} finally {
  if (app) await app.close().catch(() => undefined);
  a.server.close();
  b.server.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
}
