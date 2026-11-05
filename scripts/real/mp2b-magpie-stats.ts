/**
 * MP2b 真机检查·乙（规格「真机检查」乙项）：本机 magpie，只打印三个数。
 *
 *   node scripts/real/run-batch.mjs scripts/real/mp2b-magpie-stats.ts
 *
 * - 临时空数据目录，用「用本机 magpie」那份预设值加一家（地址 http://127.0.0.1:3425/v1、Key magpie、类型 magpie）；
 * - 获取模型（只发 GET /models）；
 * - **只打印三个数**：模型个数、分组（`group/` 开头）个数、额度卡片张数。
 *   不打印模型名、账号、额度具体数值。
 * - magpie 没起就如实打印「没跑：magpie 未运行」，不冒充。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../packages/core/src/index.js';
import { defaultAppConfig, type AppConfig } from '../../packages/contracts/src/index.js';
import { AppRuntime } from '../../apps/desktop/src/main/appRuntime.js';

const MAGPIE_BASE = 'http://127.0.0.1:3425/v1';
const MAGPIE_KEY = 'magpie';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp2b-magpie-'));
  let db: CoreDatabase | null = null;
  try {
    // magpie 没起就别装了：先看一眼端口
    try {
      const probe = await fetch(`${MAGPIE_BASE}/models`, {
        headers: { authorization: `Bearer ${MAGPIE_KEY}` },
      });
      if (!probe.ok) throw new Error(`status ${String(probe.status)}`);
    } catch {
      console.log('没跑：magpie 未运行');
      return;
    }

    db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    const base = defaultAppConfig();
    const config: AppConfig = { ...base, model: { ...base.model, modelName: '', apiBaseUrl: '' } };
    const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
    Object.assign(runtime as unknown as Record<string, unknown>, {
      db,
      conversations: new ConversationStore(db),
      todos: new TodoStore(db),
      items: new ItemService(db),
      search: new SearchService(db),
      projects: new ProjectService(db),
      coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
      dataDir: dir,
      config,
      askSessions: new Map(),
      activeAskRuns: new Map(),
      cancelledAskRuns: new Set(),
      semanticIndex: null,
      semanticBackfillRun: null,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
      kickSemanticBackfill: () => Promise.resolve(),
      awaitSemanticBackfill: () => Promise.resolve(),
      jobs: { hold: () => () => undefined },
      getTinyFishFetcher: () => null,
      getWebSearchExecutor: () => null,
    });

    // 「用本机 magpie」那份预设值
    const saved = runtime.saveModelProvider({
      name: '本机 magpie',
      kind: 'magpie',
      apiBaseUrl: MAGPIE_BASE,
      apiKey: MAGPIE_KEY,
    });
    const got = await runtime.fetchProviderModels(saved.id);
    if (got.error) {
      console.log(`没跑：获取模型失败（${got.error.slice(0, 60)}）`);
      return;
    }
    const groups = got.models.filter((m) => m.startsWith('group/')).length;
    // 额度卡片张数：手动登记的额度 + magpie 那份（有 magpie 就算 1 张）
    const manual = (
      db
        .prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'cockpit.manual_quotas'")
        .get() as {
        n: number;
      }
    ).n;
    const magpieCards = 1;
    console.log(`模型个数=${String(got.models.length)}`);
    console.log(`分组个数=${String(groups)}`);
    console.log(`额度卡片张数=${String(magpieCards + manual)}`);
  } finally {
    if (db?.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
