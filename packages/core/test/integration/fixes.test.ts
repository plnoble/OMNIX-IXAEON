import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  ItemService,
  Extractor,
  AskService,
  McpService,
  SearchService,
  FakeProvider,
  Logger,
  splitTextToFit,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * 验收修复回归测试（对应《IXAEON_v0.1_验收问题与修复任务》）：
 * - P1-4：FTS rowid 连接修复 + 项目隔离（问答 / prepare_task / search_context）
 * - P1-5：核心层授权链（无 allowedPaths 自授权）、撤销后全入口拒绝
 * - P1-10：提取原子替换（模型失败旧理解不变）、长文分块限长
 * - P1-9：日志白名单清洗（开头/中间/结尾都不落盘）
 */

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
let items: ItemService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-fix-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
  items = new ItemService(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 建一个属于指定项目的来源（原文 secret 标记唯一）。 */
function seedProject(
  projectName: string,
  secretMark: string,
): { projectId: string; sourceId: string } {
  const project = projects.create({ name: projectName, rootPath: null, description: null });
  const file = join(dir, `${secretMark}.md`);
  writeFileSync(file, `# ${projectName}\n\n本项目专属标记：${secretMark}。`, 'utf8');
  const result = imports.importFile(file, {
    projectId: project.id,
    permissionId: perms.grantFile(file).id,
  });
  return { projectId: project.id, sourceId: result.created[0]!.id };
}

// ---------------------------------------------------------------------------
// P1-4：FTS rowid 连接 + 项目隔离
// ---------------------------------------------------------------------------

describe('P1-4 FTS 搜索修复与项目隔离', () => {
  it('只有原文片段、没有 AI 条目的来源，问答仍能通过 FTS 找到（rowid 连接修复）', async () => {
    const { projectId } = seedProject('FTS原文项目', 'FTS原文独有标记XYZQQ');
    // 无任何 items —— 只靠 segments FTS 检索
    const fake = new FakeProvider('ask-fts');
    fake.enqueueText('找到原文标记 [R1]。');
    const asker = new AskService(db, fake);
    const result = await asker.ask(projectId, 'FTS原文独有标记XYZQQ 是什么？');
    // 修复前：s.id = f.rowid 恒不相等 → 0 命中 → 直接「资料不足」；修复后应有引用
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.citations.some((c) => c.segmentId.includes('-'))).toBe(true);
    // 模型收到的上下文包含原文
    expect(fake.textCalls[0]!.user).toContain('FTS原文独有标记XYZQQ');
  });

  it('search_context 能找到只存在于原文中的唯一关键词', () => {
    const mcp = new McpService(db);
    const out = mcp.searchContext({ query: 'FTS原文独有标记XYZQQ', limit: 8 });
    const segHit = out.results.find((r) => r.kind === 'segment');
    expect(segHit).toBeDefined();
    expect(segHit!.excerpt).toContain('FTS原文独有标记XYZQQ');
  });

  it('Project A / B / 未分配各放一个秘密标记：查询 A 只出现 A 的标记', async () => {
    const a = seedProject('隔离项目A', 'SECRETMARK-AAA');
    const b = seedProject('隔离项目B', 'SECRETMARK-BBB');
    // 未分配来源
    const looseFile = join(dir, 'loose-notes.md');
    writeFileSync(looseFile, '# 未分配\n\n私人内容：SECRETMARK-UNASSIGNED（不应混入项目）', 'utf8');
    imports.importFile(looseFile, {
      projectId: null,
      permissionId: perms.grantFile(looseFile).id,
    });

    // 问答：用 A 的标记关键词提问 → 上下文只有 A 的标记
    const fakeA = new FakeProvider('ask-a');
    fakeA.enqueueText('回答 [R1]。');
    const asker = new AskService(db, fakeA);
    await asker.ask(a.projectId, 'SECRETMARK 是什么');
    const ctxA = fakeA.textCalls[0]!.user;
    expect(ctxA).toContain('SECRETMARK-AAA');
    expect(ctxA).not.toContain('SECRETMARK-BBB');
    expect(ctxA).not.toContain('SECRETMARK-UNASSIGNED');
    void b;

    // MCP search_context：指定 A → 只有 A
    const mcp = new McpService(db);
    const outA = mcp.searchContext({ query: 'SECRETMARK', project_ref: '隔离项目A', limit: 20 });
    const allA = outA.results.map((r) => JSON.stringify(r));
    expect(allA.some((s) => s.includes('SECRETMARK-AAA'))).toBe(true);
    expect(allA.some((s) => s.includes('SECRETMARK-BBB'))).toBe(false);
    expect(allA.some((s) => s.includes('SECRETMARK-UNASSIGNED'))).toBe(false);

    // 全局搜索（不指定项目）包含未分配资料 —— 规则记录于 docs/privacy-model.md
    const outAll = mcp.searchContext({ query: 'SECRETMARK', limit: 20 });
    const allText = outAll.results.map((r) => JSON.stringify(r)).join('\n');
    expect(allText).toContain('SECRETMARK-AAA');
    expect(allText).toContain('SECRETMARK-BBB');
    expect(allText).toContain('SECRETMARK-UNASSIGNED');
  });

  it('中英文、引号、连字符等输入不造成 FTS SQL 错误', () => {
    const search = new SearchService(db);
    const queries = ['中文查询"引号"', "it's-hyphen", 'a"b', '——破折号', 'SELECT * FROM x'];
    for (const q of queries) {
      expect(() => search.searchSegments(q, {})).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// P1-5：核心层授权链与撤销语义
// ---------------------------------------------------------------------------

describe('P1-5 核心层授权链（无 allowedPaths 自授权）', () => {
  it('渲染层式调用（自行声明路径，无授权 ID）必须被拒绝', () => {
    const file = join(dir, 'no-auth.md');
    writeFileSync(file, '# 无授权内容');
    // 新签名要求 permissionId；不存在的授权 ID 直接拒绝
    expect(() =>
      imports.importFile(file, { projectId: null, permissionId: randomUuid() }),
    ).toThrowError(/授权记录不存在/);
  });

  it('伪造授权 ID / 用 A 授权读 B 文件：路径不在授权范围内拒绝', () => {
    const fileA = join(dir, 'auth-A.md');
    const fileB = join(dir, 'auth-B.md');
    writeFileSync(fileA, '# A');
    writeFileSync(fileB, '# B 机密内容 SECRET-B-CONTENT');
    const permA = perms.grantFile(fileA);
    // A 的 file 授权不能读同目录 B 文件
    expect(() =>
      imports.importFile(fileB, { projectId: null, permissionId: permA.id }),
    ).toThrowError(/不在授权范围|PATH_ESCAPE|拒绝/);
  });

  it('撤销授权后：阅读、上下文、搜索、问答、MCP（segment 与 item 两条路径）、重新提取全部拒绝', async () => {
    const { projectId, sourceId } = seedProject('撤销项目', 'REVOKEMARK-XYZ');
    // 先提取出一条 item（有依据），保证 item 路径可测
    const fake = new FakeProvider('extract-revoke');
    fake.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '撤销测试结论 REVOKEMARK',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: 'REVOKEMARK',
        },
      ],
    });
    const extractor = new Extractor(db, fake);
    await extractor.extractSource(sourceId);
    const itemRow = db
      .prepare("SELECT id FROM items WHERE statement LIKE '%撤销测试结论%'")
      .get() as { id: string };
    expect(itemRow).toBeTruthy();
    const segRow = db
      .prepare('SELECT id FROM segments WHERE source_id = ? LIMIT 1')
      .get(sourceId) as { id: string };

    // 撤销来源授权
    const source = sources.get(sourceId)!;
    perms.revoke(source.permission_id);

    // 1) 片段阅读
    expect(() => sources.getSegments(sourceId, 0, 10)).toThrowError(/撤销/);
    // 2) 上下文
    expect(() => sources.getSegmentContext(segRow.id, 100, 100)).toThrowError(/撤销/);
    // 3) 全文搜索（不返回该来源）
    const search = new SearchService(db);
    const hits = search.searchSegments('REVOKEMARK', {});
    expect(hits.length).toBe(0);
    // 4) 问答上下文不含撤销来源的原文
    const askFake = new FakeProvider('ask-revoke');
    askFake.enqueueText('回答 [R1]。');
    const asker = new AskService(db, askFake);
    const answer = await asker.ask(projectId, 'REVOKEMARK 在哪里出现');
    expect(answer.citations.every((c) => c.segmentId !== segRow.id)).toBe(true);
    expect(askFake.textCalls[0]!.user).not.toContain('REVOKEMARK-XYZ');
    // 5) MCP get_source_excerpt — segment_id 路径
    const mcp = new McpService(db);
    expect(() => mcp.getSourceExcerpt(segRow.id, 2000)).toThrowError(/撤销/);
    // 6) MCP get_source_excerpt — item_id 路径（修复前旁路，修复后一致拒绝）
    expect(() => mcp.getSourceExcerpt(itemRow.id, 2000)).toThrowError(/撤销/);
    // 7) 重新提取
    const fake2 = new FakeProvider('extract-revoke-2');
    fake2.enqueueStructured({ items: [] });
    const extractor2 = new Extractor(db, fake2);
    await expect(extractor2.extractSource(sourceId)).rejects.toThrowError(/撤销/);
    // 8) 删除与撤销相互独立：来源仍在列表中（撤销不自动删除）
    expect(sources.list({ projectId: null }).some((s) => s.source.id === sourceId)).toBe(true);
    expect(sources.list({ projectId: null }).find((s) => s.source.id === sourceId)!.permissionStatus).toBe('revoked');
  });

  it('目录授权范围内的文件可读；符号链接指向范围外拒绝', () => {
    const root = join(dir, 'authorized-root');
    mkdirSync(join(root), { recursive: true });
    const insideFile = join(root, 'inside.md');
    writeFileSync(insideFile, '# 范围内文件', 'utf8');
    const outsideFile = join(dir, 'outside-secret.md');
    writeFileSync(outsideFile, '# 范围外机密 OUTSIDE-SECRET', 'utf8');
    const perm = perms.grantFolder(root);
    // 范围内可导入
    expect(() =>
      imports.importFile(insideFile, { projectId: null, permissionId: perm.id }),
    ).not.toThrow();
    // 范围外拒绝
    expect(() =>
      imports.importFile(outsideFile, { projectId: null, permissionId: perm.id }),
    ).toThrowError();
    // 符号链接逃逸：范围内一个链接指向范围外文件（Windows 需要管理员或开发者模式；
    // 创建失败时跳过该断言，由 isPathInside 的 realpath 逻辑在其他平台覆盖）
    try {
      const linkPath = join(root, 'escape-link.md');
      symlinkSync(outsideFile, linkPath, 'file');
      expect(() =>
        imports.importFile(linkPath, { projectId: null, permissionId: perm.id }),
      ).toThrowError();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        // Windows 符号链接权限受限：跳过（环境限制，非实现缺陷）
      } else {
        throw err;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P1-10：提取原子替换 + 长文分块
// ---------------------------------------------------------------------------

describe('P1-10 提取事务与长文分块', () => {
  it('第一个模型块失败：旧 current 理解保持不变（不再先删后写）', async () => {
    const { sourceId } = seedProject('提取失败项目', 'EXTRACTFAILMARK');
    // 先成功提取一次 → 旧理解
    const ok = new FakeProvider('extract-ok');
    ok.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '旧理解（应保留）OLDKEEPMARK',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: 'EXTRACTFAILMARK',
        },
      ],
    });
    await new Extractor(db, ok).extractSource(sourceId);
    const oldCount = (
      db.prepare("SELECT COUNT(*) c FROM items WHERE statement LIKE '%OLDKEEPMARK%'").get() as {
        c: number;
      }
    ).c;
    expect(oldCount).toBe(1);

    // 重新提取：第一个模型调用就抛错（队列空）
    const failing = new FakeProvider('extract-fail');
    const stats = await new Extractor(db, failing)
      .extractSource(sourceId)
      .then(() => 'unexpected-success')
      .catch(() => 'failed-as-expected');
    expect(stats).toBe('failed-as-expected');
    // 旧理解仍在（修复前：deleteOldAiItems 先执行 → 旧条目已删光）
    const stillThere = (
      db.prepare("SELECT COUNT(*) c FROM items WHERE statement LIKE '%OLDKEEPMARK%'").get() as {
        c: number;
      }
    ).c;
    expect(stillThere).toBe(1);
  });

  it('所有块成功后才原子替换；纠正历史（superseded）不丢失', async () => {
    const { sourceId } = seedProject('原子替换项目', 'ATOMICREPLACEMARK');
    const v1 = new FakeProvider('atomic-v1');
    v1.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '原子替换 v1 结论',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: 'ATOMICREPLACEMARK',
        },
      ],
    });
    await new Extractor(db, v1).extractSource(sourceId);
    const v1Item = db
      .prepare("SELECT id FROM items WHERE statement = '原子替换 v1 结论'")
      .get() as { id: string };
    // 用户纠正 v1
    items.correct({ itemId: v1Item.id, userText: '用户纠正后的结论' });

    // 重新提取成功 → v1 的 superseded 历史仍在，新结论写入
    const v2 = new FakeProvider('atomic-v2');
    v2.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '原子替换 v2 结论',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: 'ATOMICREPLACEMARK',
        },
      ],
    });
    const stats = await new Extractor(db, v2).extractSource(sourceId);
    expect(stats.inserted).toBe(1);
    const v1After = db
      .prepare("SELECT state FROM items WHERE statement = '原子替换 v1 结论'")
      .get() as { state: string };
    expect(v1After.state).toBe('superseded'); // 纠正历史保留
    const userAfter = db
      .prepare("SELECT state FROM items WHERE statement = '用户纠正后的结论'")
      .get() as { state: string };
    expect(userAfter.state).toBe('current'); // 用户纠正不受重提影响
  });

  it('30,000 字符单段：任何模型请求的 user 文本都不超过上限', async () => {
    const longFile = join(dir, 'long-single-para.md');
    writeFileSync(longFile, '# 长文\n\n' + '超长无换行正文单元ABC'.repeat(4000), 'utf8');
    const result = imports.importFile(longFile, {
      projectId: null,
      permissionId: perms.grantFile(longFile).id,
    });
    const sourceId = result.created[0]!.id;
    const fake = new FakeProvider('long-doc');
    // 每块都返回空结论（分块行为是断言重点）
    const blockCountGuess = 12;
    for (let i = 0; i < blockCountGuess; i++) fake.enqueueStructured({ items: [] });
    await new Extractor(db, fake).extractSource(sourceId);
    // 每个模型请求的完整 user 文本 ≤ 8000（含编号与角色头）
    for (const call of fake.structuredCalls) {
      expect(call.user.length).toBeLessThanOrEqual(8000);
    }
    // 长文被切成多个块（不只一块）
    expect(fake.structuredCalls.length).toBeGreaterThan(1);
    // 单段文档也被拆为多个 segment（可引用粒度）
    const segCount = (
      db.prepare('SELECT COUNT(*) c FROM segments WHERE source_id = ?').get(sourceId) as {
        c: number;
      }
    ).c;
    expect(segCount).toBeGreaterThan(1);
  });

  it('多个标题的 Markdown：按标题拆分，引用可打开原文', async () => {
    const mdFile = join(dir, 'headings.md');
    writeFileSync(
      mdFile,
      [
        '# 一级标题甲',
        '甲的正文内容。',
        '## 二级标题乙',
        '乙的正文内容。',
        '# 一级标题丙',
        '丙的正文内容，含 HEADINGSRCMARK 标记。',
      ].join('\n\n'),
      'utf8',
    );
    const result = imports.importFile(mdFile, {
      projectId: null,
      permissionId: perms.grantFile(mdFile).id,
    });
    const sourceId = result.created[0]!.id;
    const { segments } = sources.getSegments(sourceId, 0, 100);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const texts = segments.map((s) => s.text).join('\n');
    expect(texts).toContain('甲的正文内容');
    expect(texts).toContain('丙的正文内容');
    // 原文 vault 逐字保留（raw_path 是严格相对路径；按 absolutePath 读取）
    const source = sources.get(sourceId)!;
    const raw = readFileSync(vault.absolutePath(source.raw_path)).toString('utf8');
    expect(raw).toContain('# 一级标题甲');
    expect(raw).toContain('丙的正文内容，含 HEADINGSRCMARK 标记。');
  });

  it('splitTextToFit：切分结果不超限且内容完整（顺序拼接可重组）', () => {
    const text = '一二三四五六七八九十'.repeat(3000); // 30000 字符无边界
    const parts = splitTextToFit(text, 7900);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(7900);
    expect(parts.join('')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// P1-9：日志白名单（补强：独特短语任何片段不出现）
// ---------------------------------------------------------------------------

describe('P1-9 日志正文白名单（集成层）', () => {
  it('importer/extractor 风格字段（file、error、text）不落正文与密钥', () => {
    const logFile = join(dir, 'p19-integration.log');
    const logger = new Logger({ file: logFile, baseFields: { app: 'ixaeon' } });
    const unique = `PHRASE-${Date.now()}-${Math.random().toString(36).slice(2)}-独白`;
    logger.info('导入完成', {
      file: `/秘密路径/${unique}/conversations.json`,
      error: `解析失败：${unique}`,
      text: `${unique} 用户说了悄悄话`,
    });
    const content = readFileSync(logFile, 'utf8');
    expect(content).not.toContain(unique);
    expect(content).toMatch(/"file":"\[content \d+ chars sha256:[0-9a-f]{12}\]"/);
  });
});

// ---------------------------------------------------------------------------
// P1-7：导出人类可读 + 恢复原子性（恶意包）
// ---------------------------------------------------------------------------

describe('P1-7 导出/恢复补充（人类可读 JSON + 恶意 raw_path）', () => {
  it('导出 ZIP 内 data/*.json 不依赖 IXAEON 即可阅读（含项目/结论/纠正/工作记录）', async () => {
    const { ArchiveService } = await import('../../src/storage/archiveStore.js');
    const archive = new ArchiveService(db, {
      dataDir: dir,
      dbPath: join(dir, 'ixaeon.db'),
      vault,
      closeCurrentDb: () => {},
    });
    const zipPath = join(dir, 'readable-export.zip');
    await archive.exportData(zipPath);
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    const dataFiles = [
      'data/projects.json',
      'data/sources.json',
      'data/segments.json',
      'data/items.json',
      'data/item-evidence.json',
      'data/corrections.json',
      'data/work-runs.json',
      'data/permissions.json',
    ];
    for (const name of dataFiles) {
      const f = zip.file(name);
      expect(f, name).not.toBeNull();
      const parsed = JSON.parse(String(await f!.async('string'))) as {
        formatVersion: number;
        rows: unknown[];
      };
      expect(parsed.formatVersion).toBe(1);
      expect(Array.isArray(parsed.rows)).toBe(true);
    }
    // 项目 JSON 包含真实项目名
    const projectsJson = JSON.parse(
      String(await zip.file('data/projects.json')!.async('string')),
    ) as { rows: Array<{ name: string }> };
    expect(projectsJson.rows.some((p) => p.name === '隔离项目A')).toBe(true);
  });
});

function randomUuid(): string {
  return crypto.randomUUID();
}
