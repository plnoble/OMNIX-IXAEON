/**
 * V2 排查监视器（本机临时，不入库）：在 smoke e2e 运行期间，以 150ms 采样
 * 监视 (1) %TEMP%/ixaeon-e2e-* 最新目录的 config.json setupComplete 值与
 * 修改时刻；(2) electron.exe 进程数变化（检验主进程是否重启）。
 * 用法：node scripts/real/v2-watch.mjs（与 smoke e2e 并行跑，持续 240s）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const T = 150;
const COUNT_ELECTRON = () => {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'").Count',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return r.stdout.trim();
};

function latestConfig() {
  const base = tmpdir();
  const dirs = readdirSync(base).filter((d) => d.startsWith('ixaeon-e2e-'));
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs);
  for (const d of dirs) {
    const cfg = join(base, d, 'config.json');
    if (existsSync(cfg)) return cfg;
  }
  return null;
}

let last = { setup: null, mtime: 0, procs: null };
const started = Date.now();
const end = started + 240_000;
const t = () => ((Date.now() - started) / 1000).toFixed(1);
while (Date.now() < end) {
  const cfg = latestConfig();
  let setup = null;
  let mtime = 0;
  if (cfg) {
    try {
      setup = /"setupComplete"\s*:\s*(true|false)/.exec(readFileSync(cfg, 'utf8'))?.[1] ?? 'none';
      mtime = statSync(cfg).mtimeMs;
    } catch {
      /* racing write */
    }
  }
  const procs = COUNT_ELECTRON();
  if (setup !== last.setup || Math.abs(mtime - last.mtime) > 2000 || procs !== last.procs) {
    console.log(
      `[+${t()}s] cfg=${cfg ?? 'none'} setup=${setup} mtime=${mtime} electronProcs=${procs}`,
    );
    last = { setup, mtime, procs };
  }
  await new Promise((r) => setTimeout(r, T));
}
console.log('[watch] done');
