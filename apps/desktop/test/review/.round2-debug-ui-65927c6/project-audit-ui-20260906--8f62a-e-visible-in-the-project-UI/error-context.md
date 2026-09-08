# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: project-audit-ui-20260906.spec.ts >> UI01: successful MCP work-result writeback must actually be visible in the project UI
- Location: apps\desktop\test\review\project-audit-ui-20260906.spec.ts:6:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('main-nav')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByTestId('main-nav')

```

```yaml
- banner:
  - heading "IXAEON 析衍" [level=1]
  - paragraph: 本地项目记忆与编码 AI 背景服务 · 首次设置
- alert:
  - text: "Error invoking remote method 'ixaeon:completeSetup': Error: No handler registered for 'ixaeon:completeSetup'"
  - button "关闭"
- heading "步骤 3 / 3 — 数据目录" [level=2]
- paragraph:
  - text: 所有数据保存在你的电脑本地，不联网上传。当前数据目录：
  - code: （默认 %LOCALAPPDATA%\OMNIX\IXAEON）
- checkbox "自定义数据目录（重启应用后生效）" [disabled]
- text: 自定义数据目录（重启应用后生效）
- button "下一步"
- heading "步骤 2 / 3 — 模型接入" [level=2]
- paragraph: 提取与问答需要一个 OpenAI 兼容模型。密钥仅保存在本机（系统加密存储），可稍后在设置中填写。
- text: 模型名称
- textbox "模型名称": fake-model
- text: API Key（可选）
- textbox "API Key（可选） 留空表示稍后配置；格式 sk-…"
- text: 留空表示稍后配置；格式 sk-…
- button "上一步"
- button "下一步"
- heading "步骤 3 / 3 — 第一个项目" [level=2]
- text: 项目名称
- textbox "项目名称": Audit UI Project
- text: 项目根目录（可选）
- textbox "项目根目录（可选） 选择目录 用于项目目录登记导入与 MCP 检索范围":
  - /placeholder: 未选择
- button "选择目录"
- text: 用于项目目录登记导入与 MCP 检索范围
- button "上一步"
- button "完成设置"
```

# Test source

```ts
  1  | import { test, expect, _electron as electron } from '@playwright/test';
  2  | import { mkdtempSync } from 'node:fs';
  3  | import { tmpdir } from 'node:os';
  4  | import { join, resolve } from 'node:path';
  5  | 
  6  | test('UI01: successful MCP work-result writeback must actually be visible in the project UI', async () => {
  7  |   const occupied = await fetch('http://127.0.0.1:43191/api/health', {
  8  |     signal: AbortSignal.timeout(1000),
  9  |   }).then(
  10 |     () => true,
  11 |     () => false,
  12 |   );
  13 |   expect(occupied, 'Do not touch an existing user service').toBe(false);
  14 |   const dir = mkdtempSync(join(tmpdir(), 'ixaeon-project-ui-audit-'));
  15 |   const env = { ...process.env, IXAEON_DATA_DIR: dir, IXAEON_FAKE_MODEL: '1' };
  16 |   const app = await electron.launch({
  17 |     args: [
  18 |       resolve('apps/desktop/out/main/index.js'),
  19 |       `--user-data-dir=${join(dir, 'electron-profile')}`,
  20 |     ],
  21 |     env,
  22 |   });
  23 |   try {
  24 |     const page = await app.firstWindow();
  25 |     await page.getByTestId('setup-next-1').click();
  26 |     await page.getByTestId('setup-model-name').fill('fake-model');
  27 |     await page.getByTestId('setup-next-2').click();
  28 |     await page.getByTestId('setup-project-name').fill('Audit UI Project');
  29 |     await page.getByTestId('setup-finish').click();
> 30 |     await expect(page.getByTestId('main-nav')).toBeVisible();
     |                                                ^ Error: expect(locator).toBeVisible() failed
  31 |     const connection = await page.evaluate(async () => {
  32 |       const settings = await window.ixaeon!.getSettings();
  33 |       const projects = await window.ixaeon!.listProjects();
  34 |       return { token: settings.mcp.localToken, projectId: projects[0]!.id };
  35 |     });
  36 |     const response = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
  37 |       method: 'POST',
  38 |       headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
  39 |       body: JSON.stringify({
  40 |         project_ref: connection.projectId,
  41 |         agent_name: 'audit-agent',
  42 |         task: 'UI_AUDIT_WORK_MARKER',
  43 |         outcome: 'success',
  44 |         summary: 'Agent reports completion; user has not accepted it.',
  45 |         changes: [],
  46 |         tests: [],
  47 |         open_loops: [],
  48 |       }),
  49 |     });
  50 |     expect(response.ok).toBe(true);
  51 |     const persisted = await page.evaluate(
  52 |       async (projectId) => window.ixaeon!.listWorkRuns({ projectId, limit: 20 }),
  53 |       connection.projectId,
  54 |     );
  55 |     expect(persisted.some((r) => r.task === 'UI_AUDIT_WORK_MARKER')).toBe(true);
  56 |     await page.getByTestId('nav-projects').click();
  57 |     await expect(page.getByTestId('projects-card')).toContainText('Audit UI Project');
  58 |     // Not merely a project-name assertion: the actual work result must be present.
  59 |     await expect(page.getByTestId('page-projects')).toContainText('UI_AUDIT_WORK_MARKER', {
  60 |       timeout: 3000,
  61 |     });
  62 |   } finally {
  63 |     await app.close();
  64 |   }
  65 | });
  66 | 
```