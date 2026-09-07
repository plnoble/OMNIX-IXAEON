import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('BUI01: recent work must expose recorded failed tests and unfinished work, not just its summary', async () => {
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(occupied, 'Do not touch an existing service').toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-recheck-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('Recheck UI');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();
    const connection = await page.evaluate(async () => ({
      token: (await window.ixaeon!.getSettings()).mcp.localToken,
      projectId: (await window.ixaeon!.listProjects())[0]!.id,
    }));
    const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({
        project_ref: connection.projectId,
        agent_name: 'review-agent',
        task: 'RECHECK_UI_WORK',
        outcome: 'partial',
        summary: 'Work requires follow-up; synthetic audit record.',
        changes: [],
        tests: [{ name: 'RECHECK_FAILED_TEST', result: 'failed' }],
        open_loops: ['RECHECK_UNFINISHED_TASK'],
      }),
    });
    expect(response.ok).toBe(true);
    const saved = await page.evaluate(
      async (projectId) => window.ixaeon!.listWorkRuns({ projectId, limit: 10 }),
      connection.projectId,
    );
    expect(JSON.stringify(saved)).toContain('RECHECK_FAILED_TEST');
    expect(JSON.stringify(saved)).toContain('RECHECK_UNFINISHED_TASK');
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('page-projects')).toContainText('RECHECK_UI_WORK');
    await expect
      .soft(page.getByTestId('page-projects'))
      .toContainText('RECHECK_FAILED_TEST', { timeout: 3000 });
    await expect
      .soft(page.getByTestId('page-projects'))
      .toContainText('RECHECK_UNFINISHED_TASK', { timeout: 3000 });

    // RF06 附验 1：离开再回到项目页（重进不丢记录、错误不被吞成“暂无记录”）
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('page-projects')).toContainText('RECHECK_UI_WORK');
    await expect(page.getByTestId('page-projects')).toContainText('RECHECK_FAILED_TEST');
    await expect(page.getByTestId('page-projects')).toContainText('RECHECK_UNFINISHED_TASK');

    // RF06 附验 2：详情可展开，展开后变更/测试/未完成事项全量可见
    const runId = saved[0]!.id;
    await page.getByTestId(`work-run-toggle-${runId}`).click();
    const detail = page.getByTestId(`work-run-detail-${runId}`);
    await expect(detail).toContainText('未完成事项');
    await expect(detail).toContainText('RECHECK_UNFINISHED_TASK');
    await expect(detail).toContainText('RECHECK_FAILED_TEST=失败');
    await page.getByTestId(`work-run-toggle-${runId}`).click();
    await expect(detail).toBeHidden();

    // RF06 附验 3：另一项目的隔离 —— 项目页不显示其他项目的回写
    const otherProjectId = await page.evaluate(async () => {
      const p = await window.ixaeon!.createProject({
        name: 'Isolation Check',
        rootPath: null,
        description: null,
      });
      return p.id;
    });
    expect(otherProjectId).not.toBe(connection.projectId);
    await page.reload();
    await expect(page.getByTestId('main-nav')).toBeVisible();
    await page.getByTestId('nav-projects').click();
    const projectsPage = page.getByTestId('page-projects');
    await expect(projectsPage).toContainText('RECHECK_UI_WORK');
    // 新项目没有回写记录 → 显示“暂无”，而不是旧项目的记录
    await expect(projectsPage).toContainText('最近工作：暂无编码 agent 回写记录。');
  } finally {
    await app.close();
  }
});

test('BUI02: work-run details survive app restart (persisted, not just in-memory state)', async () => {
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(occupied, 'Do not touch an existing service').toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-recheck-restart-'));
  const launch = () =>
    electron.launch({
      args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
      env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
    });
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('Restart Check');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();
    const connection = await page.evaluate(async () => ({
      token: (await window.ixaeon!.getSettings()).mcp.localToken,
      projectId: (await window.ixaeon!.listProjects())[0]!.id,
    }));
    const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({
        project_ref: connection.projectId,
        agent_name: 'review-agent',
        task: 'RESTART_PERSIST_WORK',
        outcome: 'partial',
        summary: 'Synthetic partial record for restart check.',
        changes: [],
        tests: [{ name: 'RESTART_FAILED_TEST', result: 'failed' }],
        open_loops: ['RESTART_UNFINISHED_TASK'],
      }),
    });
    expect(response.ok).toBe(true);
  } finally {
    await app.close();
  }
  // 重启（同一数据目录）→ 失败测试与未完成事项仍然可见
  const app2 = await launch();
  try {
    const page2 = await app2.firstWindow();
    await expect(page2.getByTestId('main-nav')).toBeVisible();
    await page2.getByTestId('nav-projects').click();
    const projectsPage = page2.getByTestId('page-projects');
    await expect(projectsPage).toContainText('RESTART_PERSIST_WORK');
    await expect(projectsPage).toContainText('RESTART_FAILED_TEST');
    await expect(projectsPage).toContainText('RESTART_UNFINISHED_TASK');
  } finally {
    await app2.close();
  }
});
