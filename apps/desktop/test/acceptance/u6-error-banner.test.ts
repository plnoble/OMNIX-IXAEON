// @vitest-environment jsdom
/**
 * U6 验收（规格 docs/委派/U6-报错条去掉英文前缀.md，条件 1–7）。
 * 源码只改 apps/desktop/src/renderer/src/api.ts 的 errMsg；条件 1–6 是它自己的行为，
 * 条件 7 用真的 errMsg 看任务页报错条（别的页面测试都把它换成替身，这里只把 api 换掉）。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask } from '@ixaeon/contracts';
import type * as ApiModule from '../../src/renderer/src/api.js';

const harness = vi.hoisted(() => ({
  listCodingTasks: vi.fn(),
  listSkillCandidates: vi.fn(async () => []),
  approveCodingTask: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof ApiModule;
  return { ...actual, api: { ...actual.api, ...harness } };
});

import { errMsg } from '../../src/renderer/src/api.js';
import { TasksPage } from '../../src/renderer/src/pages/Tasks.js';

describe('条件 1–6：errMsg 本身', () => {
  it('条件 1：Electron 前缀 + 错误码 → 错误码：消息', () => {
    expect(
      errMsg(
        new Error(
          "Error invoking remote method 'ixaeon:approveCodingTask': Error: IXA0012 这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。",
        ),
      ),
    ).toBe('IXA0012：这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。');
  });

  it('条件 2：没有前缀的 IXA0003 消息，Error 和字符串两种给法都一样', () => {
    expect(errMsg(new Error('IXA0003 消息'))).toBe('IXA0003：消息');
    expect(errMsg('IXA0003 消息')).toBe('IXA0003：消息');
  });

  it('条件 3：带前缀、不带错误码：TypeError 留着类名；Error 之后就是话', () => {
    expect(errMsg(new Error("Error invoking remote method 'ixaeon:x': TypeError: boom"))).toBe(
      'TypeError: boom',
    );
    expect(errMsg(new Error("Error invoking remote method 'ixaeon:x': Error: 普通的话"))).toBe(
      '普通的话',
    );
  });

  it('条件 4：前缀只认开头；Error: 只去一次', () => {
    expect(errMsg(new Error("前面的话 Error invoking remote method 'ixaeon:x': 后面的话"))).toBe(
      "前面的话 Error invoking remote method 'ixaeon:x': 后面的话",
    );
    expect(errMsg(new Error("Error invoking remote method 'a': Error: Error: x"))).toBe('Error: x');
  });

  it('条件 5：消息里的换行照留', () => {
    expect(errMsg(new Error('IXA0009 第一行\n第二行'))).toBe('IXA0009：第一行\n第二行');
  });

  it('条件 6：不是 Error 的值不抛错，返回 String(值)', () => {
    expect(errMsg(null)).toBe('null');
    expect(errMsg(undefined)).toBe('undefined');
    expect(errMsg({ code: 1 })).toBe('[object Object]');
  });
});

describe('条件 7：任务页报错条', () => {
  let container: HTMLDivElement;
  let root: Root;

  const task = (id: string): CodingTask =>
    ({
      id,
      goal: `合成任务 ${id}`,
      status: 'draft',
      version: 1,
      executor_name: null,
    }) as unknown as CodingTask;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    harness.listCodingTasks.mockClear().mockImplementation(async () => ({
      executor: 'fake',
      realDispatchEnabled: false,
      notice: '合成说明',
      tasks: [task('a')],
    }));
    harness.listSkillCandidates.mockClear();
    harness.approveCodingTask.mockClear().mockImplementation(async () => {
      throw new Error(
        "Error invoking remote method 'ixaeon:approveCodingTask': Error: IXA0012 这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。",
      );
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('接口照 Electron 的写法拒绝时，报错条里只剩 IXA0012：那一句', async () => {
    await act(async () => {
      root.render(createElement(TasksPage, { projects: [] }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const approve = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('批准并排队'),
    )!;
    await act(async () => {
      approve.click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    const banner = container.querySelector('[data-testid="error-banner"]');
    expect(banner).not.toBeNull();
    const text = banner!.textContent ?? '';
    expect(text).toContain(
      'IXA0012：这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。',
    );
    expect(text).not.toContain('Error invoking remote method');
    expect(text).not.toContain('ixaeon:');
  });
});
