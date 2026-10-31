/**
 * K4 验收（整合方复审时补，2026-10-31）：规格「约束」——不发任何外网请求。
 *
 * 地址校验只管第一跳；QuotaHub（或冒充它的本机程序）回一个 30x 指到别处时，`fetch` 默认会跟过去，
 * 等于绕过了「只认本机」。这里用第二个合成服务当「别处」：它一个请求都不许收到，来源记 error，
 * 快照照常返回。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, setSetting, type CoreDatabase } from '../../src/index.js';
import { buildCockpitSnapshot } from '../../src/cockpit/snapshot.js';

const dirs: string[] = [];
const dbs: CoreDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
}

describe('K4 QuotaHub 回跳转不跟', () => {
  it('30x 指到别处 → 别处收不到请求，quotas 来源 error，快照照常', async () => {
    let elsewhere = 0;
    const otherPort = await listen((_req, res) => {
      elsewhere += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{ provider: 'x', account_name: '跳转后', status: 'ok' }] }));
    });
    const hubPort = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/api/snapshots` });
      res.end();
    });

    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-k4-redirect-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'ixaeon.db'));
    dbs.push(db);
    migrate(db);
    setSetting(db, 'cockpit.quotahub_url', `http://127.0.0.1:${hubPort}`);

    const snap = await buildCockpitSnapshot(db, { relayDir: join(dir, 'relay'), ixaeonRepo: '' });
    expect(elsewhere).toBe(0);
    expect(snap.sources.quotas?.status).toBe('error');
    expect(snap.sources.quotas?.note).toBeTruthy();
    expect(snap.quotas ?? []).toEqual([]);
    expect(snap.sources.projects.status).toBe('ok');
  });
});
