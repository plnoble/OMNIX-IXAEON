/**
 * L10 契约第 4 条：开棒前装好依赖（`pnpm-lock.yaml` 变了才装）。
 *
 * 记号文件 `<dir>/node_modules/.relay-lock-sha256` 里存装依赖时 `pnpm-lock.yaml` 的 sha256。
 * 没有记号、或和现在的不一样 → 装；成功了写记号、回 `'ok'`；失败回 `'failed'`、不写记号；一样 → `'skipped'`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARK = join('node_modules', '.relay-lock-sha256');
/** 默认的安装命令：固定字符串、不含外部输入；Windows 上 corepack 是 `.cmd`，要经 shell（照 scripts/worktree.mjs）。 */
const DEFAULT_INSTALL = 'corepack pnpm install --frozen-lockfile --prefer-offline';

/** `IXAEON_RELAY_INSTALL`（JSON 数组）有值就用它（测试用）。 */
function envInstall(): string[] | null {
  const raw = process.env.IXAEON_RELAY_INSTALL?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[];
    }
  } catch {
    /* 不是 JSON 就当没设 */
  }
  return null;
}

export function ensureDeps(dir: string, install?: string[]): 'ok' | 'skipped' | 'failed' {
  const lock = join(dir, 'pnpm-lock.yaml');
  if (!existsSync(lock)) return 'skipped';
  const sha = createHash('sha256').update(readFileSync(lock)).digest('hex');
  const mark = join(dir, MARK);
  if (existsSync(mark) && readFileSync(mark, 'utf8').trim() === sha) return 'skipped';

  const chosen = install ?? envInstall();
  const r = chosen
    ? spawnSync(chosen[0]!, chosen.slice(1), { cwd: dir, stdio: 'inherit', windowsHide: true })
    : spawnSync(DEFAULT_INSTALL, { cwd: dir, stdio: 'inherit', shell: true, windowsHide: true });
  if ((r.status ?? 1) !== 0) return 'failed';
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(mark, `${sha}\n`, 'utf8');
  return 'ok';
}
