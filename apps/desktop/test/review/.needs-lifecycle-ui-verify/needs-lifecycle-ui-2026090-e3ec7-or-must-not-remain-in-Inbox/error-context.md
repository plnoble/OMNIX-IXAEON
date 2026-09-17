# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: needs-lifecycle-ui-20260908.spec.ts >> LUI02: after correction the superseded predecessor must not remain in Inbox
- Location: apps\desktop\test\review\needs-lifecycle-ui-20260908.spec.ts:75:5

# Error details

```
Error: Do not touch an existing service

expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true
```

# Test source

```ts
  1   | import { test, expect, _electron as electron } from '@playwright/test';
  2   | import { mkdtempSync } from 'node:fs';
  3   | import { tmpdir } from 'node:os';
  4   | import { join, resolve } from 'node:path';
  5   | 
  6   | async function seedPendingWork() {
  7   |   const occupied = await fetch('http://127.0.0.1:43191/api/health', {
  8   |     signal: AbortSignal.timeout(1000),
  9   |   }).then(
  10  |     () => true,
  11  |     () => false,
  12  |   );
> 13  |   expect(occupied, 'Do not touch an existing service').toBe(false);
      |                                                        ^ Error: Do not touch an existing service
  14  |   const dir = mkdtempSync(join(tmpdir(), 'ixaeon-needs-ui-'));
  15  |   const app = await electron.launch({
  16  |     args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
  17  |     env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  18  |   });
  19  |   try {
  20  |     const page = await app.firstWindow();
  21  |     await page.getByTestId('setup-next-1').click();
  22  |     await page.getByTestId('setup-model-name').fill('fake-model');
  23  |     await page.getByTestId('setup-next-2').click();
  24  |     await page.getByTestId('setup-project-name').fill('Needs lifecycle');
  25  |     await page.getByTestId('setup-finish').click();
  26  |     await expect(page.getByTestId('main-nav')).toBeVisible();
  27  |     const connection = await page.evaluate(async () => ({
  28  |       token: (await window.ixaeon!.getSettings()).mcp.localToken,
  29  |       projectId: (await window.ixaeon!.listProjects())[0]!.id,
  30  |     }));
  31  |     const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
  32  |       method: 'POST',
  33  |       headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
  34  |       body: JSON.stringify({
  35  |         project_ref: connection.projectId,
  36  |         agent_name: 'synthetic-review',
  37  |         task: 'Lifecycle audit',
  38  |         outcome: 'partial',
  39  |         summary: 'Synthetic review fixture.',
  40  |         changes: [],
  41  |         tests: [],
  42  |         open_loops: ['LIFECYCLE_PENDING_WORK'],
  43  |       }),
  44  |     });
  45  |     expect(response.ok).toBe(true);
  46  |     const result = (await response.json()) as { open_loop_candidates: Array<{ item_id: string }> };
  47  |     expect(result.open_loop_candidates).toHaveLength(1);
  48  |     const itemId = result.open_loop_candidates[0]!.item_id;
  49  |     await page.getByTestId('nav-inbox').click();
  50  |     await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeVisible();
  51  |     return { app, page, itemId };
  52  |   } catch (err) {
  53  |     await app.close();
  54  |     throw err;
  55  |   }
  56  | }
  57  | 
  58  | test('LUI01: defer button must actually defer pending work without pretending it was confirmed', async () => {
  59  |   const { app, page, itemId } = await seedPendingWork();
  60  |   try {
  61  |     const row = page.getByTestId(`inbox-item-${itemId}`);
  62  |     await row.getByRole('button', { name: '暂不处理', exact: true }).click();
  63  |     await expect.soft(row).toBeHidden({ timeout: 2500 });
  64  |     const persisted = await page.evaluate(async (id) => {
  65  |       const items = await window.ixaeon!.listItems({ projectId: null });
  66  |       return items.find((i) => i.id === id);
  67  |     }, itemId);
  68  |     expect(persisted).toBeDefined();
  69  |     expect(persisted!.confirmation).toBe('none');
  70  |   } finally {
  71  |     await app.close();
  72  |   }
  73  | });
  74  | 
  75  | test('LUI02: after correction the superseded predecessor must not remain in Inbox', async () => {
  76  |   const { app, page, itemId } = await seedPendingWork();
  77  |   try {
  78  |     const correction = await page.evaluate(
  79  |       async (id) =>
  80  |         window.ixaeon!.correctItem({ itemId: id, userText: 'LIFECYCLE_CORRECTED_WORK' }),
  81  |       itemId,
  82  |     );
  83  |     expect(correction.oldItem.state).toBe('superseded');
  84  |     expect(correction.newItem.statement).toBe('LIFECYCLE_CORRECTED_WORK');
  85  |     await page.getByTestId('nav-projects').click();
  86  |     await page.getByTestId('nav-inbox').click();
  87  |     // Await completed loading, not the initial render before the query returns.
  88  |     await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 2500 });
  89  |     await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeHidden({ timeout: 2500 });
  90  |     // N01 附验：重新归属/重绑也不能让旧历史条目重新进入待处理
  91  |     const projectId = await page.evaluate(async () => {
  92  |       const ps = await window.ixaeon!.listProjects();
  93  |       return ps[0]!.id;
  94  |     });
  95  |     await page.evaluate(
  96  |       async (args: [string, string]) => {
  97  |         await window.ixaeon!.assignItemToProject({ itemId: args[0], projectId: args[1] });
  98  |       },
  99  |       [itemId, projectId] as [string, string],
  100 |     );
  101 |     await page.getByTestId('nav-projects').click();
  102 |     await page.getByTestId('nav-inbox').click();
  103 |     await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 2500 });
  104 |     const persisted = await page.evaluate(async (id) => {
  105 |       const items = await window.ixaeon!.listItems({ projectId: null });
  106 |       return items.find((i) => i.id === id);
  107 |     }, itemId);
  108 |     expect(persisted!.needs_review).toBe(false); // 旧历史条目未复活
  109 |   } finally {
  110 |     await app.close();
  111 |   }
  112 | });
  113 | 
```