/**
 * E6：少审核——默认可用，用的时候纠正（用户 2026-09-18：不想导入一份资料就逐句审核）。
 * - 待讨论页、首页只放真正要用户拍板的：冲突、用户要求继续待处理的、编码代理报回的结果；
 * - 「个人记忆给聊天用」一次决定，代替逐条分享：只放宽 IXAEON 自己的聊天，编码客户端不变；
 * - 开关一变，权限纪元跟着变（带着旧可见范围的会话作废）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContextSelector,
  ItemService,
  buildPersonalOverview,
  codingClientMayReadItem,
  getDisclosureEpoch,
  getSetting,
  migrate,
  modelMayReadItem,
  openDatabase,
  personalMemoryToChat,
  setPersonalMemoryToChat,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let items: ItemService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-e6-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  items = new ItemService(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 一条 AI 提炼、没归项目的记忆，带指定的待处理原因。 */
function extracted(statement: string, reasons: string, extra: Record<string, string> = {}): string {
  const item = items.createManual({
    projectId: null,
    scope: 'unassigned',
    type: 'decision',
    statement,
    rationale: null,
  });
  db.prepare(
    `UPDATE items SET origin = ?, state = ?, needs_reasons = ?, needs_review = ? WHERE id = ?`,
  ).run(extra.origin ?? 'ai', extra.state ?? 'current', reasons, reasons ? 1 : 0, item.id);
  return item.id;
}

describe('待讨论只放要你拍板的', () => {
  it('冲突、要求继续待处理、编码结果列出来；只是没确认或没归项目的不列', () => {
    const conflict = extracted('两份资料说法相反', 'conflict');
    const manual = extracted('用户说这条还要再想想', 'manual');
    const work = extracted('编码代理报回：还有一个测试没过', 'unconfirmed', {
      origin: 'work_result',
    });
    const disputed = extracted('互相矛盾的一对之一', '', { state: 'disputed' });
    const unconfirmed = extracted('从用户的话里推断的决定', 'no_project,unconfirmed');
    const noProject = extracted('没归项目的一条', 'no_project');

    const needs = items.list({ projectId: null, needsReview: true, needsUser: true });
    expect(needs.map((i) => i.id).sort()).toEqual([conflict, manual, work].sort());
    const auto = items.list({ projectId: null, needsReview: true, needsUser: false });
    expect(auto.map((i) => i.id).sort()).toEqual([unconfirmed, noProject].sort());
    // 冲突状态本身就要拍板（即使原因集还没写上）
    expect(items.list({ projectId: null, needsUser: true }).map((i) => i.id)).toContain(disputed);
  });

  it('首页「要你拍板」同一规则：没确认的决定不再刷成作业', () => {
    const work = extracted('编码代理报回：还有一个测试没过', 'unconfirmed', {
      origin: 'work_result',
    });
    extracted('从用户的话里推断的决定', 'no_project,unconfirmed');
    expect(buildPersonalOverview(db).unknowns.map((i) => i.id)).toEqual([work]);
  });
});

describe('个人记忆给聊天用', () => {
  it('默认关：没归项目的记忆进不了聊天；打开后能进；编码客户端始终拿不到', () => {
    const personal = extracted('用户喜欢早上跑步', 'no_project');
    expect(personalMemoryToChat(db)).toBe(false);
    expect(modelMayReadItem(db, personal)).toBe(false);

    setPersonalMemoryToChat(db, true);
    expect(modelMayReadItem(db, personal)).toBe(true);
    expect(codingClientMayReadItem(db, personal)).toBe(false);
    const r = new ContextSelector(db).selectForQuestion('我喜欢什么时候跑步？', null);
    expect(r.items.map((i) => i.id)).toContain(personal);

    setPersonalMemoryToChat(db, false);
    expect(modelMayReadItem(db, personal)).toBe(false);
    expect(new ContextSelector(db).selectForQuestion('我喜欢什么时候跑步？', null).items).toEqual(
      [],
    );
  });

  it('开关一变，权限纪元跟着变；操作记进审计', async () => {
    const before = getDisclosureEpoch(db);
    await new Promise((r) => setTimeout(r, 5)); // 时间戳至少差 1 毫秒
    setPersonalMemoryToChat(db, true);
    expect(getDisclosureEpoch(db)).not.toBe(before);
    const audit = db
      .prepare(
        `SELECT detail_json FROM audit_events WHERE kind = 'setting.personal_memory_to_chat'`,
      )
      .all() as Array<{ detail_json: string }>;
    expect(audit.map((a) => JSON.parse(a.detail_json))).toEqual([{ enabled: true }]);
  });

  it('迁移 32 之前的库：当作关闭，不报错', () => {
    const old = openDatabase(join(dir, 'old.db'));
    try {
      migrate(old, 31);
      expect(getSetting(old, 'memory.personal_to_chat')).toBeNull();
      expect(personalMemoryToChat(old)).toBe(false);
      expect(() => getDisclosureEpoch(old)).not.toThrow();
    } finally {
      old.close();
    }
  });
});
