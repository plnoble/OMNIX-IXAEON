/**
 * D7 真机检查（本单只跑不联网这一步）：本机假上游 + 真的 OpenAIResponsesProvider，
 * 对临时目录里的合成小项目跑一次 ModelCodingExecutor。
 *
 * 断言与打印（全是合成内容）：
 * - 假上游收到几次请求、请求体字符数；
 * - 发出去的请求里没有 .env 的内容；
 * - 副本里 README.md 的改动（执行器把模型的改动写进了副本）。
 *
 *   node_modules/.bin/jiti scripts/real/d7-model-executor.ts
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCodingExecutor, OpenAIResponsesProvider } from '../../packages/core/src/index.js';
import type { CodingTask } from '@ixaeon/contracts';

const dir = mkdtempSync(join(tmpdir(), 'ixa-d7-real-'));
const workspace = join(dir, 'ws');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'README.md'), '合成 README，第一行。\n');
writeFileSync(join(workspace, '.env'), 'ENV_REAL_SECRET=d7-real-check\n');

const requests: Array<{ url: string; chars: number; body: string }> = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    requests.push({ url: req.url ?? '', chars: raw.length, body: raw });
    // 探测 /responses → 说没有这个端点（让提供者切到 /chat/completions）
    if ((req.url ?? '').includes('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if ((req.url ?? '').includes('/chat/completions')) {
      // 写死的模型返回：把 README 整份改写（内容全是合成）
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  changes: [
                    {
                      path: 'README.md',
                      action: 'write',
                      content: '合成 README，第一行。\n第二行是 D7 真机加的。\n',
                    },
                  ],
                  summary: 'README 加了一行',
                  claimedSuccess: true,
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
console.log('FAKE_UPSTREAM', port);

const provider = new OpenAIResponsesProvider({
  apiKey: 'sk-synthetic-d7',
  modelName: 'd7-fake-model',
  baseUrl: `http://127.0.0.1:${port}/v1`,
});

const task: CodingTask = {
  id: 'd7-real',
  project_id: 'p-real',
  goal: '在 README.md 末尾加一行「第二行是 D7 真机加的。」',
  scope_json: JSON.stringify(['README.md']),
  status: 'queued',
  timeout_ms: 30_000,
  workspace_path: workspace,
};

try {
  const report = await new ModelCodingExecutor(provider, 'd7-fake-model').run(
    task,
    workspace,
    new AbortController().signal,
  );
  console.log('REQUESTS', JSON.stringify(requests.map((r) => ({ url: r.url, chars: r.chars }))));
  const allBodies = requests.map((r) => r.body).join('\n');
  console.log('ENV_LEAKED', allBodies.includes('ENV_REAL_SECRET') ? '是（不该发生）' : '否');
  console.log('README_AFTER', JSON.stringify(readFileSync(join(workspace, 'README.md'), 'utf8')));
  console.log('REPORT', JSON.stringify(report));
  console.log(
    'CHECK_FILE_OK',
    readFileSync(join(workspace, 'README.md'), 'utf8').includes('第二行是 D7 真机加的')
      ? '是（改动已进副本）'
      : '否',
  );
} finally {
  server.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
}
