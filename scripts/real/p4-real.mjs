/**
 * P4 真机检查（规格 P4「真机检查」1–4 条）：用 Playwright 驱动构建好的应用，
 * 全合成数据；对话框用 IXAEON_TEST_DIALOG_RESPONSES=directory|<合成项目文件夹> 替身。
 *   node scripts/real/p4-real.mjs   （先 build）
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const Database = desktopRequire('better-sqlite3');

const log = (...a) => console.log(...a);
const root = mkdtempSync(join(tmpdir(), 'ixa-p4-real-'));
const dataDir = join(root, 'data');
const synDir = join(root, 'syn');
mkdirSync(synDir, { recursive: true });
writeFileSync(join(synDir, 'note.txt'), '合成项目文件\n');

let app = null;
try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      IXAEON_DATA_DIR: dataDir,
      IXAEON_FAKE_MODEL: '1',
      IXAEON_TEST_DIALOG_RESPONSES: `directory|${synDir}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // 过设置向导（端口与对话框状态照 smoke 的 launchApp 写法）
  await page.getByTestId('setup-next-1').click();
  await page.getByTestId('setup-model-name').fill('gpt-5.2');
  await page.getByTestId('setup-next-2').click();
  await page.getByTestId('setup-project-name').fill('第一个项目');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('main-nav').waitFor({ timeout: 20_000 });

  const snapshot = async (tag) => {
    const s = await page.evaluate(() => ({
      rows: Array.from(document.querySelectorAll('[data-testid^="project-row-"]')).map((el) =>
        el.innerText.replace(/\s+/g, ' ').trim(),
      ),
      bindButtons: Array.from(
        document.querySelectorAll('[data-testid^="project-bind-folder-"]'),
      ).map((el) => el.getAttribute('data-testid')),
    }));
    log(`[${tag}]`, JSON.stringify(s, null, 1));
    return s;
  };

  // 1) 新建一个项目 → 显示构想（未绑定目录）+ 按钮 → 绑定 → 路径显示、按钮消失
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 B');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  await snapshot('新建后');
  const newRow = page.locator('[data-testid^="project-row-"]').last();
  const projId = (await newRow.getAttribute('data-testid')).replace('project-row-', '');
  await page.getByTestId(`project-bind-folder-${projId}`).click();
  await page.waitForTimeout(800);
  await snapshot('绑定后（应显示合成目录路径、按钮消失）');

  // 库里授权条数（只输出数字，合成数据）
  const db = new Database(join(dataDir, 'ixaeon.db'), { readonly: true });
  const grants = db
    .prepare("SELECT count(*) n FROM permissions WHERE scope_type='folder' AND status='active'")
    .get();
  log(`[1] 数据库有效的 folder 授权条数（合成数据，仅数字）：${grants.n}`);
  const rootRows = db.prepare('SELECT name, root_path FROM projects ORDER BY created_at').all();
  log(
    '[1] 项目根目录（合成数据）：',
    JSON.stringify(rootRows.map((r) => ({ name: r.name, bound: !!r.root_path }))),
  );
  db.close();

  // 2) 页面里直接调伪造票据 → 报错、项目和授权不变
  const fake = await page.evaluate(async (id) => {
    try {
      const r = await window.ixaeon.bindProjectFolder({ ticket: '伪造票据', projectId: id });
      return { ok: true, value: r };
    } catch (e) {
      return { ok: false, message: String(e).slice(0, 120) };
    }
  }, projId);
  log('[2] 伪造票据结果：', JSON.stringify(fake));

  // 3) 再建一个项目绑同一文件夹 → 被拒，提示含第一个项目的名字
  await page.getByTestId('projects-new').click();
  await page.getByTestId('project-form-name').fill('合成项目 C');
  await page.getByTestId('project-form-save').click();
  await page.waitForTimeout(600);
  const row3 = page.locator('[data-testid^="project-row-"]').last();
  const proj3Id = (await row3.getAttribute('data-testid')).replace('project-row-', '');
  // 绕过按钮直接观察事件结果：点按钮后看错误提示是否带「第一个项目」
  await page.getByTestId(`project-bind-folder-${proj3Id}`).click();
  await page.waitForTimeout(800);
  const errText = await page
    .locator('.error-banner')
    .textContent()
    .catch(() => null);
  log(
    '[3] 绑同一文件夹后的错误提示（期望含「第一个项目」）：',
    (errText ?? '（无错误横幅）').replace(/\s+/g, ' '),
  );

  await page.screenshot({ path: join(root, 'p4-real-final.png') });
  log('[4] 截图已存 p4-real-final.png（临时目录，跑完即删）；以上输出原样入交付说明。');
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* noop */
    }
  }
  rmSync(root, { recursive: true, force: true });
}
