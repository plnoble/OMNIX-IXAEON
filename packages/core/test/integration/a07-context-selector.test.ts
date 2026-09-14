import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  ContextSelector,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * A07（审核 2026-09-13）：上下文选材服务（ContextSelector）
 * 验证生产与评测共用的选材逻辑：
 * 1. 语义关联系数加权（命中问句关键词得高分）
 * 2. 用户纠正优先（origin === 'user' 权重提高）
 * 3. 意图加权（问目标 → 目标条目优先，问约束 → 约束条目优先）
 * 4. 受众过滤（model 视角下未授权/未披露条目严格排除）
 * 5. 一次性事件过滤（ephemeral 语句不进入长期画像，除非针对性问及）
 */

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a07-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

describe('A07 上下文选材服务（ContextSelector）', () => {
  it('关联系数加权：问句包含的关键词优先召回', () => {
    const items = new ItemService(db);
    const projects = new ProjectService(db);
    const p = projects.create({ name: '测试项目', rootPath: null, description: null });

    items.createManual({
      projectId: p.id,
      type: 'goal',
      statement: '完成前端界面重构',
      rationale: null,
    });
    items.createManual({
      projectId: p.id,
      type: 'constraint',
      statement: '禁止直接修改生产数据库',
      rationale: null,
    });
    items.createManual({
      projectId: p.id,
      type: 'preference',
      statement: '偏好深色代码编辑器主题',
      rationale: null,
    });

    const selector = new ContextSelector(db);
    const result = selector.selectForQuestion('数据库有什么约束？', p.id);

    expect(result.selectedCount).toBeGreaterThan(0);
    // 第一条应当是关于数据库约束的条目
    expect(result.items[0]?.statement).toContain('禁止直接修改生产数据库');
    expect(result.promptBlock).toContain('禁止直接修改生产数据库');
  });

  it('用户纠正优先：纠正后的条目排在系统推断之前', () => {
    const items = new ItemService(db);
    const projects = new ProjectService(db);
    const p = projects.create({ name: '主题项目', rootPath: null, description: null });

    const oldItem = items.createAssistantSuggestion({
      projectId: p.id,
      type: 'open_loop',
      statement: '偏好红色主题',
      rationale: '推断',
    });
    items.correct({
      itemId: oldItem.id,
      userText: '偏好浅蓝色主题',
      newType: 'preference',
      projectId: p.id,
    });

    const selector = new ContextSelector(db);
    const result = selector.selectForQuestion('主题偏好是什么？', p.id);

    expect(result.items.some((i) => i.statement === '偏好浅蓝色主题')).toBe(true);
    // 旧的推断不应作为首选
    expect(result.items[0]?.statement).toBe('偏好浅蓝色主题');
    expect(result.items[0]?.origin).toBe('user');
  });

  it('受众过滤：个人未披露条目在 model 视角下不外发', () => {
    const items = new ItemService(db);

    const secret = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '绝密个人日记内容',
      rationale: null,
    });

    const selector = new ContextSelector(db);
    // model 受众
    const modelResult = selector.selectForQuestion('个人日记内容是什么？', null, {
      audience: 'model',
    });
    expect(modelResult.items.some((i) => i.id === secret.id)).toBe(false);

    // 授权披露后可外发
    items.grantDisclosure({ itemId: secret.id, audience: 'model', note: '测试披露' });
    const disclosedResult = selector.selectForQuestion('个人日记内容是什么？', null, {
      audience: 'model',
    });
    expect(disclosedResult.items.some((i) => i.id === secret.id)).toBe(true);
  });

  it('一次性事件过滤：临时指令不进入日常画像（除非针对性问及）', () => {
    const items = new ItemService(db);

    items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '今天先用红色主题试试看',
      rationale: null,
    });
    const firstItem = items.list({ projectId: null })[0];
    expect(firstItem).toBeDefined();
    items.grantDisclosure({
      itemId: firstItem!.id,
      audience: 'model',
    });

    const selector = new ContextSelector(db);
    // 问日常长期偏好 → 临时指令被过滤
    const general = selector.selectForQuestion('我的偏好是什么？', null);
    expect(general.items.some((i) => i.statement.includes('今天先用'))).toBe(false);

    // 针对性问今天的事件 → 召回
    const specific = selector.selectForQuestion('今天先用什么主题？', null);
    expect(specific.items.some((i) => i.statement.includes('今天先用'))).toBe(true);
  });
});
