/**
 * 文件夹导入（2026-09-08 用户需求：一个项目不止一个文件）。
 * 合成目录结构验证：递归白名单、排除规则、逐文件失败隔离、去重。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ImportService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
} from '../../src/index.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-import-folder-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, vault, permissions, sources);
  const projects = new ProjectService(db);
  const project = projects.create({ name: '文件夹导入', rootPath: null, description: null });
  return { dir, db, permissions, imports, sources, project };
}

describe('ImportService.importFolder', () => {
  it('递归导入白名单文件，跳过排除目录与密钥类文件，逐文件失败隔离', () => {
    const f = fixture();
    const root = join(f.dir, 'proj');
    // 正常文件：根 + 子目录 + 深层
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), '# 项目\n\n目标说明\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '文档 A 内容');
    mkdirSync(join(root, 'docs', 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'docs', 'deep', 'deeper', 'b.txt'), '深层文档 B');
    // 排除目录：不进
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'c.md'), '不应导入');
    // 排除文件名：密钥类不进
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'secret-token.json'), '{"t":1}');
    // 非白名单扩展：不进
    writeFileSync(join(root, 'app.js'), 'console.log(1)');
    // 空文件：进白名单但读取失败（逐文件隔离）
    writeFileSync(join(root, 'empty.md'), '');

    const permission = f.permissions.grantFolder(root);
    const result = f.imports.importFolder(root, {
      projectId: f.project.id,
      permissionId: permission.id,
    });

    // 4 个白名单文件被扫描（README/a/b/empty），empty 导入失败被隔离
    expect(result.scanned).toBe(4);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toContain('empty.md');
    const titles = result.created.map((s) => s.title);
    expect(titles).toContain('README.md');
    expect(titles).toContain('a.md');
    expect(titles).toContain('b.txt');
    // 排除内容绝不在来源里
    const allTitles = f.sources.list({ projectId: null }).map((s) => s.source.title.toLowerCase());
    expect(allTitles.some((t) => t.includes('c.md'))).toBe(false);
    expect(allTitles.some((t) => t.includes('secret'))).toBe(false);
    expect(allTitles.some((t) => t.includes('app.js'))).toBe(false);
    expect(allTitles.some((t) => t.includes('.env'))).toBe(false);
    f.db.close();
  });

  it('重复导入同一目录按内容去重（幂等）', () => {
    const f = fixture();
    const root = join(f.dir, 'proj2');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'note.md'), '唯一内容同一份');
    const permission = f.permissions.grantFolder(root);
    const first = f.imports.importFolder(root, {
      projectId: f.project.id,
      permissionId: permission.id,
    });
    expect(first.created).toHaveLength(1);
    const second = f.imports.importFolder(root, {
      projectId: f.project.id,
      permissionId: permission.id,
    });
    expect(second.created).toHaveLength(0);
    expect(second.deduplicated).toHaveLength(1);
    f.db.close();
  });

  it('folder 授权撤销后拒绝导入', () => {
    const f = fixture();
    const root = join(f.dir, 'proj3');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'n.md'), 'x');
    const permission = f.permissions.grantFolder(root);
    f.permissions.revoke(permission.id);
    expect(() =>
      f.imports.importFolder(root, { projectId: f.project.id, permissionId: permission.id }),
    ).toThrow();
    f.db.close();
  });
});
