import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  Extractor,
  FakeProvider,
  type CoreDatabase,
} from '@ixaeon/core';

/**
 * M1.2 展示真实状态（数据层）：
 * - listSources 返回所属项目名、内容版本、已分析版本、最后成功分析时间、
 *   最近任务状态与错误原因；
 * - 「收到资料」与「模型理解完成」不共用标记（content vs analyzed）；
 * - 最近同步时间随追加更新。
 *
 * 说明：生产中 analyzed 推进/任务落库由 AppRuntime 的 extract 处理器 +
 * JobQueue 完成；本测试用同序列调用（advanceAnalyzedRevision / 手工插任务行）
 * 模拟生产处理器行为。
 */

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m1-status-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(name: string, body: string): { id: string; file: string } {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, `# ${name}\n\n${body}`, 'utf8');
  const created = imports
    .importFile(file, { projectId: null, permissionId: perms.grantFile(file).id })
    .created[0]!;
  return { id: created.id, file };
}

/** 模拟生产 extract 处理器的完成动作：推进 analyzed 并落任务行。 */
function simulateExtractJob(sourceId: string, outcome: 'succeeded' | 'failed', error: string | null): void {
  const now = new Date().toISOString();
  const target = sources.getRevisions(sourceId).content;
  if (outcome === 'succeeded') {
    sources.advanceAnalyzedRevision(sourceId, target);
  }
  db.prepare(
    `INSERT INTO jobs (id, kind, status, payload_json, progress, error, retry_count, created_at, updated_at)
     VALUES (?, 'extract', ?, ?, 0, ?, 0, ?, ?)`,
  ).run(crypto.randomUUID(), outcome, JSON.stringify({ sourceId }), error, now, now);
}

function statusOf(sourceId: string) {
  const row = sources.list({ projectId: null }).find((s) => s.source.id === sourceId)!;
  return { ...row.analysis, projectName: row.projectName };
}

describe('M1.2 真实状态数据', () => {
  it('新导入来源：已收到等待分析（content 1 / analyzed 0 / 无任务），项目名展示', () => {
    const project = projects.create({ name: '状态项目', rootPath: null, description: null });
    const s = seed('status-a', 'STATUS_MARK_A 内容。');
    sources.bindProject(s.id, project.id);
    const st = statusOf(s.id);
    expect(st.contentRevision).toBe(1);
    expect(st.analyzedRevision).toBe(0);
    expect(st.analyzedAt).toBeNull();
    expect(st.lastJobStatus).toBeNull();
    expect(st.projectName).toBe('状态项目');
  });

  it('提取成功：analyzed 追平、analyzed_at 记录、任务 succeeded', () => {
    const s = seed('status-b', 'STATUS_MARK_B 内容。');
    const fake = new FakeProvider('m1-status');
    fake.enqueueStructured({ items: [] });
    new Extractor(db, fake).extractSource(s.id);
    simulateExtractJob(s.id, 'succeeded', null);
    const st = statusOf(s.id);
    expect(st.contentRevision).toBe(1);
    expect(st.analyzedRevision).toBe(1);
    expect(st.analyzedAt).toBeTruthy();
    expect(st.lastJobStatus).toBe('succeeded');
  });

  it('追加新内容：content 递增、analyzed 不变 → 「有新内容尚未分析」可见', () => {
    const s = seed('status-c', 'STATUS_MARK_C 内容。');
    const fake = new FakeProvider('m1-status-c');
    fake.enqueueStructured({ items: [] });
    new Extractor(db, fake).extractSource(s.id);
    simulateExtractJob(s.id, 'succeeded', null);
    const before = statusOf(s.id);
    expect(before.contentRevision).toBe(before.analyzedRevision);

    sources.appendCapturedTurns(s.id, [
      { order: 10, role: 'user', text: '追加 STATUS_APPEND_MARK' },
    ]);
    const after = statusOf(s.id);
    expect(after.contentRevision).toBe(before.contentRevision + 1);
    expect(after.analyzedRevision).toBe(before.analyzedRevision); // 旧理解仍在展示
  });

  it('任务失败：状态与错误原因可见（模型未配置场景）', () => {
    const s = seed('status-d', 'STATUS_MARK_D 内容。');
    simulateExtractJob(s.id, 'failed', 'IXA0010 模型未配置：请在设置中填写 OpenAI API Key');
    const st = statusOf(s.id);
    expect(st.lastJobStatus).toBe('failed');
    expect(st.lastJobError).toContain('IXA0010');
    expect(st.contentRevision).toBeGreaterThan(st.analyzedRevision); // 仍欠分析
  });
});
