import { describe, it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  ResearchStore,
  ResearchChecker,
  systemClock,
  createTinyFishFetcher,
  isSpaOrDynamicSkeleton,
  type TinyFishFetcher,
} from '../../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('B3 阶段 2：TinyFish 动态网页抓取与 SPA 降级增强', () => {
  it('isSpaOrDynamicSkeleton：有效静态正文不触发；SPA 骨架触发', () => {
    // 静态正文足够长
    const normalHtml = '<div id="root"><p>' + '正常正文 '.repeat(50) + '</p></div>';
    expect(isSpaOrDynamicSkeleton(normalHtml, '正常正文 '.repeat(50))).toBe(false);

    // SPA 挂载点且正文极短
    const spaHtml =
      '<!DOCTYPE html><html><body><div id="root"></div><script src="bundle.js"></script></body></html>';
    expect(isSpaOrDynamicSkeleton(spaHtml, '')).toBe(true);

    // Noscript 提示
    const noscriptHtml =
      '<html><body><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
    expect(
      isSpaOrDynamicSkeleton(noscriptHtml, 'You need to enable JavaScript to run this app.'),
    ).toBe(true);
  });

  it('createTinyFishFetcher：POST Bearer 与 X-API-Key 鉴权，请求 format: markdown 并解析 content', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          title: 'React SPA 渲染后标题',
          content: '# 动态渲染文档\n\n这是 TinyFish 无头浏览器渲染后的完整正文。',
          status: 200,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetcher = createTinyFishFetcher('tf-test-secret', { fetchFn: mockFetch });
    const result = await fetcher.fetchRendered('https://example.com/spa-docs');

    expect(result.title).toBe('React SPA 渲染后标题');
    expect(result.content).toContain('这是 TinyFish 无头浏览器渲染后的完整正文');
    expect(calls[0]?.url).toBe('https://api.fetch.tinyfish.ai/');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('tf-test-secret');
    const body = JSON.parse(String(calls[0]?.init?.body)) as { urls: string[]; format: string };
    expect(body.urls).toEqual(['https://example.com/spa-docs']);
    expect(body.format).toBe('markdown');
  });

  it('createTinyFishFetcher：401/429/网络异常诚实报错，不伪造正文', async () => {
    const fetch401 = (async () =>
      new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      createTinyFishFetcher('bad-key', { fetchFn: fetch401 }).fetchRendered(
        'https://example.com/app',
      ),
    ).rejects.toThrow(/认证失败/);

    const fetch429 = (async () =>
      new Response('rate limit exceeded', { status: 429 })) as unknown as typeof fetch;
    await expect(
      createTinyFishFetcher('key', { fetchFn: fetch429 }).fetchRendered('https://example.com/app'),
    ).rejects.toThrow(/限流/);
  });

  it('ResearchChecker：当页面为 SPA 骨架时，触发 TinyFish 渲染抓取并替换为真实正文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-spa-test-'));
    const db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    const store = new ResearchStore(db);

    const topic = store.createTopic({
      question: 'SPA 抓取测试：跟踪现代前端动态文档',
      publicDescription: '验证动态渲染降级',
      interval_ms: 60_000,
      sources: [
        {
          url: 'https://example.com/dynamic-app',
          kind: 'page',
        },
      ],
    });
    const source = store.listSources(topic.id)[0]!;

    // 静态抓取返回单页骨架（无有效正文）
    const spaRawHtml =
      '<!DOCTYPE html><html><head><title>Loading</title></head><body><div id="root"></div><script src="app.js"></script></body></html>';
    const staticFetch = (async () =>
      new Response(spaRawHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    // TinyFish 动态抓取器返回云端浏览器渲染后的正文
    let dynamicCalled = false;
    const mockTinyFishFetcher: TinyFishFetcher = {
      async fetchRendered(targetUrl: string) {
        dynamicCalled = true;
        expect(targetUrl).toBe('https://example.com/dynamic-app');
        return {
          title: '已渲染的前端技术规范',
          content:
            '<h1>已渲染的前端技术规范</h1><p>这里是经过 JavaScript 执行渲染后的真实长篇技术正文。</p>',
          status: 200,
        };
      },
    };

    const checker = new ResearchChecker(
      db,
      systemClock,
      {
        fetch: staticFetch,
        tinyfishFetcher: mockTinyFishFetcher,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      },
      () => undefined,
      () => null, // 规则研读
    );

    try {
      const outcome = await checker.checkNow(topic.id);
      expect(outcome.run.error).toBeNull();
      expect(dynamicCalled).toBe(true);

      // 检查来源指纹已基于动态渲染正文更新
      const updatedSrc = store.listSources(topic.id).find((s) => s.id === source.id);
      expect(updatedSrc?.last_fingerprint).toBeTruthy();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
