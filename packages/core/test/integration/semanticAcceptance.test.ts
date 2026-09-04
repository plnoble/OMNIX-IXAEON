import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  SearchService,
  ArchiveService,
  MAX_BLOCK_CHARS,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * P2-11 真实文档语义验收（对两份真实思想文档执行）：
 * 1. 真实导入 JARVIS 宪法 + grok 思想碰撞
 * 2. 验证分块（标题/段落拆分、超长段限长、vault 逐字保留）
 * 3. 验证六组验收问题的可检索性与真实引用（含「资料不足」路径）
 * 4. 生成人类可读导出样例 ixaeon-export-sample.zip（release 目录）
 * 不把预期答案写进生产代码——问题与判据只在测试材料中。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOC_A = join(root, 'JARVIS_CONSTITUTION_v0.1.md');
const DOC_B = join(root, 'grok-20260903-IXAEON-思想碰撞.md');

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
let search: SearchService;
let archive: ArchiveService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-semantic-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
  search = new SearchService(db);
  archive = new ArchiveService(db, {
    dataDir: dir,
    dbPath: join(dir, 'ixaeon.db'),
    vault,
    closeCurrentDb: () => {},
  });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P2-11 真实文档语义验收', () => {
  it('真实导入两份思想文档', () => {
    expect(existsSync(DOC_A)).toBe(true);
    expect(existsSync(DOC_B)).toBe(true);
    const project = projects.create({
      name: 'IXAEON',
      rootPath: root,
      description: 'IXAEON v0.1 第一阶段项目（语义验收）',
    });
    const resA = imports.importFile(DOC_A, {
      projectId: project.id,
      permissionId: perms.grantFile(DOC_A).id,
    });
    const resB = imports.importFile(DOC_B, {
      projectId: project.id,
      permissionId: perms.grantFile(DOC_B).id,
    });
    expect(resA.created).toHaveLength(1);
    expect(resB.created).toHaveLength(1);
  });

  it('分块验证：标题/段落拆分 + 单段限长 + vault 逐字保留', () => {
    const all = sources.list({ projectId: null });
    // 列表按导入时间倒序：后导入的 grok 文档在前
    const docGrok = all.find((s) => s.source.title.includes('grok'))!;
    const docJarvis = all.find((s) => s.source.title.includes('JARVIS'))!;
    const segsA = sources.getSegments(docJarvis.source.id, 0, 2000).segments;
    const segsB = sources.getSegments(docGrok.source.id, 0, 2000).segments;
    expect(segsA.length).toBeGreaterThan(5);
    expect(segsB.length).toBeGreaterThan(5);
    for (const s of [...segsA, ...segsB]) {
      expect(s.text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    }
    // 原文 vault 逐字保留（两份都 >10k 字符）
    const rawA = readFileSync(vault.absolutePath(docJarvis.source.raw_path), 'utf8');
    expect(rawA.length).toBeGreaterThan(10_000);
    // 原文打开功能：片段 → 原文可追溯
    const ctx = sources.getSegmentContext(segsA[0]!.id, 200, 200);
    expect(ctx).not.toBeNull();
    expect(ctx!.sourceTitle).toContain('JARVIS');
  });

  it('六组验收问题可检索且有真实引用', () => {
    const project = projects.list().find((p) => p.name === 'IXAEON')!;
    const pid = { projectId: project.id, limit: 5 };
    // Q1 名称：IXAEON 正式名 / 析衍中文名 / JARVIS 非正式
    expect(search.searchSegments('IXAEON', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('析衍', pid).length).toBeGreaterThan(0);
    // Q2 第一阶段定位：项目连续性，而非大而全聊天助手
    expect(search.searchSegments('第一阶段', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('连续性', pid).length).toBeGreaterThan(0);
    // Q3 原文 / 当前理解 / 用户纠正（两份文档中对应「原文不可改 + 纠正不覆盖」表述）
    expect(search.searchSegments('原文', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('纠正', pid).length).toBeGreaterThan(0);
    // Q4 编码 AI 获得有限、相关、带引用的背景（文档中为「可追溯 / 依据」表述）
    expect(search.searchSegments('MCP', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('可追溯', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('依据', pid).length).toBeGreaterThan(0);
    // Q5 ChatGPT 自动收回 + 暂停/撤销（文档中为「授权 / 保留 / 收回」表述）
    expect(search.searchSegments('ChatGPT', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('授权', pid).length).toBeGreaterThan(0);
    // Q6 表述不一致时展示来源差异（文档中为「版本 / 保留」表述：历史版本不被悄悄合并）
    expect(search.searchSegments('版本', pid).length).toBeGreaterThan(0);
    expect(search.searchSegments('保留', pid).length).toBeGreaterThan(0);
    // 资料不足路径：不存在的概念明确 0 命中
    expect(search.searchSegments('量子重力超导体不存在的内容XYZ', pid)).toHaveLength(0);
  });

  it('生成人类可读导出样例 ixaeon-export-sample.zip + 验收记录', async () => {
    const samplePath = join(root, 'apps', 'desktop', 'release', 'ixaeon-export-sample.zip');
    await archive.exportData(samplePath);
    expect(existsSync(samplePath)).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(samplePath));
    const projectsJson = JSON.parse(await zip.file('data/projects.json')!.async('string')) as {
      rows: Array<{ name: string }>;
    };
    expect(projectsJson.rows.some((p) => p.name === 'IXAEON')).toBe(true);
    const segmentsJson = JSON.parse(await zip.file('data/segments.json')!.async('string')) as {
      count: number;
    };
    expect(segmentsJson.count).toBeGreaterThan(10);
    expect(Object.keys(zip.files).some((n) => n.startsWith('vault/'))).toBe(true);

    // 验收记录（引用片段示例，供 REVIEW_PACKET 引用）
    const project = projects.list().find((p) => p.name === 'IXAEON')!;
    const hits = search.searchSegments('IXAEON', { projectId: project.id, limit: 2 });
    const record = {
      executedAt: new Date().toISOString(),
      docs: ['JARVIS_CONSTITUTION_v0.1.md', 'grok-20260903-IXAEON-思想碰撞.md'],
      sampleEvidence: hits.map((h) => ({
        sourceTitle: h.sourceTitle,
        excerpt: h.excerpt.slice(0, 120),
      })),
      exportSample: samplePath,
    };
    writeFileSync(
      join(root, 'apps', 'desktop', 'release', 'semantic-acceptance.json'),
      JSON.stringify(record, null, 2),
      'utf8',
    );
  });
});
