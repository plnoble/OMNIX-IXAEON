#!/usr/bin/env node
/**
 * L14 真机探针：工作区里的 `electron.exe` 起出来是什么完整性级别、写不写得了
 * `%TEMP%` / `%APPDATA%` / `%LOCALAPPDATA%`，单实例锁能不能建起来。
 *
 * 2026-10-23 的结论：DSH 的 Windows 沙箱给工作区打了低完整性标签；工作区里的
 * `electron.exe` 因此被降到 Low IL。Low IL 写不了 Medium 的 `%TEMP%`/`%APPDATA%`，
 * 应用在 `app.requestSingleInstanceLock()` 就失败退出——`--no-sandbox` 只修掉
 * `0x80000003`（Chromium 自己的沙箱），修不了这一层。
 *
 * 跑法：`node scripts/real/l14-electron-integrity.mjs`
 * 只写合成的探针文件（工作区 `.logs/` 与系统临时目录各一个，结束删掉）；
 * 输出只打标签，不打印用户目录。Windows 以外或没装 Electron 时直接跳过。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(REPO, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = join(REPO, '.logs', 'l14-integrity');
const PROBE = join(WORK, 'probe.cjs');
const PROFILE = join(WORK, 'profile');
const OUT = join(WORK, 'out.json');

if (process.platform !== 'win32' || !existsSync(EXE)) {
  console.log('跳过：只在 Windows 上、且装好 Electron 之后有数据');
  process.exit(0);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(
  PROBE,
  [
    "const { app } = require('electron');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const { execFileSync } = require('child_process');",
    'const lock = app.requestSingleInstanceLock();',
    'app.whenReady().then(() => {',
    '  const targets = {',
    '    TEMP: process.env.TEMP,',
    '    APPDATA: process.env.APPDATA,',
    '    LOCALAPPDATA: process.env.LOCALAPPDATA,',
    '    workspace: path.dirname(process.env.L14_PROBE_OUT),',
    '  };',
    '  const out = { lock, groups: "", writes: {} };',
    '  try {',
    "    out.groups = execFileSync('C:\\\\Windows\\\\System32\\\\whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' });",
    '  } catch (e) {',
    '    out.groups = String(e);',
    '  }',
    '  for (const [label, dir] of Object.entries(targets)) {',
    '    if (!dir) continue;',
    '    try {',
    "      fs.writeFileSync(path.join(dir, 'l14-probe-write.txt'), 'x');",
    "      fs.unlinkSync(path.join(dir, 'l14-probe-write.txt'));",
    "      out.writes[label] = 'ok';",
    '    } catch (e) {',
    '      out.writes[label] = String(e.code || e.message);',
    '    }',
    '  }',
    '  fs.writeFileSync(process.env.L14_PROBE_OUT, JSON.stringify(out));',
    '  app.exit(0);',
    '});',
    '',
  ].join('\n'),
  'utf8',
);

const env = { ...process.env, L14_PROBE_OUT: OUT };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(EXE, ['--no-sandbox', PROBE, `--user-data-dir=${PROFILE}`], {
  encoding: 'utf8',
  timeout: 60_000,
  windowsHide: true,
  env,
});

let data = null;
try {
  data = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  /* 下面按失败报 */
}

if (!data) {
  console.error(`✗ 探针没跑起来（status=${r.status ?? r.signal}）`);
  if (r.stderr) console.error(r.stderr.trim());
  process.exit(1);
}

/** 从 `whoami /groups` 里认完整性级别：S-1-16-4096=Low、8192=Medium、12288=High、16384=System。 */
const levelOf = (text) => {
  const m = /S-1-16-(\d+)/.exec(text);
  const names = { 4096: 'Low', 8192: 'Medium', 12288: 'High', 16384: 'System' };
  return m ? (names[Number(m[1])] ?? `S-1-16-${m[1]}`) : '没认出来';
};

console.log(`Electron 进程的完整性级别：${levelOf(data.groups)}（本机 shell 一般是 Medium）`);
console.log(`单实例锁（--user-data-dir 在工作区）：${data.lock}`);
for (const [label, result] of Object.entries(data.writes)) {
  console.log(`写 ${label}：${result}`);
}
console.log(
  '说明：Low 写不了 Medium 的目标；这不是 --no-sandbox 能修的（它只关 Chromium 自己的沙箱）。',
);

rmSync(WORK, { recursive: true, force: true });
