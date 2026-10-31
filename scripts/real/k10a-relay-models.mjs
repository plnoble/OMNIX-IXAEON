/**
 * K10a 真机检查（规格 docs/委派/K10a-调度器面板.md「真机检查」）。
 *
 * 用构建好的应用走一遍：合成 `IXAEON_DATA_DIR` + 合成 `IXAEON_RELAY_DIR`（合成 config 和合成补丁，
 * **不碰用户真实的 relay 目录和 DSH 配置**），进驾驶舱截图卡片；在界面上把开发换一个组合、
 * 整合方换 sonnet，再截图；最后贴出合成补丁和合成 config 改动前后的 diff（只应有那两处）。
 * 打印时临时目录、账户名一律遮成 <本机> / <临时目录>。
 *
 *   node scripts/real/k10a-relay-models.mjs       （先 node scripts/build.mjs）
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// DSH 给工作区打了低完整性标签（IXAEON_ELECTRON_NO_SANDBOX=1）时，Electron 的 TEMP / APPDATA
// 要放在工作区里才写得进（L14 的同一道坎；照 scripts/real/cf0-chat-retry.mjs）。
const work = join(process.cwd(), '.logs', `k10a-real-run-${Date.now()}`);
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');

/** 打印前遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs）。 */
const mask = (value) => {
  let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  for (const p of [
    work,
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    text = text.replaceAll(p, '<临时目录>');
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) text = text.replaceAll(escaped, '<临时目录>');
  }
  return text;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(mask));
}

const dataDir = join(work, 'data');
const relayDir = join(work, 'relay');
const profileDir = join(work, 'profile');
const shots = join(process.cwd(), '.logs', 'k10a-real');
mkdirSync(dataDir, { recursive: true });
mkdirSync(relayDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shots, { recursive: true });
const safeEnv = {
  TEMP: join(work, 'temp'),
  TMP: join(work, 'temp'),
  APPDATA: join(work, 'appdata'),
  LOCALAPPDATA: join(work, 'localappdata'),
};
for (const d of Object.values(safeEnv)) mkdirSync(d, { recursive: true });

const patchPath = join(relayDir, 'synthetic-relay.patch.yml');
const configPath = join(relayDir, 'config.json');

const PATCH = `# 合成补丁（K10a 真机检查；不是用户的 DSH 配置）
- id: sandbox-policy
  config:
    mode: danger-full-access

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gw-a:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: model-a1
            name: model-a1
          - id: model-a2
            name: model-a2
      gw-b:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: model-b1
            name: model-b1
      magpie:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: local-a
            name: local-a
          - id: local-b
            name: local-b

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gw-b
    model: model-b1
`;

const CONFIG = {
  roles: {
    developer: {
      argv: [
        'node',
        'dsh.mjs',
        '--profile',
        'headless',
        '--patch',
        patchPath,
        '--json',
        '{prompt_file}',
      ],
      cwd: work,
    },
    integrator: {
      argv: ['claude.exe', '--restricted', '--tools', 'PowerShell', '-p', '{prompt_file}'],
      cwd: work,
    },
  },
};

writeFileSync(patchPath, PATCH, 'utf8');
writeFileSync(configPath, `${JSON.stringify(CONFIG, null, 2)}\n`, 'utf8');

// 合成「这一棒在跑」：lock 用本脚本自己的 pid（活着），turns/7 的修改时间在 12 分钟前。
const twelveMinAgo = new Date(Date.now() - 12 * 60_000);
writeFileSync(
  join(relayDir, 'lock.json'),
  `${JSON.stringify({ pid: process.pid, startedAt: twelveMinAgo.toISOString() })}\n`,
  'utf8',
);
mkdirSync(join(relayDir, 'turns', '7'), { recursive: true });
writeFileSync(join(relayDir, 'turns', '7', 'prompt.md'), '合成交代文件（不读内容）\n', 'utf8');
utimesSync(join(relayDir, 'turns', '7', 'prompt.md'), twelveMinAgo, twelveMinAgo);
utimesSync(join(relayDir, 'turns', '7'), twelveMinAgo, twelveMinAgo);

const patchBefore = readFileSync(patchPath, 'utf8');
const configBefore = readFileSync(configPath, 'utf8');

/** 真行级 diff（git diff --no-index）；只打印有变化的行，路径遮掉。 */
function diffLines(label, before, after) {
  const a = join(work, `${label}-before.txt`);
  const b = join(work, `${label}-after.txt`);
  writeFileSync(a, before, 'utf8');
  writeFileSync(b, after, 'utf8');
  const r = spawnSync('git', ['diff', '--no-index', '--unified=0', '--', a, b], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const body = (r.stdout ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('diff --git ') && !line.startsWith('index '))
    .join('\n');
  return {
    text: mask(body).trim(),
    added: (r.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    removed: (r.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

let app = null;
let result = '没通过：脚本没跑完';
const log = (...a) => console.log(...a);

try {
  const env = {
    ...process.env,
    ...safeEnv,
    IXAEON_DATA_DIR: dataDir,
    IXAEON_RELAY_DIR: relayDir,
    IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
    IXAEON_EMBED_MODEL: 'none',
    IXAEON_FAKE_MODEL: '1',
    IXAEON_CODEX_EXE: 'none',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${profileDir}`];
  // 接力里的 DSH 给工作区打了低完整性标签，Electron 沙箱起不来（照 scripts/real/cf0-chat-retry.mjs）。
  if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  app = await electron.launch({
    executablePath: join(
      process.cwd(),
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
  await page.waitForLoadState('domcontentloaded');

  // 首次向导（和 scripts/real/p5-unbind-folder.mjs 一样）。
  await page.getByTestId('setup-next-1').waitFor({ timeout: 30_000 });
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('demo-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('K10a 合成项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 30_000 });

  await page.getByTestId('nav-cockpit').click();
  await page.getByTestId('cockpit-relay-models').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);

  const rowText = async (id) =>
    (await page.getByTestId(id).innerText()).replace(/\s+/g, ' ').trim();
  log('开发行（改前）：', await rowText('relay-model-row-developer'));
  log('整合方行（改前）：', await rowText('relay-model-row-integrator'));
  log('审查行（改前）：', await rowText('relay-model-row-reviewer'));
  log('替补行（改前）：', await rowText('relay-model-row-substitutes'));
  log('现在在跑：', (await page.getByTestId('relay-model-running').innerText()).trim());
  log(
    '开发下拉：',
    (await page.getByTestId('relay-model-select-developer').locator('option').allInnerTexts()).join(
      ' | ',
    ),
  );

  const beforeShot = join(shots, 'k10a-1-before.png');
  await page.getByTestId('cockpit-relay-models').screenshot({ path: beforeShot });

  await page.getByTestId('relay-model-select-developer').selectOption('magpie / local-a');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="relay-model-current-developer"]')
        ?.textContent?.includes('magpie / local-a'),
    { timeout: 10_000 },
  );
  await page.getByTestId('relay-model-select-integrator').selectOption('sonnet');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="relay-model-current-integrator"]')
        ?.textContent?.trim() === 'sonnet',
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);

  log('开发行（改后）：', await rowText('relay-model-row-developer'));
  log('整合方行（改后）：', await rowText('relay-model-row-integrator'));
  const afterShot = join(shots, 'k10a-2-after.png');
  await page.getByTestId('cockpit-relay-models').screenshot({ path: afterShot });

  const patchAfter = readFileSync(patchPath, 'utf8');
  const configAfter = readFileSync(configPath, 'utf8');
  const patchDiff = diffLines('patch', patchBefore, patchAfter);
  const configDiff = diffLines('config', configBefore, configAfter);
  log('\nPATCH-DIFF（只应有两行：provider / model）:\n' + (patchDiff.text || '（没有变化）'));
  log('\nCONFIG-DIFF（只应有 --model 那一对）:\n' + (configDiff.text || '（没有变化）'));

  // config 是 JSON 重写：新增一对 --model 时，数组上一项会多一个逗号（diff 里 +3 / -1），
  // 语义上只有这一对；这里按解析后的 argv 判。
  const beforeArgv = JSON.parse(configBefore).roles.integrator.argv;
  const afterArgv = JSON.parse(configAfter).roles.integrator.argv;
  const configOk =
    JSON.stringify(afterArgv) === JSON.stringify([...beforeArgv, '--model', 'sonnet']) &&
    configDiff.added <= 3 &&
    configDiff.removed <= 1;
  const ok = patchDiff.added === 2 && patchDiff.removed === 2 && configOk;
  log(
    `\n改动行数：补丁 +${patchDiff.added} / -${patchDiff.removed}（两行成对 = 2+2），config +${configDiff.added} / -${configDiff.removed}（新增 --model 那一对，含数组上一项的逗号）`,
  );
  log(`截图：${beforeShot}`);
  log(`截图：${afterShot}`);
  copyFileSync(beforeShot, join(process.cwd(), 'docs', '委派', '交付', 'k10a-1-before.png'));
  copyFileSync(afterShot, join(process.cwd(), 'docs', '委派', '交付', 'k10a-2-after.png'));

  result = ok
    ? '通过'
    : `没通过：改动不对（补丁 +${patchDiff.added}/-${patchDiff.removed}，config +${configDiff.added}/-${configDiff.removed}，argv 只应是原来加 --model sonnet）`;
} catch (err) {
  result = `没通过：${err instanceof Error ? err.message : String(err)}`;
} finally {
  if (app) await app.close().catch(() => {});
}
log(`RESULT ${result}`);
process.exit(result === '通过' ? 0 : 1);
