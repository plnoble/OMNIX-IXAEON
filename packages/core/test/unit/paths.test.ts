import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPathInside, assertInside, safeJoin, redactValue } from '../../src/index.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-paths-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('路径授权范围检查', () => {
  it('目录内的文件通过', () => {
    const root = join(dir, 'project');
    mkdirSync(root, { recursive: true });
    expect(isPathInside(root, join(root, 'a.md'))).toBe(true);
    expect(isPathInside(root, join(root, 'docs', 'b.md'))).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
  });

  it('目录外的文件被拒绝', () => {
    const root = join(dir, 'project');
    mkdirSync(root, { recursive: true });
    expect(isPathInside(root, join(dir, 'outside.md'))).toBe(false);
    // .. 穿越
    expect(isPathInside(root, join(root, '..', 'escape.md'))).toBe(false);
  });

  it('符号链接逃逸被拒绝', () => {
    const root = join(dir, 'project2');
    const secret = join(dir, 'secret');
    const link = join(root, 'link');
    mkdirSync(root, { recursive: true });
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, 'key.pem'), 'fake');
    symlinkSync(secret, link, 'junction');
    expect(isPathInside(root, join(link, 'key.pem'))).toBe(false);
  });

  it('assertInside 抛出 PATH_ESCAPE 错误码', () => {
    const root = join(dir, 'project3');
    mkdirSync(root, { recursive: true });
    expect(() => assertInside(root, join(dir, 'x.md'))).toThrowError(
      expect.objectContaining({ code: 'IXA0002' }),
    );
  });
});

describe('ZIP 条目安全拼接（Zip Slip 防护）', () => {
  it('正常相对路径通过', () => {
    const base = join(dir, 'unzip');
    expect(safeJoin(base, 'data/projects.json')).toBe(join(base, 'data', 'projects.json'));
    expect(safeJoin(base, 'raw/ab/hash')).toBe(join(base, 'raw', 'ab', 'hash'));
  });

  it('绝对路径与盘符被拒绝', () => {
    const base = join(dir, 'unzip');
    expect(safeJoin(base, '/etc/passwd')).toBeNull();
    expect(safeJoin(base, 'C:/Windows/system32/evil.dll')).toBeNull();
    expect(safeJoin(base, 'C:\\Windows\\evil.dll')).toBeNull();
    expect(safeJoin(base, '\\\\server\\share\\evil')).toBeNull();
  });

  it('.. 穿越被拒绝', () => {
    const base = join(dir, 'unzip');
    expect(safeJoin(base, '../escape.txt')).toBeNull();
    expect(safeJoin(base, 'data/../../escape.txt')).toBeNull();
    expect(safeJoin(base, 'data\\..\\..\\escape.txt')).toBeNull();
  });

  it('空字节注入被拒绝', () => {
    const base = join(dir, 'unzip');
    expect(safeJoin(base, 'a\0b')).toBeNull();
  });
});

describe('日志敏感字段遮盖（P1-9 白名单式清洗）', () => {
  it('按 key 名遮盖：敏感键只留长度+哈希摘要（不可复原）', () => {
    const out = redactValue({
      apiKey: 'sk-abc123def456ghi789',
      authorization: 'Bearer xyz',
      nested: { user_token: 'topsecret-value', ok: 'fine' },
    }) as Record<string, unknown>;
    // 敏感键值不落日志（摘要形式，非原文）
    expect(String(out['apiKey'])).toMatch(/^\[content \d+ chars sha256:[0-9a-f]{12}\]$/);
    expect(String(out['apiKey'])).not.toContain('sk-abc123');
    expect(String(out['authorization'])).toMatch(/^\[content \d+ chars sha256:[0-9a-f]{12}\]$/);
    expect(String(out['authorization'])).not.toContain('Bearer xyz');
    const nested = out['nested'] as Record<string, unknown>;
    expect(String(nested['user_token'])).not.toContain('topsecret-value');
    expect(nested['ok']).toBe('fine');
  });

  it('字符串中的 sk- / Bearer 形态密钥被遮盖', () => {
    const out = redactValue('error calling with sk-AbCdEfGhIjKlMnOp1234') as string;
    expect(out).not.toContain('sk-AbCdEfGhIjKlMnOp1234');
    expect(out).toContain('[REDACTED]');
    const out2 = redactValue('auth Bearer aVeryLongTokenValue1234567890') as string;
    expect(out2).not.toContain('aVeryLongTokenValue1234567890');
  });

  it('正文键不截断而是整体摘要（修复 P1-9：开头/中间/结尾都不落日志）', () => {
    const long = 'HEADMARK'.padEnd(5000, 'x') + 'TAILMARK';
    const out = redactValue({ text: long }) as Record<string, unknown>;
    expect(String(out['text'])).toMatch(/^\[content 5008 chars sha256:[0-9a-f]{12}\]$/);
    expect(String(out['text'])).not.toContain('HEADMARK');
    expect(String(out['text'])).not.toContain('TAILMARK');
    // 普通短字符串仍保留（截断上限 300）
    const out2 = redactValue({ note: '正常日志字段' }) as Record<string, unknown>;
    expect(out2['note']).toBe('正常日志字段');
  });
});
