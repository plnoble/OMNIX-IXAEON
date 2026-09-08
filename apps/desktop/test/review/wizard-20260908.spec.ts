import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 设置向导改造回归（2026-09-08）：
 * 1. 完成设置的反馈必须在视口内立即可见（修复「点了没反应」——
 *    旧版提示渲染在滚动区外顶部）；
 * 2. 第一个项目可跳过（项目名留空 → 不建项目，仍完成设置）；
 * 3. 数据目录用原生「选择目录」按钮（无勾选框/手输路径）。
 * 模型列表拉取经上游真实网络，不在此自动化（属真实环境验收）；
 * Key 保存失败警告在 B09-B10 已有契约级覆盖。
 */
test('WIZ01: finish feedback visible, project optional, default dir completes in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-wiz-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  });
  try {
    const page = await app.firstWindow();
    // 第 1 步：默认目录直接下一步（原生选择按钮存在且默认显示当前目录）
    await expect(page.getByTestId('setup-pick-dir')).toBeVisible();
    await page.getByTestId('setup-next-1').click();
    // 第 2 步：直接填模型名（不拉列表），API 地址默认值存在
    await expect(page.getByTestId('setup-api-base')).toHaveValue(/https:\/\//);
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    // 第 3 步：项目名留空 → 完成设置
    await expect(page.getByTestId('setup-project-name')).toHaveValue('');
    await page.getByTestId('setup-finish').click();
    // 默认目录就地完成：直接进主界面
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 10_000 });
    // 未建项目（项目列表空）
    const projects = await page.evaluate(async () => window.ixaeon!.listProjects());
    expect(projects).toEqual([]);
  } finally {
    await app.close();
  }
});

test('WIZ02: custom dir via picker flow shows restart notice in-viewport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-wiz2-'));
  const customData = join(dir, 'chosen-data');
  mkdirSync(customData, { recursive: true });
  // 不用 IXAEON_DATA_DIR（那会禁用目录选择）；用独立 LOCALAPPDATA
  // 让默认数据目录落到临时区，不污染真实用户目录（与 packaged 复核同法）
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: {
      ...process.env,
      LOCALAPPDATA: join(dir, 'localappdata'),
      APPDATA: join(dir, 'appdata'),
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${customData}`,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-pick-dir').click();
    await expect(page.getByTestId('setup-dir-display')).toHaveValue(customData);
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-finish').click();
    // 反馈必须在视口内可见（旧版 bug：提示在滚动区外顶部看不到）
    const notice = page.getByTestId('setup-finish-notice');
    await expect(notice).toBeVisible({ timeout: 5_000 });
    await expect(notice).toContainText('重新打开');
    // notice 在完成按钮附近（操作区内），不在页面顶部 header 之上
    const noticeBox = await notice.boundingBox();
    const finishBox = await page.getByTestId('setup-finish').boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(finishBox).not.toBeNull();
    expect(Math.abs((noticeBox!.y ?? 0) - (finishBox!.y ?? 0))).toBeLessThan(200);
  } finally {
    await app.close();
  }
});
