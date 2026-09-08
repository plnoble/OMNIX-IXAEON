# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: needs-lifecycle-ui-20260908.spec.ts >> LUI02: after correction the superseded predecessor must not remain in Inbox
- Location: apps\desktop\test\review\needs-lifecycle-ui-20260908.spec.ts:75:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('inbox-empty')
Expected: visible
Timeout: 2500ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 2500ms
  - waiting for getByTestId('inbox-empty')

```

```yaml
- banner:
  - heading "IXAEON 析衍" [level=1]
  - paragraph: 本地项目记忆与编码 AI 背景服务 · OMNIX
  - navigation:
    - button "总览"
    - button "理解"
    - button "待讨论"
    - button "问答"
    - button "历史"
    - button "项目"
    - button "来源"
    - button "检索"
    - button "设置"
- main:
  - heading "待讨论（Inbox）" [level=2]
  - paragraph: 无法确定所属项目或相互冲突的结论，需要你确认归属。
  - list:
    - listitem:
      - text: LIFECYCLE_PENDING_WORK work_result
      - button "确认正确"
      - button "不采纳"
      - combobox:
        - option "归属到项目…" [selected]
        - option "Needs lifecycle"
      - button "暂不处理"
```

# Test source

```ts
  1  | import { test, expect, _electron as electron } from '@playwright/test';
  2  | import { mkdtempSync } from 'node:fs';
  3  | import { tmpdir } from 'node:os';
  4  | import { join, resolve } from 'node:path';
  5  | 
  6  | async function seedPendingWork() {
  7  |   const occupied = await fetch('http://127.0.0.1:43191/api/health', {
  8  |     signal: AbortSignal.timeout(1000),
  9  |   }).then(
  10 |     () => true,
  11 |     () => false,
  12 |   );
  13 |   expect(occupied, 'Do not touch an existing service').toBe(false);
  14 |   const dir = mkdtempSync(join(tmpdir(), 'ixaeon-needs-ui-'));
  15 |   const app = await electron.launch({
  16 |     args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(dir, 'profile')}`],
  17 |     env: { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' },
  18 |   });
  19 |   try {
  20 |     const page = await app.firstWindow();
  21 |     await page.getByTestId('setup-next-1').click();
  22 |     await page.getByTestId('setup-model-name').fill('fake-model');
  23 |     await page.getByTestId('setup-next-2').click();
  24 |     await page.getByTestId('setup-project-name').fill('Needs lifecycle');
  25 |     await page.getByTestId('setup-finish').click();
  26 |     await expect(page.getByTestId('main-nav')).toBeVisible();
  27 |     const connection = await page.evaluate(async () => ({
  28 |       token: (await window.ixaeon!.getSettings()).mcp.localToken,
  29 |       projectId: (await window.ixaeon!.listProjects())[0]!.id,
  30 |     }));
  31 |     const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
  32 |       method: 'POST',
  33 |       headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
  34 |       body: JSON.stringify({
  35 |         project_ref: connection.projectId,
  36 |         agent_name: 'synthetic-review',
  37 |         task: 'Lifecycle audit',
  38 |         outcome: 'partial',
  39 |         summary: 'Synthetic review fixture.',
  40 |         changes: [],
  41 |         tests: [],
  42 |         open_loops: ['LIFECYCLE_PENDING_WORK'],
  43 |       }),
  44 |     });
  45 |     expect(response.ok).toBe(true);
  46 |     const result = (await response.json()) as { open_loop_candidates: Array<{ item_id: string }> };
  47 |     expect(result.open_loop_candidates).toHaveLength(1);
  48 |     const itemId = result.open_loop_candidates[0]!.item_id;
  49 |     await page.getByTestId('nav-inbox').click();
  50 |     await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeVisible();
  51 |     return { app, page, itemId };
  52 |   } catch (err) {
  53 |     await app.close();
  54 |     throw err;
  55 |   }
  56 | }
  57 | 
  58 | test('LUI01: defer button must actually defer pending work without pretending it was confirmed', async () => {
  59 |   const { app, page, itemId } = await seedPendingWork();
  60 |   try {
  61 |     const row = page.getByTestId(`inbox-item-${itemId}`);
  62 |     await row.getByRole('button', { name: '暂不处理', exact: true }).click();
  63 |     await expect.soft(row).toBeHidden({ timeout: 2500 });
  64 |     const persisted = await page.evaluate(async (id) => {
  65 |       const items = await window.ixaeon!.listItems({ projectId: null });
  66 |       return items.find((i) => i.id === id);
  67 |     }, itemId);
  68 |     expect(persisted).toBeDefined();
  69 |     expect(persisted!.confirmation).toBe('none');
  70 |   } finally {
  71 |     await app.close();
  72 |   }
  73 | });
  74 | 
  75 | test('LUI02: after correction the superseded predecessor must not remain in Inbox', async () => {
  76 |   const { app, page, itemId } = await seedPendingWork();
  77 |   try {
  78 |     const correction = await page.evaluate(
  79 |       async (id) =>
  80 |         window.ixaeon!.correctItem({ itemId: id, userText: 'LIFECYCLE_CORRECTED_WORK' }),
  81 |       itemId,
  82 |     );
  83 |     expect(correction.oldItem.state).toBe('superseded');
  84 |     expect(correction.newItem.statement).toBe('LIFECYCLE_CORRECTED_WORK');
  85 |     await page.getByTestId('nav-projects').click();
  86 |     await page.getByTestId('nav-inbox').click();
  87 |     // Await completed loading, not the initial render before the query returns.
> 88 |     await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 2500 });
     |                                                   ^ Error: expect(locator).toBeVisible() failed
  89 |     await expect(page.getByTestId(`inbox-item-${itemId}`)).toBeHidden({ timeout: 2500 });
  90 |   } finally {
  91 |     await app.close();
  92 |   }
  93 | });
  94 | 
```