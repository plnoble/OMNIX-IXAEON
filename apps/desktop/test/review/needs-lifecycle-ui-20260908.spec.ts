import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function seedPendingWork() {
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(occupied, 'Do not touch an existing service').toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-needs-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
    env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('Needs lifecycle');
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
        agent_name: 'synthetic-review',
        task: 'Lifecycle audit',
        outcome: 'partial',
        summary: 'Synthetic review fixture.',
        changes: [],
        tests: [],
        open_loops: ['LIFECYCLE_PENDING_WORK'],
      }),
    });
    expect(response.ok).toBe(true);
    const result = (await response.json()) as { open_loop_candidates: Array<{ item_id: string }> };
    expect(result.open_loop_candidates).toHaveLength(1);
    const itemId = result.open_loop_candidates[0]!.item_id;
    await page.getByTestId('nav-inbox').click();
    await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeVisible();
    return { app, page, itemId };
  } catch (err) {
    await app.close();
    throw err;
  }
}

test('LUI01: defer button must actually defer pending work without pretending it was confirmed', async () => {
  const { app, page, itemId } = await seedPendingWork();
  try {
    const row = page.getByTestId(`inbox-item-${itemId}`);
    await row.getByRole('button', { name: '暂不处理', exact: true }).click();
    await expect.soft(row).toBeHidden({ timeout: 2500 });
    const persisted = await page.evaluate(async (id) => {
      const items = await window.ixaeon!.listItems({ projectId: null });
      return items.find((i) => i.id === id);
    }, itemId);
    expect(persisted).toBeDefined();
    expect(persisted!.confirmation).toBe('none');
  } finally {
    await app.close();
  }
});

test('LUI02: after correction the superseded predecessor must not remain in Inbox', async () => {
  const { app, page, itemId } = await seedPendingWork();
  try {
    const correction = await page.evaluate(
      async (id) =>
        window.ixaeon!.correctItem({ itemId: id, userText: 'LIFECYCLE_CORRECTED_WORK' }),
      itemId,
    );
    expect(correction.oldItem.state).toBe('superseded');
    expect(correction.newItem.statement).toBe('LIFECYCLE_CORRECTED_WORK');
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('nav-inbox').click();
    // Await completed loading, not the initial render before the query returns.
    await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 2500 });
    await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeHidden({ timeout: 2500 });
    // N01 附验：重新归属/重绑也不能让旧历史条目重新进入待处理
    const projectId = await page.evaluate(async () => {
      const ps = await window.ixaeon!.listProjects();
      return ps[0]!.id;
    });
    await page.evaluate(
      async (args: [string, string]) => {
        await window.ixaeon!.assignItemToProject({ itemId: args[0], projectId: args[1] });
      },
      [itemId, projectId] as [string, string],
    );
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('nav-inbox').click();
    await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 2500 });
    const persisted = await page.evaluate(async (id) => {
      const items = await window.ixaeon!.listItems({ projectId: null });
      return items.find((i) => i.id === id);
    }, itemId);
    expect(persisted!.needs_review).toBe(false); // 旧历史条目未复活
  } finally {
    await app.close();
  }
});

test('LUI03: defer→re-enter→restart→resume keeps reasons and confirmation intact', async () => {
  const occupied = await fetch('http://127.0.0.1:43191/api/health', {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(occupied, 'Do not touch an existing service').toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-needs-ui-defer-'));
  const launch = () =>
    electron.launch({
      args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
      env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
    });
  const app = await launch();
  let itemId = '';
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('Defer lifecycle');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible();
    const connection = await page.evaluate(async () => ({
      token: (await window.ixaeon!.getSettings()).mcp.localToken,
      projectId: (await window.ixaeon!.listProjects())[0]!.id,
    }));
    const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify({
        project_ref: connection.projectId,
        agent_name: 'synthetic-review',
        task: 'Defer audit',
        outcome: 'partial',
        summary: 'Synthetic defer fixture.',
        changes: [],
        tests: [],
        open_loops: ['DEFER_PENDING_WORK'],
      }),
    });
    expect(response.ok).toBe(true);
    const result = (await response.json()) as { open_loop_candidates: Array<{ item_id: string }> };
    itemId = result.open_loop_candidates[0]!.item_id;

    // 暂不处理（搁置）→ 移出待讨论、进入已搁置区
    await page.getByTestId('nav-inbox').click();
    await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeVisible();
    await page.getByTestId(`inbox-defer-${itemId}`).click();
    await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeHidden({ timeout: 2500 });
    await expect(page.getByTestId(`inbox-shelved-${itemId}`)).toBeVisible({ timeout: 2500 });

    // 重进页面：搁置状态可理解（已搁置区仍显示）
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('nav-inbox').click();
    await expect(page.getByTestId(`inbox-shelved-${itemId}`)).toBeVisible({ timeout: 2500 });
  } finally {
    await app.close();
  }
  // 重启：搁置状态持久；恢复后回到待讨论，原因与确认状态未被篡改
  const app2 = await launch();
  try {
    const page2 = await app2.firstWindow();
    await expect(page2.getByTestId('main-nav')).toBeVisible();
    await page2.getByTestId('nav-inbox').click();
    await expect(page2.getByTestId(`inbox-shelved-${itemId}`)).toBeVisible({ timeout: 2500 });
    await page2.getByTestId(`inbox-resume-${itemId}`).click();
    await expect(page2.getByTestId(`inbox-item-${itemId}`)).toBeVisible({ timeout: 2500 });
    await expect(page2.getByTestId(`inbox-shelved-${itemId}`)).toBeHidden({ timeout: 2500 });
    const restored = await page2.evaluate(async (id) => {
      const items = await window.ixaeon!.listItems({ projectId: null });
      return items.find((i) => i.id === id);
    }, itemId);
    expect(restored!.needs_review).toBe(true); // 未解决原因仍在
    expect(restored!.confirmation).toBe('none'); // 未被冒充确认
    expect(restored!.shelved_at).toBe(null);
  } finally {
    await app2.close();
  }
});
