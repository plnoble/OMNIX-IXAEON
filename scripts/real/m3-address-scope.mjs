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

/** 逐条对照，只有全都符合才写「通过」；出错非零（照 p5/p7 的规矩）。 */
let passed = true;
const fail = (why) => {
  passed = false;
  console.log('不符：', why);
};

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
  // 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell 与门禁都带），Electron 会当普通
  // node 跑、主进程里 app 是 undefined、Playwright 报「Process failed to launch!」。
  // 照 scripts/real/p8-delete-project.mjs 清掉。
  // 照现在的规矩隔离：随机端口（不和用户开着的应用撞）、不载嵌入模型、不碰真 Codex / 真 Hermes。
  // 这里**不能**设 IXAEON_FAKE_MODEL：M3 量的是「地址甲收到合成 Key、换地址后新地址收不到旧 Key」，
  // 得让应用真的按设置里的地址去取模型，替身模型会把这条测没了。
  const env = {
    ...process.env,
    IXAEON_DATA_DIR: dataDir,
    IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
    IXAEON_EMBED_MODEL: 'none',
    IXAEON_CODEX_EXE: 'none',
    IXAEON_HERMES_EXE: '',
    IXAEON_HERMES_HOME: '',
    HERMES_HOME: '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [
      join(desktopApp, 'out', 'main', 'index.js'),
      `--user-data-dir=${join(dataDir, 'profile')}`,
    ],
    env,
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
  const aGotKey = a.auths.length > 0 && a.auths.every((h) => h === `Bearer ${TEST_KEY}`);
  if (!aGotKey) fail(`地址甲没按预期收到合成的那个 Key（收到 ${a.auths.length} 条）`);

  // 2) 地址改成乙、Key 留空、保存：界面「未配置」+ 提示
  await page.getByTestId('settings-api-base').fill(b.base);
  await page.getByTestId('settings-api-key').fill('');
  await page.getByTestId('settings-model-save').click();
  await page.getByTestId('settings-apikey-cleared').waitFor({ timeout: 15_000 });
  const cardText = await page.getByTestId('settings-model').innerText();
  const keyShowsUnset = cardText.includes('未配置');
  if (!keyShowsUnset) fail('换了地址、Key 留空保存之后，设置页没显示「未配置」');
  console.log('B_KEY_STATUS', keyShowsUnset ? '未配置（提示已显示）' : '异常');
  console.log('B_HINT', await page.getByTestId('settings-apikey-cleared').innerText());

  // 3) Key 留空检测：乙没收到带旧 Key 的请求（主进程照「还没有保存过 API Key」拒绝）
  await page.getByTestId('settings-fetch-models').click();
  await page.getByTestId('error-banner').waitFor({ timeout: 20_000 });
  console.log('B_AUTHS', JSON.stringify(b.auths));
  const sawOldKey = b.auths.includes(`Bearer ${TEST_KEY}`);
  if (sawOldKey) fail('新地址收到了旧地址的 Key（不该发生）');
  console.log('B_SAW_OLD_KEY', sawOldKey ? '是（不该发生）' : '否');
} catch (err) {
  passed = false;
  console.log('脚本出错：', err instanceof Error ? err.message : String(err));
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
console.log(
  'RESULT',
  passed
    ? '通过：地址甲收到合成 Key → 换地址留空后设置页显示「未配置」 → 新地址没收到旧 Key'
    : '没通过：上面有不符或脚本出错的那条',
);
process.exit(passed ? 0 : 1);
