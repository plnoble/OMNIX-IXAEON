/**
 * MCP 客户端不得搜到个人资料原文（2026-09-17 整合 F1 时发现）。
 *
 * 规则（AGENTS.md）：个人记忆不能自动暴露给所有 MCP 客户端。
 * 条目层已按此实现：search_context 只返回项目范围条目，或对 coding_client
 * 单独授权过的个人条目。但原文片段层没有同样的限制——不带 project_ref 时
 * 在所有已授权来源里全文检索，个人聊天原文每条最多 300 字随之返回。
 * 结果是：编码客户端搜不到个人「结论」，却能搜到这些结论的「原文」。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  McpService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const PERSONAL_SECRET = 'PERSONALSECRET7731';
const PROJECT_PHRASE = 'PROJECTPHRASE4412';

let dir: string;
let db: CoreDatabase;
let mcp: McpService;
let projectId: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mcp-personal-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const permissions = new PermissionService(db);
  const imports = new ImportService(
    db,
    new Vault(join(dir, 'vault')),
    permissions,
    new SourceStore(db),
  );
  projectId = new ProjectService(db).create({
    name: '公开项目',
    rootPath: null,
    description: null,
  }).id;

  const personal = join(dir, 'personal-chat.md');
  writeFileSync(
    personal,
    `# 私人记录\n\n周三去看牙，暗号 ${PERSONAL_SECRET}，别告诉别人。\n`,
    'utf8',
  );
  imports.importFile(personal, {
    projectId: null,
    permissionId: permissions.grantFile(personal).id,
  });

  const shared = join(dir, 'project-notes.md');
  writeFileSync(shared, `# 项目说明\n\n本项目的接口约定见 ${PROJECT_PHRASE}。\n`, 'utf8');
  imports.importFile(shared, { projectId, permissionId: permissions.grantFile(shared).id });

  mcp = new McpService(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('search_context：个人资料原文不暴露给 MCP 客户端', () => {
  it('不带 project_ref 搜个人暗号：一条原文都不返回', () => {
    const out = mcp.searchContext({ query: PERSONAL_SECRET, limit: 20 });
    const leaked = out.results.filter((r) => r.excerpt.includes(PERSONAL_SECRET));
    expect(leaked).toEqual([]);
  });

  it('对照：项目资料照常可搜（带或不带 project_ref）', () => {
    const scoped = mcp.searchContext({ query: PROJECT_PHRASE, project_ref: projectId, limit: 20 });
    expect(scoped.results.some((r) => r.excerpt.includes(PROJECT_PHRASE))).toBe(true);
    const unscoped = mcp.searchContext({ query: PROJECT_PHRASE, limit: 20 });
    expect(unscoped.results.some((r) => r.excerpt.includes(PROJECT_PHRASE))).toBe(true);
  });

  it('带 project_ref 也搜不到别处的个人原文', () => {
    const out = mcp.searchContext({ query: PERSONAL_SECRET, project_ref: projectId, limit: 20 });
    expect(out.results.filter((r) => r.excerpt.includes(PERSONAL_SECRET))).toEqual([]);
  });
});

describe('get_source_excerpt：还没分析过的个人原文也不能按 ID 展开', () => {
  it('个人来源的片段 → SCOPE_DENIED（此前因「没有条目」被放行）', () => {
    const seg = db
      .prepare('SELECT id FROM segments WHERE text LIKE ?')
      .get(`%${PERSONAL_SECRET}%`) as { id: string };
    // 前提：这段原文确实还没被提炼出任何条目
    const linked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i LEFT JOIN item_evidence e ON e.item_id = i.id
         WHERE e.segment_id = ? OR i.extracted_from_source_id =
           (SELECT source_id FROM segments WHERE id = ?)`,
      )
      .get(seg.id, seg.id) as { n: number };
    expect(linked.n).toBe(0);
    expect(() => mcp.getSourceExcerpt(seg.id, 500)).toThrow(/个人或未整理资料/);
  });

  it('对照：项目来源的片段照常展开', () => {
    const seg = db
      .prepare('SELECT id FROM segments WHERE text LIKE ?')
      .get(`%${PROJECT_PHRASE}%`) as { id: string };
    expect(mcp.getSourceExcerpt(seg.id, 500).excerpt).toContain(PROJECT_PHRASE);
  });
});

describe('单独授权的个人条目：按条目引用可展开依据原文（文档所述的合法分享路径）', () => {
  const SHARED_PREF = 'SHAREDPREF5520';
  let d2: string;
  let db2: CoreDatabase;
  let mcp2: McpService;
  let items2: ItemService;
  let itemId: string;

  beforeAll(async () => {
    d2 = mkdtempSync(join(tmpdir(), 'ixaeon-mcp-disclose-'));
    db2 = openDatabase(join(d2, 'ixaeon.db'));
    migrate(db2);
    const permissions = new PermissionService(db2);
    const imports = new ImportService(
      db2,
      new Vault(join(d2, 'vault')),
      permissions,
      new SourceStore(db2),
    );
    const file = join(d2, 'personal-pref.md');
    writeFileSync(file, `# 私人偏好\n\n写代码时我偏好 ${SHARED_PREF} 风格。\n`, 'utf8');
    const result = imports.importFile(file, {
      projectId: null,
      permissionId: permissions.grantFile(file).id,
    });
    const fake = new FakeProvider('fake-disclose');
    fake.enqueueStructured({
      items: [
        {
          type: 'preference',
          statement: `偏好 ${SHARED_PREF} 风格`,
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: `写代码时我偏好 ${SHARED_PREF} 风格。`,
        },
      ],
    });
    await new Extractor(db2, fake).extractSource(result.created[0]!.id);
    items2 = new ItemService(db2);
    const row = db2
      .prepare('SELECT id FROM items WHERE statement LIKE ?')
      .get(`%${SHARED_PREF}%`) as { id: string } | undefined;
    if (!row) throw new Error('前提失败：没有提炼出条目');
    itemId = row.id;
    mcp2 = new McpService(db2);
  });

  afterAll(() => {
    db2.close();
    rmSync(d2, { recursive: true, force: true });
  });

  it('未授权：按条目展开被拒', () => {
    expect(() => mcp2.getSourceExcerpt(itemId, 500)).toThrow(/个人或未整理资料/);
  });

  it('授权给编码客户端后：按条目展开可见依据原文；原文检索仍不返回', () => {
    items2.grantDisclosure({ itemId, audience: 'coding_client' });
    expect(mcp2.getSourceExcerpt(itemId, 500).excerpt).toContain(SHARED_PREF);
    // 条目本身可被搜到，但未绑定项目的原文片段仍不作为检索结果返回
    const out = mcp2.searchContext({ query: SHARED_PREF, limit: 20 });
    expect(out.results.some((r) => r.kind === 'item')).toBe(true);
    expect(out.results.some((r) => r.kind === 'segment')).toBe(false);
  });
});
