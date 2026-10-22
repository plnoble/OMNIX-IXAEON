/** 命令逻辑（契约第 10 条）：`once` / `run [--exit-when-idle]` / `status` / `resume`。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  checkConfig,
  loadState,
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
process.exit(0);
