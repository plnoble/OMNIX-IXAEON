/**
 * L3 真机检查（规格「真机检查」）：用户配好了飞书机器人就发一条合成测试消息。
 *
 * feishu.json 的路径照 scripts/worktree.mjs 现算，不写死：
 *   IXAEON_WORKTREES 有值用它，否则主检出往上两级的 Worktrees/IXAEON，再加 relay/feishu.json。
 * 文件在就发「【IXAEON 接力】这是一条测试消息，不用回。」，只打印「发成了 / 没发成 + 错误码」。
 * 文件不在就不发，退出码 0，打印「没跑：用户还没配飞书机器人」。
 * 不打印地址和密钥。真正发的逻辑在 l3-feishu-send.ts，这里只负责找 jiti 跑它
 * （照 scripts/real/run-batch.mjs：要真的 JS 入口，不要 .bin 里的批处理包装）。
 *   node scripts/real/l3-feishu-send.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 跑批器要求真机脚本自带临时目录。这里建一个空的，用完就删。
const scratch = mkdtempSync(join(tmpdir(), 'ixa-l3-real-'));
rmSync(scratch, { recursive: true, force: true });

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

function findJiti() {
  const found = [];
  try {
    for (const dir of readdirSync(join(repo, 'node_modules', '.pnpm'))) {
      if (dir.startsWith('jiti@')) {
        found.push(
          join(repo, 'node_modules', '.pnpm', dir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'),
        );
      }
    }
  } catch {
    /* 没有 .pnpm 就看下一个 */
  }
  found.push(join(repo, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
  return found.find((p) => existsSync(p)) ?? null;
}

const jiti = findJiti();
if (!jiti) {
  console.log('没发成 code=找不到jiti');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(process.execPath, [jiti, join(here, 'l3-feishu-send.ts')], {
  cwd: repo,
  stdio: 'inherit',
  env,
  windowsHide: true,
  timeout: 120_000,
});
process.exit(r.status ?? 1);
