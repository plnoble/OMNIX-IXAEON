// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    },
  );
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => {}),
    },
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('T11: two distinct formal URLs never share a capture session just because their text matches', async () => {
  const { currentCaptureSession } = await import('../../../extension/src/content.js');
  const turns = [{ order: 0, role: 'user' as const, text: '你好' }];
  const a = currentCaptureSession('/c/formal-a-123456', turns);
  const b = currentCaptureSession('/c/formal-b-123456', turns);
  expect(a.sessionId).not.toBe(b.sessionId);
});

it('T12: editing an answer in the same conversation does not create a different capture session', async () => {
  const { currentCaptureSession } = await import('../../../extension/src/content.js');
  const a = currentCaptureSession('/c/formal-a-123456', [
    { order: 0, role: 'user', text: '你好' },
    { order: 1, role: 'assistant', text: 'Old answer' },
  ]);
  const b = currentCaptureSession('/c/formal-a-123456', [
    { order: 0, role: 'user', text: '你好' },
    { order: 1, role: 'assistant', text: 'Regenerated answer' },
  ]);
  expect(a.sessionId).toBe(b.sessionId);
});
