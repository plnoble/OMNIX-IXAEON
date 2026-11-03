/**
 * CF3 真机检查·乙（规格「真机检查」乙项）：真模型、合成数据，经 run-batch.mjs 跑。
 *
 *   node scripts/real/run-batch.mjs scripts/real/cf3-direct-chat.ts -- <模型名>
 *
 * - 临时空库，写进几条**合成**记忆；网关用本机网关（127.0.0.1:3425，Key 由环境变量给出，
 *   默认走脚本内置的占位值——模型名由参数传入，**不写进仓库**）。
 * - 问 5 个合成问题：闲聊、要查记忆的、要联网的、多轮追问、本来就答不了的。
 * - 打印：每问用了哪些工具、第一个字出来几秒、总共几秒、回答前 80 字（全是合成的，可以打印）。
 * - 搜索服务没配，就照实打印「联网搜索没有配置」。
 *
 * 隐私：临时目录整个遮成 <临时目录>；不打印 Key、不打印真实记忆。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextSelector,
  ItemService,
  OpenAIChatStreamClient,
  migrate,
  openDatabase,
  runDirectChat,
  setPersonalMemoryToChat,
  type CoreDatabase,
  type DirectChatTools,
  type MemoryUsedItem,
  type PriorTurn,
} from '../../packages/core/src/index.js';
import { DIRECT_CHAT_TOOL_NAMES } from '../../packages/core/src/index.js';

const work = mkdtempSync(join(tmpdir(), 'ixa-cf3-real-'));
const log = (...args: unknown[]): void =>
  console.log(
    ...args.map((v) => (typeof v === 'string' ? v.replaceAll(work, '<临时目录>') : String(v))),
  );

const baseUrl = process.env['IXAEON_REAL_GATEWAY'] ?? 'http://127.0.0.1:3425/v1';
const apiKey = process.env['IXAEON_REAL_GATEWAY_KEY'] ?? 'magpie';
const model = process.argv[2] ?? process.env['IXAEON_REAL_MODEL'] ?? '';
if (!model) {
  log('用法：node scripts/real/run-batch.mjs scripts/real/cf3-direct-chat.ts -- <模型名>');
  process.exitCode = 2;
} else {
  void main();
}

function seed(db: CoreDatabase): void {
  const items = new ItemService(db);
  const rows: Array<[string, string]> = [
    ['preference', '合成记忆：用户偏好简洁的回答，不喜欢长列表'],
    ['goal', '合成记忆：用户的项目叫「合成项目 A」，用 TypeScript 写'],
    ['decision', '合成记忆：用户 2026-10 决定先做合成功能 B，暂不做 C'],
  ];
  for (const [type, statement] of rows) {
    items.createManual({
      projectId: null,
      type: type as 'preference' | 'goal' | 'decision',
      statement,
      rationale: null,
      scope: 'personal',
    });
  }
  setPersonalMemoryToChat(db, true);
}

function makeTools(db: CoreDatabase): DirectChatTools {
  const defs = DIRECT_CHAT_TOOL_NAMES.map((name) => ({
    name,
    description: `合成工具：${name}`,
    parameters: { type: 'object' as const },
  }));
  return {
    defs,
    call: async (name, args) => {
      if (name === 'search_memory') {
        const query = String(args['query'] ?? '').trim();
        const r = await new ContextSelector(db).selectForQuestionHybrid(query, null, {
          audience: 'model',
          maxItems: 12,
          semantic: null,
        });
        const memoryUsed: MemoryUsedItem[] = r.items.map((i) => ({
          id: i.id,
          statement: i.statement,
          tag: '合成',
        }));
        return {
          ok: true,
          content: JSON.stringify({
            today: new Date().toISOString().slice(0, 10),
            items: r.items.map((i) => ({ id: i.id, statement: i.statement })),
          }),
          memoryUsed,
        };
      }
      if (name === 'search_web') {
        return { ok: false, content: '联网搜索没有配置：设置里填搜索服务的 Key' };
      }
      return {
        ok: false,
        content: `${name}：本脚本未接（真机检查只用 search_memory / search_web）`,
      };
    },
  };
}

async function main(): Promise<void> {
  const db = openDatabase(join(work, 'ixaeon.db'));
  migrate(db);
  seed(db);
  const client = new OpenAIChatStreamClient({ baseUrl, apiKey, model, timeoutMs: 60_000 });
  const tools = makeTools(db);
  log(`== CF3 真机乙：真模型 + 合成数据（模型由参数传入，不打印）==`);

  const questions: string[] = [
    '你好，用一句话介绍你自己',
    '我平时喜欢什么样的回答风格？',
    '帮我查一下最近的公开新闻里有没有和 TypeScript 相关的大事',
    '那按你刚才说的，我该先做哪个功能？',
    '请告诉我我上个月具体花了多少钱，精确到分',
  ];
  const prior: PriorTurn[] = [];
  for (const [index, question] of questions.entries()) {
    const started = Date.now();
    let firstAt: number | null = null;
    const result = await runDirectChat({
      client,
      question,
      priorTurns: [...prior],
      contextBlock: '',
      preMemoryUsed: [],
      tools,
      onDelta: () => {
        if (firstAt === null) firstAt = Date.now() - started;
      },
    });
    const total = Date.now() - started;
    const used = result.steps.map((s) => s.tool);
    log(
      `Q${index + 1} 状态=${result.status} 工具=[${used.join(', ')}] ` +
        `首字=${firstAt === null ? '—' : `${String(firstAt)}ms`} 总计=${String(total)}ms`,
    );
    log(`     回答前 80 字：${result.answer.replace(/\s+/g, ' ').slice(0, 80)}`);
    if (result.failure) log(`     失败原因：${result.failure}`);
    prior.push({ role: 'user', content: question });
    if (result.answer) prior.push({ role: 'assistant', content: result.answer });
    if (used.includes('search_web') && result.answer.length === 0) {
      log('     （联网搜索没有配置，按实打印）');
    }
  }
  db.close();
  rmSync(work, { recursive: true, force: true });
}
