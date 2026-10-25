#!/usr/bin/env node
/**
 * 接力调度器的命令行入口（契约第 10 条）：`relay once | run [--exit-when-idle] | forever | status | resume`。
 *
 * 跑 TS 照 `scripts/real/run-batch.mjs` 找 jiti 的办法：先找 `node_modules/.pnpm/jiti@*` 里的
 * 真 JS 入口（`.bin/jiti.cmd` 是批处理包装，交给 node 解析会失败），再退到提升到根上的 jiti。
 * 逻辑在 `relay-main.ts` 里，这个文件只负责找 jiti、转发参数、原样转发退出码。
 *
 * L18 契约第 1 条：`relay forever` 在找 jiti **之前**分出去——它自己不用 jiti、不读配置、不拿锁，
 * 所以它本身永远不需要换新：一直起 `relay run`，看门人用退出码 75（`selfupdate.ts` 的
 * RESTART_EXIT_CODE，两边写同一个数）表示「代码换了」，就马上再起一个。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

/** L18：工作目录根——照 packages/relay/src/datadir.ts 的 worktreesRoot() 在 .mjs 里写一份（不 import TS）。 */
function worktreesRoot() {
  const trees = process.env.IXAEON_WORKTREES?.trim();
  if (trees) return resolve(trees);
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  const common = (r.stdout ?? '').trim();
  const mainRoot = common ? dirname(common) : process.cwd();
  return resolve(mainRoot, '..', '..', 'Worktrees', 'IXAEON');
}

/** `relay forever`：一直起 `relay run`；75 = 代码换了，马上再起。防转圈：10 分钟里第 6 次 → 停。 */
async function forever(rest) {
  const selfEntry = join(here, 'relay.mjs');
  const pickEntry = () => {
    const code = process.env.IXAEON_RELAY_CODE?.trim();
    if (code) return resolve(code, 'packages', 'relay', 'bin', 'relay.mjs');
    const shared = join(worktreesRoot(), 'relay-run', 'packages', 'relay', 'bin', 'relay.mjs');
    return existsSync(shared) ? shared : selfEntry;
  };
  const restarts = [];
  for (;;) {
    const entry = pickEntry();
    const entryRoot = resolve(entry, '..', '..', '..', '..');
    const code = await new Promise((done) => {
      const child = spawn(process.execPath, [entry, 'run', ...rest], {
        cwd: entryRoot,
        stdio: 'inherit',
        env: { ...process.env, IXAEON_RELAY_FOREVER: '1' },
        windowsHide: true,
      });
      child.on('close', (c) => done(c));
    });
    if (code !== 75) process.exit(code ?? 1);
    console.log('relay run 的代码换了，重起');
    const now = Date.now();
    restarts.push(now);
    while (restarts.length > 0 && now - restarts[0] > 10 * 60_000) restarts.shift();
    if (restarts.length >= 6) {
      console.log('10 分钟里重起了 6 次，停下：看门人的代码和 relay-run 里的对不上');
      process.exit(1);
    }
  }
}

if (process.argv[2] === 'forever') {
  await forever(process.argv.slice(3));
  process.exit(0);
}

function findJiti() {
  const candidates = [];
  const pnpm = join(root, 'node_modules', '.pnpm');
  try {
    for (const dir of readdirSync(pnpm)) {
      if (dir.startsWith('jiti@')) {
        candidates.push(join(pnpm, dir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
      }
    }
  } catch {
    /* 没有 .pnpm 就看下一个 */
  }
  candidates.push(join(root, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
  return candidates.find((p) => existsSync(p)) ?? null;
}

const jiti = findJiti();
if (!jiti) {
  console.error(
    '没找到 jiti 的 CLI（node_modules/.pnpm/jiti@*/node_modules/jiti/lib/jiti-cli.mjs）',
  );
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 宿主带的这个会让 Electron/node 走错路
const r = spawnSync(
  process.execPath,
  [jiti, join(here, 'relay-main.ts'), ...process.argv.slice(2)],
  // 整合方改：在仓库根上跑（从别处启动时，数据目录和共用检出目录都会算错）；
  // 不设超时（relay run 本来就要一直转，到点被杀会留下孤儿进程）
  { cwd: root, stdio: 'inherit', env, windowsHide: true },
);
process.exit(r.status ?? 1);
