/** 命令逻辑（契约第 10 条）：`init` / `once [--under <pid>]` / `run [--exit-when-idle]` / `status` / `resume`。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  checkConfig,
  ensureDeps,
  fetchMain,
  findSharedCheckout,
  git,
  loadState,
  oldRelayDir,
  pidAlive,
  readLedger,
  readLock,
  relayDir,
  releaseLock,
  runOnce,
  saveState,
  updateCodeCheckout,
  worktreesRoot,
  type RelayConfig,
  type RelayState,
} from '../src/index.js';
import { createNotifier, loadFeishuTarget } from '../src/notify/feishu.js';

/** 调度器所在的这份检出（不一定是主检出：从工作目录里跑时就是那个工作目录）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';
const dataDir = relayDir();
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

/** 用户本机的配置：只有这个命令行用，所以放在这里。 */
const loadConfig = (dir: string): RelayConfig =>
  JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as RelayConfig;

/**
 * L8：打印时把用户目录换成 `~`（仓库是公开的，账户名不能跟着进交付说明）。
 * 只改打印，不改 `state.json` / `ledger.jsonl` 里存的东西。
 * JSON 里的反斜杠是转义过的，所以三种写法都换一遍。
 */
const maskHome = (text: string): string => {
  const home = homedir();
  if (!home) return text;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [home, home.replaceAll('\\', '/'), JSON.stringify(home).slice(1, -1)];
  // Windows 的路径不区分大小写：`IXAEON_RELAY_DIR` 写小写盘符时也要认出来。
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  return forms.reduce((s, p) => s.replace(new RegExp(escape(p), flags), '~'), text);
};

/** Claude Code 的可执行文件：`%APPDATA%/npm/.../claude.exe`，再找 PATH 里的。都没有回 `null`。 */
const CLAUDE_REL = join('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const findClaudeExe = (): string | null => {
  const appdata = process.env.APPDATA?.trim();
  if (appdata) {
    const p = join(appdata, CLAUDE_REL);
    if (existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir.trim()) continue;
    // 整合方改（2026-10-23）：不认 claude.cmd——批处理不经 shell 起不了，调度器起角色不走 shell
    for (const name of process.platform === 'win32' ? ['claude.exe'] : ['claude']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
};

/**
 * `relay init`（L5 契约第 2 条）：一条命令生成真用的配置。
 * 形状照 `config.example.json`，把占位符换成这台机器现算的路径；`_` 开头的说明键不写进生成的文件。
 */
const buildConfig = (o: {
  dir: string;
  root: string;
  trees: string;
  intCwd: string;
  claude: string;
}): RelayConfig => {
  const example = JSON.parse(
    readFileSync(join(o.root, 'packages', 'relay', 'config.example.json'), 'utf8'),
  ) as RelayConfig & Record<string, unknown>;
  const bag = example as unknown as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (key.startsWith('_')) delete bag[key];
  }
  const integrator = example.roles.integrator;
  const developer = example.roles.developer;
  integrator.argv = integrator.argv.map((a) => {
    if (a === '<数据目录>/turns') return join(o.dir, 'turns');
    return a;
  });
  integrator.argv[0] = o.claude;
  integrator.cwd = o.intCwd;
  developer.argv = [
    'node',
    // L10 契约第 5 条：DSH 启动器也跟着新代码走（看门人那份代码在 <工作目录根>/relay-run）。
    '{relay_root}/packages/relay/bin/dsh.mjs',
    '--profile',
    'headless',
    '--json',
    '读 {prompt_file}，照里面做。',
  ];
  developer.cwd = join(o.trees, 'dsh');
  // L6 契约第 2 条：开发只提交，推送由调度器替它做（整合方不写这个字段）。
  developer.pushByRelay = true;
  return example;
};

const initCommand = async (dir: string): Promise<void> => {
  const file = join(dir, 'config.json');
  if (existsSync(file)) {
    console.log(`已经有配置了，没改：${file}`);
    return;
  }
  const root = REPO_ROOT;
  const trees = worktreesRoot();
  const intCwd = join(trees, 'relay-int');
  // 整合方补（2026-10-22）：建 relay-int 之前先拉一次 origin/main——CI 上跑临时分支时本地没有 origin/main。
  // 注意：这一步是真 HTTPS，所以后面一律用 exitCode、不用 process.exit（这台机器上发过 HTTPS 再强退会崩）。
  if (!(await fetchMain(root))) {
    console.error('拉不下来 origin/main，建不了整合方的工作目录');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(intCwd)) {
    const made = git(root, ['worktree', 'add', '--detach', intCwd, 'origin/main']);
    if (made.code !== 0) {
      console.error(`建不了整合方的工作目录：${made.out}`);
      process.exitCode = 1;
      return;
    }
  }
  // L6b 契约第 4 条：给 DSH 一套它自己的仓库——<工作目录根>/dsh 是它的根，里面的 repo 是本地克隆
  // （`.git` 在它自己里面，DSH 的沙箱才提交得了），origin 改成调度器所在仓库的 origin 地址。
  const dshRoot = join(trees, 'dsh');
  const devRepo = join(dshRoot, 'repo');
  if (!existsSync(devRepo)) {
    mkdirSync(dshRoot, { recursive: true });
    const cloned = git(root, ['clone', root, devRepo], 300_000);
    if (cloned.code !== 0) {
      console.error(`建不了开发的仓库：${cloned.out}`);
      process.exitCode = 1;
      return;
    }
    const originUrl = git(root, ['remote', 'get-url', 'origin']).out;
    if (originUrl) git(devRepo, ['remote', 'set-url', 'origin', originUrl]);
  }
  const claude = findClaudeExe();
  if (!claude) console.log('没找到 Claude Code 的可执行文件，配置里先写 claude，要手动改');
  const config = buildConfig({ dir, root, trees, intCwd, claude: claude ?? 'claude' });
  mkdirSync(join(dir, 'turns'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const checked = checkConfig(config);
  if (!checked.ok) {
    rmSync(file, { force: true });
    console.error(`写出来的配置不过，已经删掉：${checked.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`写好了：${file}`);
  console.log(`整合方的工作目录：${config.roles.integrator.cwd}`);
  console.log(`开发的工作目录：${config.roles.developer.cwd}`);
};

/** L10 契约第 1 条：看门人。每一轮换代码 → 起一个 `relay once --under <自己>` → 等它退出 → 看下一轮。 */
const childCli = (root: string): string => join(root, 'packages', 'relay', 'bin', 'relay.mjs');
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const watchdog = async (config: RelayConfig, state: RelayState): Promise<void> => {
  console.log(`看门人 ${process.pid}`);
  const codeEnv = process.env.IXAEON_RELAY_CODE?.trim();
  const codeRoot = codeEnv ? resolve(codeEnv) : join(worktreesRoot(), 'relay-run');
  const repo = findSharedCheckout();
  const exitWhenIdle = argv.includes('--exit-when-idle');
  const notifier = createNotifier(loadFeishuTarget(), (state.notify ??= { sent: {} }), {
    now: () => new Date(),
  });
  const idleMs = Math.max(1, config.idleSeconds) * 1000;
  let crashes = 0;
  let lastTurns = loadState(dataDir).turns ?? 0;

  for (;;) {
    // `IXAEON_RELAY_CODE` 有值 → 直接用那个目录，不建、不更新、不装依赖（测试/临时调试用）。
    if (!codeEnv) {
      if (repo && (await fetchMain(repo))) {
        const up = updateCodeCheckout(repo, codeRoot);
        if (up.note) console.log(`代码没换成最新的：${up.note}`);
        // 装不上就当这一轮没开（打一行日志，不停下，等下一轮）。
        if (ensureDeps(codeRoot) === 'failed') {
          console.log('没开棒：看门人那份代码装不上依赖');
          await sleep(idleMs);
          continue;
        }
      } else {
        console.log('拉不下来 origin/main，这一轮先不换代码');
        // 整合方改：第一轮就拉不下来时 relay-run 还没建，起子进程必失败，不该算崩。
        if (!existsSync(childCli(codeRoot))) {
          await sleep(idleMs);
          continue;
        }
      }
    }

    let stderr = '';
    let childPid = 0;
    const code = await new Promise<number | null>((done) => {
      const child = spawn(
        process.execPath,
        [childCli(codeRoot), 'once', '--under', String(process.pid)],
        {
          cwd: codeRoot,
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      childPid = child.pid ?? 0;
      child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
        process.stderr.write(d);
      });
      child.on('error', (e) => {
        stderr += `${e.message}\n`;
        done(null);
      });
      child.on('close', (c) => done(c));
    });
    console.log(`子进程 ${childPid} 退出 ${code ?? '?'}`);

    const after = loadState(dataDir);
    if (code === 0) {
      crashes = 0;
      if (after.stoppedReason) {
        console.log(
          `看门人退出：调度器停下了（${after.stoppedReason}）。处理完跑 relay resume，再起 relay run`,
        );
        return;
      }
      if ((after.turns ?? 0) > lastTurns) {
        lastTurns = after.turns ?? lastTurns;
        continue; // 跑了棒，马上下一轮
      }
      if (exitWhenIdle) return;
      await sleep(idleMs);
      continue;
    }

    // 崩了一次：第 1、2 次各等 idleSeconds × 1、× 5；第 3 次不再等，写原因、发 stopped、退出。
    crashes += 1;
    if (crashes >= 3) {
      const why = firstLine(stderr).slice(0, 200);
      after.stoppedReason = `调度器连着崩了 3 次：${why}`;
      after.notify = state.notify;
      saveState(dataDir, after);
      await notifier.notify({ kind: 'stopped', reason: after.stoppedReason });
      saveState(dataDir, after);
      return;
    }
    await sleep(idleMs * (crashes === 1 ? 1 : 5));
  }
};

const main = async (): Promise<void> => {
  if (!['init', 'once', 'run', 'status', 'resume'].includes(cmd)) {
    die(
      `用法：relay init | once [--under <pid>] | run [--exit-when-idle] | status | resume（数据目录 ${dataDir}）`,
    );
  }
  if (cmd === 'init') {
    await initCommand(dataDir);
    return;
  }
  const state = loadState(dataDir);

  if (cmd === 'status') {
    console.log(maskHome(JSON.stringify({ dataDir, state }, null, 2)));
    for (const row of readLedger(dataDir).slice(-5)) console.log(maskHome(JSON.stringify(row)));
    // L4 契约第 2 条：旧位置还有文件就多打一行（只打路径，不打内容）；不自动搬。
    // L10 契约第 6 条：Windows 上再认一处 `<LOCALAPPDATA>/IXAEON/relay`。
    const olds = [oldRelayDir()];
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
      olds.push(join(local, 'IXAEON', 'relay'));
    }
    for (const oldDir of olds) {
      if (['config.json', 'state.json', 'feishu.json'].some((f) => existsSync(join(oldDir, f)))) {
        console.log(maskHome(`旧的数据目录里还有文件：${oldDir}，请挪到 ${dataDir}`));
        break;
      }
    }
    return;
  }
  if (cmd === 'resume') {
    state.stoppedReason = null;
    saveState(dataDir, state);
    console.log('已清掉 stoppedReason，可以接着跑');
    return;
  }

  const config = loadConfig(dataDir);
  const checked = checkConfig(config);
  if (!checked.ok) die(`配置不过，不启动：${checked.reason}`);

  // L10 契约第 2 条：`once --under <pid>`——锁里就是那个活着的进程，当作已经拿到锁（不再拿、退出时也不放）。
  const underAt = argv.indexOf('--under');
  const under = underAt >= 0 ? Number(argv[underAt + 1]) : Number.NaN;
  const borrowed = Number.isInteger(under) && readLock(dataDir)?.pid === under && pidAlive(under);

  let acquired = false;
  if (!borrowed) {
    const lock = acquireLock(dataDir);
    if (!lock.ok) die(`不启动：${lock.reason}`);
    acquired = true;
  }
  try {
    if (cmd === 'once') {
      // 带 --under 时没活照 `run` 的样子发 idle。
      await runOnce(config, state, dataDir, { sendIdle: borrowed });
    } else {
      await watchdog(config, state);
    }
  } finally {
    if (acquired) releaseLock(dataDir);
  }
};

await main();
// 整合方改（2026-10-22）：这一棒可能发过飞书（真 HTTPS）。发过之后 process.exit 会在这台机器上
// （Windows + Node 24 + jiti）退出时断言失败崩掉（退出码 0xC0000409）。设 exitCode，让进程自己退。
process.exitCode = process.exitCode ?? 0;
