/**
 * M1 真机检查：本机起一个假的流式服务，立刻回响应头，隔 110 秒再吐文字，
 * 确认 OpenAIResponsesProvider 拿到完整结果、中途没有断。
 * 真网关那部分待用户验证（Key 在 Electron 加密存储里，脚本解不开）。
 *   node_modules/.bin/jiti scripts/real/m1-slow-stream.ts
 */
import { createServer, type ServerResponse } from 'node:http';
import { OpenAIResponsesProvider } from '../../packages/core/src/index.js';

const DELAY_MS = 110_000;

function writeSse(res: ServerResponse, events: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(event);
  res.end();
}

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (url.includes('/no-responses/') && url.endsWith('/responses')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  if (url.endsWith('/responses')) {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { input?: unknown[] };
      if (!body.input || body.input.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"model not specified"}');
        return;
      }
      // 立刻把响应头刷出去，隔 110 秒再吐文字：网关按「100 秒没回应」掐断的就是这种情况。
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      console.log('HEADERS_FLUSHED', Date.now());
      setTimeout(() => {
        res.write(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"慢模型的完整回答"}\n\n',
        );
        res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
        res.end();
      }, DELAY_MS);
    });
    return;
  }
  if (url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"兼容端点的回答"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, DELAY_MS);
    return;
  }
  writeSse(res, []);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
console.log('FAKE_SERVER', port);

const base = `http://127.0.0.1:${port}/v1`;
const started = Date.now();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const res = await originalFetch(url, init);
  if (
    String(url).endsWith('/responses') &&
    res.headers.get('content-type')?.includes('event-stream')
  ) {
    headersAfterSeconds = Math.round((Date.now() - started) / 1000);
    console.log('HEADERS_RECEIVED_AFTER_SECONDS', Math.round((Date.now() - started) / 1000));
  }
  return res;
}) as typeof fetch;
// 结论由脚本自己算出来的值决定：一处不符就不写「通过」
let passed = true;
let firstFail = '';
const fail = (why: string): void => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
let headersAfterSeconds: number | null = null;
let responsesSeconds: number | null = null;
// 出错也要有 RESULT 行、退出码非零（照 p5/p7 的规矩）
const crash = (err: unknown): void => {
  console.log('脚本出错：', err);
  console.log('RESULT 没通过：脚本出错：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

try {
  const responses = new OpenAIResponsesProvider({
    apiKey: 'sk-test',
    modelName: 'slow-model',
    baseUrl: base,
  });
  const text = await responses.chatText({ system: 's', user: 'u' });
  console.log('RESPONSES_TEXT', text);
  if (text !== '慢模型的完整回答')
    fail(`慢模型的回答不完整（期望 RESPONSES_TEXT「慢模型的完整回答」，实际「${text}」）`);
  responsesSeconds = Math.round((Date.now() - started) / 1000);
  console.log('RESPONSES_SECONDS', Math.round((Date.now() - started) / 1000));
  if (headersAfterSeconds === null || headersAfterSeconds > 1)
    fail(
      `响应头不是立刻收到的（期望 HEADERS_RECEIVED_AFTER_SECONDS 0–1 秒，实际 ${headersAfterSeconds}）`,
    );
  if (responsesSeconds < 100)
    fail(`慢响应没等满（期望 RESPONSES_SECONDS ≥ 100 秒，实际 ${responsesSeconds}）`);

  const chat = new OpenAIResponsesProvider({
    apiKey: 'sk-test',
    modelName: 'slow-model',
    baseUrl: `http://127.0.0.1:${port}/no-responses/v1`,
  });
  const chatText = await chat.chatText({ system: 's', user: 'u' });
  console.log('CHAT_TEXT', chatText);
  if (chatText !== '兼容端点的回答')
    fail(`兼容端点的回答不对（期望 CHAT_TEXT「兼容端点的回答」，实际「${chatText}」）`);
} catch (err) {
  console.log('脚本出错：', err);
  passed = false;
  firstFail = `脚本出错：${err instanceof Error ? err.message : String(err)}`;
} finally {
  server.close();
}
console.log(
  'RESULT',
  passed
    ? `通过：假服务端 ${headersAfterSeconds} 秒就回了响应头、等满 ${responsesSeconds} 秒拿到完整回答，兼容端点也拿到回答`
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
