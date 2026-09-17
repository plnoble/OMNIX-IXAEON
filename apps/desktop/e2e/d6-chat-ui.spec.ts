import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * D6 验收：问答页连续聊天（三周任务单 / 委派单 D6）。
 *
 * 模型入口：IXAEON_FAKE_MODEL=1 + IXAEON_FAKE_MODEL_SCRIPT。
 * 关闭 Hermes 环境变量，避免本机真引擎抢走 FakeProvider。
 */

function findDesktopDir(): string {
  for (let dir = process.cwd(); ; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js');
    dir = parent;
  }
}

const desktopDir = findDesktopDir();
const shotDir = join(desktopDir, 'release', 'screenshots');

function launchEnv(dataDir: string, scriptPath: string): Record<string, string> {
  return {
    ...process.env,
    IXAEON_DATA_DIR: dataDir,
    IXAEON_FAKE_MODEL: '1',
    IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
    IXAEON_HERMES_EXE: '',
    IXAEON_HERMES_HOME: '',
    HERMES_HOME: '',
  };
}

async function launchApp(
  dataDir: string,
  scriptPath: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(desktopDir, 'out', 'main', 'index.js')],
    env: launchEnv(dataDir, scriptPath),
  });
  const page = await app.firstWindow();
  // 整合复核补充：整个流程不允许出现页面报错。改名曾用 window.prompt，
  // Electron 不支持、点击即抛错，但页面不崩，原测试没发现（9-17 用户实测才暴露）。
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const pageErrors: string[] = [];

async function setupOnce(page: Page): Promise<void> {
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('fake-model');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('D6 聊天项目');
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
}

async function askOnce(page: Page, text: string, expectCount: number): Promise<void> {
  await page.getByTestId('ask-input').fill(text);
  await page.getByTestId('ask-run').click();
  await expect(page.getByTestId('message-item')).toHaveCount(expectCount, { timeout: 30_000 });
}

test.describe('D6 聊天界面', () => {
  let dataDir: string;
  let scriptPath: string;

  test.beforeAll(() => {
    mkdirSync(shotDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-d6-'));
    scriptPath = join(dataDir, 'model-script.json');
    const emptyExtract = { items: [] };
    writeFileSync(
      scriptPath,
      JSON.stringify({
        structured: [
          { tool: 'answer', args: { text: '第一答：正式系统名是 IXAEON（析衍）。' } },
          emptyExtract,
          { tool: 'answer', args: { text: '第二答：析衍读作 xī yǎn。' } },
          emptyExtract,
          { tool: 'answer', args: { text: '第三答：从原文析出，再往前衍。' } },
          emptyExtract,
          { tool: 'answer', args: { text: '第二对话的回答，不应出现在第一对话。' } },
          emptyExtract,
        ],
      }),
      'utf8',
    );
  });

  test.afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟 */
    }
  });

  test('连续三轮、切换对话、重开还原、失败/取消/引用/批准卡', async () => {
    test.setTimeout(180_000);
    let { app, page } = await launchApp(dataDir, scriptPath);
    await setupOnce(page);
    await page.getByTestId('nav-ask').click();
    await expect(page.getByTestId('page-ask')).toBeVisible();
    await expect(page.getByTestId('conversation-list')).toBeVisible();
    await expect(page.getByTestId('message-list')).toBeVisible();

    await askOnce(page, '正式系统名是什么？', 2);
    await askOnce(page, '刚才那个名字怎么读？', 4);
    await askOnce(page, '为什么叫这个？', 6);

    const firstRound = page.getByTestId('message-item');
    await expect(firstRound).toHaveCount(6);
    await expect(firstRound.nth(0)).toHaveAttribute('data-role', 'user');
    await expect(firstRound.nth(1)).toHaveAttribute('data-role', 'assistant');
    await expect(page.getByTestId('message-list')).toContainText('正式系统名是什么？');
    await expect(page.getByTestId('message-list')).toContainText('第一答：正式系统名是 IXAEON');
    await expect(page.getByTestId('message-list')).toContainText('刚才那个名字怎么读？');
    await expect(page.getByTestId('message-list')).toContainText('第二答：析衍读作');
    await expect(page.getByTestId('message-list')).toContainText('为什么叫这个？');
    await expect(page.getByTestId('message-list')).toContainText('第三答：从原文析出');

    // 整合复核补充：三轮的引擎/存档说明一字不差，只应在首轮露出一次，
    // 其余收进折叠区——原样每条都显示时，诊断文字比回答本身还显眼。
    await expect(page.getByTestId('message-notice')).toHaveCount(1);
    // 引擎摘要每条回答都常显（不能把 Core 兜底冒充成 Hermes）
    await expect(page.locator('.ask-msg-details > summary')).toHaveCount(3);
    await expect(page.locator('.ask-msg-details > summary').first()).toContainText(
      '引擎 core-bounded',
    );

    const firstConvId = await page
      .getByTestId('conversation-item')
      .first()
      .getAttribute('data-conversation-id');
    expect(firstConvId).toBeTruthy();

    // 改名：列表内直接编辑，回车保存；Esc 取消不保存
    const firstItem = page.locator(
      `[data-testid="conversation-item"][data-conversation-id="${firstConvId}"]`,
    );
    await firstItem.getByTestId('conversation-rename').click();
    const renameInput = firstItem.getByTestId('conversation-rename-input');
    await expect(renameInput).toBeFocused();
    await renameInput.fill('系统名问答');
    await renameInput.press('Enter');
    await expect(firstItem).toContainText('系统名问答');
    await firstItem.getByTestId('conversation-rename').click();
    await firstItem.getByTestId('conversation-rename-input').fill('不该保存的名字');
    await firstItem.getByTestId('conversation-rename-input').press('Escape');
    await expect(firstItem.getByTestId('conversation-rename-input')).toHaveCount(0);
    await expect(firstItem).toContainText('系统名问答');
    await expect(firstItem).not.toContainText('不该保存的名字');

    await page.getByTestId('conversation-new').click();
    await askOnce(page, '这是第二个对话的问题', 2);
    await expect(page.getByTestId('message-list')).toContainText('第二对话的回答');
    await expect(page.getByTestId('message-list')).not.toContainText('第一答：正式系统名是 IXAEON');

    await page
      .locator(`[data-testid="conversation-item"][data-conversation-id="${firstConvId}"]`)
      .click();
    await expect(page.getByTestId('message-item')).toHaveCount(6, { timeout: 10_000 });
    await expect(page.getByTestId('message-list')).toContainText('第一答：正式系统名是 IXAEON');
    await expect(page.getByTestId('message-list')).not.toContainText('第二对话的回答');

    await page.screenshot({ path: join(shotDir, 'd6-chat.png') });
    await page.screenshot({ path: join(shotDir, '07-ask.png') });

    await app.close();

    ({ app, page } = await launchApp(dataDir, scriptPath));
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nav-ask').click();
    await expect(page.getByTestId('conversation-item').first()).toBeVisible();
    await page
      .locator(`[data-testid="conversation-item"][data-conversation-id="${firstConvId}"]`)
      .click();
    await expect(page.getByTestId('message-item')).toHaveCount(6, { timeout: 10_000 });
    await expect(page.getByTestId('message-list')).toContainText('引擎');
    await expect(page.getByTestId('message-list')).toContainText('模型');
    await app.close();

    const db = new Database(join(dataDir, 'ixaeon.db'));
    const assistant = db
      .prepare(
        `SELECT id, meta_json FROM messages
         WHERE conversation_id = ? AND role = 'assistant' AND seq = 2`,
      )
      .get(firstConvId) as { id: string; meta_json: string };
    const citations = [
      {
        ref: 'R1',
        segmentId: 'seg-1',
        sourceTitle: '用户纠正',
        role: 'user',
        excerpt: '正式名 IXAEON',
        isUserCorrection: true,
      },
    ];
    db.prepare('UPDATE messages SET citations_json = ? WHERE id = ?').run(
      JSON.stringify(citations),
      assistant.id,
    );

    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, seq, role, content, status, created_at, updated_at,
          run_id, engine, model_name, citations_json, meta_json, error_message)
       VALUES (?, ?, 7, 'assistant', '', 'failed', ?, ?, NULL, 'core-bounded', 'fake-model-v1', '[]', '{}', ?)`,
    ).run(
      randomUUID(),
      firstConvId,
      new Date().toISOString(),
      new Date().toISOString(),
      '引擎超时',
    );

    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, seq, role, content, status, created_at, updated_at,
          run_id, engine, model_name, citations_json, meta_json, error_message)
       VALUES (?, ?, 8, 'assistant', '已经写出的半截回答', 'cancelled', ?, ?, NULL, 'core-bounded', 'fake-model-v1', '[]', '{}', NULL)`,
    ).run(randomUUID(), firstConvId, new Date().toISOString(), new Date().toISOString());

    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    const taskId = randomUUID();
    db.prepare(
      `INSERT INTO coding_tasks (
         id, project_id, goal, scope_json, workspace_path, snapshot_ref, context_digest,
         allowed_commands_json, timeout_ms, status, version, approval_id, dispatch_key,
         generation, executor_name, executor_report_json, verify_status, verify_exit_code,
         verify_output, tests_modified, accepted_at, error, created_at, updated_at
       ) VALUES (?, ?, ?, '["note.txt"]', NULL, NULL, 'digest', '[]', 900000, 'draft', 1, NULL, NULL,
         0, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)`,
    ).run(taskId, project.id, '写一条 note.txt', now, now);

    const meta = JSON.parse(assistant.meta_json) as Record<string, unknown>;
    meta.proposedTasks = [
      { id: taskId, goal: '写一条 note.txt', status: 'draft', scope: ['note.txt'] },
    ];
    db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(
      JSON.stringify(meta),
      assistant.id,
    );
    db.close();

    ({ app, page } = await launchApp(dataDir, scriptPath));
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nav-ask').click();
    await page
      .locator(`[data-testid="conversation-item"][data-conversation-id="${firstConvId}"]`)
      .click();
    await expect(page.getByTestId('message-item')).toHaveCount(8, { timeout: 10_000 });
    await expect(page.getByTestId('message-list')).toContainText('失败：引擎超时');
    await expect(page.locator('[data-testid="message-item"][data-status="failed"]')).toBeVisible();
    await expect(page.getByTestId('message-list')).toContainText('已取消');
    await expect(page.getByTestId('message-list')).toContainText('已经写出的半截回答');
    await expect(
      page.locator('[data-testid="message-item"][data-status="cancelled"]'),
    ).toBeVisible();

    await page.getByTestId('ask-citations').getByRole('button').first().click();
    await expect(page.getByTestId('ask-citations')).toContainText('正式名 IXAEON');
    await expect(page.getByTestId('ask-citations')).toContainText('用户纠正');

    await expect(page.getByText('行动批准卡')).toBeVisible();
    await page.getByRole('button', { name: '批准并排队' }).click();
    await expect(page.getByText('已排队执行')).toBeVisible({ timeout: 15_000 });

    await app.close();
    expect(pageErrors).toEqual([]);
  });
});
