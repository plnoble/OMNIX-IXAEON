import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 理解页连续工作回归（2026-09-08 用户反馈）：
 * 1. 确认后不再整页刷新跳回总览（保持理解页，可继续确认下一条）；
 * 2. 点「纠正」对话框必须立即可见（此前渲染在页面底部滚动区外）。
 */
async function launchWithOneItem() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-und-'));
  const doc = join(dir, 'doc.md');
  writeFileSync(doc, '# 文档\n\nUND_EVIDENCE 内容\n');
  // FakeProvider 预置响应：一次提取返回一条 decision
  const scriptPath = join(dir, 'model-script.json');
  writeFileSync(
    scriptPath,
    JSON.stringify({
      structured: [
        {
          items: [
            {
              type: 'decision',
              statement: 'UND_FIRST_CONCLUSION',
              rationale: null,
              confidence: 0.9,
              segment_ref: 'S2',
              project_hint: null,
              excerpt: 'UND_EVIDENCE',
            },
          ],
        },
      ],
      text: ['（合成回答）'],
    }),
    'utf8',
  );
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${doc}`,
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('fake-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('连续工作');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible();
  await page.getByTestId('nav-sources').click();
  await page.getByTestId('sources-import-docs').click();
  // 等提取完成（失败也如实暴露）
  await expect
    .poll(
      async () => {
        const jobs = await page.evaluate(async () => {
          const list = await window.ixaeon!.listJobs(20);
          return list.filter((j) => j.kind === 'extract').map((j) => j.status);
        });
        return jobs.length > 0 && jobs.every((s) => s !== 'queued' && s !== 'running');
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const failed = await page.evaluate(async () => {
    const list = await window.ixaeon!.listJobs(20);
    return list.filter((j) => j.kind === 'extract' && j.status === 'failed').length;
  });
  expect(failed, '提取任务不应失败').toBe(0);
  await page.getByTestId('nav-understanding').click();
  await expect
    .poll(async () => page.locator('[data-testid^="item-"]').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
  return { app, page, dir };
}

test('UND01: confirm keeps the user on the understanding page (no full reload)', async () => {
  const { app, page } = await launchWithOneItem();
  try {
    const items = await page.evaluate(async () => {
      const list = await window.ixaeon!.listItems({ projectId: null });
      return list.filter((i) => i.origin === 'ai' && i.confirmation === 'none');
    });
    expect(items.length).toBeGreaterThan(0);
    await page.getByTestId(`confirm-${items[0]!.id}`).click();
    // 关键断言：确认后 3 秒内仍停留在理解页（旧版整页 reload 会跳回总览）
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('page-understanding')).toBeVisible();
    // 徽标更新为「用户已确认」（局部刷新生效）
    await expect(page.getByTestId(`confirmed-${items[0]!.id}`)).toBeVisible({ timeout: 5000 });
  } finally {
    await app.close();
  }
});

test('UND02: clicking correct makes the dialog visible in-viewport', async () => {
  const { app, page } = await launchWithOneItem();
  try {
    const items = await page.evaluate(async () => {
      const list = await window.ixaeon!.listItems({ projectId: null });
      return list.filter((i) => i.origin === 'ai');
    });
    expect(items.length).toBeGreaterThan(0);
    await page.getByTestId(`correct-${items[0]!.id}`).click();
    // 对话框立即可见且输入框可用（旧版渲染在滚动区外，看起来像没反应）
    const dialog = page.getByTestId('correction-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.getByTestId('correction-input').fill('UND_CORRECTED_STATEMENT');
    await page.getByTestId('correction-preview').click();
    await expect(page.getByTestId('correction-preview-panel')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('correction-confirm').click();
    // 纠正完成 → 仍停留理解页且新结论出现
    await expect
      .poll(async () => page.textContent('[data-testid="page-understanding"]'), {
        timeout: 10_000,
      })
      .toContain('UND_CORRECTED_STATEMENT');
    await expect(page.getByTestId('page-understanding')).toBeVisible();
  } finally {
    await app.close();
  }
});
