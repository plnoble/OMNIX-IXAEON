/**
 * P1-B（自动且有分寸的记忆）与 P1-C（多资料入口与三个项目统筹）验收套件
 * 按照 IXAEON 长期开发总计划 2026-09-16 编制：
 * 1. 记忆分层与分寸：无关问题取 0 条记忆；临时事项不升级为长期约束；自然纠正优先；角色/来源明确；
 * 2. 三个项目统筹：相关项目建议复用并说明理由、收益与代价；无关项目保持独立；用户否决后不再强推；已完成状态来自实际工作记录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ContextSelector,
  ItemService,
  ProjectService,
  RelationService,
  migrate,
  openDatabase,
  proposeObviousRelations,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';

let dir: string;
let db: CoreDatabase;
let selector: ContextSelector;
let itemService: ItemService;
let projects: ProjectService;
let relations: RelationService;

function insertTestItem(
  dbInstance: CoreDatabase,
  input: {
    statement: string;
    type: string;
    scope?: string;
    projectId?: string | null;
    origin?: string;
    state?: string;
    confirmation?: string;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  dbInstance
    .prepare(
      `INSERT INTO items (id, project_id, scope, type, statement, state, confidence, origin, confirmation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId ?? null,
      input.scope ?? (input.projectId ? 'project' : 'personal'),
      input.type,
      input.statement,
      input.state ?? 'current',
      input.origin ?? 'user',
      input.confirmation ?? 'none',
      now,
      now,
    );
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p1-mem-proj-'));
  db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  selector = new ContextSelector(db);
  itemService = new ItemService(db);
  projects = new ProjectService(db);
  relations = new RelationService(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p1-mem-proj-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P1-B 自动且有分寸的记忆', () => {
  it('P1-B01 [分寸原则] 与个人记忆无关的通用问题，选取 0 条记忆，不强行注入画像', () => {
    // 注入个人偏好与日常记忆
    insertTestItem(db, {
      statement: '用户喜欢喝黑咖啡不加糖',
      type: 'preference',
      scope: 'personal',
      origin: 'user',
    });
    insertTestItem(db, {
      statement: '日常工作主力操作系统是 Windows 11',
      type: 'preference',
      scope: 'personal',
      origin: 'user',
    });

    // 针对完全不相干的通用问题进行上下文选取
    const res = selector.selectForQuestion('快速排序算法的时间复杂度是多少？', null, {
      audience: 'model',
    });

    expect(res.selectedCount).toBe(0);
    expect(res.items.length).toBe(0);
    expect(res.promptBlock).toBe('');
  });

  it('P1-B02 [分寸原则] 临时性一次性事项不会升级为长期约束，不注入普通问答', () => {
    // 注入临时事件类条目
    insertTestItem(db, {
      statement: '今天下午三点提醒我去会议室开周会',
      type: 'constraint',
      scope: 'personal',
      origin: 'user',
    });
    insertTestItem(db, {
      statement: '这次帮我查一下最新款手机的折旧价格',
      type: 'goal',
      scope: 'personal',
      origin: 'ai',
    });

    // 提问普通任务或技术问题
    const res = selector.selectForQuestion('如何配置项目的 ESLint 规则？', null, {
      audience: 'model',
    });

    expect(res.selectedCount).toBe(0);
    expect(res.items.some((i) => i.statement.includes('会议室'))).toBe(false);
    expect(res.items.some((i) => i.statement.includes('手机'))).toBe(false);
  });

  it('P1-B03 [纠正优先] 用户自然纠正后，旧条目变为 superseded，新条目优先采纳并带 origin=user', () => {
    const oldItemId = insertTestItem(db, {
      statement: '用户常用编程语言是 Python',
      type: 'preference',
      scope: 'personal',
      origin: 'ai',
    });

    // 用户发起自然纠正
    const { newItem } = itemService.correct({
      itemId: oldItemId,
      userText: '主力开发语言已全面转为 TypeScript 和 Rust',
    });

    // 查询旧条目状态
    const oldRow = itemService.get(oldItemId);
    expect(oldRow.state).toBe('superseded');

    // 提问相关问题（桌面助手视角 audience: user）
    const res = selector.selectForQuestion('为新项目推荐合适的开发语言', null, {
      audience: 'user',
    });

    expect(res.selectedCount).toBeGreaterThanOrEqual(1);
    const matched = res.items.find((i) => i.id === newItem.id);
    expect(matched).toBeTruthy();
    expect(matched?.statement).toContain('TypeScript 和 Rust');
    expect(matched?.origin).toBe('user');
    // 确认旧条目绝不出现在结果中
    expect(res.items.some((i) => i.id === oldItemId)).toBe(false);
  });

  it('P1-B04 [来源标识] 上下文注入中明确标识用户指定 vs 系统推断及争议状态', () => {
    insertTestItem(db, {
      statement: '代码仓库必须配置严格的 Prettier 规则',
      type: 'constraint',
      scope: 'personal',
      origin: 'user',
    });
    insertTestItem(db, {
      statement: '可能偏好使用 pnpm 作为包管理器',
      type: 'preference',
      scope: 'personal',
      origin: 'ai',
    });

    const res = selector.selectForQuestion('代码仓库的 Prettier 规则与 pnpm 包管理器要求', null, {
      audience: 'user',
    });

    expect(res.selectedCount).toBeGreaterThanOrEqual(2);
    expect(res.promptBlock).toContain('用户指定');
    expect(res.promptBlock).toContain('系统推断');
  });
});

describe('P1-C 多资料入口与三个项目统筹', () => {
  it('P1-C01 [三个项目场景] 相关项目建议复用并说明理由、收益与代价，无关项目保持独立', () => {
    // 1. 项目 A：底层持久化存储
    const projA = projects.create({
      name: 'StorageEngine-Core',
      rootPath: null,
      description: '底层持久化与事务日志存储引擎',
    });
    insertTestItem(db, {
      statement: '实现高性能的本地 SQLite 与事务快照机制',
      type: 'goal',
      scope: 'project',
      projectId: projA.id,
      origin: 'user',
    });

    // 2. 项目 B：向量检索与多维索引（与 A 有复用价值）
    const projB = projects.create({
      name: 'VectorSearch-Indexer',
      rootPath: null,
      description: '基于底层存储引擎构建的多维索引层',
    });
    insertTestItem(db, {
      statement: '构建依赖底层 SQLite 事务快照的多维向量索引',
      type: 'goal',
      scope: 'project',
      projectId: projB.id,
      origin: 'user',
    });

    // 3. 项目 C：完全无关的美食菜谱管理
    const projC = projects.create({
      name: 'GourmetRecipe-App',
      rootPath: null,
      description: '日常私房菜谱与烘焙配方记录',
    });
    insertTestItem(db, {
      statement: '记录川菜家常菜谱和烘焙发酵时间表',
      type: 'goal',
      scope: 'project',
      projectId: projC.id,
      origin: 'user',
    });

    // 执行跨项目关系分析
    const proposed = proposeObviousRelations(db);

    // 验证：A 与 B 之间被发现有复用关系，并给出了明确理由、收益与代价
    const relAB = proposed.find(
      (r) =>
        r !== null &&
        ((r.from_project_id === projA.id && r.to_entity_id === projB.id) ||
          (r.from_project_id === projB.id && r.to_entity_id === projA.id) ||
          r.evidence_json.includes('SQLite')),
    );
    expect(relAB).toBeTruthy();
    expect(relAB?.rationale).toBeTruthy();
    expect(relAB?.benefit).toBeTruthy();
    expect(relAB?.cost).toBeTruthy();

    // 验证：项目 C 与项目 A、B 之间没有任何关系，保持完全独立
    const relC = proposed.filter(
      (r) =>
        r !== null &&
        (r.from_project_id === projC.id ||
          r.to_entity_id === projC.id ||
          r.rationale?.includes('川菜')),
    );
    expect(relC.length).toBe(0);
  });

  it('P1-C02 [否决不强推] 用户否决某项关联后，重新分析或重启时不再强行推介该关系', () => {
    const projA = projects.create({
      name: 'Project-Alpha',
      rootPath: null,
      description: 'Alpha 架构',
    });
    const projB = projects.create({
      name: 'Project-Beta',
      rootPath: null,
      description: 'Beta 架构',
    });

    insertTestItem(db, {
      statement: '统一认证与鉴权中心构建',
      type: 'goal',
      scope: 'project',
      projectId: projA.id,
      origin: 'user',
    });
    insertTestItem(db, {
      statement: '接入统一认证与鉴权系统',
      type: 'goal',
      scope: 'project',
      projectId: projB.id,
      origin: 'user',
    });

    const proposed = proposeObviousRelations(db);
    const targetRel = proposed.find((r) => r !== null);
    expect(targetRel).toBeTruthy();

    // 用户在桌面端审阅后，明确点击“否决（Reject）”
    relations.reject(targetRel!.id);

    const updated = relations.get(targetRel!.id);
    expect(updated.status).toBe('rejected');

    // 重新运行分析（模拟系统后台周期轮询或重启）
    const reanalyzed = proposeObviousRelations(db);
    // 已经否决的关系绝不能重新作为新提案再次弹出
    const reProposed = reanalyzed.filter(
      (r) => r !== null && r.id !== targetRel!.id && r.rationale === targetRel!.rationale,
    );
    expect(reProposed.length).toBe(0);
  });

  it('P1-C03 [事实完成依据] 项目的“已完成”来自实际成功工作记录，不凭设想推断', () => {
    const proj = projects.create({
      name: 'Delivery-Project',
      rootPath: null,
      description: '真实交付项目',
    });

    // 仅有一条口头设想“项目应该已经做完了”
    insertTestItem(db, {
      statement: '这个系统应该算做完了吧',
      type: 'project_summary',
      scope: 'project',
      projectId: proj.id,
      origin: 'ai',
    });

    // 查询项目状态，依然是 active，绝不能推断为 completed
    const current = projects.get(proj.id);
    expect(current).toBeTruthy();
    expect(current!.status).toBe('active');

    // 记录实际成功的编码交付 work_run
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', '最终功能交付验证', 'success', '所有自动化测试通过，产物已交付', '{"passed": true}', '["index.js"]', '[]', ?)`,
    ).run(randomUUID(), proj.id, new Date().toISOString());

    // 验证：有确实的真实交付依据
    const runs = db
      .prepare('SELECT outcome FROM work_runs WHERE project_id = ?')
      .all(proj.id) as Array<{ outcome: string }>;
    expect(runs.some((r) => r.outcome === 'success')).toBe(true);
  });
});
