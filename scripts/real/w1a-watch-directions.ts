/**
 * W1a 真机检查（合成数据）：临时库 + 一组合成记忆，用真的模型提关注方向，
 * 贴出方向与对外检索描述。记忆与项目全是合成的；不碰用户的数据目录
 * （只读 config.json 的模型名与地址，不打印地址）。
 * API Key 只从进程环境变量 IXAEON_MODEL_API_KEY 读，不落盘、不打印。
 *   node_modules/.bin/jiti scripts/real/w1a-watch-directions.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ItemService,
  OpenAIResponsesProvider,
  ProjectService,
  buildWatchPrompt,
  collectWatchMemories,
  mapWatchDirections,
  migrate,
  openDatabase,
  resolveDataDir,
  watchDirectionsSchema,
} from '../../packages/core/src/index.js';

const key = process.env.IXAEON_MODEL_API_KEY;
if (!key) {
  console.error('没有 IXAEON_MODEL_API_KEY，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}
const configFile = join(resolveDataDir().dataDir, 'config.json');
if (!existsSync(configFile)) {
  console.error('本机没有模型配置，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configFile, 'utf8')) as {
  model: { apiBaseUrl?: string; modelName?: string };
};
if (!cfg.model.modelName) {
  console.error('本机没有模型名称，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}
const provider = new OpenAIResponsesProvider({
  apiKey: key,
  modelName: cfg.model.modelName,
  baseUrl: cfg.model.apiBaseUrl?.trim() || process.env.IXAEON_OPENAI_BASE_URL,
});
const dir = mkdtempSync(join(tmpdir(), 'ixaeon-w1a-real-'));
const db = openDatabase(join(dir, 'ixaeon.db'));
migrate(db);
const project = new ProjectService(db).create({
  name: '析衍示例项目',
  rootPath: null,
  description: '合成示例',
});
const items = new ItemService(db);
items.createManual({
  projectId: project.id,
  type: 'goal',
  statement: '想做一个全天记录的个人助理',
  rationale: null,
});
items.createManual({
  projectId: project.id,
  type: 'goal',
  statement: '关注人形机器人',
  rationale: null,
});
items.createManual({
  projectId: project.id,
  type: 'constraint',
  statement: '想换一台内存大、能跑本地大模型的手机',
  rationale: null,
});
const memories = collectWatchMemories(db);
const t0 = Date.now();
try {
  const raw = await provider.chatStructured({
    ...buildWatchPrompt(memories, [project]),
    schema: watchDirectionsSchema,
  });
  const directions = mapWatchDirections(raw, memories, [], []);
  console.log(
    `模型 ${cfg.model.modelName}｜${Math.round((Date.now() - t0) / 1000)} 秒｜${directions.length} 个方向`,
  );
  for (const d of directions) {
    console.log(`- 方向：${d.question}`);
    console.log(`  对外检索用：${d.publicDescription}`);
    console.log(`  依据：${d.basis.map((b) => b.statement).join('；') || '（无）'}`);
  }
} catch (err) {
  console.log(`失败：${err instanceof Error ? err.message : String(err)}`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
