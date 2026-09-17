import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ImportService,
  PermissionService,
  Vault,
  SourceStore,
  isSourceAuthorized,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * 问答落 Core（用户 2026-09-13 指示：所有问答内容都进 Core）。
 *
 * 每次桌面问答的回答存为 ask_session 来源（迁移 20 扩 provider 枚举），
 * 挂在 ask.ixaeon.local 域授权上；走既有提取管线生成理解候选（提案→
 * 用户确认）。撤销授权 = 停止提取/读取，与其他来源同一套边界。
 */

let dir: string;
let db: CoreDatabase;
let vaultDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-askcap-'));
  vaultDir = join(dir, 'vault');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟：尽力清理
  }
});

function makeImports(): { imports: ImportService; permissions: PermissionService } {
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, new Vault(vaultDir), permissions, sources);
  return { imports, permissions };
}

describe('问答落 Core（ask_session 来源）', () => {
  it('问答对存为来源：片段 user→assistant、vault 原文在盘、授权有效', () => {
    const { imports, permissions } = makeImports();
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const result = imports.captureAsk({
      question: '帮我记一下：周三下午要去看牙',
      answer: '已帮你记下：本周三下午看牙。',
      conversationId: 'conv-1',
      userSeq: 1,
      assistantSeq: 2,
      runId: 'run-1',
      engine: 'hermes',
      model: 'gemini-3.7-flash-tiered',
      projectId: null,
      permissionId: perm.id,
    });
    expect(result.created).toBe(true);
    expect(result.source.provider).toBe('ask_session');
    expect(result.source.kind).toBe('conversation');
    expect(result.source.title).toContain('周三');

    const segments = db
      .prepare('SELECT sequence, role, text FROM segments WHERE source_id = ? ORDER BY sequence')
      .all(result.source.id) as Array<{ sequence: number; role: string; text: string }>;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.role).toBe('user');
    expect(segments[0]!.text).toContain('看牙');
    expect(segments[1]!.role).toBe('assistant');
    expect(segments[1]!.text).toContain('已帮你记下');

    const vault = new Vault(vaultDir);
    expect(existsSync(vault.absolutePath(result.source.raw_path))).toBe(true);
    // vault 读回 = 原文（问答对完整保留）
    const vaultHash = result.source.raw_path.replace(/\\/g, '/').split('/').pop()!;
    expect(vault.read(vaultHash).toString('utf8')).toContain('看牙');
    expect(isSourceAuthorized(db, result.source.id)).toBe(true);

    // 元数据带引擎与模型（理解来源可追溯）
    const meta = JSON.parse(result.source.metadata_json) as { engine?: string; model?: string };
    expect(meta.engine).toBe('hermes');
    expect(meta.model).toBe('gemini-3.7-flash-tiered');
  });

  it('同一 runId 同内容幂等：不产生第二个来源', () => {
    const { imports, permissions } = makeImports();
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const input = {
      question: '今天天气如何？',
      answer: '晴天。',
      conversationId: 'conv-2',
      userSeq: 1,
      assistantSeq: 2,
      runId: 'run-2',
      engine: 'core-bounded' as const,
      model: null,
      projectId: null,
      permissionId: perm.id,
    };
    const first = imports.captureAsk(input);
    const second = imports.captureAsk(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM sources WHERE provider = 'ask_session'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('撤销 ask 授权后：来源不可读（提取将被拒绝）——同一套边界不开特例', () => {
    const { imports, permissions } = makeImports();
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const result = imports.captureAsk({
      question: '问题',
      answer: '回答',
      conversationId: 'conv-3',
      userSeq: 1,
      assistantSeq: 2,
      runId: 'run-3',
      engine: 'hermes',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    expect(isSourceAuthorized(db, result.source.id)).toBe(true);
    permissions.revoke(perm.id);
    expect(isSourceAuthorized(db, result.source.id)).toBe(false);
    // 再落库：授权不可用，诚实拒绝
    expect(() =>
      imports.captureAsk({
        question: '问题2',
        answer: '回答2',
        conversationId: 'conv-4',
        userSeq: 1,
        assistantSeq: 2,
        runId: 'run-4',
        engine: 'hermes',
        model: null,
        projectId: null,
        permissionId: perm.id,
      }),
    ).toThrow(/授权/);
  });
});
