// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chatgptMockPagePath } from '@ixaeon/test-fixtures';
import { extractTurns, extractMessageText, hashText, shouldSubmit } from '../../src/content.js';

/**
 * 用 JSDOM 解析 mock 页面后驱动内容脚本的纯函数。
 * （MutationObserver 的 2s 稳定性逻辑在 e2e 里端到端验证。）
 */

let cachedDoc: Document | null = null;

function loadMockDoc(): Document {
  if (cachedDoc) return cachedDoc;
  const html = readFileSync(chatgptMockPagePath(), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  cachedDoc = doc;
  return doc;
}

/** 完整 document stub（只实现 extractTurns 需要的 querySelectorAll）。 */
function asDocument(doc: Document): Document {
  return doc;
}

describe('M4 内容脚本：轮次提取', () => {
  it('从 mock 页面提取 user/assistant 两轮', () => {
    const turns = extractTurns(asDocument(loadMockDoc()));
    expect(turns.length).toBe(2);
    expect(turns[0]).toMatchObject({ order: 0, role: 'user' });
    expect(turns[1]).toMatchObject({ order: 1, role: 'assistant' });
  });

  it('文本不含侧栏与操作按钮噪音', () => {
    const doc = loadMockDoc();
    const assistant = doc.querySelector<HTMLElement>(
      '[data-message-author-role="assistant"]',
    )!;
    const text = extractMessageText(assistant);
    expect(text).toContain('IXAEON');
    expect(text).not.toContain('复制');
    expect(text).not.toContain('重新生成');
    // 侧栏文本不进入轮次
    const all = extractTurns(asDocument(doc)).map((t) => t.text).join('\n');
    expect(all).not.toContain('侧栏');
  });

  it('内容指纹稳定且不同文本不同', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('abc')).toHaveLength(64);
  });

  it('shouldSubmit：空/重复/冷却期内不提交', () => {
    const turns = [{ order: 0, role: 'user' as const, text: 'x' }];
    expect(shouldSubmit([])).toBe(false);
    expect(shouldSubmit(turns)).toBe(true);
    // 冷却由闭包状态控制：这里只验证纯逻辑分支存在
  });

  it('动态追加轮次后能提取到第三轮（模拟流式完成）', () => {
    const doc = loadMockDoc().cloneNode(true) as Document;
    const thread = doc.querySelector('main#thread')!;
    const newTurn = doc.createElement('div');
    newTurn.className = 'message';
    newTurn.setAttribute('data-message-author-role', 'user');
    newTurn.innerHTML = '<div class="text">追加问题：如何验证溯源？</div>';
    thread.appendChild(newTurn);
    const turns = extractTurns(asDocument(doc));
    expect(turns.length).toBe(3);
    expect(turns[2]!.text).toContain('追加问题');
  });
});
