/**
 * S2 验收（整合方写死，执行方不改）：导入 Codex 的会话记录。
 * 委派单：docs/委派/S2-导入Codex会话.md
 *
 * Codex 把会话存成 ~/.codex/sessions/年/月/日/rollout-*.jsonl，一行一个
 * {timestamp, type, payload}。下面全是合成数据，结构按 2026-09 本机真实文件的字段。
 * 本机有超过 512MB 的会话文件——必须逐行读，不能整份读进内存。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ImportService,
  PermissionService,
  SourceStore,
  Vault,
  detectAgentSession,
  migrate,
  openDatabase,
  parseCodexSession,
  type CoreDatabase,
} from '../../src/index.js';

const SID = '019f11e1-aaaa-7bbb-8ccc-dddddddddddd';
const L = (o: unknown) => JSON.stringify(o);
const at = (s: number) => `2026-09-18T02:00:${String(s).padStart(2, '0')}.000Z`;
const item = (s: number, payload: unknown) =>
  L({ timestamp: at(s), type: 'response_item', payload });
const text = (
  role: string,
  t: string,
  kind = role === 'assistant' ? 'output_text' : 'input_text',
) => ({
  type: 'message',
  role,
  content: [{ type: kind, text: t }],
});

function session(source: unknown = 'cli'): string[] {
  return [
    L({
      timestamp: at(0),
      type: 'session_meta',
      payload: {
        id: SID,
        session_id: SID,
        timestamp: at(0),
        cwd: 'D:/work/demo',
        originator: 'codex_cli_rs',
        cli_version: '0.99.0',
        source,
        git: {
          branch: 'main',
          commit_hash: 'abc123',
          repository_url: 'https://example.invalid/demo.git',
        },
      },
    }),
    item(1, text('developer', '<permissions instructions>不该导入</permissions instructions>')),
    item(2, text('user', '# AGENTS.md instructions for D:/work/demo\n不该导入')),
    item(
      3,
      text(
        'user',
        '<environment_context>\n<cwd>D:/work/demo</cwd>\n不该导入\n</environment_context>',
      ),
    ),
    item(4, text('user', '把 A1 的重试逻辑补上去重')),
    item(5, { type: 'reasoning', summary: [{ type: 'summary_text', text: '推理，不该导入' }] }),
    item(6, {
      type: 'function_call',
      name: 'shell',
      arguments: '{"command":["git","status"]}',
      call_id: 'c1',
    }),
    item(7, { type: 'function_call_output', call_id: 'c1', output: 'SECRET 输出，不该导入' }),
    item(8, text('assistant', '已经补好，测试全过。')),
    L({ timestamp: at(9), type: 'event_msg', payload: { type: 'token_count', info: null } }),
    L({ timestamp: at(10), type: 'turn_context', payload: { cwd: 'D:/work/demo' } }),
    item(11, text('user', '<user_instructions>\n不该导入\n</user_instructions>')),
    item(12, text('user', '再跑一遍 verify')),
    item(13, {
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: '*** Begin Patch',
      call_id: 'c2',
    }),
    item(14, { type: 'custom_tool_call_output', call_id: 'c2', output: '不该导入' }),
    item(15, text('assistant', '跑完了，全部通过。')),
    '这一行不是 JSON',
  ];
}

describe('解析', () => {
  it('认得出是 Codex 的会话', () => {
    expect(detectAgentSession(session().slice(0, 3))).toBe('codex');
  });

  it('一问一答成段；用过的工具记成一行；注入的指令、环境说明、推理、工具输出都不导', () => {
    const parsed = parseCodexSession(session())!;
    expect(parsed.segments.map((s) => [s.role, s.text])).toEqual([
      ['user', '把 A1 的重试逻辑补上去重'],
      ['assistant', '已经补好，测试全过。\n\n〔工具：shell〕'],
      ['user', '再跑一遍 verify'],
      ['assistant', '跑完了，全部通过。\n\n〔工具：apply_patch〕'],
    ]);
    const all = parsed.segments.map((s) => s.text).join('\n');
    expect(all).not.toContain('不该导入');
    expect(all).not.toContain('SECRET');
    expect(parsed.segments[0]).toMatchObject({ sequence: 0, occurredAt: at(4) });
  });

  it('来源信息：编码代理、会话 id、第一句话作标题、工作目录与分支', () => {
    const parsed = parseCodexSession(session())!;
    expect(parsed).toMatchObject({
      kind: 'conversation',
      provider: 'coding_agent',
      externalId: SID,
      title: '把 A1 的重试逻辑补上去重',
      importMethod: 'history_export',
    });
    expect(parsed.metadata).toMatchObject({
      tool: 'codex',
      cwd: 'D:/work/demo',
      gitBranch: 'main',
    });
  });

  it('Codex 自己派出去的子代理（如自动审查）的会话不导：那不是你在聊', () => {
    expect(parseCodexSession(session({ subagent: { other: 'guardian' } }))).toBeNull();
  });

  // 2026-09-19 按本机真实会话的结构补：一条「用户」消息常由好几段拼成，注入的内容和你的话
  // 可能在同一条里。要逐段认，不能先拼起来再看开头。
  it('一条消息分好几段的逐段认：注入的段丢掉，只留你的话；什么都没留下的不打断回答', () => {
    const multi = (s: number, ...parts: Array<string | null>) =>
      item(s, {
        type: 'message',
        role: 'user',
        content: parts.map((t) =>
          t === null
            ? { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
            : { type: 'input_text', text: t },
        ),
      });
    const lines = [
      session()[0]!,
      multi(
        1,
        '<recommended_plugins>\n不该导入\n</recommended_plugins>',
        '# AGENTS.md instructions for D:/work/demo\n不该导入',
        '<environment_context>\n不该导入\n</environment_context>',
      ),
      multi(
        2,
        '# Files mentioned by the user:\n\n## plan.md: D:/work/demo/plan.md\n\n## My request for Codex:\n按这个计划改导入\n',
        '<image name=[Image #1] path="D:/work/demo/shot.png">',
        null,
        '</image>',
      ),
      item(3, text('assistant', '先看计划。')),
      item(4, text('user', '<turn_aborted>\n不该导入\n</turn_aborted>')),
      item(5, text('user', '<subagent_notification>\n不该导入\n</subagent_notification>')),
      item(
        6,
        text(
          'user',
          '<send_user_message_question_reply>[{"selected_option":"[\\"A\\"]"}]</send_user_message_question_reply>',
        ),
      ),
      item(
        7,
        text('user', '<codex_internal_context source="goal">\n不该导入\n</codex_internal_context>'),
      ),
      item(8, text('assistant', '改好了。')),
      // 内置浏览器的状态贴在你的话前面：去掉标签，留下后面的话
      item(
        9,
        text(
          'user',
          '<in-app-browser-context source="ambient-ui-state">\n不该导入\n</in-app-browser-context>\n## My request:\n页面上那个按钮点不动',
        ),
      ),
      item(10, text('assistant', '按钮修好了。')),
      item(
        11,
        text(
          'user',
          '# Files mentioned by the user:\n\n## a.ts: D:/work/demo/a.ts\n\n## My request:\n再看一下 a.ts',
        ),
      ),
      item(12, text('user', '# Files mentioned by the user:\n\n## b.ts: D:/work/demo/b.ts')),
      item(13, text('assistant', '看过了。')),
    ];
    const parsed = parseCodexSession(lines)!;
    expect(parsed.segments.map((s) => [s.role, s.text])).toEqual([
      ['user', '按这个计划改导入'],
      ['assistant', '先看计划。\n\n改好了。'],
      ['user', '页面上那个按钮点不动'],
      ['assistant', '按钮修好了。'],
      ['user', '再看一下 a.ts'],
      ['assistant', '看过了。'],
    ]);
    const all = parsed.segments.map((s) => s.text).join('\n');
    for (const junk of ['不该导入', 'Image #1', 'plan.md', 'selected_option', 'b.ts']) {
      expect(all).not.toContain(junk);
    }
  });
});

describe('导入', () => {
  let dir: string;
  let db: CoreDatabase;
  let imports: ImportService;
  let permissions: PermissionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ixaeon-s2-'));
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

  it('按 年/月/日 目录放着的会话，文件夹导入能找到；子代理会话列进失败并说明', () => {
    const day = join(dir, 'sessions', '2026', '09', '18');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-09-18T02-00-00-${SID}.jsonl`),
      session().join('\n'),
      'utf8',
    );
    writeFileSync(
      join(day, 'rollout-2026-09-18T03-00-00-sub.jsonl'),
      session({ subagent: { other: 'guardian' } }).join('\n'),
      'utf8',
    );
    const root = join(dir, 'sessions');
    const r = imports.importFolder(root, {
      projectId: null,
      permissionId: permissions.grantFolder(root).id,
    });
    expect(r.created.map((s) => [s.provider, s.title])).toEqual([
      ['coding_agent', '把 A1 的重试逻辑补上去重'],
    ]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.message).toContain('子代理');
  });

  it('超过普通文件 10MB 上限的会话也能导（大块的是工具输出，本来就不导）', () => {
    const lines = session();
    lines.splice(
      7,
      1,
      item(7, {
        type: 'function_call_output',
        call_id: 'c1',
        output: 'x'.repeat(11 * 1024 * 1024),
      }),
    );
    const path = join(dir, `rollout-${SID}.jsonl`);
    writeFileSync(path, lines.join('\n'), 'utf8');
    const r = imports.importFile(path, {
      projectId: null,
      permissionId: permissions.grantFile(path).id,
    });
    expect(r.created).toHaveLength(1);
  });
});
