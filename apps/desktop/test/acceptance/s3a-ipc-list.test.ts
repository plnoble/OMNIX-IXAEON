/**
 * S3a 验收条件 5（v2 规格，执行方写、整合方 2026-09-19 复审后补全并重锁）：
 * 编号不在清单里、清单号过期或编造 → 拒绝，什么都不导。docs/委派/S3a-编码代理会话选择导入（核心）.md
 *
 * 渲染层只传清单号和编号。主进程：IPC 处理函数消费票据、建 folder 授权后调
 * runtime.listAgentSessions({ root, permissionId })；估算与导入只认这次清单里的编号，30 分钟过期。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorCodes } from '@ixaeon/contracts';
import {
  ImportService,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

type Listed = {
  listId: string;
  sessions: Array<{ id: number; title: string }>;
  unrecognizedCount: number;
  subagentCount: number;
};
type S3aRuntime = AppRuntime & {
  listAgentSessions: (input: { root: string; permissionId: string }) => Promise<Listed>;
  estimateAgentSessions: (input: { listId: string; ids: number[] }) => Promise<unknown>;
  importAgentSessions: (input: {
    listId: string;
    ids: number[];
    projectId: string | null;
  }) => Promise<{ created: number; unchanged: number; failed: unknown[] }>;
};

const SID = '11111111-2222-4333-8444-999999999999';
const L = (o: unknown) => JSON.stringify(o);

let dir: string;
let folder: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s3a-ipc-'));
  folder = join(dir, 'sessions');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const base = { sessionId: SID, cwd: 'D:/work/demo', gitBranch: 'main', isSidechain: false };
  // 一个合成的 Claude Code 会话
  const lines = [
    L({
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-09-19T01:00:01.000Z',
      message: { role: 'user', content: '帮我把导入修好' },
    }),
    L({
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-09-19T01:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '改好了。' }] },
    }),
  ];
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${SID}.jsonl`), lines.join('\n'), 'utf8');
});

afterEach(() => {
  vi.useRealTimers();
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runtime() {
  const permissions = new PermissionService(db);
  const rt = Object.create(AppRuntime.prototype) as S3aRuntime;
  Object.assign(rt, {
    db,
    permissions,
    imports: new ImportService(db, new Vault(join(dir, 'vault')), permissions, new SourceStore(db)),
    enqueueExtract: () => undefined,
    logger: { warn: () => undefined, info: () => undefined },
  });
  return { rt, permissionId: permissions.grantFolder(folder).id };
}

const sourceCount = () =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM sources WHERE provider = 'coding_agent'").get() as {
      n: number;
    }
  ).n;

it('条件 5：编造的清单号、不在清单里的编号、清单过期：估算与导入都拒绝，什么都不导；正常的照常能导', async () => {
  const { rt, permissionId } = runtime();
  const listed = await rt.listAgentSessions({ root: folder, permissionId });
  expect(listed.sessions).toHaveLength(1);
  const valid = listed.sessions[0]!.id;
  const rejected = { code: ErrorCodes.VALIDATION_FAILED };

  // 编造的清单号
  await expect(
    rt.importAgentSessions({ listId: 'forged-list', ids: [valid], projectId: null }),
  ).rejects.toMatchObject(rejected);
  await expect(
    rt.estimateAgentSessions({ listId: 'forged-list', ids: [valid] }),
  ).rejects.toMatchObject(rejected);

  // 真的清单号，但编号不在清单里；混着一个合法的也整批拒绝
  await expect(
    rt.importAgentSessions({ listId: listed.listId, ids: [99_999], projectId: null }),
  ).rejects.toMatchObject(rejected);
  await expect(
    rt.importAgentSessions({ listId: listed.listId, ids: [valid, 99_999], projectId: null }),
  ).rejects.toMatchObject(rejected);
  await expect(
    rt.estimateAgentSessions({ listId: listed.listId, ids: [99_999] }),
  ).rejects.toMatchObject(rejected);

  // 过了 30 分钟：清单作废
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 31 * 60 * 1000);
  await expect(
    rt.importAgentSessions({ listId: listed.listId, ids: [valid], projectId: null }),
  ).rejects.toMatchObject(rejected);
  await expect(
    rt.estimateAgentSessions({ listId: listed.listId, ids: [valid] }),
  ).rejects.toMatchObject(rejected);
  vi.useRealTimers();

  expect(sourceCount()).toBe(0);

  // 对照：重新列一次，合法的编号能估算、能导入
  const fresh = await rt.listAgentSessions({ root: folder, permissionId });
  await expect(
    rt.estimateAgentSessions({ listId: fresh.listId, ids: [fresh.sessions[0]!.id] }),
  ).resolves.toBeTruthy();
  const r = await rt.importAgentSessions({
    listId: fresh.listId,
    ids: [fresh.sessions[0]!.id],
    projectId: null,
  });
  expect(r.created).toBe(1);
  expect(sourceCount()).toBe(1);
});
