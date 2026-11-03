/**
 * CF3 真机检查·甲用的假 OpenAI 兼容网关（不是被测代码，是检查工具）。
 *
 *   node scripts/real/cf3-fake-gateway.mjs
 *
 * - 监听 127.0.0.1 的随机端口，打印一行 `PORT=<端口>`，之后一直跑（Ctrl+C 结束）。
 * - `GET /v1/models`：给出一个合成模型 demo-a（应用里要选它）。
 * - `POST /v1/chat/completions`：第一次请求先回一个 search_memory 的工具调用；
 *   之后按 `data:` 分段把正文吐出去（含 [DONE]），模拟真流式。
 * - 只看请求里有没有 role:tool 消息来判断「第一次」还是「第二次」，不存状态。
 * - 不打印请求正文（里面可能有用户的问题），只打印计数。
 */
import { createServer } from 'node:http';

const MODEL = 'demo-a';
const ANSWER = [
  '按记忆里的偏好：你喜欢简洁的回答，',
  '所以我直接说结论——',
  '这段是假网关分段吐出来的，用来验证流式出字。',
];
let calls = 0;

function sse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) res.write(chunk);
  res.end();
}

function toolCallChunk() {
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'search_memory', arguments: '{"query":"回答风格"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

function textChunks() {
  const out = [];
  for (const part of ANSWER) {
    out.push(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
  }
  out.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  );
  return out;
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      calls += 1;
      let hasToolResult = false;
      try {
        const parsed = JSON.parse(body);
        hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
      } catch {
        /* 解析不了就当第一次 */
      }
      console.log(`[fake-gateway] 第 ${calls} 次请求：${hasToolResult ? '带工具结果' : '首次'}`);
      if (!hasToolResult) {
        sse(res, toolCallChunk());
        return;
      }
      // 分段慢慢吐，界面上能看出流式
      const chunks = textChunks();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunks[i]);
        i += 1;
      }, 220);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(`PORT=${String(port)}`);
  console.log(`[fake-gateway] 地址 http://127.0.0.1:${String(port)}/v1 ，模型 ${MODEL}`);
});
