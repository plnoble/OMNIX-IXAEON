#!/usr/bin/env node
/**
 * 接力调度器的命令行入口（契约第 10 条）：`relay once | run [--exit-when-idle] | status | resume`。
 *
 * 跑 TS 照 `scripts/real/run-batch.mjs` 找 jiti 的办法：先找 `node_modules/.pnpm/jiti@*` 里的
 * 真 JS 入口（`.bin/jiti.cmd` 是批处理包装，交给 node 解析会失败），再退到提升到根上的 jiti。
 * 逻辑在 `relay-main.ts` 里，这个文件只负责找 jiti、转发参数、原样转发退出码。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

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
