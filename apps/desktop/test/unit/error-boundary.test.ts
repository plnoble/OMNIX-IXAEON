// @vitest-environment jsdom
/**
 * 顶层错误边界（2026-09-17 用户遇到「全屏黑了」的后续）。
 * 没有边界时，任意渲染异常都会让 React 卸载整棵树，只剩深色背景。
 * 单测只收 .test.ts，所以这里用 createElement 而不是 JSX。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/renderer/src/ErrorBoundary.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'join')");
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // React 会把捕获到的错误打到控制台；测试里静音，避免干扰输出
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('子组件渲染报错时显示出错原因和重新加载，而不是整页空白', () => {
    act(() => {
      root.render(createElement(ErrorBoundary, null, createElement(Boom)));
    });
    const crash = container.querySelector('[data-testid="app-crash"]');
    expect(crash).not.toBeNull();
    expect(container.textContent).toContain('界面出错了');
    expect(container.querySelector('[data-testid="app-crash-detail"]')?.textContent).toContain(
      "TypeError: Cannot read properties of undefined (reading 'join')",
    );
    expect(container.querySelector('[data-testid="app-crash-reload"]')).not.toBeNull();
  });

  it('没有报错时原样渲染子组件', () => {
    act(() => {
      root.render(createElement(ErrorBoundary, null, createElement('p', null, '正常内容')));
    });
    expect(container.textContent).toBe('正常内容');
    expect(container.querySelector('[data-testid="app-crash"]')).toBeNull();
  });

  it('对照：没有边界时同样的报错会让整棵树消失（这就是黑屏）', () => {
    const bare = document.createElement('div');
    document.body.appendChild(bare);
    const bareRoot = createRoot(bare, { onUncaughtError: () => undefined });
    // 测试环境里 act 会把未捕获的渲染错误重新抛出——正说明它一路冒到了顶
    let thrown: unknown = null;
    try {
      act(() => {
        bareRoot.render(createElement(Boom));
      });
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("reading 'join'");
    expect(bare.childElementCount).toBe(0);
    act(() => bareRoot.unmount());
    bare.remove();
  });
});
