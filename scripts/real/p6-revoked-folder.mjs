/**
 * P6 真机检查（规格 P6「真机检查」界面部分）：用 Playwright 驱动构建好的应用，全合成数据。
 * 绑定合成文件夹 → 来源页导入一次 → 对其中一份撤销读取（真 IPC，界面目前没有撤销按钮，
 * 见交付说明）→ 任务页建草案、点批准：打印报的错，并查临时库确认任务没批准、副本目录没建。
 * 照 scripts/real/p5-unbind-folder.mjs 的规矩：打印遮掉临时目录、随机端口、IXAEON_EMBED_MODEL=none、
 * IXAEON_CODEX_EXE=none；RESULT 和退出码一致，脚本自己出错也以非零码退出。
 *   node scripts/real/p6-revoked-folder.mjs   （先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');

const work = mkdtempSync(join(tmpdir(), 'ixa-p6-real-'));
const log = (...a) =>
  console.log(...a.map((v) => (typeof v === 'string' ? v.replaceAll(work, '<临时目录>') : v)));
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
const dbo = () => (db ??= new Database(join(dataDir, 'ixaeon.db'), { readonly: true }));
/** 库里这张任务的状态与有没有副本（只输出状态和有没有）。 */
const taskState = (goal) =>
  dbo()
    .prepare(
      'SELECT status, workspace_path FROM coding_tasks WHERE goal = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(goal);

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

  // 1. 新建项目并绑定合成文件夹；来源页导入一次（授权下有资料）
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 P6');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  const row = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await row.getAttribute('data-testid')).replace('project-row-', '');
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);
  await page.getByTestId('nav-sources').click();
  await page.waitForTimeout(400);
  await page.locator('select').first().selectOption({ label: '合成项目 P6' });
  await page.getByTestId('sources-import-folder').click();
  await page.waitForTimeout(2500);

  // 2. 对导入的其中一份撤销读取（真 IPC；界面上没有撤销按钮，见交付说明）
  const before = await page.evaluate(async () => {
    const list = await window.ixaeon.listSources({ projectId: null });
    return list.map((s) => s.source.id);
  });
  if (!before.length) fail('来源页导入后没有资料');
  const revoked = await page.evaluate(async (sourceId) => {
    try {
      await window.ixaeon.revokeSourceReading(sourceId);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: String(e).slice(0, 200) };
    }
  }, before[0]);
  log('[1] 撤销读取的结果：', JSON.stringify(revoked));
  if (!revoked.ok) fail('撤销读取没成功');

  // 3. 任务页建草案、点批准：打印报的错
  await page.getByTestId('nav-tasks').click();
  await page.getByTestId('task-goal').fill('P6 真机草案');
  await page.locator('select').first().selectOption({ label: '合成项目 P6' });
  await page.getByRole('button', { name: '创建草案' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '批准并排队' }).first().click();
  await page.waitForTimeout(600);
  const banner = (
    (await page
      .locator('.error-banner')
      .textContent()
      .catch(() => null)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  log('[2] 批准报的错（遮掉临时目录）：', banner);

  // 4. 查临时库：任务没批准、副本目录没建（只输出状态和有没有）
  const t = taskState('P6 真机草案');
  log(
    '[3] 库里这张任务：状态 =',
    t?.status,
    '；有没有副本目录 =',
    t?.workspace_path ? (existsSync(t.workspace_path) ? '有' : '有记录但目录不在') : '没有',
  );

  if (!banner.includes('授权已经撤销')) fail('报的错不是「授权已撤销」那句');
  if (!t || t.status !== 'draft') fail('任务被批准了（该还是 draft）');
  if (t.workspace_path) fail('建了任务副本（该没有）');
  result = '通过：撤销读取后批准报「授权已撤销」，任务保持草案、没建副本';
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
