/** G1a 开发回归，加载草案到临时库；不替代原 B 档验收及正式迁移验证。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type CoreDatabase } from '../../src/index.js';
import { ConversationStore } from '../../src/storage/conversationStore.js';
import { GoalStore } from '../../src/goals/index.js';

let dir: string;
let db: CoreDatabase;
let goals: GoalStore;
const snapshot = () => ({
  goals: db.prepare('SELECT * FROM goals ORDER BY id').all(),
  events: db.prepare('SELECT * FROM goal_events ORDER BY id').all(),
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1a-core-'));
  db = openDatabase(join(dir, 'test.db'));
  migrate(db); // 整合方改（2026-10-29）：第 39 号正式迁移建表，不再从草案里抽 SQL
  goals = new GoalStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('来源与用户确认正交（只验证内部存储，非鉴权接线）', () => {
  it.each(['user', 'agent'] as const)(
    '%s 来源默认 proposed，明确 UI/API 操作可确认且来源不变',
    (origin) => {
      const pending = goals.create({ title: '合成目标', origin });
      expect(pending).toMatchObject({
        origin,
        status: 'proposed',
        confirmation: 'pending',
        confirmed_at: null,
      });
      for (const how of ['ui', 'api'] as const) {
        const created = goals.create({ title: '明确创建', origin, via: how });
        expect(created).toMatchObject({
          origin,
          confirmation: how,
          status: 'active',
          confirmed_by_message_id: null,
        });
        expect(created.confirmed_at).toBeTruthy();
        const candidate = goals.create({ title: '候选目标', origin });
        expect(goals.confirm(candidate.id, { how })).toMatchObject({
          origin,
          status: 'active',
          confirmation: how,
        });
      }
    },
  );

  it('真实 ConversationStore 用户消息确认，来源保持；AI 消息、缺失消息不充当用户确认', () => {
    const conversations = new ConversationStore(db);
    const conversation = conversations.create({ title: '合成确认对话' });
    const user = conversations.appendMessage(conversation.id, {
      role: 'user',
      content: '确认这个目标',
    });
    const agent = conversations.appendMessage(conversation.id, {
      role: 'assistant',
      content: '建议做这个目标',
    });
    const goal = goals.create({
      title: '合成目标',
      origin: 'agent',
      fromConversationId: conversation.id,
    });
    const before = snapshot();
    for (const messageId of ['missing-synthetic-message', agent.id]) {
      expect(() => goals.confirm(goal.id, { how: 'chat', messageId })).toThrow();
      expect(snapshot()).toEqual(before);
    }
    const result = goals.confirm(goal.id, { how: 'chat', messageId: user.id });
    expect(result).toMatchObject({
      origin: 'agent',
      confirmation: 'chat',
      status: 'active',
      confirmed_by_message_id: user.id,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('直接 agent/system 激活 proposed 被拒，目标和事件均不变', () => {
    const goal = goals.create({ title: '候选', origin: 'agent' });
    const before = snapshot();
    for (const decidedBy of ['agent', 'system'] as const) {
      expect(() => goals.transition(goal.id, 'active', { decidedBy })).toThrow();
      expect(snapshot()).toEqual(before);
    }
  });
});

describe('事务与核心状态', () => {
  it('合法迁移记录 actor/reason，解除阻塞清理由，completed=100；终态不能复活', () => {
    const goal = goals.create({ title: '目标', via: 'ui' });
    goals.transition(goal.id, 'paused', { decidedBy: 'user' });
    goals.transition(goal.id, 'active', { decidedBy: 'user' });
    expect(
      goals.transition(goal.id, 'blocked', { decidedBy: 'agent', reason: '缺少输入' }),
    ).toMatchObject({ status: 'blocked', blocked_reason: '缺少输入' });
    const event = db
      .prepare("SELECT * FROM goal_events WHERE goal_id=? AND kind='status' AND decided_by='agent'")
      .get(goal.id) as { detail_json: string };
    expect(JSON.parse(event.detail_json)).toMatchObject({ to: 'blocked', reason: '缺少输入' });
    expect(goals.transition(goal.id, 'active', { decidedBy: 'user' }).blocked_reason).toBeNull();
    expect(goals.transition(goal.id, 'completed', { decidedBy: 'user' })).toMatchObject({
      status: 'completed',
      progress: 100,
    });
    expect(() => goals.transition(goal.id, 'active', { decidedBy: 'user' })).toThrow();
  });

  it('非法状态迁移拒绝，完整目标和事件快照不变', () => {
    const candidate = goals.create({ title: '候选', origin: 'agent' });
    const active = goals.create({ title: '明确目标', via: 'ui' });
    const abandoned = goals.create({ title: '放弃目标', via: 'api' });
    goals.transition(abandoned.id, 'abandoned', { decidedBy: 'user' });
    const before = snapshot();
    const attempts = [
      () => goals.transition(candidate.id, 'completed', { decidedBy: 'user' }),
      () => goals.transition(candidate.id, 'abandoned', { decidedBy: 'agent' }),
      () => goals.transition(abandoned.id, 'active', { decidedBy: 'user' }),
      () => goals.transition(active.id, 'blocked', { decidedBy: 'agent', reason: '   ' }),
      () => goals.transition(active.id, 'blocked', { decidedBy: 'system', reason: '计数阈值' }),
      () => goals.transition(active.id, 'proposed', { decidedBy: 'agent' }),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow();
      expect(snapshot()).toEqual(before);
    }
  });

  it('写事件途中失败，已更新的 Goal 回滚；没有伪成功和残留事件', () => {
    const goal = goals.create({ title: '事务故障注入', via: 'ui' });
    const before = snapshot();
    db.exec(`CREATE TEMP TRIGGER reject_goal_event BEFORE INSERT ON goal_events
      BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END;`);
    expect(() =>
      goals.transition(goal.id, 'blocked', { decidedBy: 'user', reason: '合成原因' }),
    ).toThrow('synthetic event failure');
    expect(snapshot()).toEqual(before);
  });

  it('根权重可空、子默认1、非正权重拒绝；manual与weighted仅存值且两目标隔离', () => {
    const root = goals.create({ title: '根', via: 'ui', parentWeight: null });
    const child = goals.create({
      title: '子',
      via: 'ui',
      parentGoalId: root.id,
      progressMode: 'weighted',
    });
    expect(root.parent_weight).toBeNull();
    expect(child.parent_weight).toBe(1);
    expect(goals.childrenOf(root.id).map((g) => g.id)).toEqual([child.id]);
    const before = snapshot();
    for (const parentWeight of [0, -1])
      expect(() =>
        goals.create({ title: '非法子', parentGoalId: root.id, parentWeight }),
      ).toThrow();
    expect(snapshot()).toEqual(before);
    goals.setProgress(root.id, 42);
    goals.setProgress(child.id, 15);
    goals.transition(root.id, 'blocked', { decidedBy: 'user', reason: '根的阻塞' });
    expect(goals.get(child.id)).toMatchObject({
      status: 'active',
      progress_mode: 'weighted',
      progress: 15,
      blocked_reason: null,
    });
    expect(goals.get(root.id)!.progress).toBe(42);
    expect(goals.list({ status: 'active' }).map((g) => g.id)).toEqual([child.id]);
  });

  it('数据库约束拒绝 active+pending / 空 blocked 理由，不绕过外键', () => {
    const candidate = goals.create({ title: '候选', origin: 'agent' });
    const active = goals.create({ title: '明确目标', via: 'ui' });
    const before = snapshot();
    expect(() =>
      db.prepare("UPDATE goals SET status='active' WHERE id=?").run(candidate.id),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare("UPDATE goals SET status='blocked', blocked_reason=NULL WHERE id=?")
        .run(active.id),
    ).toThrow(/CHECK/);
    expect(snapshot()).toEqual(before);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('关闭重开后父子、确认、进度与事件逐行一致', () => {
    const parent = goals.create({ title: '父', via: 'ui' });
    goals.create({ title: '子', via: 'api', parentGoalId: parent.id, parentWeight: 3 });
    goals.setProgress(parent.id, 27);
    goals.transition(parent.id, 'blocked', { decidedBy: 'user', reason: '输入未齐' });
    const before = snapshot();
    db.close();
    db = openDatabase(join(dir, 'test.db'));
    goals = new GoalStore(db);
    expect(snapshot()).toEqual(before);
    expect(goals.get(parent.id)).toMatchObject({
      confirmation: 'ui',
      progress: 27,
      status: 'blocked',
    });
  });
});
