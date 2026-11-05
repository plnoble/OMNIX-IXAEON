/**
 * MP3 真机检查：本机起两个假 OpenAI 兼容服务（一个回 429、一个正常），
 * 用**产品代码**（resolveModelUseChain / FallbackChatClient / FallbackModelProvider / Extractor）
 * 各跑一次聊天和一次后台分析，只打印：实际答的是第几个候选、换了几次、提示句的样子。
 *
 *   node scripts/real/mp3-fallback.mjs
 *
 * - 临时数据目录（路径遮成 <临时目录>）；不连外网。
 * - 两家供应商的 Key 是合成的；这里直接用产品里「解出来的明文」建客户端
 *   （Electron 里那一步由 safeStorage 解，本脚本不重复加密）。
 * - 聊天走 runDirectChat + FallbackChatClient（appRuntime 用同一对类）；
 *   后台分析走 Extractor + FallbackModelProvider（getProvider 用同一对类）。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Extractor,
  PermissionService,
  ImportService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  resolveModelUseChain,
  runDirectChat,
  OpenAIChatStreamClient,
  OpenAIResponsesProvider,
} from '../../packages/core/src/index.js';
import { writeFileSync } from 'node:fs';
import {
  FallbackChatClient,
  FallbackModelProvider,
} from '../../apps/desktop/src/main/modelFallback.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3-real-'));
const mask = (s) => String(s).replaceAll(dir, '<临时目录>');
const log = (...a) => console.log(...a.map(mask));

const sse = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '来自替补的回答' } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const answerBody = (text) => JSON.stringify({ output: [{ content: [{ text }] }] });

const s1 = createServer((_q, r) => {
  r.writeHead(429, { 'content-type': 'application/json' });
  r.end(JSON.stringify({ error: { message: '额度用完' } }));
});
const s2 = createServer((q, r) => {
  if (q.url?.includes('/responses')) {
    const payload = {
      items: [
        {
          type: 'decision',
          statement: '来自第二个的提炼结论',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: '合成资料正文甲，用来提炼一条结论。',
        },
      ],
    };
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(answerBody(JSON.stringify(payload)));
    return;
  }
  sse(r);
});
const port1 = await new Promise((res) => s1.listen(0, '127.0.0.1', () => res(s1.address().port)));
const port2 = await new Promise((res) => s2.listen(0, '127.0.0.1', () => res(s2.address().port)));
log('假服务：429 在', port1, '正常在', port2, '；临时数据目录', dir);

const enc = (key) => Buffer.from(`enc:${key}`).toString('base64');
const decrypt = (c) => Buffer.from(c, 'base64').toString().slice(4);
const config = {
  fallbacks: {
    analysis: [{ providerId: 'p-b', model: 'demo-b' }],
    chat: [{ providerId: 'p-b', model: 'demo-b' }],
  },
  model: { modelName: '', chatModelName: '' },
  providers: [
    {
      id: 'p-a',
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: `http://127.0.0.1:${port1}/v1`,
      apiKeyEncrypted: enc('sk-synthetic-a'),
      apiKeyPresent: true,
      savedModels: ['demo-a'],
      modelsCheckedAt: null,
    },
    {
      id: 'p-b',
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: `http://127.0.0.1:${port2}/v1`,
      apiKeyEncrypted: enc('sk-synthetic-b'),
      apiKeyPresent: true,
      savedModels: ['demo-b'],
      modelsCheckedAt: null,
    },
  ],
  uses: {
    analysis: { providerId: 'p-a', model: 'demo-a' },
    chat: { providerId: 'p-a', model: 'demo-a' },
  },
};

// ---- 聊天 ----
{
  const chain = resolveModelUseChain(config, 'chat');
  let switches = 0;
  const client = new FallbackChatClient(
    chain.map((c) => ({
      key: `${c.providerId}/${c.model}`,
      providerName: c.providerName,
      model: c.model,
      launch: { model: c.model, baseUrl: c.apiBaseUrl, apiKey: decrypt(c.apiKeyEncrypted) },
    })),
    (l) => new OpenAIChatStreamClient(l),
    () => {
      switches += 1;
    },
  );
  const out = await runDirectChat({
    client,
    question: '合成问题',
    priorTurns: [],
    contextBlock: '',
    preMemoryUsed: [],
    tools: { defs: [], call: async () => ({}) },
    onDelta: () => undefined,
  });
  const idx = chain.findIndex((c) => c.model === client.modelName) + 1;
  log(
    `聊天：状态=${out.status}｜实际答的是第 ${idx} 个候选（${client.modelName}）｜换了 ${switches} 次`,
  );
  log('聊天提示句：', client.notice ?? '（没换）');
}

// ---- 后台分析 ----
{
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, vault, permissions, sources);
  const path = join(dir, '合成资料.md');
  writeFileSync(path, '合成资料正文甲，用来提炼一条结论。\n', 'utf8');
  const sourceId = imports.importFile(path, {
    projectId: null,
    permissionId: permissions.grantFile(path).id,
  }).created[0].id;

  const chain = resolveModelUseChain(config, 'analysis');
  let switches = 0;
  const provider = new FallbackModelProvider(
    chain.map((c) => ({
      key: `${c.providerId}/${c.model}`,
      providerName: c.providerName,
      model: c.model,
    })),
    (cand) => {
      const c = chain.find((x) => `${x.providerId}/${x.model}` === cand.key);
      return new OpenAIResponsesProvider({
        apiKey: decrypt(c.apiKeyEncrypted),
        modelName: c.model,
        baseUrl: c.apiBaseUrl,
      });
    },
    (e) => {
      switches += 1;
      log('换替补日志：', JSON.stringify(e));
    },
    () => undefined,
  );
  const stats = await new Extractor(db, provider).extractSource(sourceId);
  const items = db
    .prepare('SELECT statement FROM items WHERE extracted_from_source_id = ?')
    .all(sourceId);
  const idx = chain.findIndex((c) => c.model === provider.modelName) + 1;
  log(
    `后台分析：插入 ${stats.inserted} 条｜实际用的是第 ${idx} 个候选（${provider.modelName}）｜换了 ${switches} 次`,
  );
  log('提炼出的条目：', items.map((i) => i.statement).join('｜') || '（无）');
  db.close();
}

s1.close();
s2.close();
rmSync(dir, { recursive: true, force: true });
