/**
 * K1 真机检查（规格 docs/委派/K1-项目清单导入.md）：
 * 临时数据目录（IXAEON_DATA_DIR）启动真实 Electron，用一份 5 条的合成清单走一遍
 *   「从清单导入」→ 预览 → 确认导入 → 项目页；
 * 截图预览弹窗和导入后的项目页，落 `.logs/`（已 gitignore）。
 *
 * 跑法（仓库根目录下）：
 *   node apps/desktop/node_modules/@playwright/test/cli.js test \
 *     -c scripts/real/playwright.real.config.ts k1-project-import.spec.ts
 *
 * 清单是合成数据；用户真实清单（项目名、路径）不进仓库、也不在这里读。文件选择走
 * `IXAEON_TEST_DIALOG_RESPONSES` 替身（主进程按票据读，渲染层不自己读路径）。
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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { electronArgs } from '../../apps/desktop/test/review/electron-args';

// 宿主要是带着 ELECTRON_RUN_AS_NODE，playwright 拉起的 Electron 会当普通 node 跑、窗口起不来。
delete process.env.ELECTRON_RUN_AS_NODE;

const SCREENSHOTS = resolve('.logs');

/**
 * 接力调度器起的 DSH：工作区里的 electron.exe 是 Low IL，写不进 %TEMP% / %APPDATA%，
 * 单实例锁建不起来、应用直接退出（见 docs/委派/交付/L14.md）。门禁/DSH 用
 * `IXAEON_ELECTRON_NO_SANDBOX=1` 标记这一层：把 TEMP/TMP/APPDATA/LOCALAPPDATA 指到工作区，
 * 并给 Electron 加 `--no-sandbox`。用户平时跑不加这个变量，行为不变。
 */
if (process.env.IXAEON_ELECTRON_NO_SANDBOX === '1') {
  const envRoot = join(SCREENSHOTS, 'k1-electron-env');
  mkdirSync(envRoot, { recursive: true });
  for (const name of ['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'] as const) {
    process.env[name] = envRoot;
  }
}

test('K1 真机：5 条合成清单预览、确认导入、项目页刷新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-k1-real-'));
  const listPath = join(dir, '合成项目清单.json');
  // 5 条：A 改成归档、B 不变、C 与 D 新增（D 暂停）、E 的 status 不合法 → 无效。
  writeFileSync(
    listPath,
    JSON.stringify(
      {
        version: 1,
        projects: [
          { name: '合成项目A', status: 'archived', description: '清单里的说明（不该覆盖）' },
          { name: '合成项目B', status: 'paused' },
          { name: '合成项目C', status: 'active', note: '清单备注 C' },
          { name: '合成项目D', status: 'paused' },
          { name: '合成项目E', status: 'done' },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  mkdirSync(SCREENSHOTS, { recursive: true });

  const app = await electron.launch({
    args: electronArgs([
      resolve('apps/desktop/out/main/index.js'),
      `--user-data-dir=${join(dir, 'profile')}`,
    ]),
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dir,
      IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      IXAEON_EMBED_MODEL: 'none',
      IXAEON_CODEX_EXE: 'none',
      IXAEON_HERMES_EXE: '',
      IXAEON_HERMES_HOME: '',
      HERMES_HOME: '',
      IXAEON_FAKE_MODEL: '1',
      // 主进程「选文件」替身：Kind documents → 这份合成清单
      IXAEON_TEST_DIALOG_RESPONSES: `documents|${listPath}`,
    },
  });
  try {
    const page = await app.firstWindow();
    // 引导：合成模型名 + 一个引导项目
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('引导项目');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();

    // 合成库里先放 A、B（A active、B paused），对应条件 1 的起点
    await page.evaluate(async () => {
      const a = await window.ixaeon!.createProject({
        name: '合成项目A',
        description: '库里的 A 说明',
      });
      const b = await window.ixaeon!.createProject({ name: '合成项目B' });
      await window.ixaeon!.updateProjectStatus({ id: a.id, status: 'active' });
      await window.ixaeon!.updateProjectStatus({ id: b.id, status: 'paused' });
    });

    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('projects-card')).toBeVisible();
    await expect(page.locator('body')).toContainText('合成项目A');

    // 1. 选清单 → 预览（不写库）
    await page.getByTestId('projects-import').click();
    await expect(page.getByTestId('project-import-preview')).toBeVisible();
    await expect(page.getByTestId('project-import-counts')).toContainText(
      '新增 2 个、变化 1 个、不变 1 个、无效 1 个',
    );
    await expect(page.getByTestId('project-import-invalid')).toContainText('status 不合法');
    await page.screenshot({ path: join(SCREENSHOTS, 'k1-preview.png'), fullPage: true });

    // 预览阶段库里没有新增
    const before = await page.evaluate(async () => (await window.ixaeon!.listProjects()).length);
    expect(before).toBe(3); // 引导项目 + A + B

    // 2. 确认导入 → 刷新
    await page.getByTestId('project-import-confirm').click();
    await expect(page.getByTestId('project-import-result')).toContainText(
      '新增 2 个项目，更新 1 个状态',
    );
    await expect(page.getByTestId('projects-card')).toContainText('合成项目C');
    await expect(page.getByTestId('projects-card')).toContainText('合成项目D');

    const after = await page.evaluate(async () => {
      const rows = await window.ixaeon!.listProjects();
      return Object.fromEntries(rows.map((p) => [p.name, p.status]));
    });
    expect(after['合成项目A']).toBe('archived');
    expect(after['合成项目B']).toBe('paused');
    expect(after['合成项目C']).toBe('active');
    expect(after['合成项目D']).toBe('paused');
    expect(after['合成项目E']).toBeUndefined();

    await page.screenshot({ path: join(SCREENSHOTS, 'k1-after.png'), fullPage: true });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
