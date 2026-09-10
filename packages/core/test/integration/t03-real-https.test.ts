import { describe, it, expect } from 'vitest';
import { fetchApprovedSource } from '../../src/index.js';

/**
 * 真网探测，不是 T03 产品闭环。默认跳过；IXAEON_REAL_NET=1 才跑。
 * 成功只证明批准来源抓取能打开公开 HTTPS，不证明桌面关注/发现/通知已验收。
 * 2026-09-10 本机：PowerShell 200；Node fetch/https.get TLS ECONNRESET。失败要如实记。
 */
const run = process.env.IXAEON_REAL_NET === '1';

describe.skipIf(!run)('T03 真网探测（批准来源抓取）', () => {
  it('example.com HTTPS GET 成功，不是全网搜索', async () => {
    const r = await fetchApprovedSource('https://example.com/');
    expect(r.status).toBe(200);
    expect(r.finalUrl).toMatch(/^https:\/\/example\.com\/?/);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body).toMatch(/example/i);
  });
});
