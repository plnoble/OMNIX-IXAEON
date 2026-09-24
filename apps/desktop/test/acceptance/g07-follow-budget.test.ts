/**
 * G07 验收（W1a 关注建主题，规格 docs/委派/G07-搜索预算按天恢复.md 条件 4）
 *
 * 搜索已配置时，「关注」建出的主题 daily_request_cap = 3（同时 request_cap = 3）。
 * 搜索没配置时仍是 paid_budget_mode = 'none'（W1a 的行为不许退化）。
 * 整合方复审时补（2026-09-24）：搜索没配置时也不设每天额度（daily_request_cap 为空）——
 * 否则每天被「恢复」出 3 次、研究页写「今天还能搜 3 次」，而这个主题根本不能搜。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchChecker, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runtime(searchConfigured: boolean): AppRuntime {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-g07-follow-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const checker = new ResearchChecker(
    db,
    undefined,
    {},
    searchConfigured
      ? () => ({
          search: async () => ({ hits: [] }),
        })
      : undefined,
  );
  const rt = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(rt, { db, research: checker });
  return rt;
}

const direction = {
  question: '本地模型的新进展',
  publicDescription: 'local model runtime',
  relatedGoalId: null,
  relatedProjectId: null,
};

it('条件 4：搜索已配置时，关注建出的主题每天 3 次', async () => {
  const rt = runtime(true);
  const { id } = await rt.followWatchDirection(direction);
  const row = db!
    .prepare(
      'SELECT daily_request_cap AS daily, request_cap AS cap, paid_budget_mode AS mode FROM research_topics WHERE id = ?',
    )
    .get(id) as { daily: number | null; cap: number; mode: string };
  expect(row.daily).toBe(3);
  expect(row.cap).toBe(3);
  expect(row.mode).toBe('request_cap');
});

it('条件 4：搜索没配置时仍是 paid_budget_mode = none', async () => {
  const rt = runtime(false);
  const { id } = await rt.followWatchDirection(direction);
  const row = db!
    .prepare(
      'SELECT paid_budget_mode AS mode, request_cap AS cap, daily_request_cap AS daily FROM research_topics WHERE id = ?',
    )
    .get(id) as { mode: string; cap: number; daily: number | null };
  expect(row.mode).toBe('none');
  expect(row.cap).toBe(0);
  expect(row.daily).toBeNull();
});
