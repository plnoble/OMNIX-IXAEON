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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');

const work = mkdtempSync(join(tmpdir(), 'ixa-p7-real-'));
// 应用里存的是规范化过的路径，和 work 的写法可能不一样：两种都遮掉
const masks = [...new Set([work, realpathSync.native(work)])];
const mask = (s) => masks.reduce((acc, m) => acc.replaceAll(m, '<临时目录>'), s);
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));
const dataDir = join(work, 'data');
const synA = join(work, 'synA');
const synB = join(work, 'synB');
mkdirSync(synA, { recursive: true });
writeFileSync(join(synA, 'note.txt'), '合成资料：没绑项目的文件夹\n');
mkdirSync(synB, { recursive: true });
writeFileSync(join(synB, 'readme.md'), '# 合成资料：项目绑着的文件夹\n');

let app = null;
let result = '没通过：脚本没跑完';
let passed = true;
const fail = (why) => {
  log('不符：', why);
  if (passed) result = `没通过：${why}`;
  passed = false;
};
mkdirSync(dataDir, { recursive: true });
let db = null;
const dbo = () => (db ??= new Database(join(dataDir, 'ixaeon.db'), { readonly: true }));
const folderGrantCounts = () =>
  dbo()
    .prepare(
      "SELECT status, count(*) AS n FROM permissions WHERE scope_type='folder' GROUP BY status ORDER BY status",
    )
    .all();
const grantOf = (sourceId) =>
  dbo()
    .prepare(
      'SELECT p.id, p.status FROM sources s JOIN permissions p ON p.id = s.permission_id WHERE s.id = ?',
    )
    .get(sourceId);
const sourcesUnder = (permissionId) =>
  dbo().prepare('SELECT count(*) AS n FROM sources WHERE permission_id = ?').get(permissionId).n;
const sourceStatusCounts = () =>
  dbo()
    .prepare(
      'SELECT p.status, count(*) AS n FROM sources s JOIN permissions p ON p.id = s.permission_id GROUP BY p.status ORDER BY p.status',
    )
    .all();

try {
  // 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell 与门禁都带），Electron 会当普通
  // node 跑、主进程里 app 是 undefined、Playwright 报「Process failed to launch!」。
  // 照 scripts/real/p8-delete-project.mjs 清掉。
  const env = {
    ...process.env,
    IXAEON_DATA_DIR: dataDir,
    IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
    IXAEON_EMBED_MODEL: 'none',
    IXAEON_CODEX_EXE: 'none',
    IXAEON_FAKE_MODEL: '1',
    IXAEON_TEST_DIALOG_RESPONSES: `directory|${synA}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(work, 'profile')}`],
    env,
  });
  // 目录对话框替身每次都现读环境变量：换文件夹就改主进程里的这个变量
  const pickDirectory = (dir) =>
    app.evaluate((_electron, v) => {
      process.env.IXAEON_TEST_DIALOG_RESPONSES = v;
    }, `directory|${dir}`);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // 确认框：记下每一次问了什么；accept 决定这一次点确认还是取消
  const dialogs = [];
  let accept = false;
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await (accept ? d.accept() : d.dismiss());
  });
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
  const textOf = async (testId) =>
    (
      (await page
        .getByTestId(testId)
        .textContent({ timeout: 2000 })
        .catch(() => null)) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();

  // ---- 1. 来源页导入一个合成文件夹（不绑项目）→ 打开详情 → 撤销读取 → 先取消确认 ----
  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);
  const ids1 = await sourceIds();
  log('[1] 导入后资料份数：', ids1.length);
  if (ids1.length === 0) throw new Error('步骤 1：导入后没有资料');
  const grantA = grantOf(ids1[0]);
  log('[1] 导入后 folder 授权状态条数：', JSON.stringify(folderGrantCounts()));
  await page.getByTestId(`source-row-${ids1[0]}`).click();
  await page.waitForTimeout(500);
  accept = false;
  await page.getByTestId('source-revoke-reading').click();
  await page.waitForTimeout(600);
  log('[1] 问了几次：', dialogs.length);
  log('[1] 取消确认后这条授权的状态：', grantOf(ids1[0]).status);
  if (dialogs.length !== 1) fail('步骤 1：点了「撤销读取」没有问');
  if (grantOf(ids1[0]).status !== 'active') fail('步骤 1：取消确认后授权变了');

  // ---- 2. 再点一次，确认 ----
  accept = true;
  await page.getByTestId('source-revoke-reading').click();
  await page.waitForTimeout(800);
  const dialogText = dialogs[1] ?? '';
  log('[2] 确认框文字（合成数据）：');
  log(
    dialogText
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n'),
  );
  const resultText = await textOf('source-revoke-result');
  const underA = sourcesUnder(grantA.id);
  log('[2] 结果那句话：', resultText);
  log('[2] 确认后这条授权的状态：', grantOf(ids1[0]).status);
  log('[2] 这条授权下的资料份数：', underA);
  log('[2] 确认后资料按授权状态的份数：', JSON.stringify(sourceStatusCounts()));
  log('[2] 详情卡片还开着：', await page.getByTestId('source-detail').isVisible());
  const rowText = await page
    .getByTestId(`source-row-${ids1[0]}`)
    .innerText()
    .catch(() => '');
  log('[2] 列表里那一行现在显示：', rowText.replace(/\s+/g, ' ').trim().slice(0, 120));
  if (!dialogText.startsWith('撤销这个文件夹的读取授权？\n\n')) fail('步骤 2：确认框文字不对');
  if (grantOf(ids1[0]).status !== 'revoked') fail('步骤 2：确认后授权没有撤销');
  if (resultText !== `已撤销读取授权：${underA} 份资料不再读原文。`) fail('步骤 2：结果那句话不对');
  if (!rowText.includes('授权已撤销')) fail('步骤 2：列表那一行没显示授权已撤销');

  // ---- 3. 新建项目绑另一个合成文件夹，从来源页把它也导入一次 → 撤销读取 → 叫去项目页 ----
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 P7');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  const row = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await row.getAttribute('data-testid')).replace('project-row-', '');
  await pickDirectory(synB);
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);
  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.locator('select').first().selectOption({ label: '合成项目 P7' });
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);
  const newId = (await sourceIds()).find((id) => !ids1.includes(id));
  if (!newId) throw new Error('步骤 3：导入项目的文件夹没有新资料');
  await page.getByTestId(`source-row-${newId}`).click();
  await page.waitForTimeout(500);
  const asked = dialogs.length;
  await page.getByTestId('source-revoke-reading').click();
  await page.waitForTimeout(600);
  const note = await textOf('source-revoke-note');
  log('[3] 显示的那句话：', note);
  log('[3] 问了几次（这一步）：', dialogs.length - asked);
  log('[3] 这条授权的状态：', grantOf(newId).status);
  log('[3] 最后 folder 授权状态条数：', JSON.stringify(folderGrantCounts()));
  if (
    note !==
    '项目「合成项目 P7」正靠这条授权读它的文件夹：到项目页对它点「解除绑定」，会一并撤销这个文件夹的读取授权。'
  )
    fail('步骤 3：那句不是叫去项目页解除绑定');
  if (dialogs.length !== asked) fail('步骤 3：有项目靠着还是问了');
  if (grantOf(newId).status !== 'active') fail('步骤 3：项目绑着的那条授权没保持有效');

  if (passed)
    result =
      '通过：导入→撤销读取先取消（授权还在）→ 确认（授权撤销、列表显示已撤销、结果句数字对）→ 项目绑着的文件夹只显示「去项目页解除绑定」、不问、授权有效';
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
log('RESULT', result);
process.exit(passed ? 0 : 1);
