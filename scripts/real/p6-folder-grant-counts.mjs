/**
 * P6 之前看一眼真实库的形状：绑着文件夹的项目里，有几个的文件夹不在任何有效的读取授权之内
 * （P6 之后这些项目派不了编码任务，要先解除绑定、重新绑定）。
 *
 * 只输出数字：不打印项目名、路径、任务内容。读的是数据库的副本（拷到临时目录再开），不动原库。
 *
 *   node scripts/real/p6-folder-grant-counts.mjs [数据目录]
 *   （不给数据目录就照应用的办法找：IXAEON_DATA_DIR → bootstrap.json 里记的 → 默认位置）
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const Database = desktopRequire('better-sqlite3');

function findDataDir() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.IXAEON_DATA_DIR?.trim()) return process.env.IXAEON_DATA_DIR.trim();
  const base = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'OMNIX',
    'IXAEON',
  );
  try {
    const chosen = JSON.parse(readFileSync(join(base, 'bootstrap.json'), 'utf8')).dataDir;
    if (typeof chosen === 'string' && chosen.trim()) return chosen.trim();
  } catch {
    // 没有 bootstrap.json 或者读不了：用默认位置
  }
  return base;
}

const dataDir = findDataDir();
if (!existsSync(join(dataDir, 'ixaeon.db'))) {
  console.log('RESULT 没找到数据库（数据目录里没有 ixaeon.db）');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ixa-p6-counts-'));
let code = 0;
try {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = join(dataDir, `ixaeon.db${suffix}`);
    if (existsSync(src)) copyFileSync(src, join(tmp, `ixaeon.db${suffix}`));
  }
  const db = new Database(join(tmp, 'ixaeon.db'));
  const norm = (p) => {
    const r = resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  /** root 是不是 locator 自己或者在它下面。 */
  const inside = (locator, root) => {
    const l = norm(locator);
    const r = norm(root);
    return r === l || r.startsWith(l.endsWith(sep) ? l : l + sep);
  };
  const projects = db.prepare('SELECT id, root_path, status FROM projects').all();
  const grants = db
    .prepare("SELECT locator, status FROM permissions WHERE scope_type = 'folder'")
    .all();
  const bound = projects.filter((p) => p.root_path);
  const covered = (p) =>
    grants.some((g) => g.status === 'active' && inside(g.locator, p.root_path));
  const uncovered = bound.filter((p) => !covered(p));
  const hadRevoked = uncovered.filter((p) =>
    grants.some((g) => g.status === 'revoked' && inside(g.locator, p.root_path)),
  );
  const waiting = uncovered.length
    ? db
        .prepare(
          `SELECT status, count(*) AS n FROM coding_tasks
            WHERE project_id IN (${uncovered.map(() => '?').join(',')})
              AND status IN ('draft','waiting_approval','queued')
            GROUP BY status`,
        )
        .all(...uncovered.map((p) => p.id))
    : [];
  db.close();
  console.log('项目一共：', projects.length);
  console.log('绑着文件夹的：', bound.length);
  console.log('  文件夹在有效授权之内的：', bound.length - uncovered.length);
  console.log('  文件夹不在任何有效授权之内的：', uncovered.length);
  console.log('    其中有过授权、后来撤销了的：', hadRevoked.length);
  console.log('    其中从来没发过授权的：', uncovered.length - hadRevoked.length);
  console.log('    其中已归档的项目：', uncovered.filter((p) => p.status === 'archived').length);
  console.log('  这些项目里还没派出去的编码任务（按状态）：', JSON.stringify(waiting));
  console.log('RESULT 数完了');
} catch (err) {
  console.log('RESULT 脚本出错：', err instanceof Error ? err.message.split('\n')[0] : String(err));
  code = 1;
} finally {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
process.exit(code);
