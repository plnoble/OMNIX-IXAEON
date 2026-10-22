/**
 * L3 真机检查的发送部分（由 l3-feishu-send.mjs 经 jiti 跑）。
 * 只打印「发成了 / 没发成 + 错误码」，不打印地址和密钥。
 *
 * feishu.json 在调度器的数据目录里：位置和调度器用同一套算法（packages/relay/src/datadir.ts：
 * IXAEON_RELAY_DIR 有值用它，否则 %LOCALAPPDATA%/IXAEON/relay）。2026-10-22 整合方改：
 * 原来写死的是 L4 之前的旧位置 <Worktrees>/IXAEON/relay。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { relayDir } from '../../packages/relay/src/datadir.js';
import { loadFeishuTarget, sendFeishu } from '../../packages/relay/src/notify/feishu.js';

const file = join(relayDir(), 'feishu.json');

if (!existsSync(file)) {
  console.log('没跑：用户还没配飞书机器人');
} else {
  const target = loadFeishuTarget(file);
  if (!target) {
    console.log('没发成 code=配置读不出来');
    process.exitCode = 1;
  } else {
    const sent = await sendFeishu('【IXAEON 接力】这是一条测试消息，不用回。', target);
    // 发过真 HTTPS 请求之后不能 process.exit——这台机器上（Windows + Node 24 + jiti）
    // 退出时会断言失败崩掉（退出码 0xC0000409）。设 exitCode，让进程自己退。
    if (sent.ok) {
      console.log('发成了');
    } else {
      const code = /code\s+(\S+)/.exec(sent.error)?.[1] ?? '未知';
      console.log(`没发成 code=${code}`);
      process.exitCode = 1;
    }
  }
}
