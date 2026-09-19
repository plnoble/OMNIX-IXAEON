/**
 * S1 并入时整合方补的规则（锁定验收之外）：
 * - Claude Code 会把一些不是你打的字也记成「用户」行：技能展开与命令说明（isMeta）、
 *   上下文压缩后的摘要（isCompactSummary）、后台任务通知、停止记录；接口出错时还会合成一句
 *   「回答」（isApiErrorMessage）。2026-09 本机会话里分别有 64、24、87、16、55 条。
 *   这些都不导，也不打断正在累积的回答；
 * - 标题会反复写，改过名的以最后一次为准；
 * - 逐块读的切行：换行、多字节字符跨块，超长的一行整行跳过。
 * 全是合成数据。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeCodeSession } from '../../src/index.js';
import { iterateJsonlLines } from '../../src/import/importService.js';

const SID = '99999999-8888-4777-8666-555555555555';
const L = (o: unknown) => JSON.stringify(o);
const at = (s: number) => `2026-09-19T01:00:${String(s).padStart(2, '0')}.000Z`;
const base = { sessionId: SID, cwd: 'D:/work/demo', gitBranch: 'main', isSidechain: false };
const line = (type: string, uuid: string, s: number, content: unknown, extra = {}) =>
  L({ ...base, ...extra, type, uuid, timestamp: at(s), message: { role: type, content } });

describe('Claude Code 自己注入的内容不当成你说的话', () => {
  const lines = [
    line('user', 'u1', 1, '把导入修好'),
    line('assistant', 'a1', 2, [{ type: 'text', text: '先看代码' }]),
    line('user', 'm1', 3, 'Base directory for this skill: 合成技能说明', { isMeta: true }),
    line('assistant', 'a2', 4, [{ type: 'text', text: '改好了' }]),
    line(
      'user',
      't1',
      5,
      '<task-notification>\n<task-id>x</task-id>\n合成通知\n</task-notification>',
    ),
    line('user', 'i1', 6, [{ type: 'text', text: '[Request interrupted by user]' }]),
    line('assistant', 'e1', 7, [{ type: 'text', text: 'API Error: 合成错误' }], {
      isApiErrorMessage: true,
    }),
    line(
      'user',
      'c1',
      8,
      'This session is being continued from a previous conversation. 合成摘要',
      {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      },
    ),
    line('user', 'u2', 9, '再跑一遍测试'),
    line('assistant', 'a3', 10, [{ type: 'text', text: '全过' }]),
    L({ type: 'custom-title', customTitle: '旧名字', sessionId: SID }),
    L({ type: 'ai-title', aiTitle: 'AI 起的名', sessionId: SID }),
    L({ type: 'custom-title', customTitle: '新名字', sessionId: SID }),
  ];

  it('技能展开、压缩摘要、任务通知、停止记录、合成的出错提示都不导，也不打断回答', () => {
    const parsed = parseClaudeCodeSession(lines)!;
    expect(parsed.segments.map((s) => [s.role, s.text])).toEqual([
      ['user', '把导入修好'],
      ['assistant', '先看代码\n\n改好了'],
      ['user', '再跑一遍测试'],
      ['assistant', '全过'],
    ]);
    const all = parsed.segments.map((s) => s.text).join('\n');
    for (const junk of [
      '合成技能说明',
      '合成摘要',
      '合成通知',
      'Request interrupted',
      'API Error',
    ]) {
      expect(all).not.toContain(junk);
    }
  });

  it('改过名的以最后一次为准', () => {
    expect(parseClaudeCodeSession(lines)!.title).toBe('新名字');
  });
});

describe('逐块读的切行', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const file = (content: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'ixaeon-jsonl-'));
    const p = join(dir, 's.jsonl');
    writeFileSync(p, content, 'utf8');
    return p;
  };

  it('换行符与中文跨块也切得对；最后一行没有换行也算', () => {
    const p = file('a\r\nbb\n\n中文行\r\n最后一行');
    expect([...iterateJsonlLines(p, { chunkBytes: 3 })]).toEqual([
      'a',
      'bb',
      '',
      '中文行',
      '最后一行',
    ]);
  });

  it('超长的一行整行跳过，前后的行照常', () => {
    const p = file(`ok\n${'x'.repeat(50)}\nnext\n${'y'.repeat(30)}`);
    expect([...iterateJsonlLines(p, { chunkBytes: 4, maxLineBytes: 20 })]).toEqual(['ok', 'next']);
  });
});
