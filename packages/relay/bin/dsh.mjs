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
  // L6 契约第 1 条：让 DSH 里的 git 走 OpenSSL（这台机器上 schannel 握手失败）。
  // 用 `GIT_CONFIG_PARAMETERS`（git 拿它当 `-c` 用）而不是 `GIT_CONFIG_KEY_*`——后者名字里带 KEY，
  // 会被 DSH 的子进程层擦掉。原来的值放前面、空格隔开；不设 GIT_CONFIG_COUNT。
  const prev = process.env.GIT_CONFIG_PARAMETERS?.trim();
  const parameters = prev ? `${prev} 'http.sslBackend=openssl'` : "'http.sslBackend=openssl'";
  // L6b 契约第 1 条：DSH 自己的仓库根。没有设就设成它自己的当前目录（调度器起开发时的 cwd）——
  // 这样 DSH 里跑的 scripts/worktree.mjs 把工作目录建在它自己的根下面，git 只写自己的目录。
  const trees = process.env.IXAEON_WORKTREES?.trim() || process.cwd();
  // L14 契约第 3 条：DSH 的受限令牌下 Chromium 沙箱起不来，门禁里四套「真实 Electron」界面复审
  // 会崩在 0x80000003。只让**测试里起的** Electron 加 --no-sandbox（apps/desktop/test/review/
  // electron-args.ts 读它），应用本身和用户平时打开的 IXAEON 不读这个变量。
  const r = spawnSync(found.exe, ['--expose-internals', found.cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GIT_CONFIG_PARAMETERS: parameters,
      IXAEON_WORKTREES: trees,
      IXAEON_ELECTRON_NO_SANDBOX: '1',
    },
  });
  if (r.error) {
    console.error(`起不了 DSH：${r.error.message}`);
    process.exitCode = 1;
  } else {
    // 规格末尾第 2 条：结尾用 exitCode，不用 process.exit（这台机器上发过 HTTPS 再强退会崩）。
    process.exitCode = r.status ?? 1;
  }
}
