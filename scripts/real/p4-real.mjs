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

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
const maskOut = (v) => {
  let text;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

const Database = desktopRequire('better-sqlite3');

const log = (...a) => console.log(...a);
/** 逐条对照，只有全都符合才写「通过」；出错非零（照 p5/p7 的规矩）。 */
let passed = true;
const fail = (why) => {
  passed = false;
  log('不符：', why);
};
const root = mkdtempSync(join(tmpdir(), 'ixa-p4-real-'));
const dataDir = join(root, 'data');
const synDir = join(root, 'syn');
mkdirSync(synDir, { recursive: true });
writeFileSync(join(synDir, 'note.txt'), '合成项目文件\n');

const env = {
  ...process.env,
  IXAEON_DATA_DIR: dataDir,
  // 照现在的规矩隔离：随机端口、不载嵌入模型、不碰真 Codex / 真 Hermes
  IXAEON_HTTP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  IXAEON_EMBED_MODEL: 'none',
  IXAEON_CODEX_EXE: 'none',
  IXAEON_HERMES_EXE: '',
  IXAEON_HERMES_HOME: '',
  HERMES_HOME: '',
  IXAEON_FAKE_MODEL: '1',
  IXAEON_TEST_DIALOG_RESPONSES: `directory|${synDir}`,
};
// 宿主要是带着 ELECTRON_RUN_AS_NODE（开发 agent 的 shell / 门禁都带），Electron 会当普通 node
// 跑、主进程里 app 是 undefined、窗口起不来。照 scripts/real/p8-delete-project.mjs 清掉。
delete env.ELECTRON_RUN_AS_NODE;

let app = null;
try {
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(root, 'profile')}`],
    env,
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
  const afterBind = await snapshot('绑定后（应显示合成目录路径、按钮消失）');
  const boundRow = afterBind.rows.find((r) => r.includes('合成项目 B')) ?? '';
  if (!boundRow.includes(synDir)) fail('绑定后项目行里没显示合成目录的完整路径');
  if (boundRow.includes('未绑定目录') || boundRow.includes('绑定文件夹')) {
    fail('绑定后项目行还写着「未绑定目录」或还留着绑定按钮');
  }
  if (afterBind.bindButtons.length !== 1) {
    fail(`绑定后应只剩第一个项目的绑定按钮，实际 ${afterBind.bindButtons.length} 个`);
  }

  // 库里授权条数（只输出数字，合成数据）
  const db = new Database(join(dataDir, 'ixaeon.db'), { readonly: true });
  const grants = db
    .prepare("SELECT count(*) n FROM permissions WHERE scope_type='folder' AND status='active'")
    .get();
  log(`[1] 数据库有效的 folder 授权条数（合成数据，仅数字）：${grants.n}`);
  if (grants.n !== 1) fail(`绑定后有效的 folder 授权应有 1 条，实际 ${grants.n} 条`);
  const rootRows = db.prepare('SELECT name, root_path FROM projects ORDER BY created_at').all();
  const boundCount = rootRows.filter((r) => r.root_path).length;
  if (boundCount !== 1) fail(`应只有 1 个项目绑了目录，实际 ${boundCount} 个`);
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
  if (fake.ok) fail('伪造票据居然绑定成功了');
  else if (!String(fake.message).includes('IXA0001')) {
    fail(`伪造票据该报 IXA0001，实际报：${fake.message}`);
  }

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
    '[3] 绑同一文件夹后的错误提示（期望含先绑的那个项目名「合成项目 B」）：',
    (errText ?? '（无错误横幅）').replace(/\s+/g, ' '),
  );
  // 提示里点名的是「先绑的那个项目」：这里先绑的是合成项目 B（第一个项目是向导建的、没绑）
  if (!errText || !errText.includes('合成项目 B')) {
    fail(`绑同一文件夹该提示「合成项目 B」，实际：${String(errText).slice(0, 80)}`);
  }

  await page.screenshot({ path: join(root, 'p4-real-final.png') });
  log('[4] 截图已存 p4-real-final.png（临时目录，跑完即删）；以上输出原样入交付说明。');
} catch (err) {
  passed = false;
  log('脚本出错：', err instanceof Error ? err.message : String(err));
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
log(
  'RESULT',
  passed
    ? '通过：绑定后路径与授权都对（1 条授权、1 个项目绑了目录、按钮消失）→ 伪造票据被拒（IXA0001）→ 绑同一文件夹被拒，提示里点名先绑的那个项目（合成项目 B）'
    : '没通过：上面有不符或脚本出错的那条',
);
process.exit(passed ? 0 : 1);
