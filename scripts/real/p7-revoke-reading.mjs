/**
 * P7 真机检查（规格 P7「真机检查」1–3 条）：用 Playwright 驱动构建好的应用，全合成数据。
 * 照 scripts/real/p5-unbind-folder.mjs 与 p6-revoked-folder.mjs 的规矩：临时数据目录、
 * 随机端口、IXAEON_EMBED_MODEL=none、IXAEON_CODEX_EXE=none、目录对话框替身、
 * 打印遮掉临时目录、库里只输出条数和状态、RESULT 和退出码一致、脚本出错非零。
 *   node scripts/real/p7-revoke-reading.mjs   （先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');

const work = mkdtempSync(join(tmpdir(), 'ixa-p7-real-'));
const log = (...a) =>
  console.log(...a.map((v) => (typeof v === 'string' ? v.replaceAll(work, '<临时目录>') : v)));
const dataDir = join(work, 'data');
const synA = join(work, 'synA');
const synB = join(work, 'synB');
for (const d of [synA, synB]) {
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'note.txt'), '合成项目文件\n');
}
const git = (...args) => execFileSync('git', args, { cwd: synB });
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
const dbo = () => (db ??= new Database(join(dataDir, 'ixaeon.db'), { readonly: true }));
const folderGrantCounts = () =>
  dbo()
    .prepare(
      "SELECT status, count(*) AS n FROM permissions WHERE scope_type='folder' GROUP BY status",
    )
    .all();
const sourceCounts = () =>
  dbo()
    .prepare(
      'SELECT p.status, count(*) AS n FROM sources s JOIN permissions p ON p.id = s.permission_id GROUP BY p.status',
    )
    .all();

try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(work, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      IXAEON_EMBED_MODEL: 'none',
      IXAEON_CODEX_EXE: 'none',
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${synA}`,
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

  const sourceIds = async () =>
    await page.evaluate(async () => {
      const list = await window.ixaeon.listSources({ projectId: null });
      return list.map((s) => s.source.id);
    });

  // ---- 1. 来源页导入一个合成文件夹（不绑项目）→ 打开详情 → 撤销读取 → 先取消确认 ----
  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);
  log('[1] 导入后 folder 授权状态条数：', JSON.stringify(folderGrantCounts()));
  const ids1 = await sourceIds();
  if (ids1.length === 0) fail('步骤 1：导入后没有资料');
  await page.getByTestId(`source-row-${ids1[0]}`).click();
  await page.waitForTimeout(500);
  await page.getByTestId('source-revoke-reading').click();
  await page.waitForTimeout(400); // 无监听器，Playwright 自动 dismiss = 取消
  log('[1] 取消确认后 folder 授权状态条数：', JSON.stringify(folderGrantCounts()));
  const afterCancel = folderGrantCounts().filter((g) => g.status === 'active');
  if (afterCancel.length !== 1) fail('步骤 1：取消确认后授权状态变了');

  // ---- 2. 再点一次，确认 ----
  let dialogText = '';
  page.once('dialog', async (d) => {
    dialogText = d.message();
    await d.accept();
  });
  await page.waitForTimeout(200);
  await page.getByTestId('source-revoke-reading').click();
  await page.waitForTimeout(600);
  log('[2] 确认框文字（合成数据）：');
  log(
    dialogText
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n'),
  );
  const resultText = (
    (await page
      .getByTestId('source-revoke-result')
      .textContent()
      .catch(() => null)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  log('[2] 结果那句话：', resultText);
  log('[2] 确认后 folder 授权状态条数：', JSON.stringify(folderGrantCounts()));
  log('[2] 确认后资料的授权状态条数：', JSON.stringify(sourceCounts()));
  const rowText = await page
    .getByTestId(`source-row-${ids1[0]}`)
    .innerText()
    .catch(() => '');
  log('[2] 列表里那一行现在显示：', rowText.replace(/\s+/g, ' ').trim().slice(0, 120));
  const revoked = folderGrantCounts().filter((g) => g.status === 'revoked');
  if (!dialogText.includes('撤销这个文件夹的读取授权？')) fail('步骤 2：确认框文字不对');
  if (revoked.length !== 1) fail('步骤 2：确认后授权没有撤销');
  if (!resultText.includes('份资料')) fail('步骤 2：结果那句话不对');

  // ---- 3. 新建项目绑另一个文件夹 + 导入 → 详情撤销读取 → 显示「去项目页解除绑定」且授权有效 ----
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 P7');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  const row = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await row.getAttribute('data-testid')).replace('project-row-', '');
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);
  // 导入按内容去重：给合成文件夹加一个新文件，这次导入才有新资料
  writeFileSync(join(synA, 'second.md'), '# 第二个合成文件\n');
  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.locator('select').first().selectOption({ label: '合成项目 P7' });
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);
  const ids3 = await sourceIds();
  const newId = ids3.find((id) => !ids1.includes(id));
  if (!newId) fail('步骤 3：第二次导入没有新资料');
  await page.getByTestId(`source-row-${newId}`).click();
  await page.waitForTimeout(500);
  // 收起上一次的结果句不影响
  await page.getByTestId('source-revoke-reading').click();
  await page.waitForTimeout(500);
  const note = (
    (await page
      .getByTestId('source-revoke-note')
      .textContent()
      .catch(() => null)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  log('[3] 显示的那句话：', note);
  log('[3] 最后 folder 授权状态条数：', JSON.stringify(folderGrantCounts()));
  if (!note.includes('解除绑定')) fail('步骤 3：那句不是叫去项目页解除绑定');
  const active = folderGrantCounts().filter((g) => g.status === 'active');
  if (active.length !== 1) fail('步骤 3：绑定的那条授权没保持有效');

  result =
    '通过：导入→撤销读取先取消（授权还在）→ 确认（授权撤销、资料带状态、结果句）→ 绑项目的文件夹显示「去项目页解除绑定」且授权有效';
} catch (err) {
  passed = false;
  result = `没通过：脚本出错：${err instanceof Error ? err.message : String(err)}`;
  log('脚本出错：', result);
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
log('RESULT', result.replaceAll(work, '<临时目录>'));
process.exit(passed ? 0 : 1);
