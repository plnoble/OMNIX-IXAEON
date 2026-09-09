import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 文件夹导入与重新分析（2026-09-08 用户反馈 P1/P3）：
 * P1「一个项目不止一个文件」→ 来源页「导入文件夹」递归导入；
 * P3「看不到重新分析」→ 来源详情页常驻「重新分析」按钮。
 */
test('SRC01: import folder button imports recursive text files as sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-src-folder-'));
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, 'docs', 'sub'), { recursive: true });
  writeFileSync(join(proj, 'README.md'), '# 项目甲\n\nSRC01_ROOT_DOC 目标说明\n');
  writeFileSync(join(proj, 'docs', 'design.md'), 'SRC01_DESIGN 文档内容');
  writeFileSync(join(proj, 'docs', 'sub', 'notes.txt'), 'SRC01_NOTES 笔记内容');
  mkdirSync(join(proj, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(proj, 'node_modules', 'x', 'skip.md'), '不应导入');
  writeFileSync(join(proj, 'app.js'), '不支持的扩展');

  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${proj}`,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('文件夹导入');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();

    await page.getByTestId('nav-sources').click();
    await page.getByTestId('sources-import-folder').click();
    // 三个白名单文件成为来源；node_modules 与 .js 不进
    await expect
      .poll(
        async () => {
          const rows = await page.locator('[data-testid^="source-row-"]').count();
          return rows;
        },
        { timeout: 10_000 },
      )
      .toBe(3);
    const body = await page.textContent('[data-testid="page-sources"]');
    expect(body).toContain('README.md');
    expect(body).toContain('design.md');
    expect(body).toContain('notes.txt');
    expect(body).not.toContain('skip.md');
    expect(body).not.toContain('app.js');
  } finally {
    await app.close();
  }
});

test('SRC02: source detail has a persistent reanalyze button', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-src-reanalyze-'));
  const doc = join(dir, 'doc.md');
  writeFileSync(doc, '# 文档\n\nSRC02_EVIDENCE 内容\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${doc}`,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('重新分析');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('sources-import-docs').click();
    await expect
      .poll(async () => page.locator('[data-testid^="source-row-"]').count(), { timeout: 10_000 })
      .toBe(1);
    // 打开详情：常驻「重新分析」按钮可见且可点（不抛错）
    await page.locator('[data-testid^="source-row-"]').first().click();
    const reanalyze = page.getByTestId('source-reanalyze');
    await expect(reanalyze).toBeVisible();
    await reanalyze.click();
    // 任务入队后状态流转（queued/running/succeeded 任一）——轮询任务表
    await expect
      .poll(
        async () => {
          const jobs = await page.evaluate(async () => {
            const list = await window.ixaeon!.listJobs(20);
            return list.filter((j) => j.kind === 'extract').map((j) => j.status);
          });
          return jobs.length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
