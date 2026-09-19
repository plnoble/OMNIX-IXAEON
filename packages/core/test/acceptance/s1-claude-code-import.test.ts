/**
 * S1 验收（整合方写死，执行方不改）：导入 Claude Code 的会话记录。
 * 委派单：docs/委派/S1-导入ClaudeCode会话.md
 *
 * 场景一第一步：它要知道你和编码代理聊了什么、做到哪了。Claude Code 把每个会话存成
 * ~/.claude/projects/<目录名>/<会话 id>.jsonl，一行一个 JSON。下面全是合成数据，
 * 结构按 2026-09 本机真实文件的字段（只看了结构，没看内容）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ImportService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  detectAgentSession,
  migrate,
  openDatabase,
  parseClaudeCodeSession,
  type CoreDatabase,
} from '../../src/index.js';

const SID = '11111111-2222-4333-8444-555555555555';
const L = (o: unknown) => JSON.stringify(o);
const at = (s: number) => `2026-09-18T01:00:${String(s).padStart(2, '0')}.000Z`;

function session(cwd: string): string[] {
  const base = { sessionId: SID, cwd, gitBranch: 'main', version: '2.0.0', isSidechain: false };
  const user = (uuid: string, s: number, content: unknown, extra = {}) =>
    L({
      ...base,
      ...extra,
      type: 'user',
      uuid,
      timestamp: at(s),
      message: { role: 'user', content },
    });
  const assistant = (uuid: string, s: number, id: string, content: unknown[], extra = {}) =>
    L({
      ...base,
      ...extra,
      type: 'assistant',
      uuid,
      timestamp: at(s),
      message: { id, role: 'assistant', content },
    });
  return [
    L({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), sessionId: SID }),
    user('u1', 1, '帮我把导入时的乱码修一下'),
    assistant('a1', 2, 'msg_1', [{ type: 'thinking', thinking: '内部思考，不该导入' }]),
    assistant('a2', 3, 'msg_1', [{ type: 'text', text: '先看一下编码设置。' }]),
    assistant('a3', 4, 'msg_1', [
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } },
    ]),
    user('r1', 5, [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'SECRET_FILE_CONTENT，不该导入' },
    ]),
    assistant('a4', 6, 'msg_2', [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: {} }]),
    assistant('a5', 7, 'msg_2', [{ type: 'text', text: '改好了，乱码是编码没声明。' }]),
    user('s1', 8, '子代理的活，不该导入', { isSidechain: true }),
    assistant('s2', 9, 'msg_s', [{ type: 'text', text: '子代理的回答，不该导入' }], {
      isSidechain: true,
    }),
    user('c1', 10, '<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
    user('u2', 11, [
      {
        type: 'text',
        text: '<system-reminder>系统提醒，不该导入</system-reminder>\n再把测试跑一下',
      },
    ]),
    assistant('a6', 12, 'msg_3', [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: {} }]),
    assistant('a7', 13, 'msg_3', [{ type: 'text', text: '测试都过了。' }]),
    L({ type: 'ai-title', aiTitle: '修复导入乱码问题', sessionId: SID }),
    L({ type: 'custom-title', customTitle: '修导入乱码', sessionId: SID }),
    '这一行不是 JSON',
  ];
}

describe('解析', () => {
  it('认得出是 Claude Code 的会话；别的 JSONL 不认', () => {
    expect(detectAgentSession(session('D:/work/demo').slice(0, 5))).toBe('claude_code');
    expect(detectAgentSession([L({ hello: 'world' }), L({ a: 1 })])).toBeNull();
  });

  it('一问一答成段；一次回答拆成多行的并成一段，用过的工具记成一行', () => {
    const parsed = parseClaudeCodeSession(session('D:/work/demo'))!;
    expect(parsed.segments.map((s) => [s.role, s.text])).toEqual([
      ['user', '帮我把导入时的乱码修一下'],
      ['assistant', '先看一下编码设置。\n\n改好了，乱码是编码没声明。\n\n〔工具：Read、Edit〕'],
      ['user', '再把测试跑一下'],
      ['assistant', '测试都过了。\n\n〔工具：Bash〕'],
    ]);
    expect(parsed.segments.map((s) => s.sequence)).toEqual([0, 1, 2, 3]);
    expect(parsed.segments[0]).toMatchObject({ externalNodeId: 'u1', occurredAt: at(1) });
    expect(parsed.segments[2]).toMatchObject({ externalNodeId: 'u2', occurredAt: at(11) });
  });

  it('不导入：工具输出（可能有文件内容、密钥）、思考、子代理、系统提醒、命令包装', () => {
    const all = parseClaudeCodeSession(session('D:/work/demo'))!
      .segments.map((s) => s.text)
      .join('\n');
    expect(all).not.toContain('不该导入');
    expect(all).not.toContain('SECRET_FILE_CONTENT');
    expect(all).not.toContain('<command-name>');
  });

  it('来源信息：编码代理、会话 id、你起的标题优先、工作目录与分支', () => {
    const parsed = parseClaudeCodeSession(session('D:/work/demo'))!;
    expect(parsed).toMatchObject({
      kind: 'conversation',
      provider: 'coding_agent',
      externalId: SID,
      title: '修导入乱码',
      importMethod: 'history_export',
      accountNamespace: 'local',
    });
    expect(parsed.metadata).toMatchObject({
      tool: 'claude_code',
      cwd: 'D:/work/demo',
      gitBranch: 'main',
    });
  });

  it('没起标题：用第一句话（最多 80 字）；一句正经对话都没有：不算一个会话', () => {
    const noTitle = session('D:/work/demo').filter((l) => !l.includes('-title'));
    expect(parseClaudeCodeSession(noTitle)!.title).toBe('帮我把导入时的乱码修一下');
    const empty = [
      L({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), sessionId: SID }),
    ];
    expect(parseClaudeCodeSession(empty)).toBeNull();
  });
});

describe('导入', () => {
  let dir: string;
  let db: CoreDatabase;
  let imports: ImportService;
  let permissions: PermissionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ixaeon-s1-'));
    db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    permissions = new PermissionService(db);
    imports = new ImportService(
      db,
      new Vault(join(dir, 'vault')),
      permissions,
      new SourceStore(db),
    );
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, lines: string[]): string {
    const path = join(dir, name);
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    return path;
  }

  it('导入一个会话文件；再导一次按内容去重', () => {
    const path = write(`${SID}.jsonl`, session('D:/work/demo'));
    const permissionId = permissions.grantFile(path).id;
    const first = imports.importFile(path, { projectId: null, permissionId });
    expect(first.created).toHaveLength(1);
    expect(first.created[0]).toMatchObject({ provider: 'coding_agent', title: '修导入乱码' });
    const roles = db
      .prepare('SELECT role FROM segments WHERE source_id = ? ORDER BY sequence')
      .all(first.created[0]!.id)
      .map((r) => (r as { role: string }).role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    const again = imports.importFile(path, { projectId: null, permissionId });
    expect(again.created).toHaveLength(0);
    expect(again.deduplicated).toHaveLength(1);
  });

  it('会话在哪个项目的目录里做的，就归到哪个项目（导入时没选项目的话）', () => {
    const root = join(dir, 'demo-project');
    mkdirSync(root);
    const project = new ProjectService(db).create({
      name: '合成项目',
      rootPath: root,
      description: null,
    });
    const path = write(`${SID}.jsonl`, session(root.toUpperCase()));
    const r = imports.importFile(path, {
      projectId: null,
      permissionId: permissions.grantFile(path).id,
    });
    expect(r.created[0]!.project_id).toBe(project.id);
  });

  it('超过普通文件 10MB 上限的会话也能导（逐行读；大块的是工具输出，本来就不导）', () => {
    const lines = session('D:/work/demo');
    lines.splice(
      5,
      1,
      L({
        type: 'user',
        uuid: 'r-big',
        sessionId: SID,
        isSidechain: false,
        timestamp: at(5),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(11 * 1024 * 1024) },
          ],
        },
      }),
    );
    const path = write(`${SID}.jsonl`, lines);
    const r = imports.importFile(path, {
      projectId: null,
      permissionId: permissions.grantFile(path).id,
    });
    expect(r.created).toHaveLength(1);
  });

  it('文件夹导入认得 .jsonl 会话；认不出的 .jsonl 列进失败并说明', () => {
    const folder = join(dir, 'sessions');
    mkdirSync(folder);
    writeFileSync(join(folder, `${SID}.jsonl`), session('D:/work/demo').join('\n'), 'utf8');
    writeFileSync(join(folder, 'other.jsonl'), [L({ hello: 'world' })].join('\n'), 'utf8');
    const r = imports.importFolder(folder, {
      projectId: null,
      permissionId: permissions.grantFolder(folder).id,
    });
    expect(r.created.map((s) => s.provider)).toEqual(['coding_agent']);
    expect(r.failed.map((f) => f.path.endsWith('other.jsonl'))).toEqual([true]);
    expect(r.failed[0]!.message).toContain('不认识');
  });
});
