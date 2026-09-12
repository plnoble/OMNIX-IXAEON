import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
  Vault,
  ArchiveService,
  FakeProvider,
  HermesRuntimeAdapter,
  CoreToolBroker,
  AgentSession,
  buildPersonalOverview,
  locateHermes,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-r13-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  delete process.env.IXAEON_HERMES_EXE;
  delete process.env.IXAEON_HERMES_HOME;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('R13 不绑引擎（合成验证，非本机 Hermes）', () => {
  it('停引擎后 Core 仍可问答/记账/导出；重开库纠正仍生效', async () => {
    // 语料：项目 + 个人目标（已披露）+ AI 旧推断被纠正
    const projects = new ProjectService(db);
    const items = new ItemService(db);
    const project = projects.create({ name: 'R13 项目', rootPath: null, description: null });
    const personal = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'goal',
      statement: '长期做一个本地优先的个人助手',
      rationale: null,
    });
    items.grantDisclosure({ itemId: personal.id, audience: 'model', note: 'R13 测试' });
    const old = items.createAssistantSuggestion({
      projectId: project.id,
      type: 'open_loop',
      statement: '界面用深色主题好看',
      rationale: '旧推断',
    });
    items.correct({ itemId: old.id, userText: '界面默认浅色主题', newType: 'preference' });

    // 1) 引擎缺席是事实，不假装
    const locator = locateHermes();
    expect(locator.found).toBe(false);
    expect(new HermesRuntimeAdapter().probe().engine).toBe('missing');

    // 2) Core 有界循环仍能跑并记账
    const provider = new FakeProvider('r13');
    provider.enqueueStructured({ tool: 'search_memory', args: { query: '个人助手' } });
    provider.enqueueStructured({
      tool: 'answer',
      args: { text: '你要长期做本地优先的个人助手。这不是 Hermes。' },
    });
    const broker = new CoreToolBroker(
      db,
      items,
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      projects,
    );
    const session = new AgentSession(db, new HermesRuntimeAdapter(broker), broker, provider);
    const result = await session.run({ goal: '我的长期目标是什么？', projectId: null });
    expect(result.engine).toBe('core-bounded');
    const runRow = db
      .prepare('SELECT engine, status FROM runtime_runs WHERE id = ?')
      .get(result.runId) as { engine: string; status: string };
    expect(runRow.engine).toBe('core-bounded');
    expect(runRow.status).toBe('succeeded');

    // 3) 导出不依赖引擎：资产随 Core 走
    const vault = new Vault(join(dir, 'vault'));
    mkdirSync(join(dir, 'vault'), { recursive: true });
    const archive = new ArchiveService(db, {
      dataDir: dir,
      dbPath: join(dir, 'ixaeon.db'),
      vault,
      closeCurrentDb: () => {},
    });
    const zipPath = join(dir, 'r13-export.zip');
    await archive.exportData(zipPath);
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    expect(zip.file('data/runtime-runs.json')).toBeTruthy();
    expect(zip.file('data/corrections.json')).toBeTruthy();
    expect(zip.file('data/items.json')).toBeTruthy();

    // 4) 「新专属 profile」重开同一资产：纠正仍生效，引擎状态不影响
    db.close();
    process.env.IXAEON_HERMES_HOME = join(dir, 'dedicated-hermes-home');
    const reopened = openDatabase(join(dir, 'ixaeon.db'));
    const overview = buildPersonalOverview(reopened);
    expect(overview.goals.some((g) => g.statement.includes('个人助手'))).toBe(true);
    const corrected = reopened
      .prepare("SELECT state, origin FROM items WHERE statement = '界面默认浅色主题'")
      .get() as { state: string; origin: string };
    expect(corrected.state).toBe('current');
    expect(corrected.origin).toBe('user');
    const superseded = reopened
      .prepare("SELECT state FROM items WHERE statement = '界面用深色主题好看'")
      .get() as { state: string };
    expect(superseded.state).toBe('superseded');
    expect(locateHermes().found).toBe(false);
    reopened.close();
  });
});
