/** 命令逻辑（契约第 10 条）：`once` / `run [--exit-when-idle]` / `status` / `resume`。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  checkConfig,
  loadState,
  oldRelayDir,
  readLedger,
  relayDir,
  releaseLock,
  runOnce,
  saveState,
  type RelayConfig,
} from '../src/index.js';

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

if (!['once', 'run', 'status', 'resume'].includes(cmd)) {
  die(`用法：relay once | run [--exit-when-idle] | status | resume（数据目录 ${dataDir}）`);
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
  process.exit(0);
}
if (cmd === 'resume') {
  state.stoppedReason = null;
  saveState(dataDir, state);
  console.log('已清掉 stoppedReason，可以接着跑');
  process.exit(0);
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
// 整合方改（2026-10-22）：这一棒可能发过飞书（真 HTTPS）。发过之后 process.exit 会在这台机器上
// （Windows + Node 24 + jiti）退出时断言失败崩掉（退出码 0xC0000409）。设 exitCode，让进程自己退。
process.exitCode = 0;
