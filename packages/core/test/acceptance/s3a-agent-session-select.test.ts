/**
 * S3a 验收（v2 规格：执行方按规格条件写成测试；本单 B 档先只交测试）：
 * docs/委派/S3a-编码代理会话选择导入（核心）.md
 *
 * 条件 1：合成文件夹 2 个 Claude Code + 1 个 Codex + 1 个 Codex 子代理 + 1 个无关 jsonl
 *          → 列出 3 个；子代理 1、认不出 1 只报个数。
 * 条件 2：Claude Code 标题取最后一次改的名字；Codex 标题取第一句用户的话，
 *          AGENTS.md / 环境说明不当标题。
 * 条件 3：导入后再列是「已导入」；追加一轮并更新 mtime 后再列是「有更新」。
 * 条件 4：只导勾选的；计数对；新导入的进 pendingExtraction。
 * 条件 6：估算字数等于解析器解析出的你说的、AI 回答的字数之和。
 * 条件 7：列出一个大会话时只读开头（最多 20 个非空行、最多 256KB）和末尾 256KB，不是整份读
 *   （整合方 2026-09-19 复审时补：原测试只拦 readFileSync，逐块把整份读完也能过）。
 *
 * 条件 5（假编号 / 过期清单）在 apps/desktop/test/acceptance/s3a-ipc-list.test.ts。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ImportService,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  parseClaudeCodeSession,
  parseCodexSession,
  type CoreDatabase,
} from '../../src/index.js';

// 条件 7：数一数每个文件实际读了多少字节（替换 node:fs，只包一层计数，行为不变）
const io = vi.hoisted(() => ({
  fdPath: new Map<number, string>(),
  bytes: new Map<string, number>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  const key = (p: unknown) => String(p).replace(/\\/g, '/');
  const add = (p: string, n: number) => io.bytes.set(p, (io.bytes.get(p) ?? 0) + n);
  const call = <T>(fn: unknown, args: unknown[]) => (fn as (...a: unknown[]) => T)(...args);
  const wrapped = {
    ...real,
    openSync: (...args: unknown[]) => {
      const fd = call<number>(real.openSync, args);
      io.fdPath.set(fd, key(args[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      io.fdPath.delete(fd);
      real.closeSync(fd);
    },
    readSync: (fd: number, ...rest: unknown[]) => {
      const n = call<number>(real.readSync, [fd, ...rest]);
      const p = io.fdPath.get(fd);
      if (p) add(p, n);
      return n;
    },
    readFileSync: (...args: unknown[]) => {
      const out = call<string | Buffer>(real.readFileSync, args);
      if (typeof args[0] === 'string') add(key(args[0]), out.length);
      return out;
    },
  };
  return { ...wrapped, default: wrapped };
});

const CC_SID = '11111111-2222-4333-8444-555555555555';
const CC_SID2 = '11111111-2222-4333-8444-666666666666';
const CX_SID = '019f11e1-aaaa-7bbb-8ccc-dddddddddddd';
const L = (o: unknown) => JSON.stringify(o);
const at = (s: number) => `2026-09-18T03:00:${String(s).padStart(2, '0')}.000Z`;

function claudeSession(opts: {
  sid: string;
  cwd: string;
  user: string;
  assistant: string;
  customTitle?: string;
  aiTitle?: string;
}): string[] {
  const base = {
    sessionId: opts.sid,
    cwd: opts.cwd,
    gitBranch: 'main',
    version: '2.0.0',
    isSidechain: false,
  };
  const lines = [
    L({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), sessionId: opts.sid }),
    L({
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: at(1),
      message: { role: 'user', content: opts.user },
    }),
    L({
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: at(2),
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: opts.assistant }] },
    }),
  ];
  if (opts.aiTitle) {
    lines.push(L({ type: 'ai-title', aiTitle: opts.aiTitle, sessionId: opts.sid }));
  }
  if (opts.customTitle) {
    lines.push(L({ type: 'custom-title', customTitle: '先起的名', sessionId: opts.sid }));
    lines.push(L({ type: 'custom-title', customTitle: opts.customTitle, sessionId: opts.sid }));
  }
  return lines;
}

function codexSession(source: unknown, userText: string, assistantText: string): string[] {
  const item = (s: number, payload: unknown) =>
    L({ timestamp: at(s), type: 'response_item', payload });
  const text = (role: string, t: string) => ({
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: t }],
  });
  return [
    L({
      timestamp: at(0),
      type: 'session_meta',
      payload: {
        id: CX_SID,
        session_id: CX_SID,
        timestamp: at(0),
        cwd: 'D:/work/demo',
        originator: 'codex_cli_rs',
        cli_version: '0.99.0',
        source,
      },
    }),
    item(1, text('user', '# AGENTS.md instructions for D:/work/demo\n不该当标题')),
    item(
      2,
      text(
        'user',
        '<environment_context>\n<cwd>D:/work/demo</cwd>\n不该当标题\n</environment_context>',
      ),
    ),
    item(3, text('user', userText)),
    item(4, text('assistant', assistantText)),
  ];
}

function subagentSession(): string[] {
  return [
    L({
      timestamp: at(0),
      type: 'session_meta',
      payload: {
        id: '019f11e1-aaaa-7bbb-8ccc-eeeeeeeeeeee',
        cwd: 'D:/work/demo',
        source: { subagent: { type: 'reviewer' } },
      },
    }),
    L({
      timestamp: at(1),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '子代理' }],
      },
    }),
  ];
}

let dir: string;
let db: CoreDatabase;
let imports: ImportService;
let permissions: PermissionService;
let folder: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s3a-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  permissions = new PermissionService(db);
  imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, new SourceStore(db));
  folder = join(dir, 'sessions');
  mkdirSync(join(folder, 'nested'), { recursive: true });
  writeFileSync(
    join(folder, 'cc1.jsonl'),
    claudeSession({
      sid: CC_SID,
      cwd: 'D:/work/demo',
      user: '帮我修导入',
      assistant: '改好了。',
      customTitle: '修导入乱码',
      aiTitle: 'AI起的名',
    }).join('\n'),
    'utf8',
  );
  writeFileSync(
    join(folder, 'nested', 'cc2.jsonl'),
    claudeSession({
      sid: CC_SID2,
      cwd: 'D:/work/other',
      user: '第二会话用户话',
      assistant: '第二会话回答',
      aiTitle: '第二会话 AI 名',
    }).join('\n'),
    'utf8',
  );
  writeFileSync(
    join(folder, 'cx.jsonl'),
    codexSession('cli', '把重试逻辑补上去重', '已经补好。').join('\n'),
    'utf8',
  );
  writeFileSync(join(folder, 'sub.jsonl'), subagentSession().join('\n'), 'utf8');
  writeFileSync(join(folder, 'other.jsonl'), [L({ hello: 'world' })].join('\n'), 'utf8');
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Preview = {
  sessions: Array<{
    id: number;
    tool: 'claude_code' | 'codex';
    title: string;
    cwd: string | null;
    projectId: string | null;
    mtimeMs: number;
    size: number;
    status: 'new' | 'imported' | 'updated';
  }>;
  unrecognizedCount: number;
  subagentCount: number;
};

function preview(): Preview {
  return (
    imports as ImportService & { previewAgentSessions: (p: string) => Preview }
  ).previewAgentSessions(folder);
}

it('条件 1：列出 3 个会话；子代理和认不出的只报个数', () => {
  const r = preview();
  expect(r.sessions).toHaveLength(3);
  expect(r.subagentCount).toBe(1);
  expect(r.unrecognizedCount).toBe(1);
  expect(r.sessions.map((s) => s.tool).sort()).toEqual(['claude_code', 'claude_code', 'codex']);
});

it('条件 2：Claude Code 用最后一次改的名字；Codex 用第一句用户话，注入不当标题', () => {
  const r = preview();
  const cc = r.sessions.find((s) => s.title === '修导入乱码');
  const cc2 = r.sessions.find((s) => s.title === '第二会话 AI 名');
  const cx = r.sessions.find((s) => s.tool === 'codex');
  expect(cc).toBeTruthy();
  expect(cc2).toBeTruthy();
  expect(cx?.title).toBe('把重试逻辑补上去重');
  expect(cx?.title).not.toContain('AGENTS.md');
  expect(cx?.title).not.toContain('不该当标题');
});

it('条件 3：导入后再列是已导入；追加并更新 mtime 后是有更新', () => {
  const first = preview();
  const one = first.sessions.find((s) => s.title === '修导入乱码')!;
  const perm = permissions.grantFolder(folder);
  const imported = (
    imports as ImportService & {
      importSelectedAgentSessions: (
        dir: string,
        ids: number[],
        opts: { permissionId: string; projectId: string | null },
      ) => {
        created: unknown[];
        unchanged: unknown[];
        failed: unknown[];
        pendingExtraction: unknown[];
      };
    }
  ).importSelectedAgentSessions(folder, [one.id], { permissionId: perm.id, projectId: null });
  expect(imported.created).toHaveLength(1);
  expect(preview().sessions.find((s) => s.id === one.id)?.status).toBe('imported');

  const path = join(folder, 'cc1.jsonl');
  const extra = claudeSession({
    sid: CC_SID,
    cwd: 'D:/work/demo',
    user: '帮我修导入',
    assistant: '改好了。又追加一轮。',
    customTitle: '修导入乱码',
  });
  writeFileSync(path, extra.join('\n'), 'utf8');
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
  expect(preview().sessions.find((s) => s.title === '修导入乱码')?.status).toBe('updated');
});

it('条件 4：只导勾选的；计数对；新导入进 pendingExtraction', () => {
  const listed = preview();
  const pick = listed.sessions.find((s) => s.tool === 'codex')!;
  const perm = permissions.grantFolder(folder);
  const r = (
    imports as ImportService & {
      importSelectedAgentSessions: (
        dir: string,
        ids: number[],
        opts: { permissionId: string; projectId: string | null },
      ) => {
        created: Array<{ provider: string }>;
        unchanged: unknown[];
        failed: unknown[];
        pendingExtraction: unknown[];
      };
    }
  ).importSelectedAgentSessions(folder, [pick.id], { permissionId: perm.id, projectId: null });
  expect(r.created).toHaveLength(1);
  expect(r.unchanged).toHaveLength(0);
  expect(r.failed).toHaveLength(0);
  expect(r.pendingExtraction).toHaveLength(1);
  const sources = db.prepare('SELECT title FROM sources').all() as Array<{ title: string }>;
  expect(sources).toHaveLength(1);
  expect(sources[0]?.title).toBe('把重试逻辑补上去重');
});

it('条件 6：估算字数等于解析器你说的 + AI 回答的字数之和', () => {
  const listed = preview();
  const cc = listed.sessions.find((s) => s.title === '修导入乱码')!;
  const cx = listed.sessions.find((s) => s.tool === 'codex')!;
  const est = (
    imports as ImportService & {
      estimateAgentSessions: (
        dir: string,
        ids: number[],
      ) => {
        items: Array<{ id: number; userChars: number; assistantChars: number }>;
        userChars: number;
        assistantChars: number;
      };
    }
  ).estimateAgentSessions(folder, [cc.id, cx.id]);
  const parsedCc = parseClaudeCodeSession(
    claudeSession({
      sid: CC_SID,
      cwd: 'D:/work/demo',
      user: '帮我修导入',
      assistant: '改好了。',
      customTitle: '修导入乱码',
      aiTitle: 'AI起的名',
    }),
  )!;
  const parsedCx = parseCodexSession(codexSession('cli', '把重试逻辑补上去重', '已经补好。'))!;
  const sum = (p: NonNullable<typeof parsedCc>, role: 'user' | 'assistant') =>
    p.segments.filter((s) => s.role === role).reduce((n, s) => n + s.text.length, 0);
  expect(est.userChars).toBe(sum(parsedCc, 'user') + sum(parsedCx, 'user'));
  expect(est.assistantChars).toBe(sum(parsedCc, 'assistant') + sum(parsedCx, 'assistant'));
});

it('条件 7：列出大会话时只读开头和末尾——中间的改名不当标题，读的字节远小于文件', () => {
  const big = join(folder, 'big.jsonl');
  const sid = '11111111-2222-4333-8444-777777777777';
  const pad = (tag: string) =>
    L({
      type: 'user',
      uuid: `pad-${tag}`,
      sessionId: sid,
      timestamp: at(5),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: tag, content: 'M'.repeat(10 * 1024 * 1024) }],
      },
    });
  writeFileSync(
    big,
    [
      // 开头：没有标题行，第一句用户的话就是标题；紧跟一条 10MB 的工具输出（开头也要有字节上限）
      ...claudeSession({
        sid,
        cwd: 'D:/work/demo',
        user: '大文件开头用户话',
        assistant: '开头回答',
      }),
      pad('a'),
      // 中间：改过一次名。只读头尾的话看不到它
      L({ type: 'custom-title', customTitle: '藏在中间的名字', sessionId: sid }),
      pad('b'),
      L({
        type: 'assistant',
        uuid: 'tail',
        sessionId: sid,
        timestamp: at(9),
        message: { role: 'assistant', content: [{ type: 'text', text: '末尾的回答' }] },
      }),
    ].join('\n'),
    'utf8',
  );
  io.bytes.clear();
  const r = preview();
  const titles = r.sessions.map((s) => s.title);
  expect(titles).toContain('大文件开头用户话');
  expect(titles).not.toContain('藏在中间的名字');
  const readBig = [...io.bytes.entries()]
    .filter(([p]) => p.endsWith('/big.jsonl'))
    .reduce((n, [, b]) => n + b, 0);
  expect(readBig).toBeGreaterThan(0);
  expect(readBig).toBeLessThan(1024 * 1024);
});
