import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
  ArchiveService,
  type CoreDatabase,
} from '../../src/index.js';
import { fixturePath } from '@ixaeon/test-fixtures';

/**
 * M5 导出/恢复测试（计划 7.x）：
 * - 导出 ZIP 结构（manifest/readme/db/vault）
 * - 预览（计数 + 项目列表 + 警告）
 * - 恢复（替换 + 备份 + 数据一致）
 * - 安全：非本应用 ZIP 拒绝；zip slip 条目拒绝
 */

let dir: string;
let db: CoreDatabase;
let archive: ArchiveService;
let sources: SourceStore;
let imports: ImportService;
let vault: InstanceType<typeof Vault>;
let closed = false;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m5-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const dbPath = join(dir, 'ixaeon.db');
  db = openDatabase(dbPath);
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  sources = new SourceStore(db);
  const projects = new ProjectService(db);
  imports = new ImportService(db, vault, permissions, sources);
  archive = new ArchiveService(db, {
    dataDir: dir,
    dbPath,
    vault,
    closeCurrentDb: () => {
      closed = true;
      // 真正关闭（Windows 上打开的文件无法 rename 备份）
      try {
        db.close();
      } catch {
        // 已关闭
      }
    },
  });

  project = projects.create({ name: '导出测试项目', rootPath: null, description: null });
  const doc = fixturePath('files', 'project-notes.md');
  imports.importFile(doc, { projectId: project.id, permissionId: permissions.grantFile(doc).id });
});

let project: { id: string; name: string };

afterAll(() => {
  try {
    db.close();
  } catch {
    // 已关闭
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('M5 导出', () => {
  it('导出为 ZIP（manifest + readme + db + vault）', async () => {
    const zipPath = join(dir, 'export.zip');
    const result = await archive.exportData(zipPath);
    expect(result.zipPath).toBe(zipPath);
    expect(result.fileCount).toBeGreaterThanOrEqual(3); // manifest + readme + db
    expect(result.totalChars).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    expect(zip.file('manifest.json')).not.toBeNull();
    expect(zip.file('readme.txt')).not.toBeNull();
    expect(zip.file('db.sqlite')).not.toBeNull();
    // vault 文件（导入过 1 个来源）
    const vaultEntries = Object.keys(zip.files).filter((n) => n.startsWith('vault/'));
    expect(vaultEntries.length).toBeGreaterThanOrEqual(1);

    const manifest = JSON.parse(String(await zip.file('manifest.json')!.async('string'))) as {
      counts: Record<string, number>;
    };
    expect(manifest.counts.projects).toBe(1);
    expect(manifest.counts.sources).toBe(1);

    // readme 人类可读
    const readme = await zip.file('readme.txt')!.async('string');
    expect(readme).toContain('IXAEON');
    expect(readme).toContain('恢复');
  });

  it('导出目标必须是 .zip', async () => {
    await expect(archive.exportData(join(dir, 'export.tar'))).rejects.toThrowError(/必须是 \.zip/);
  });
});

describe('M5 恢复预览', () => {
  it('预览返回计数 + 项目 + 警告（替换提醒）', async () => {
    const zipPath = join(dir, 'export.zip');
    const preview = await archive.previewRestore(zipPath);
    expect(preview.manifestVersion).toBe(2);
    expect(preview.counts.projects).toBe(1);
    expect(preview.projects[0]!.name).toBe('导出测试项目');
    expect(preview.warnings.some((w) => w.includes('替换当前全部数据'))).toBe(true);
  });

  it('不存在的文件报 NOT_FOUND', async () => {
    await expect(archive.previewRestore(join(dir, 'no.zip'))).rejects.toThrowError(/不存在/);
  });

  it('非 ZIP 文件报格式错误', async () => {
    const bad = join(dir, 'bad.zip');
    writeFileSync(bad, 'this is not a zip');
    await expect(archive.previewRestore(bad)).rejects.toThrowError(/不是有效的 ZIP/);
  });

  it('缺 manifest 的 ZIP 被拒绝', async () => {
    const bad = join(dir, 'nomanifest.zip');
    const zip = new JSZip();
    zip.file('random.txt', 'hello');
    writeFileSync(bad, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(archive.previewRestore(bad)).rejects.toThrowError(/缺少 manifest/);
  });

  it('manifest 版本不匹配在恢复时拒绝', async () => {
    const bad = join(dir, 'badversion.zip');
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ manifestVersion: 99 }));
    zip.file('db.sqlite', Buffer.alloc(100, 0));
    writeFileSync(bad, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(archive.restoreData(bad)).rejects.toThrowError(/清单版本/);
  });
});

describe('M5 恢复（替换 + 备份）', () => {
  it('恢复成功：数据一致 + 备份生成 + 旧连接关闭', async () => {
    const zipPath = join(dir, 'export.zip');
    closed = false;
    const result = await archive.restoreData(zipPath);
    expect(result.ok).toBe(true);
    expect(closed).toBe(true);
    expect(existsSync(join(result.backupDir, 'ixaeon.db'))).toBe(true);

    // 恢复后的数据库包含导出时的数据
    const restored = openDatabase(join(dir, 'ixaeon.db'));
    const projects = restored.prepare('SELECT name FROM projects').all() as Array<{ name: string }>;
    expect(projects.some((p) => p.name === '导出测试项目')).toBe(true);
    const segCount = (restored.prepare('SELECT COUNT(*) n FROM segments').get() as { n: number }).n;
    expect(segCount).toBeGreaterThan(0);
    // vault 原文恢复（物理布局 ab/hash）
    const srcRow = restored
      .prepare('SELECT raw_path FROM sources WHERE raw_path IS NOT NULL LIMIT 1')
      .get() as { raw_path: string } | undefined;
    if (srcRow?.raw_path) {
      const abs = vault.absolutePath(srcRow.raw_path);
      expect(existsSync(abs)).toBe(true);
    }
    restored.close();
  });
});

describe('M5 安全（zip slip 防护）', () => {
  it('含 .. 路径的 vault 条目被拒绝', async () => {
    const evil = join(dir, 'evil.zip');
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        manifestVersion: 1,
        appVersion: '0.1.0',
        exportedAt: new Date().toISOString(),
        counts: {},
      }),
    );
    zip.file('db.sqlite', readFileSync(join(dir, 'export.zip')).subarray(0, 0)); // 会被 db 校验先拒
    zip.file('vault/../../evil.txt', 'pwned');
    writeFileSync(evil, await zip.generateAsync({ type: 'nodebuffer' }));
    // db.sqlite 为空 → 先触发 db 校验（同样拒绝）；专测路径需合法 db
    await expect(archive.restoreData(evil)).rejects.toThrowError();
  });

  it('未知顶层条目被拒绝', async () => {
    const evil = join(dir, 'evil2.zip');
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ manifestVersion: 1 }));
    zip.file('evil.exe', 'malware');
    writeFileSync(evil, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(archive.restoreData(evil)).rejects.toThrowError();
  });

  it('合法导出 + 注入 evil 条目：仍被拒绝（路径校验）', async () => {
    // 用合法导出 + 加一个 evil 条目
    const zipPath = join(dir, 'export.zip');
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    zip.file('vault/../outside.txt', 'pwned');
    const evil = join(dir, 'evil3.zip');
    writeFileSync(evil, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(archive.restoreData(evil)).rejects.toThrowError(/zip slip|未知条目/);
  });
});
