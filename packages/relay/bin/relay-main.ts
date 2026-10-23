/** 命令逻辑（契约第 10 条）：`init` / `once` / `run [--exit-when-idle]` / `status` / `resume`。 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  checkConfig,
  fetchMain,
  git,
  loadState,
  oldRelayDir,
  readLedger,
  relayDir,
  releaseLock,
  runOnce,
  saveState,
  worktreesRoot,
  type RelayConfig,
} from '../src/index.js';

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
    join(o.root, 'packages', 'relay', 'bin', 'dsh.mjs'),
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

const main = async (): Promise<void> => {
  if (!['init', 'once', 'run', 'status', 'resume'].includes(cmd)) {
    die(
      `用法：relay init | once | run [--exit-when-idle] | status | resume（数据目录 ${dataDir}）`,
    );
  }
  if (cmd === 'init') {
    await initCommand(dataDir);
    return;
  }
  const state = loadState(dataDir);

  if (cmd === 'status') {
    console.log(JSON.stringify({ dataDir, state }, null, 2));
    for (const row of readLedger(dataDir).slice(-5)) console.log(JSON.stringify(row));
    // L4 契约第 2 条：旧位置还有文件就多打一行（只打路径，不打内容）；不自动搬。
    const oldDir = oldRelayDir();
    if (['config.json', 'state.json', 'feishu.json'].some((f) => existsSync(join(oldDir, f)))) {
      console.log(`旧的数据目录里还有文件：${oldDir}，请挪到 ${dataDir}`);
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
  const lock = acquireLock(dataDir);
  if (!lock.ok) die(`不启动：${lock.reason}`);
  try {
    if (cmd === 'once') {
      await runOnce(config, state, dataDir, { sendIdle: false });
    } else {
      // 一直转：有活就跑，没活等 idleSeconds 再看；停住就退出；--exit-when-idle 时第一次没活就退。
      for (;;) {
        const outcome = await runOnce(config, state, dataDir, { sendIdle: true });
        if (outcome === 'stopped') break;
        if (outcome !== 'idle') continue;
        if (argv.includes('--exit-when-idle')) break;
        await new Promise((r) => setTimeout(r, Math.max(1, config.idleSeconds) * 1000));
      }
    }
  } finally {
    releaseLock(dataDir);
  }
};

await main();
// 整合方改（2026-10-22）：这一棒可能发过飞书（真 HTTPS）。发过之后 process.exit 会在这台机器上
// （Windows + Node 24 + jiti）退出时断言失败崩掉（退出码 0xC0000409）。设 exitCode，让进程自己退。
process.exitCode = process.exitCode ?? 0;
