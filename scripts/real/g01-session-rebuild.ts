/**
 * 真机检查（G01，规格 docs/委派/G01-会话重建后补历史.md）：
 * 用本机的真 Hermes 在临时空库里连聊三轮，看会话重建后模型还记不记得前几轮。
 *
 *   node_modules/.bin/jiti scripts/real/g01-session-rebuild.ts
 *
 * 流程（规格「真机检查」一节）：
 *   1. 第一轮说一个合成口令；
 *   2. 往库里加一条合成记忆（新增不触发重建）；
 *   3. 第二轮问口令是什么——应复用同一会话，模型靠自己的上下文答出；
 *   4. 把一条记忆标成「不对」（收回可见性，触发重建）；
 *   5. 第三轮再问口令——应新开会话并补历史，口令在注入的前几轮里，模型仍答得出。
 * 输出每轮的引擎会话是否复用、回答原文；数据全是合成的，不碰用户的数据目录。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  locateHermes,
  migrate,
  openDatabase,
  type PriorTurn,
} from '../../packages/core/src/index.js';

const PASSPHRASE = '口令：青柠七九';
const history: PriorTurn[] = [];

function insertMemory(statement: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  // 提炼器产物的形状（origin=ai、said_by=user），与 G01 验收测试一致
  db.prepare(
    `INSERT INTO items (id, type, statement, origin, said_by, created_at, updated_at)
     VALUES (?, 'goal', ?, 'ai', 'user', ?, ?)`,
  ).run(id, statement, now, now);
  return id;
}

async function turn(label: string, goal: string): Promise<void> {
  const t0 = Date.now();
  const r = await session.run({ goal, projectId: null, priorTurns: [...history] });
  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(`\n=== ${label}｜引擎 ${r.engine}｜模型 ${r.modelName}｜${sec} 秒`);
  console.log('--- 回答全文：');
  console.log(r.answer);
  history.push({ role: 'user', content: goal }, { role: 'assistant', content: r.answer });
}

if (!locateHermes().found) {
  console.error('本机没找到 IXAEON 专属的 Hermes 安装，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'ixa-g01-real-'));
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
const items = new ItemService(db);

try {
  await turn('第一轮（说口令）', `${PASSPHRASE}，请记住这句口令。`);
  const fresh = insertMemory('一条合成的无关记忆：周六打算整理书桌');
  console.log(`\n--- 往库里新增一条记忆（${fresh}）`);
  await turn('第二轮（问口令）', '我刚才说的口令是什么？');
  const rejected = insertMemory('一条马上被标「不对」的合成记忆');
  items.reject(rejected);
  console.log(`\n--- 把记忆 ${rejected} 标成「不对」（收回可见性，会话应重建）`);
  await turn('第三轮（再问口令）', '现在再告诉我，我刚才说的口令是什么？');
} catch (err) {
  console.log(`\n=== 失败：${err instanceof Error ? err.message : String(err)}`);
} finally {
  adapter.disposeAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
