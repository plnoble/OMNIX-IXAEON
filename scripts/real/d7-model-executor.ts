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

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
// 出错时打印的是 Error（带栈、带临时目录绝对路径），不遮就会把账户名带进交付说明。
const maskOut = (v: unknown): string => {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => orig(...a.map(maskOut));
}

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

// 结论由脚本自己算出来的值决定：一处不符就不写「通过」
let passed = true;
let firstFail = '';
const fail = (why: string): void => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
// 出错也要有 RESULT 行、退出码非零（照 p5/p7 的规矩）
const crash = (err: unknown): void => {
  console.log('脚本出错：', err);
  console.log('RESULT 没通过：脚本出错：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

try {
  const report = await new ModelCodingExecutor(provider, 'd7-fake-model').run(
    task,
    workspace,
    new AbortController().signal,
  );
  console.log('REQUESTS', JSON.stringify(requests.map((r) => ({ url: r.url, chars: r.chars }))));
  const chatCalls = requests.filter((r) => r.url.includes('/chat/completions'));
  const responsesProbes = requests.filter((r) => r.url.includes('/responses'));
  if (responsesProbes.length < 1) fail('假上游没收到 /responses 探测（期望至少 1 次）');
  if (chatCalls.length < 1) fail('假上游没收到 /chat/completions 请求（期望至少 1 次）');
  if (requests.some((r) => r.chars === 0)) fail('有一次请求的请求体是空的（期望每次都有请求体）');
  const allBodies = requests.map((r) => r.body).join('\n');
  console.log('ENV_LEAKED', allBodies.includes('ENV_REAL_SECRET') ? '是（不该发生）' : '否');
  if (allBodies.includes('ENV_REAL_SECRET'))
    fail('发给模型的请求里有 .env 的内容（期望 ENV_LEAKED 否）');
  console.log('README_AFTER', JSON.stringify(readFileSync(join(workspace, 'README.md'), 'utf8')));
  console.log('REPORT', JSON.stringify(report));
  if (report.claimedSuccess !== true || !report.changedPaths.includes('README.md'))
    fail(
      `执行器报告不对（期望 claimedSuccess true、改动里有 README.md，实际 claimedSuccess ${report.claimedSuccess}、改动 ${JSON.stringify(report.changedPaths)}）`,
    );
  console.log(
    'CHECK_FILE_OK',
    readFileSync(join(workspace, 'README.md'), 'utf8').includes('第二行是 D7 真机加的')
      ? '是（改动已进副本）'
      : '否',
  );
  if (!readFileSync(join(workspace, 'README.md'), 'utf8').includes('第二行是 D7 真机加的'))
    fail('执行器的改动没进副本（期望 CHECK_FILE_OK「是（改动已进副本）」，实际「否」）');
} catch (err) {
  console.log('脚本出错：', err);
  passed = false;
  firstFail = `脚本出错：${err instanceof Error ? err.message : String(err)}`;
} finally {
  server.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
}
console.log(
  'RESULT',
  passed
    ? `通过：假上游收到 ${requests.length} 次请求（/responses 探测 + /chat/completions），请求里没有 .env 内容，模型的改动进了副本`
    : `没通过：${firstFail}`,
);
// 不用 process.exit：这个脚本退出时还有没关的句柄（假上游等），硬退会撞 libuv 的
// 「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」（本机 2026-10-20 实测 exit=3221226505）。
process.exitCode = passed ? 0 : 1;
