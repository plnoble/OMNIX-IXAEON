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
      // 立刻回响应头，隔 110 秒再吐文字：网关按「100 秒没回应」掐断的就是这种情况。
      res.writeHead(200, { 'content-type': 'text/event-stream' });
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
try {
  const responses = new OpenAIResponsesProvider({
    apiKey: 'sk-test',
    modelName: 'slow-model',
    baseUrl: base,
  });
  const text = await responses.chatText({ system: 's', user: 'u' });
  console.log('RESPONSES_TEXT', text);
  console.log('RESPONSES_SECONDS', Math.round((Date.now() - started) / 1000));

  const chat = new OpenAIResponsesProvider({
    apiKey: 'sk-test',
    modelName: 'slow-model',
    baseUrl: `http://127.0.0.1:${port}/no-responses/v1`,
  });
  const chatText = await chat.chatText({ system: 's', user: 'u' });
  console.log('CHAT_TEXT', chatText);
} finally {
  server.close();
}
