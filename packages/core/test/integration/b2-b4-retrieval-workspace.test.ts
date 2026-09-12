import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  SearchService,
  CodingTaskStore,
  KeywordRetrievalAdapter,
  LanceDbRetrievalAdapter,
  copyProjectWorkspace,
  sanitizePublicQuery,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-b2b4rw-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('公开查询脱敏', () => {
  it('去掉邮箱、路径和密钥，不把私人原文当搜索词', () => {
    const s = sanitizePublicQuery(
      '帮我搜 sk-abc1234567 和 a@b.com 以及 C:\\Users\\me\\secret 我的密码是什么',
    );
    expect(s.redacted).toBe(true);
    expect(s.query).not.toMatch(/sk-abc1234567/);
    expect(s.query).not.toMatch(/a@b\.com/);
    expect(s.query).not.toMatch(/C:\\Users/);
    expect(s.reasons).toEqual(expect.arrayContaining(['email', 'credential', 'local-path']));
  });
});

describe('检索适配器：无嵌入则关键词降级', () => {
  it('LanceDB 未配置时 degraded=true，结果仍走关键词且不是语义验收', () => {
    const keyword = new KeywordRetrievalAdapter(new SearchService(db));
    const lance = new LanceDbRetrievalAdapter(keyword, '');
    const hit = lance.lookup('不存在的查询词xyz', { projectId: null, limit: 4 });
    expect(hit.degraded).toBe(true);
    expect(hit.notice).toMatch(/不是语义验收通过|关键词/);
    expect(hit.backend).toBe('lancedb');
  });
});

describe('现有项目工作区副本可追溯', () => {
  it('复制真实文件、跳过 .env、记录 sha256，空目录不能冒充快照', () => {
    const root = join(dir, 'proj');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export const n = 1;\n', 'utf8');
    writeFileSync(join(root, '.env'), 'SECRET=1\n', 'utf8');
    const dest = join(dir, 'ws');
    const snap = copyProjectWorkspace(root, dest);
    expect(snap.fileCount).toBe(1);
    expect(snap.skipped.some((p) => p === '.env' || p.endsWith('.env'))).toBe(true);
    expect(existsSync(join(dest, 'src', 'app.ts'))).toBe(true);
    expect(existsSync(join(dest, '.env'))).toBe(false);
    expect(readFileSync(join(dest, 'src', 'app.ts'), 'utf8')).toMatch(/export const n/);
    expect(snap.snapshotRef).toMatch(/sha256:[0-9a-f]{64}/);
    expect(snap.snapshotRef).toMatch(/files:1/);

    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(() => copyProjectWorkspace(empty, join(dir, 'ws-empty'))).toThrow(/空/);

    const projects = new ProjectService(db);
    const project = projects.create({ name: '有根项目', rootPath: root, description: null });
    const store = new CodingTaskStore(db);
    const task = store.create({
      projectId: project.id,
      goal: '改 app.ts',
      scope: ['src/app.ts'],
      allowedCommands: [['check']],
    });
    const prepared = store.prepareWorkspace(task.id, dir);
    expect(prepared.snapshot_ref).toMatch(/sha256:/);
    expect(existsSync(join(prepared.workspace_path!, 'src', 'app.ts'))).toBe(true);
    void new ItemService(db);
  });
});
