import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('UI01: successful MCP work-result writeback must actually be visible in the project UI', async () => {
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(occupied, 'Do not touch an existing user service').toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-project-ui-audit-'));
  const env = { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' };
  const app = await electron.launch({
    args: [
      resolve('apps/desktop/out/main/index.js'),
      `--user-data-dir=${join(dir, 'electron-profile')}`,
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('Audit UI Project');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();
    const connection = await page.evaluate(async () => {
      const settings = await window.ixaeon!.getSettings();
      const projects = await window.ixaeon!.listProjects();
      return { token: settings.mcp.localToken, projectId: projects[0]!.id };
    });
    const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({
        project_ref: connection.projectId,
        agent_name: 'audit-agent',
        task: 'UI_AUDIT_WORK_MARKER',
        outcome: 'success',
        summary: 'Agent reports completion; user has not accepted it.',
        changes: [],
        tests: [],
        open_loops: [],
      }),
    });
    expect(response.ok).toBe(true);
    const persisted = await page.evaluate(
      async (projectId) => window.ixaeon!.listWorkRuns({ projectId, limit: 20 }),
      connection.projectId,
    );
    expect(persisted.some((r) => r.task === 'UI_AUDIT_WORK_MARKER')).toBe(true);
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('projects-card')).toContainText('Audit UI Project');
    // Not merely a project-name assertion: the actual work result must be present.
    await expect(page.getByTestId('page-projects')).toContainText('UI_AUDIT_WORK_MARKER', {
      timeout: 3000,
    });
  } finally {
    await app.close();
  }
});
