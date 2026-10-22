/**
 * L3 真机检查的发送部分（由 l3-feishu-send.mjs 经 jiti 跑）。
 * 只打印「发成了 / 没发成 + 错误码」，不打印地址和密钥。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadFeishuTarget, sendFeishu } from '../../packages/relay/src/notify/feishu.js';

// 跑批器要求真机脚本自带临时目录。这里建一个空的，用完就删，不往里面放配置。
const scratch = mkdtempSync(join(tmpdir(), 'ixa-l3-real-'));
rmSync(scratch, { recursive: true, force: true });

const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
  windowsHide: true,
});
const common = (git.stdout ?? '').trim();
const fromEnv = process.env.IXAEON_WORKTREES?.trim();
const root = fromEnv
  ? resolve(fromEnv)
  : resolve(common ? dirname(common) : process.cwd(), '..', '..', 'Worktrees', 'IXAEON');
const file = join(root, 'relay', 'feishu.json');

if (!existsSync(file)) {
  console.log('没跑：用户还没配飞书机器人');
  process.exit(0);
}
const target = loadFeishuTarget(file);
if (!target) {
  console.log('没发成 code=配置读不出来');
  process.exit(1);
}
const sent = await sendFeishu('【IXAEON 接力】这是一条测试消息，不用回。', target);
// 整合方改（2026-10-22）：发过真 HTTPS 请求之后不能 process.exit——这台机器上（Windows + Node 24 + jiti）
// 退出时会断言失败崩掉（退出码 0xC0000409）。设 exitCode，让进程自己退。
if (sent.ok) {
  console.log('发成了');
} else {
  const code = /code\s+(\S+)/.exec(sent.error)?.[1] ?? '未知';
  console.log(`没发成 code=${code}`);
  process.exitCode = 1;
}
