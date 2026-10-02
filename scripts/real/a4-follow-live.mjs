/**
 * A4 真机检查：真 Hermes 引擎 + 构建好的桌面应用 + 临时数据目录。
 *
 * 发一个要求分段长回答的合成问题，发问后立刻切到「项目」页再切回「对话」，
 * 按 id 在列表里点开这个对话，观察并输出：
 *   1. 切回来时仍在转圈（跟进态「正在回答…」，无阶段无秒数）；
 *   2. 分段在出现（Hermes 逐段写库，2s 轮询追进气泡：两帧采样文本长度增长）；
 *   3. 答完自动换成最终回答（不再转圈，气泡正文与库里一致）。
 *
 * 只用合成问题与临时库，不碰用户数据；输出只含长度与开头一小段，不含完整内容。
 * 从 apps/desktop 目录运行（@playwright/test 装在 apps/desktop）：
 *   cd apps/desktop && node ../../scripts/real/a4-follow-live.mjs
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const desktopApp = join(root, 'apps', 'desktop');
// @playwright/test 装在 apps/desktop/node_modules，从这里解析
const localRequire = createRequire(join(desktopApp, 'package.json'));
const { _electron: electron } = localRequire('@playwright/test');

function desktopDir() {
  if (existsSync(join(desktopApp, 'out', 'main', 'index.js'))) {
    return desktopApp;
  }
  throw new Error('找不到 out/main/index.js（请先 build）');
}

const dataDir = mkdtempSync(join(tmpdir(), 'ixa-a4-real-'));
console.log('DATA_DIR', dataDir);

let app = null;
let page;
try {
  app = await electron.launch({
    args: [join(desktopDir(), 'out', 'main', 'index.js')],
    env: { ...process.env, IXAEON_DATA_DIR: dataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 160)));

  // 首次设置向导
  await page.getByTestId('setup-next-1').click();
  // 填本机 Hermes 网关「default」组里有可用通道的模型名（CLI 直连默认模型，
  // gemini-3.7-flash-tiered）；乱填模型名会让网关报 503 No available channel。
  await page.getByTestId('setup-model-name').fill('gemini-3.7-flash-tiered');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('A4 真机项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 30_000 });
  console.log('SETUP', '完成');

  // 发一个要求多段的合成问题（回答长一些，分段窗口才够切走切回）
  await page.getByTestId('nav-ask').click();
  await page
    .getByTestId('ask-input')
    .fill(
      '请分四段介绍析衍（IXAEON）这款应用：记忆导入与提炼、项目问答与引用、研究发现的判定、编码任务的派发。每段至少写三句话，段落之间留空行。',
    );
  await page.getByTestId('ask-run').click();
  await page.getByTestId('message-list').getByText('正在').first().waitFor({ timeout: 15_000 });
  console.log('ASKED', '正在回答');

  // 立刻切走再切回
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('page-projects').waitFor({ timeout: 15_000 });
  await page.getByTestId('nav-ask').click();
  await page.getByTestId('page-ask').waitFor({ timeout: 15_000 });

  // 按 id 点开刚提问的对话（不依赖页面自动选中）
  const convId = await page.evaluate(async () => {
    const convs = await window.ixaeon.listConversations();
    return convs[0]?.id ?? '';
  });
  console.log('CONV_ID', convId);
  await page.locator(`[data-testid="conversation-item"][data-conversation-id="${convId}"]`).click();

  // 1) 切回来时仍在转圈（跟进态）
  const spinner = async () =>
    page
      .locator('[data-testid="loading"]')
      .isVisible()
      .catch(() => false);
  const spLabel = async () =>
    page
      .locator('[data-testid="loading"]')
      .innerText()
      .catch(() => '');
  const bubbleLen = async () =>
    page.evaluate(() => {
      const pre = document.querySelector('[data-testid="ask-answer"] pre.answer-text');
      return pre ? pre.innerText.length : 0;
    });
  let sawSpinner = false;
  let label = '';
  for (let i = 0; i < 10 && !sawSpinner; i++) {
    if (await spinner()) {
      sawSpinner = true;
      label = await spLabel();
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log('SPINNER_ON_RETURN', sawSpinner ? `是（标签：${label}）` : '否（回答已结束）');

  // 2) 分段在出现：仍转圈时按 1.5s 一帧采样（Hermes 冷启动组装要 5–9 秒，
  // 流式窗口可能靠后，最多采 40 秒），后一帧比前一帧长即分段在出现
  const samples = [];
  for (let i = 0; i < 27; i++) {
    samples.push(await bubbleLen());
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await spinner())) break;
  }
  const grew = samples.length >= 2 && samples[samples.length - 1] > samples[0];
  console.log('BUBBLE_LENS', samples.join(','), 'GROWING', grew ? '是（分段在出现）' : '否');

  // 3) 答完自动换成最终回答：不再转圈、气泡正文与库里一致
  await page.locator('[data-testid="loading"]').waitFor({ state: 'detached', timeout: 120_000 });
  const check = await page.evaluate(async () => {
    const convs = await window.ixaeon.listConversations();
    const data = await window.ixaeon.getConversation(convs[0].id);
    const last = data.messages[data.messages.length - 1];
    const ui = document.querySelector('[data-testid="ask-answer"] pre.answer-text');
    return {
      dbStatus: last.status,
      dbLen: last.content.length,
      uiText: ui ? ui.innerText : null,
      dbText: last.content,
      head: last.content.slice(0, 60),
      errorMessage: last.errorMessage ?? '',
      notice: typeof last.meta?.notice === 'string' ? last.meta.notice.slice(0, 300) : '',
      steps: Array.isArray(last.meta?.steps)
        ? last.meta.steps.map((s) => `${s.round}:${s.tool}:${s.ok ? 'ok' : 'FAIL'}`).join('|')
        : '',
    };
  });
  console.log(
    'FINAL',
    JSON.stringify({
      dbStatus: check.dbStatus,
      dbLen: check.dbLen,
      uiMatchesDb: check.uiText !== null && check.uiText === check.dbText,
      head: check.head,
      errorMessage: check.errorMessage,
      notice: check.notice,
      steps: check.steps,
    }),
  );
  console.log(
    'FINAL_OK',
    check.dbStatus === 'complete' &&
      check.uiText !== null &&
      check.uiText === check.dbText &&
      check.dbLen > 200
      ? '是（答完自动显示，气泡正文与库逐字一致）'
      : '否',
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟，残留目录无碍 */
  }
}
