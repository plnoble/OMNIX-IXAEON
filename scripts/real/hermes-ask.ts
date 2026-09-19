/**
 * 真机检查：用本机的真 Hermes（IXAEON 专属安装）在临时空库里问几个**合成的**问题，
 * 看模型实际怎么答。改了发给模型的提示词或约定的任务必须跑（2026-09-19 T2a 的约定
 * 就是这样查出「知识性问题也附一串待办」）。
 *
 *   node_modules/.bin/jiti scripts/real/hermes-ask.ts "问题一" "问题二" …
 *
 * 每个问题一个新的临时库和会话，互不影响；不碰用户的数据目录。会用掉少量模型额度。
 * 输出：引擎、模型、耗时、回答末尾 400 字、按「建议待办」约定解析出的待办。
 * 问题要合成的、不带用户的个人信息。每类情况都要问到：该触发的、不该触发的。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSession,
  CodingOrchestrator,
  CoreToolBroker,
  FakeCodingExecutor,
  HermesRuntimeAdapter,
  ItemService,
  ProjectService,
  SearchService,
  extractSuggestedTodos,
  locateHermes,
  migrate,
  openDatabase,
} from '../../packages/core/src/index.js';

const questions = process.argv.slice(2);
if (questions.length === 0) {
  console.error('用法：node_modules/.bin/jiti scripts/real/hermes-ask.ts "问题一" "问题二" …');
  process.exit(2);
}
if (!locateHermes().found) {
  console.error('本机没找到 IXAEON 专属的 Hermes 安装，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}

for (const q of questions) {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-hermes-ask-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const broker = new CoreToolBroker(
    db,
    new ItemService(db),
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    new ProjectService(db),
  );
  const adapter = new HermesRuntimeAdapter(broker);
  const session = new AgentSession(db, adapter, broker, null, { mcpBridgedTools: [] });
  const t0 = Date.now();
  try {
    const r = await session.run({ goal: q, projectId: null });
    const { todos } = extractSuggestedTodos(r.answer);
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`\n=== 问：${q}｜引擎 ${r.engine}｜模型 ${r.modelName}｜${sec} 秒`);
    console.log('--- 回答末尾 400 字：');
    console.log(r.answer.slice(-400));
    console.log(`--- 解析出的待办（${todos.length} 件）：${JSON.stringify(todos)}`);
  } catch (err) {
    console.log(`\n=== 问：${q}｜失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    adapter.disposeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(0);
