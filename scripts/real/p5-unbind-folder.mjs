/**
 * P5 真机检查（规格 P5「真机检查」1–5 条）：用 Playwright 驱动构建好的应用，全合成数据。
 * 目录对话框用 IXAEON_TEST_DIALOG_RESPONSES=directory|<合成文件夹> 替身；确认框用
 * page.on('dialog') 应答（先取消一次，再确认一次）。库里只输出条数和状态，不输出内容。
 *   node scripts/real/p5-unbind-folder.mjs   （先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');

const log = (...a) => console.log(...a);
const work = mkdtempSync(join(tmpdir(), 'ixa-p5-real-'));
const dataDir = join(work, 'data');
const synDir = join(work, 'syn');
mkdirSync(synDir, { recursive: true });
writeFileSync(join(synDir, 'note.txt'), '合成项目文件\n');
writeFileSync(join(synDir, 'plan.md'), '# 合成计划\n');
const git = (...args) => execFileSync('git', args, { cwd: synDir });
git('init', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');

let app = null;
let result = '没通过：脚本没跑完';
let passed = true;
const fail = (why) => {
  log('不符：', why);
  passed = false;
  result = `没通过：${why}`;
};
mkdirSync(dataDir, { recursive: true });
let db = null;
/** 应用起来、数据库建好之后再打开（只读，只输出条数和状态）。 */
const dbo = () => (db ??= new Database(join(dataDir, 'ixaeon.db'), { readonly: true }));
/** 库里文件夹授权的状态条数（只输出数字）。 */
const grantCounts = () =>
  dbo()
    .prepare(
      "SELECT status, count(*) AS n FROM permissions WHERE scope_type='folder' GROUP BY status",
    )
    .all();
/** 库里这文件夹下资料的授权状态各几条（只输出数字）。 */
const sourceCounts = () =>
  dbo()
    .prepare(
      'SELECT p.status, count(*) AS n FROM sources s JOIN permissions p ON p.id = s.permission_id GROUP BY p.status',
    )
    .all();
const statusOf = {
  queued: '排队',
  cancelled: '已取消',
};
const queuedTasks = () =>
  dbo()
    .prepare(
      "SELECT id, status FROM coding_tasks WHERE status IN ('queued','running','pending_verify','cancelled') ORDER BY created_at",
    )
    .all();

try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(work, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_CODEX_EXE: 'none',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${synDir}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('gpt-5.2');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('第一个项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

  const rowTextOf = async (id) =>
    (await page.getByTestId(`project-row-${id}`).innerText()).replace(/\s+/g, ' ').trim();

  // ---- 1. 新建项目 → 绑定合成文件夹 → 来源页导入一次 → 任务页建草案并批准（停在排队） ----
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 P5');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  const row = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await row.getAttribute('data-testid')).replace('project-row-', '');
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);
  log('[1] 绑定后项目行：', await rowTextOf(projId));

  // 来源页导入同一个文件夹（这样授权下有资料）
  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.locator('select').first().selectOption({ label: '合成项目 P5' });
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);
  log('[1] 导入后文件夹授权的状态条数：', JSON.stringify(grantCounts()));
  log('[1] 导入后资料的授权状态条数：', JSON.stringify(sourceCounts()));

  // 任务页建一个草案并批准（停在排队，不派发）
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('task-goal').fill('P5 真机草案');
  await page.locator('select').first().selectOption({ label: '合成项目 P5' });
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(800);
  log(
    '[1] 批准后的任务状态：',
    JSON.stringify(queuedTasks().map((t) => statusOf[t.status] ?? t.status)),
  );

  // ---- 2. 点「解除绑定」，先取消确认：项目行还显示路径；授权还有效、任务还在排队 ----
  await page.getByTestId('nav-projects').click();
  await page.waitForTimeout(400);
  const unbindBtn = page.getByTestId(`project-unbind-folder-${projId}`);
  if ((await unbindBtn.count()) === 0) fail('步骤 2：项目行没有「解除绑定」按钮');
  const before = JSON.stringify(grantCounts());
  await unbindBtn.click();
  await page.waitForTimeout(400);
  log('[2] 取消确认后项目行：', await rowTextOf(projId));
  log('[2] 取消确认后文件夹授权的状态条数：', JSON.stringify(grantCounts()));
  log(
    '[2] 取消确认后任务状态：',
    JSON.stringify(queuedTasks().map((t) => statusOf[t.status] ?? t.status)),
  );
  if (!(await rowTextOf(projId)).includes(synDir)) fail('步骤 2：取消确认后项目行不再显示路径');
  if (JSON.stringify(grantCounts()) !== before) fail('步骤 2：取消确认后授权状态变了');
  const stillChat = queuedTasks().filter((t) => t.status === 'queued');
  if (stillChat.length !== 1) fail('步骤 2：取消确认后任务不在排队（该还是排队）');

  // ---- 3. 再点一次，确认。----
  let dialogText = '';
  page.once('dialog', async (d) => {
    dialogText = d.message();
    await d.accept();
  });
  await page.waitForTimeout(200);
  await unbindBtn.click();
  await page.waitForTimeout(800);
  log('[3] 确认框文字（合成数据）：');
  log(
    dialogText
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n'),
  );
  log('[3] 确认后项目行：', await rowTextOf(projId));
  const resultEl = await page
    .getByTestId('project-unbind-result')
    .textContent()
    .catch(() => null);
  log('[3] 结果那句话：', (resultEl ?? '').replace(/\s+/g, ' ').trim());
  log('[3] 确认后文件夹授权的状态条数：', JSON.stringify(grantCounts()));
  log(
    '[3] 确认后任务状态：',
    JSON.stringify(queuedTasks().map((t) => statusOf[t.status] ?? t.status)),
  );
  log('[3] 确认后资料的授权状态条数：', JSON.stringify(sourceCounts()));
  if ((await rowTextOf(projId)).includes(synDir)) fail('步骤 3：确认后项目行还显示路径');
  if (!(await rowTextOf(projId)).includes('构想（未绑定目录）'))
    fail('步骤 3：项目行没变成「构想（未绑定目录）」');
  if (!dialogText.includes('解除「合成项目 P5」和这个文件夹的绑定？'))
    fail('步骤 3：确认框文字不对');
  const afterUnbind = queuedTasks();
  if (afterUnbind.length !== 1 || afterUnbind[0].status !== 'cancelled')
    fail('步骤 3：任务没有被取消');
  const activeGrants = grantCounts().filter((g) => g.status === 'active');
  const revokedGrants = grantCounts().filter((g) => g.status === 'revoked');
  // 这条文件夹只有一条有效授权（绑定和来源页导入复用同一条），撤销后就它变 revoked
  if (activeGrants.length !== 0 || revokedGrants.length !== 1)
    fail('步骤 3：授权状态条数不对（该是有效 0 条、已撤销 1 条）');

  // ---- 4. 任务页对一个新草案点「批准」：报「还没绑定文件夹」 ----
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('task-goal').fill('P5 真机第二个草案');
  await page.locator('select').first().selectOption({ label: '合成项目 P5' });
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(600);
  const errText = (
    (await page
      .locator('.error-banner')
      .textContent()
      .catch(() => null)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  log('[4] 批准报的错：', errText);
  if (!errText.includes('还没绑定文件夹')) fail('步骤 4：报的错不是「还没绑定文件夹」那句');

  // ---- 5. 重新绑定同一个文件夹 ----
  await page.getByTestId('nav-projects').click();
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);
  log('[5] 重新绑定后项目行：', await rowTextOf(projId));
  log('[5] 重新绑定后文件夹授权的状态条数：', JSON.stringify(grantCounts()));
  const rebind = grantCounts();
  if (
    rebind.filter((g) => g.status === 'active').length !== 1 ||
    rebind.filter((g) => g.status === 'revoked').length !== 1
  )
    fail('步骤 5：重新绑定后授权条数不对（该是有效 1 条、已撤销 1 条）');
  if (!(await rowTextOf(projId)).includes(synDir)) fail('步骤 5：重新绑定后项目行没显示路径');

  result =
    '通过：绑定 → 取消确认没变化 → 确认后路径清、授权撤、任务取消 → 批准报「还没绑定文件夹」 → 重新绑定成功';
} catch (err) {
  if (passed) {
    result = `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`;
    log('脚本出错：', result);
  }
} finally {
  if (db) {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
  if (app) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
log('RESULT', result);
process.exit(passed ? 0 : 1);
