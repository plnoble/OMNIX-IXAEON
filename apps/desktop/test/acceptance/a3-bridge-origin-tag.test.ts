/**
 * A3 验收（整合方写死，执行方不改）：记忆桥查到的记忆，出处标签与聊天注入一致。
 * 委派单：docs/委派/A3-记忆桥出处标签.md
 *
 * E3 之后聊天注入会把 AI 在对话里给的建议标成「AI 当时的建议，不是用户的决定」，
 * 但记忆桥的 search_memory 自己拼标签，只分「用户指定 / 系统推断」——
 * 开着记忆桥时，Hermes 查到 AI 的建议会当成系统对用户的推断。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { LocalServer } from '../../src/main/server/localServer.js';
import { AppRuntime } from '../../src/main/appRuntime.js';

const BRIDGE_TOKEN = 'bridge-token-'.padEnd(64, '2');

let dir: string;
let db: CoreDatabase;
let app: FastifyInstance;
let items: ItemService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a3-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  items = new ItemService(db);
  let config: AppConfig = {
    ...defaultAppConfig(),
    localToken: 'local-token-'.padEnd(64, '1'),
    hermesBridge: { enabled: true, token: BRIDGE_TOKEN },
  };
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['db'] = db;
  rt['items'] = items;
  rt['search'] = new SearchService(db);
  rt['projects'] = new ProjectService(db);
  rt['coding'] = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
  rt['semanticIndex'] = null;
  rt['semanticBackfillRun'] = null;
  const runtime = rt as unknown as {
    hermesTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  const server = new LocalServer({
    db,
    permissions: new PermissionService(db),
    sources: new SourceStore(db),
    vault: new Vault(join(dir, 'vault')),
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    hermesTool: (name, args) => runtime.hermesTool(name, args),
  });
  app = Fastify();
  await server.register(app);
});

afterEach(async () => {
  await app.close();
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 给模型看过的一条个人记忆；saidBy/confirmation 模拟 E3 之后的提炼结果。 */
function memory(
  statement: string,
  opts: { origin?: string; saidBy?: 'user' | 'ai' | null; confirmation?: string } = {},
): string {
  const item = items.createManual({
    projectId: null,
    scope: 'personal',
    type: 'decision',
    statement,
    rationale: null,
  });
  items.grantDisclosure({ itemId: item.id, audience: 'model', note: '合成' });
  db.prepare('UPDATE items SET origin = ?, said_by = ?, confirmation = ? WHERE id = ?').run(
    opts.origin ?? 'user',
    opts.saidBy ?? null,
    opts.confirmation ?? 'none',
    item.id,
  );
  return item.id;
}

async function search(query: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/hermes/tool',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    payload: { name: 'search_memory', args: { query } },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    adviceNote?: string;
    items: Array<{ id: string; origin: string }>;
  };
}

describe('记忆桥 search_memory 的出处标签', () => {
  it('与聊天注入同一套：用户指定 / 系统推断 / AI 当时的建议 / 用户采纳的 AI 建议', async () => {
    const mine = memory('台式机预算一万以内');
    const inferred = memory('台式机要能跑本地大模型', { origin: 'ai', saidBy: 'user' });
    const advice = memory('AI 建议台式机选大机箱', { origin: 'ai', saidBy: 'ai' });
    const adopted = memory('AI 建议台式机配 64G 内存', {
      origin: 'ai',
      saidBy: 'ai',
      confirmation: 'confirmed',
    });
    const body = await search('台式机');
    const tag = (id: string) => body.items.find((i) => i.id === id)?.origin;
    expect(tag(mine)).toBe('用户指定');
    expect(tag(inferred)).toBe('系统推断');
    expect(tag(advice)).toBe('AI 当时的建议，不是用户的决定');
    expect(tag(adopted)).toBe('用户采纳的 AI 建议');
  });

  it('查到 AI 建议时附一句说明：那是当时的看法，不是定论', async () => {
    memory('AI 建议台式机选大机箱', { origin: 'ai', saidBy: 'ai' });
    expect((await search('台式机')).adviceNote).toContain('不是定论');
  });

  it('没查到 AI 建议时不附这句', async () => {
    memory('台式机预算一万以内');
    expect((await search('台式机')).adviceNote).toBeUndefined();
  });
});
