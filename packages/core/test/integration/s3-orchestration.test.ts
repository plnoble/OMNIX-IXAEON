import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  ItemService,
  ProjectService,
  RelationService,
  proposeObviousRelations,
  buildPersonalOverview,
  AskService,
  FakeProvider,
  Orchestrator,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let items: ItemService;
let projects: ProjectService;
let relations: RelationService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s3-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  items = new ItemService(db);
  projects = new ProjectService(db);
  relations = new RelationService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('A08 正反关联', () => {
  it('全新库迁移版本为 13', () => {
    expect(currentMigrationVersion(db)).toBe(13);
  });

  it('有共同主题的目标可提案；不靠项目名；证据不足不强连；不移动资料', () => {
    const a = projects.create({
      name: '完全无关的名字甲',
      rootPath: null,
      description: null,
    });
    const b = projects.create({
      name: '完全无关的名字乙',
      rootPath: null,
      description: null,
    });
    const personal = items.createManual({
      projectId: null,
      type: 'goal',
      statement: '做一个本地优先的个人助手',
      rationale: null,
      scope: 'personal',
    });
    const ag = items.createManual({
      projectId: a.id,
      type: 'goal',
      statement: '本地优先的个人助手桌面端',
      rationale: null,
    });
    items.createManual({
      projectId: b.id,
      type: 'goal',
      statement: '整理花园浇水计划',
      rationale: null,
    });
    const proposed = proposeObviousRelations(db).filter(Boolean);
    expect(
      proposed.some((r) => r && r.kind === 'serves_goal' && r.to_entity_id === personal.id),
    ).toBe(true);
    // 花园计划与助手没有共同 token，不应硬编码项目名去连接
    expect(
      proposed.some(
        (r) =>
          r &&
          r.kind === 'suspected_duplicate' &&
          r.from_project_id === a.id &&
          r.to_entity_id === b.id,
      ),
    ).toBe(false);
    expect(items.get(ag.id).project_id).toBe(a.id);
    expect(items.get(personal.id).project_id).toBeNull();
  });

  it('没有证据时拒绝生成连接', () => {
    const a = projects.create({ name: '空项目', rootPath: null, description: null });
    expect(() =>
      relations.propose({
        kind: 'reusable',
        fromProjectId: a.id,
        toEntityKind: 'project',
        toEntityId: a.id,
        rationale: '无证据',
        evidence: [],
      }),
    ).toThrow(/不能把项目关联到自身|没有足够证据/);
  });
});

describe('A09 关系生命周期', () => {
  it('确认 / 不采纳 / 同样证据不再催促 / 新证据可出新版本 / 纠正后旧关系 stale', () => {
    const a = projects.create({ name: '内核', rootPath: null, description: null });
    const b = projects.create({ name: '扩展', rootPath: null, description: null });
    const g1 = items.createManual({
      projectId: a.id,
      type: 'goal',
      statement: '共享记忆内核',
      rationale: null,
    });
    const g2 = items.createManual({
      projectId: b.id,
      type: 'goal',
      statement: '共享记忆内核的插件',
      rationale: null,
    });
    const first = relations.propose({
      kind: 'reusable',
      fromProjectId: a.id,
      toEntityKind: 'project',
      toEntityId: b.id,
      rationale: '可复用记忆内核',
      evidence: [
        { itemId: g1.id, note: g1.statement },
        { itemId: g2.id, note: g2.statement },
      ],
      benefit: '少写一套存储',
      cost: '耦合',
      independentAlternative: '各自维护',
    });
    expect(first).not.toBeNull();
    const rejected = relations.reject(first!.id);
    expect(rejected.status).toBe('rejected');
    const nag = relations.propose({
      kind: 'reusable',
      fromProjectId: a.id,
      toEntityKind: 'project',
      toEntityId: b.id,
      rationale: '再次催促',
      evidence: [
        { itemId: g1.id, note: g1.statement },
        { itemId: g2.id, note: g2.statement },
      ],
    });
    expect(nag).toBeNull();

    const extra = items.createManual({
      projectId: a.id,
      type: 'decision',
      statement: '抽出共享包',
      rationale: null,
    });
    const revised = relations.proposeRevision(first!.id, {
      kind: 'reusable',
      fromProjectId: a.id,
      toEntityKind: 'project',
      toEntityId: b.id,
      rationale: '新证据：已决定抽出共享包',
      evidence: [
        { itemId: g1.id, note: g1.statement },
        { itemId: extra.id, note: extra.statement },
      ],
    });
    expect(revised).not.toBeNull();
    expect(revised!.id).not.toBe(first!.id);

    const accepted = relations.accept(revised!.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.verification).toBe('unverified');
    relations.setVerification(accepted.id, 'verified');
    expect(relations.get(accepted.id).verification).toBe('verified');

    items.correct({ itemId: extra.id, userText: '暂不抽包' });
    expect(relations.get(accepted.id).stale).toBe(true);
  });
});

describe('A10 个人问答覆盖', () => {
  it('总览含多项目目标与未知；问答按问题筛选并带覆盖说明', async () => {
    const a = projects.create({ name: '桌面端', rootPath: null, description: null });
    const b = projects.create({ name: '研究笔记', rootPath: null, description: null });
    items.createManual({
      projectId: null,
      type: 'goal',
      statement: '持续理解我自己',
      rationale: null,
      scope: 'personal',
    });
    items.createManual({
      projectId: a.id,
      type: 'goal',
      statement: '本地桌面记忆系统',
      rationale: null,
    });
    items.createManual({
      projectId: b.id,
      type: 'constraint',
      statement: '研究笔记必须本地保存',
      rationale: null,
    });
    const overview = buildPersonalOverview(db);
    expect(overview.goals.some((g) => g.statement.includes('理解我自己'))).toBe(true);
    expect(overview.projects).toHaveLength(2);
    expect(overview.coverage.projectCount).toBe(2);

    const fake = new FakeProvider('s3-ask');
    fake.enqueueText('你目前想持续理解自己，并做本地桌面记忆系统 [R1]。');
    const ask = new AskService(db, fake);
    const result = await ask.ask(null, '你目前理解我想做什么？有哪些不确定的地方？');
    expect(result.answer).toMatch(/理解自己|本地/);
    expect(result.coverage).toBeTruthy();
    expect(result.coverage!.includedProjects).toEqual(
      expect.arrayContaining(['桌面端', '研究笔记']),
    );
    expect(result.notice ?? '').toMatch(/未整理|尚未分析|冲突|$/);
  });
});

describe('S3 有界统筹器', () => {
  it('无模型时只展示资料缺口，不生成假理解', async () => {
    const orch = new Orchestrator(db, null);
    const result = await orch.run('找出可复用的项目关系');
    expect(result.stopped).toBe(true);
    expect(result.reason).toMatch(/模型未配置/);
    expect(result.steps).toHaveLength(0);
  });

  it('只接受白名单工具；未知工具失败退出，不执行文本命令', async () => {
    const fake = new FakeProvider('s3-orch');
    fake.enqueueStructured({ tool: 'shell', args: { cmd: 'rm -rf /' } });
    const orch = new Orchestrator(db, fake);
    const result = await orch.run('任意目标');
    expect(result.stopped).toBe(true);
    expect(result.reason).toMatch(/无效|未授权/);
    expect(result.proposals).toHaveLength(0);
  });

  it('校验项目 ID 后才能保存提案', async () => {
    const a = projects.create({ name: '内核', rootPath: null, description: null });
    const b = projects.create({ name: '插件', rootPath: null, description: null });
    const g1 = items.createManual({
      projectId: a.id,
      type: 'goal',
      statement: '共享记忆内核',
      rationale: null,
    });
    const g2 = items.createManual({
      projectId: b.id,
      type: 'goal',
      statement: '共享记忆内核的插件',
      rationale: null,
    });
    const fake = new FakeProvider('s3-orch-ok');
    fake.enqueueStructured({
      tool: 'propose_relation',
      args: {
        kind: 'reusable',
        fromProjectId: a.id,
        toEntityKind: 'project',
        toEntityId: b.id,
        rationale: '可复用记忆内核',
        evidenceItemIds: [g1.id, g2.id],
      },
    });
    fake.enqueueStructured({ tool: 'stop', args: { reason: '完成' } });
    const orch = new Orchestrator(db, fake);
    const result = await orch.run('有没有可复用能力？');
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.verification).toBe('unverified');
    expect(result.proposals[0]!.status).toBe('proposed');
  });
});
