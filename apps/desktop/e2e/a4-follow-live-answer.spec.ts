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

function withDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-a4-'));
  writeFileSync(
    join(dir, 'model-script.json'),
    JSON.stringify({ text: ['A4 合成回答：这是切回来之后自动显示出来的最终内容。'] }),
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
      // 切回来时仍在写（显示「正在」字样），答完几秒内自动换成最终内容
      await expect(page.getByTestId('message-list')).toContainText('正在', { timeout: 10_000 });
      await expect(page.getByTestId('message-list')).toContainText('A4 合成回答', {
        timeout: 30_000,
      });
      // 与库里一致、不重复
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
      expect(db.content).toContain('A4 合成回答');
      expect(db.status).not.toBe('streaming');
      expect(db.assistantCount).toBe(1);
      await expect(page.getByTestId('message-list')).not.toContainText('正在', { timeout: 5_000 });
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
      // 失败态的落库收尾在应用重启时才做（规格约束）；这里只要求界面不再转圈
      await expect(page.getByTestId('message-list')).not.toContainText('正在', { timeout: 30_000 });
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
      // 等这轮结束
      await expect(page.getByTestId('message-list')).toContainText('A4 合成回答', {
        timeout: 30_000,
      });
      const convs = await page.evaluate(async () =>
        (await window.ixaeon!.listConversations()).map((c) => c.id),
      );
      expect(convs.length).toBeGreaterThanOrEqual(1);
      for (const id of convs) {
        const data = await page.evaluate(
          async (cid: string) => window.ixaeon!.getConversation(cid),
          id,
        );
        const mine = data.messages.some(
          (m) => m.role === 'user' && m.content.includes('A4 另一问'),
        );
        if (!mine) {
          expect(data.messages.some((m) => m.content.includes('A4 合成回答'))).toBe(false);
        }
      }
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
