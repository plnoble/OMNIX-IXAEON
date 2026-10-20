/**
 * S3b 真机检查（合成数据）：临时数据目录启动应用，对合成的会话文件夹走一遍
 * 列出 → 勾选 → 估算 → 导入，并确认资料页出现新来源。
 * 文件夹选择用主进程的 IXAEON_TEST_DIALOG_RESPONSES 测试钩子（只在环境变量存在时生效）。
 * 截图落到 apps/desktop/release/screenshots/。
 * 没有选用户真实的会话文件夹；会话内容全是合成的。
 *   node scripts/real/s3b-agent-sessions-ui.ts
 *   （本机没有 node_modules/.bin/jiti 的话，用 `node node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti-cli.mjs scripts/real/s3b-agent-sessions-ui.ts`）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
const maskOut = (v: unknown): string => {
  let text: string;
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
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => orig(...a.map(maskOut));
}

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(root, 'apps', 'desktop');
const pw = require(require.resolve('@playwright/test', { paths: [desktopDir] }));
const electron = pw._electron;
if (!electron) {
  throw new Error('no _electron: ' + Object.keys(pw).slice(0, 30).join(','));
}
const shotDir = join(desktopDir, 'release', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-s3b-real-'));
const sessionDir = join(dataDir, 'sessions');
mkdirSync(sessionDir, { recursive: true });
const seg = (type: 'user' | 'assistant', content: unknown) =>
  JSON.stringify({
    sessionId: '11111111-2222-4333-8444-999999999999',
    cwd: 'D:/work/s3b-demo',
    isSidechain: false,
    type,
    timestamp: '2026-09-20T01:00:01.000Z',
    message: { role: type, content },
  });
writeFileSync(
  join(sessionDir, 'cc.jsonl'),
  `${seg('user', 'S3b 合成任务：把会话选择导入做好')}\n${seg('assistant', [
    { type: 'text', text: 'S3b 合成回答。' },
  ])}`,
  'utf8',
);
const scriptPath = join(dataDir, 'model-script.json');
writeFileSync(scriptPath, JSON.stringify({ structured: [] }), 'utf8');

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  // 照现在的规矩隔离：随机端口、不载嵌入模型、不碰真 Codex / 真 Hermes
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_FAKE_MODEL: '1',
  IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
  IXAEON_TEST_DIALOG_RESPONSES: `directory|${sessionDir}`,
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
};

// 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell 与门禁都带），Electron 会当普通 node
// 跑、主进程里 app 是 undefined、Playwright 报「Process failed to launch!」。照 p8 的写法清掉。
delete env.ELECTRON_RUN_AS_NODE;

async function launch() {
  const app = await electron.launch({
    args: [
      join(desktopDir, 'out', 'main', 'index.js'),
      `--user-data-dir=${join(dataDir, 'profile')}`,
    ],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

let passed = true;
let firstFail = '';
const fail = (why: string): void => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
// 出错也要有 RESULT 行、退出码非零（照 p5/p7 的规矩）
const crash = (err: unknown): void => {
  console.log('脚本出错：', err);
  console.log('RESULT 没通过：脚本出错：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const run = await launch();
try {
  await run.page.getByTestId('setup-next-1').click();
  await run.page.getByTestId('setup-model-name').fill('fake-model');
  await run.page.getByTestId('setup-next-2').click();
  await run.page.getByTestId('setup-project-name').fill('S3b 合成项目');
  await run.page.getByTestId('setup-finish').click();
  await run.page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

  await run.page.getByTestId('nav-sources').click();
  await run.page.getByTestId('sources-import-agent-sessions').click();
  await run.page.getByTestId('agent-sessions-list').waitFor({ timeout: 10_000 });
  const rows = await run.page.getByTestId('agent-sessions-list').innerText();
  console.log('LIST');
  console.log(rows);
  if (rows.trim().length === 0)
    fail('会话清单是空的（期望 LIST 里列出合成的 cc.jsonl 这一个会话）');

  await run.page.getByTestId('agent-sessions-select-new').click();
  await run.page
    .getByTestId('agent-sessions-estimate')
    .waitFor({ timeout: 10_000, state: 'visible' });
  await run.page.waitForTimeout(300);
  const estimate = await run.page.getByTestId('agent-sessions-estimate').innerText();
  console.log('ESTIMATE');
  console.log(estimate);
  // 合成的会话是「S3b 合成任务：把会话选择导入做好」+「S3b 合成回答。」，不到一万字，
  // 所以估算该是「约 0 万字（你说的 0 万、AI 回答 0 万）」——整句对，错误提示满足不了这一条。
  const est = estimate.replace(/\s+/g, '');
  if (!est.includes('将发给模型分析')) fail(`估算那一步不是估算结果：${estimate.slice(0, 80)}`);
  else if (!est.includes('约0万字') || !est.includes('你说的0万') || !est.includes('AI回答0万'))
    fail(`估算的数不对（期望 约 0 万字 / 你说的 0 万 / AI 回答 0 万）：${estimate}`);
  else console.log('估算与合成会话的字数一致（0 万，共识别的显示为 0）');
  await run.page.screenshot({ path: join(shotDir, 's3b-agent-list.png'), fullPage: true });

  await run.page.getByTestId('agent-sessions-import').click();
  await run.page
    .getByTestId('agent-sessions-result')
    .waitFor({ timeout: 20_000, state: 'visible' });
  const result = await run.page.getByTestId('agent-sessions-result').innerText();
  console.log('RESULT_IMPORT');
  console.log(result);
  // 只有一行合成会话：该是「新导入 1 个、没变化 0 个、失败 0 个」——三个数都核对，
  // 只查「非空」的话「导入失败」那类提示也会过。
  const imp = result.replace(/\s+/g, '');
  if (!imp.includes('新导入1个') || !imp.includes('没变化0个') || !imp.includes('失败0个'))
    fail(`导入结果不对（期望 新导入 1 个、没变化 0 个、失败 0 个）：${result}`);
  else console.log('导入结果与合成会话一致：新导入 1、没变化 0、失败 0');
  await run.page.waitForTimeout(1500);
  const sourceRow = run.page.locator('[data-testid^="source-row-"]').first();
  const sourceVisible = await sourceRow.count();
  const sourceText = sourceVisible ? await sourceRow.innerText() : '';
  console.log('SOURCE_ROW', sourceVisible);
  console.log(sourceText);
  if (sourceVisible < 1) fail(`资料页没有新来源（期望 SOURCE_ROW ≥ 1，实际 ${sourceVisible}）`);
  // 那一行要真的是这条合成会话：标题就是合成的那句
  else if (!sourceText.includes('S3b 合成任务：把会话选择导入做好'))
    fail(`资料页那行不是导入的合成会话：${sourceText.replace(/\s+/g, ' ').slice(0, 120)}`);
  else console.log('资料页那行就是导入的合成会话（标题对得上）');
  await run.page.screenshot({ path: join(shotDir, 's3b-after-import.png'), fullPage: true });
} catch (err) {
  console.log('脚本出错：', err);
  passed = false;
  firstFail = `脚本出错：${err instanceof Error ? err.message : String(err)}`;
} finally {
  await run.app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log('done');
console.log(
  'RESULT',
  passed ? '通过：列出、估算、导入三步都有输出，资料页出现 1 行新来源' : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
