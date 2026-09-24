/**
 * 真机检查（G06，规格 docs/委派/G06-对话的项目固定.md）：
 * 用临时数据目录（IXAEON_DATA_DIR）启动真实 Electron，照全局审核的复现步骤点一遍：
 *   1. 建 A、B 两个合成项目；
 *   2. 在 A 下开一个对话（发一句合成的话，让对话有消息）；
 *   3. 下拉框切到 B；
 *   4. 再打开 A 的那个对话；
 *   5. 确认下拉框回到 A、不可选，旁边有「换项目请开新对话」。
 *
 *   node_modules/.bin/playwright test -c e2e/playwright.config.ts scripts/real/g06-project-pin.spec.ts
 *
 * 全程合成数据、临时目录，不碰用户的数据目录；用户 app 占着 43191 端口时脚本先如实失败。
 *
 * （scripts/real 不在 apps/desktop 的包范围里，playwright 从桌面应用的依赖里相对引入。）
 */
import pw from '../../apps/desktop/node_modules/@playwright/test/index.js';
import type { ElectronApplication, Expect, TestType } from '@playwright/test';

interface PlaywrightBundle {
  test: TestType;
  expect: Expect;
  _electron: {
    launch(opts: { args: string[]; env: Record<string, string> }): Promise<ElectronApplication>;
  };
}
const { test, expect, _electron: electron } = pw as unknown as PlaywrightBundle;
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('G06 复现：切到 B 后打开 A 的旧对话，下拉框回到 A 且锁定', async () => {
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(occupied, '不要碰正在跑的服务').toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ixa-g06-real-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  });
  try {
    const page = await app.firstWindow();
    // 引导：合成模型名 + 一个合成项目（这个项目只用来完成引导，不算 A/B）
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('引导项目');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();

    // 建 A、B 两个合成项目（直接走 IPC，界面建项目不在本检查范围内）
    const { projectA, projectB } = await page.evaluate(async () => {
      const a = await window.ixaeon!.createProject({ name: '合成项目A' });
      const b = await window.ixaeon!.createProject({ name: '合成项目B' });
      return { projectA: a.id, projectB: b.id };
    });

    // 在 A 下开一个对话并发一句合成的话（有消息，项目即固定）
    const conv = await page.evaluate(async (id: string) => {
      const c = await window.ixaeon!.createConversation({ projectId: id });
      return c.id;
    }, projectA);
    await page.getByTestId('nav-ask').click();
    // 发一句合成的话让对话有消息（本检查只看项目固定，不看模型回答；
    // 临时库没配真模型网关，ask 可能 503 失败——消息已落库，失败不挡本检查）。
    await page.evaluate(
      async ({ id, text, project }: { id: string; text: string; project: string }) => {
        try {
          await window.ixaeon!.askQuestion({
            conversationId: id,
            projectId: project,
            question: text,
          });
        } catch {
          /* 503 也行：user/assistant 消息已写进对话 */
        }
      },
      { id: conv, text: '合成的第一句话', project: projectA },
    );
    await page.evaluate(async (id: string) => {
      await window.ixaeon!.listConversations();
      void id;
    }, conv);

    // 下拉框切到 B
    await page.getByTestId('ask-project-select').selectOption(projectB);
    await expect(page.getByTestId('ask-project-select')).toHaveValue(projectB);

    // 再打开 A 的那个对话
    const item = page.locator(`[data-conversation-id="${conv}"]`);
    await item
      .getByRole('button', { name: /合成|新对话/ })
      .first()
      .click();

    // 下拉框回到 A、锁定，旁边有提示
    await expect(page.getByTestId('ask-project-select')).toHaveValue(projectA);
    await expect(page.getByTestId('ask-project-select')).toBeDisabled();
    await expect(page.getByTestId('ask-project-locked')).toContainText('换项目请开新对话');
  } finally {
    await app.close();
  }
});
