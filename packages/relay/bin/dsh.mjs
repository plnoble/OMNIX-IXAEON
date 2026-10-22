#!/usr/bin/env node
/**
 * DSH 启动器（L4 契约第 1 条）：`dsh.cmd` 是批处理，Node 不经 shell 起不了。
 * 这里直接起 `DeepSeek Harness.exe --expose-internals <app.asar 里的 cli.js>`，环境里设
 * `ELECTRON_RUN_AS_NODE=1`；自己收到的参数原样接在后面，标准输出、错误输出、退出码原样回来。
 * 只找安装目录、只转参数：**不加、不改任何权限相关的参数和环境变量**（不设 DSH_PERMISSION_MODE）。
 *
 * 找安装目录：`IXAEON_DSH_INSTALL` 有值就只认它（规格末尾第 1 条），否则依次试
 * `D:/Agent/DeepSeek Harness/Install`、`%LOCALAPPDATA%/Programs/DeepSeek Harness`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CLI_IN_ASAR = join(
  'resources',
  'app.asar',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'dsh-desktop-host',
  'lib',
  'cli.js',
);

function findInstall() {
  const env = process.env.IXAEON_DSH_INSTALL?.trim();
  const local = process.env.LOCALAPPDATA?.trim();
  const candidates = env
    ? [env]
    : [
        'D:/Agent/DeepSeek Harness/Install',
        local ? join(local, 'Programs', 'DeepSeek Harness') : '',
      ];
  for (const install of candidates.filter((x) => x)) {
    const exe = join(install, 'DeepSeek Harness.exe');
    // 注意：`resources/app.asar` 在真机上是一个**文件**（cli.js 在它里面，只有 Electron 的 fs 能穿过去），
    // 所以探到 `app.asar` 这一层就够——不能再往里探 cli.js，普通 node 探不到（假安装目录里它是真文件，会漏掉这条）。
    const asar = join(install, 'resources', 'app.asar');
    if (existsSync(exe) && existsSync(asar)) return { exe, cli: join(install, CLI_IN_ASAR) };
  }
  return null;
}

const found = findInstall();
if (!found) {
  console.error('没找到 DSH 的安装目录');
  process.exitCode = 2;
} else {
  const r = spawnSync(found.exe, ['--expose-internals', found.cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error) {
    console.error(`起不了 DSH：${r.error.message}`);
    process.exitCode = 1;
  } else {
    // 规格末尾第 2 条：结尾用 exitCode，不用 process.exit（这台机器上发过 HTTPS 再强退会崩）。
    process.exitCode = r.status ?? 1;
  }
}
