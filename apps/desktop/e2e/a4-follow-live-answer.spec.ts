/**
 * A4 验收（规格 docs/委派/A4-切回来接着看还在写的回答.md 条件 1–4；条件 5 由现有聊天套件照过）。
 * 用假模型 + 测试延迟把「回答中」窗口拉长几秒：发问后立刻切走再切回来，断言页面接着跟上、答完自动显示。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 从 cwd 往上找 desktop 应用目录（照 smoke.spec.ts 的 findDesktopDir）。 */
function desktopDir(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js（请先 build）');
    dir = parent;
  }
}

async function launch(
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(desktopDir(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      // 本机的 Hermes 安装别干扰假模型路径：清掉探测环境变量，只留 IXAEON_FAKE_MODEL
      HERMES_HOME: '',
      IXAEON_HERMES_HOME: '',
      IXAEON_HERMES_EXE: '',
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`));
  return { app, page };
}

async function setupOnce(page: Page): Promise<void> {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('fake-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('A4 项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
}

const DELAY = '4500';

const ANSWER_TEXT = 'A4 合成回答：这是切回来之后自动显示出来的最终内容。';

/** 列表里点开指定对话（data-conversation-id，不靠列表顺序和页面自动选中）。 */
async function clickConversation(page: Page, id: string): Promise<void> {
  await page
    .locator(`[data-testid="conversation-item"][data-conversation-id="${id}"]`)
    .click();
}

/** 当前数据目录里唯一（或首个）对话的 id（刚发问时对话刚建，轮询等到列表里有它）。 */
async function firstConversationId(page: Page): Promise<string> {
  const read = () =>
    page.evaluate(async () => (await window.ixaeon!.listConversations())[0]?.id ?? '');
  await expect.poll(read, { timeout: 15_000 }).not.toBe('');
  return (await read())!;
}

function withDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-a4-'));
  // core-bounded 工具循环（CI 上没有 Hermes 走这条路）：每问消耗
  // answer(1) + 回答后的记忆提取(1)；照 d6 的脚本形状，备足两问的量。
  writeFileSync(
    join(dir, 'model-script.json'),
    JSON.stringify({
      structured: [
        { tool: 'answer', args: { text: ANSWER_TEXT } },
        { items: [] },
        { tool: 'answer', args: { text: ANSWER_TEXT } },
        { items: [] },
      ],
    }),
  );
  return dir;
}

test.describe('A4：切回来接着看还在写的回答', () => {
  test('条件 1/2：发问后切走再切回，答完自动显示最终内容，与库里一致、不重复', async () => {
    const dataDir = withDataDir();
    const { app, page } = await launch({
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: join(dataDir, 'model-script.json'),
      IXAEON_TEST_MODEL_DELAY_MS: DELAY,
    });
    try {
      await setupOnce(page);
      await page.getByTestId('nav-ask').click();
      await page.getByTestId('ask-input').fill('A4 问一句');
      await page.getByTestId('ask-run').click();
      await expect(page.getByTestId('message-list')).toContainText('正在', { timeout: 10_000 });
      // 切走再切回（轮次仍在写）
      await page.getByTestId('nav-projects').click();
      await expect(page.getByTestId('page-projects')).toBeVisible();
      await page.getByTestId('nav-ask').click();
      await expect(page.getByTestId('page-ask')).toBeVisible();
      // 切回对话页不自动选对话（App 把 openConversationId 置空，显示空状态引导）；
      // 照用户实际操作：按 id 在列表里点开刚提问的这个对话，不靠页面自动选中
      await clickConversation(page, await firstConversationId(page));
      // 切回来时仍在写（跟进态显示「正在回答…」，无阶段无秒数）
      await expect(page.getByTestId('message-list')).toContainText('正在回答…', {
        timeout: 10_000,
      });
      // 条件 2：切回来之后到来的分段照常出现在气泡里（轮询周期 2s 内从库里同步）
      await expect(page.getByTestId('message-list')).toContainText(ANSWER_TEXT, {
        timeout: 30_000,
      });
      // 答完几秒内自动显示最终内容（不再转圈）
      await expect(page.getByTestId('message-list')).not.toContainText('正在', { timeout: 5_000 });
      // 与库里一致（精确相等）、不重复（恰好一条 assistant 消息）
      const db = await page.evaluate(async () => {
        const convs = await window.ixaeon!.listConversations();
        const data = await window.ixaeon!.getConversation(convs[0]!.id);
        const last = data.messages[data.messages.length - 1]!;
        return {
          content: last.content,
          status: last.status,
          assistantCount: data.messages.filter((m) => m.role === 'assistant').length,
        };
      });
      expect(db.status).toBe('complete');
      expect(db.assistantCount).toBe(1);
      // 界面气泡包含库里的完整正文（不重复断言：正文恰好出现一次）
      const uiText = await page.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="message-list"]')?.innerText ?? '',
      );
      expect(uiText).toContain(ANSWER_TEXT);
      expect(uiText.split(ANSWER_TEXT).length - 1).toBe(1);
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('条件 3：失败告终的轮，切回来的页面显示错误、不再转圈', async () => {
    const dataDir = withDataDir();
    const { app, page } = await launch({
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_MODEL_DELAY_MS: DELAY,
    });
    try {
      await setupOnce(page);
      await page.getByTestId('nav-ask').click();
      await page.getByTestId('ask-input').fill('会失败的提问');
      await page.getByTestId('ask-run').click();
      await page.getByTestId('nav-projects').click();
      await expect(page.getByTestId('page-projects')).toBeVisible();
      await page.getByTestId('nav-ask').click();
      await expect(page.getByTestId('page-ask')).toBeVisible();
      // 照用户实际操作：按 id 在列表里点开刚提问的这个对话
      await clickConversation(page, await firstConversationId(page));
      // 条件 3：切回来的页面在结束后显示失败和错误信息（不再转圈）。
      // 跟进页靠 2s 轮询同步库状态：失败收尾落库后，下个周期界面换成失败态
      await expect(page.getByTestId('message-list')).toContainText('失败', { timeout: 30_000 });
      await expect(page.getByTestId('message-list')).not.toContainText('正在回答', {
        timeout: 10_000,
      });
      // 库里那条消息收尾为 failed（失败收尾有异步重试，轮询等待）
      await expect
        .poll(
          async () => {
            const st = await page.evaluate(async () => {
              const convs = await window.ixaeon!.listConversations();
              const data = await window.ixaeon!.getConversation(convs[0]!.id);
              return data.messages[data.messages.length - 1]!.status;
            });
            return st;
          },
          { timeout: 30_000 },
        )
        .toBe('failed');
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('条件 4：这一轮的分段不串进别的对话', async () => {
    const dataDir = withDataDir();
    const { app, page } = await launch({
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: join(dataDir, 'model-script.json'),
      IXAEON_TEST_MODEL_DELAY_MS: DELAY,
    });
    try {
      await setupOnce(page);
      await page.getByTestId('nav-ask').click();
      await page.getByTestId('ask-input').fill('A4 另一问');
      await page.getByTestId('ask-run').click();
      await expect(page.getByTestId('message-list')).toContainText('正在', { timeout: 10_000 });
      // 条件 4：这轮的分段不串进别的对话。
      // 先记下原对话的 id（发问刚建，列表轮询等到它出现），切走再切回、点开它、等这轮结束
      const origId = await firstConversationId(page);
      await page.getByTestId('nav-projects').click();
      await page.getByTestId('nav-ask').click();
      await clickConversation(page, origId);
      await expect(page.getByTestId('message-list')).toContainText(ANSWER_TEXT, {
        timeout: 30_000,
      });
      // 原轮结束后建新对话并打开
      await page.getByTestId('conversation-new').click();
      await expect(page.locator('[data-testid="conversation-item"]')).toHaveCount(2, {
        timeout: 15_000,
      });
      // 新对话的 id：列表里不是原对话的那一个（列表按 updated_at 排序，不靠位置猜）
      const newId = await page.evaluate(async (orig) => {
        const convs = await window.ixaeon!.listConversations();
        return convs.map((c) => c.id).find((id) => id !== orig);
      }, origId);
      if (!newId) throw new Error('没找到新对话');
      // 新对话是空的：没有本轮的分段、没有本轮的回答、没有转圈
      await expect(page.getByTestId('message-list')).not.toContainText(ANSWER_TEXT, {
        timeout: 10_000,
      });
      await expect(page.getByTestId('message-list')).not.toContainText('A4 另一问');
      await expect(page.getByTestId('message-list')).not.toContainText('正在');
      // 再切回原对话：内容完好（回答在那里、只有一条）
      await clickConversation(page, origId);
      await expect(page.getByTestId('message-list')).toContainText(ANSWER_TEXT, {
        timeout: 15_000,
      });
      // 再切到新对话：仍然干净（界面级隔离，切来切去不串）
      await clickConversation(page, newId);
      await expect(page.getByTestId('message-list')).not.toContainText(ANSWER_TEXT);
      await expect(page.getByTestId('message-list')).not.toContainText('A4 另一问');
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
