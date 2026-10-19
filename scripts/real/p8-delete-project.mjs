/**
 * P8 真机检查（规格 P8「真机检查」1–3 条）：用 Playwright 驱动构建好的应用，全合成数据。
 * 照 scripts/real/p7-revoke-reading.mjs 的写法：临时数据目录、随机端口、
 * IXAEON_EMBED_MODEL=none、IXAEON_CODEX_EXE=none、目录对话框替身、打印遮掉临时目录的两种写法、
 * 库里和硬盘上只输出条数、状态、有没有；只有全都符合才写通过；RESULT 和退出码一致；脚本出错非零。
 *   node scripts/real/p8-delete-project.mjs   （先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');
// 用桌面应用自己装的 Electron。不指定的话 Playwright 会去下它自己的一份，
// 这一份没下完就报 Process failed to launch。
const electronExe = desktopRequire('electron');

const work = mkdtempSync(join(tmpdir(), 'ixa-p8-real-'));
// 应用里存的是规范化过的路径，和 work 的写法可能不一样：两种都遮掉
const masks = [...new Set([work, realpathSync.native(work)])];
const mask = (s) => masks.reduce((acc, m) => acc.replaceAll(m, '<临时目录>'), s);
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));
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
  if (passed) result = `没通过：${why}`;
  passed = false;
};
mkdirSync(dataDir, { recursive: true });
let db = null;
/** 应用起来、数据库建好之后再打开（只读，只输出条数和状态）。 */
const dbo = () => (db ??= new Database(join(dataDir, 'ixaeon.db'), { readonly: true }));
/** 这份资料所在的那条授权（按资料查，不查「库里有没有有效的文件夹授权」）。 */
const grantOfSource = (sourceId) =>
  dbo()
    .prepare(
      'SELECT p.id, p.status FROM sources s JOIN permissions p ON p.id = s.permission_id WHERE s.id = ?',
    )
    .get(sourceId);
/** 这条授权下的资料，按授权状态各几条。 */
const sourceStatusUnder = (permissionId) =>
  dbo()
    .prepare(
      'SELECT p.status, count(*) AS n FROM sources s JOIN permissions p ON p.id = s.permission_id WHERE s.permission_id = ? GROUP BY p.status ORDER BY p.status',
    )
    .all(permissionId);
/** 数据目录 workspaces/ 下有几个目录（只输出个数）。 */
const workspaceCount = () => {
  const dir = join(dataDir, 'workspaces');
  return existsSync(dir) ? readdirSync(dir).length : 0;
};
/** 合成的项目文件夹里的文件还在不在（只输出有没有，不输出内容）。 */
const projectFilesPresent = () =>
  ['note.txt', 'plan.md', '.git'].every((name) => existsSync(join(synDir, name)));

try {
  // 宿主要是带着 ELECTRON_RUN_AS_NODE（这个检查有时从带这个变量的进程里跑），
  // Electron 会当成纯 Node 启动，Playwright 等不到调试端口，直接判启动失败。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronExe,
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(work, 'profile')}`],
    env: {
      ...env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      IXAEON_EMBED_MODEL: 'none',
      IXAEON_CODEX_EXE: 'none',
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${synDir}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
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

  const textOf = async (testId) =>
    (
      (await page
        .getByTestId(testId)
        .textContent({ timeout: 2000 })
        .catch(() => null)) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  const sourceIds = async () =>
    await page.evaluate(async () => {
      const list = await window.ixaeon.listSources({ projectId: null });
      return list.map((s) => s.source.id);
    });
  const projectGone = async (id) => (await page.getByTestId(`project-row-${id}`).count()) === 0;

  // ---- 1. 新建项目，绑定合成的 git 文件夹；来源页导入一次；一个做完（留下副本），一个停在排队 ----
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 P8');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  const row = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await row.getAttribute('data-testid')).replace('project-row-', '');
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);

  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.locator('select').first().selectOption({ label: '合成项目 P8' });
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);
  const imported = await sourceIds();
  if (imported.length === 0) throw new Error('步骤 1：导入后没有资料');
  const grant = grantOfSource(imported[0]);

  await page.getByTestId('nav-tasks').click();
  await page.waitForTimeout(400);
  await page.locator('select').first().selectOption({ label: '合成项目 P8' });
  // 验证命令留空：替身执行器写 note.txt，空命令的任务做完停在「待用户接受」，副本留着
  await page.getByTestId('task-verify').fill('');
  await page.getByTestId('task-goal').fill('P8 做完留下副本');
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '派发（Fake）' }).first().click();
  await page.getByText('待用户接受', { exact: false }).first().waitFor({ timeout: 20_000 });

  await page.getByTestId('task-goal').fill('P8 批准后停在排队');
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(800);

  const copiesBefore = workspaceCount();
  log('[1] workspaces/ 下的目录数：', copiesBefore);
  log('[1] 这条授权的状态：', grant.status);
  if (copiesBefore !== 2) fail(`步骤 1：副本目录数是 ${copiesBefore}，该是 2`);
  if (grant.status !== 'active') fail('步骤 1：这条授权不是有效');

  // ---- 2. 项目页点「删除」，先取消确认：项目还在，授权还有效，副本个数没变 ----
  await page.getByTestId('nav-projects').click();
  await page.waitForTimeout(400);
  accept = false;
  const asked = dialogs.length;
  await page.getByTestId(`project-delete-${projId}`).click();
  await page.waitForTimeout(600);
  const copiesAfterCancel = workspaceCount();
  log('[2] 问了几次（这一步）：', dialogs.length - asked);
  log('[2] 取消后项目还在：', !(await projectGone(projId)));
  log('[2] 取消后这条授权的状态：', grantOfSource(imported[0]).status);
  log('[2] 取消后 workspaces/ 下的目录数：', copiesAfterCancel);
  if (dialogs.length !== asked + 1) fail('步骤 2：点了「删除」没有问');
  if (await projectGone(projId)) fail('步骤 2：取消确认后项目没了');
  if (grantOfSource(imported[0]).status !== 'active') fail('步骤 2：取消确认后这条授权变了');
  if (copiesAfterCancel !== copiesBefore) fail('步骤 2：取消确认后副本个数变了');

  // ---- 3. 再点一次，确认 ----
  accept = true;
  await page.getByTestId(`project-delete-${projId}`).click();
  await page.waitForTimeout(800);
  const dialogText = dialogs.at(-1) ?? '';
  log('[3] 确认框文字（合成数据）：');
  log(
    dialogText
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n'),
  );
  const resultText = await textOf('project-delete-result');
  const under = sourceStatusUnder(grant.id);
  const copiesAfter = workspaceCount();
  const filesOk = projectFilesPresent();
  log('[3] 结果那句话：', resultText);
  log('[3] 项目列表里还有没有它：', !(await projectGone(projId)));
  log('[3] 这条授权的状态：', grantOfSource(imported[0]).status);
  log('[3] 这条授权下资料按授权状态的份数：', JSON.stringify(under));
  log('[3] workspaces/ 下的目录数：', copiesAfter);
  log('[3] 合成的项目文件夹里的文件还在：', filesOk);
  if (!dialogText.startsWith('删除项目「合成项目 P8」？\n\n')) fail('步骤 3：确认框文字不对');
  if (!dialogText.includes('- 这个文件夹的读取授权一并撤销。')) fail('步骤 3：确认框没说撤销授权');
  if (!dialogText.includes('- 有 1 个编码任务正在排队或执行，会被取消。'))
    fail('步骤 3：确认框没说要取消的任务');
  if (!(await projectGone(projId))) fail('步骤 3：确认后项目还在列表里');
  if (grantOfSource(imported[0]).status !== 'revoked') fail('步骤 3：这条授权没有撤销');
  if (under.length !== 1 || under[0].status !== 'revoked' || under[0].n < 1)
    fail('步骤 3：这条授权下的资料不是都已撤销');
  if (copiesAfter !== 0) fail('步骤 3：任务副本没有清掉');
  if (!filesOk) fail('步骤 3：合成的项目文件夹被改了');
  if (resultText !== '已删除项目「合成项目 P8」。这个文件夹的读取授权已撤销。取消了 1 个编码任务。')
    fail('步骤 3：结果那句话不对');

  if (passed)
    result =
      '通过：做完一个、排队一个（副本 2 个）→ 删除先取消（项目、这条授权、副本都没变）→ 确认（项目没了、这条授权撤销、资料都已撤销、副本清掉、项目文件夹原样）';
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
