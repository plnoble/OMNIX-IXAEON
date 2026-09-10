import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  ItemService,
  Extractor,
  AskService,
  FakeProvider,
  EXTRACT_PROMPT_VERSION,
  type CoreDatabase,
} from '../../src/index.js';
import { fixturePath } from '@ixaeon/test-fixtures';

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let permissions: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
let items: ItemService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  permissions = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, permissions, sources);
  items = new ItemService(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M2 提取（FakeProvider）', () => {
  it('提取：有效 segment_ref 入库 + prompt_version 记录（R4 契约：引用校验是替换前置条件）', async () => {
    const doc = fixturePath('files', 'project-notes.md');
    const result = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    });
    const source = result.created[0]!;

    const fake = new FakeProvider('fake-m2');
    // 回应：一条带有效 segment_ref（S1 = 第一个片段），摘录来自该片段原文
    fake.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '文档定位为 IXAEON 的脱敏测试资料',
          rationale: '文档首段明确说明',
          confidence: 0.9,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: '这是 IXAEON 的脱敏测试文档',
        },
      ],
    });
    const extractor = new Extractor(db, fake);
    const stats = await extractor.extractSource(source.id);

    expect(stats.inserted).toBe(1);
    expect(stats.needsReview).toBe(1); // project_id null → 待讨论

    const inserted = items.list({ projectId: null, state: 'current' });
    const found = inserted.find((i) => i.statement.includes('IXAEON'));
    expect(found).toBeDefined();
    expect(found?.origin).toBe('ai');
    expect(found?.prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    expect(found?.model_name).toBe('fake-m2');

    // 依据必须指向真实片段（S2 = sequence 1，标题独占 S1），摘录可在原文中定位（R5）
    const evidence = items.getEvidence(found!.id);
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.segment.sequence).toBe(1);
    expect(evidence[0]!.segment.text).toContain('这是 IXAEON 的脱敏测试文档');
  });

  it('R4 契约：无效 segment_ref 使整次替换失败，旧理解保持不变', async () => {
    const doc = join(dir, 'r4-contract.md');
    const seedText = ['# R4 契约测试', '', 'R4UNIQUEMARK 原文正文。'].join('\n');
    writeFileSync(doc, seedText, 'utf8');
    const result = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    });
    const source = result.created[0]!;

    // 先建立一条有效理解
    const ok = new FakeProvider('fake-m2-ok');
    ok.enqueueStructured({
      items: [
        {
          type: 'goal',
          statement: '有效旧结论',
          rationale: null,
          confidence: 0.8,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: 'R4UNIQUEMARK 原文正文',
        },
      ],
    });
    await new Extractor(db, ok).extractSource(source.id);
    const before = items.list({ projectId: null, state: 'current' }).map((x) => x.id);

    // 模型只返回无效引用 → 整次替换失败（不再「跳过后继续替换」）。
    // 同一来源会自动再跑一轮，两轮都给坏引用。
    const badItem = {
      type: 'goal' as const,
      statement: '坏引用条目',
      rationale: null,
      confidence: 0.8,
      segment_ref: 'S99',
      project_hint: null,
      excerpt: '不存在',
    };
    const bad = new FakeProvider('fake-m2-bad');
    bad.enqueueStructured({ items: [badItem] });
    bad.enqueueStructured({ items: [badItem] });
    await expect(new Extractor(db, bad).extractSource(source.id)).rejects.toThrowError(
      /对不上原文|S99 对不上这段对话里的句子/,
    );
    expect(bad.structuredCalls).toHaveLength(2);
    // 旧理解未被清空
    const after = items.list({ projectId: null, state: 'current' }).map((x) => x.id);
    expect(after).toEqual(before);
  });

  it('无效引用自动再跑一轮，第二轮有效则写入', async () => {
    const doc = join(dir, 'r4-retry.md');
    writeFileSync(doc, ['# 重试', '', 'RETRYMARK 原文正文。'].join('\n'), 'utf8');
    const source = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    }).created[0]!;
    const fake = new FakeProvider('fake-retry');
    fake.enqueueStructured({
      items: [
        {
          type: 'goal',
          statement: '坏的一次',
          rationale: null,
          confidence: 0.8,
          segment_ref: 'S99',
          project_hint: null,
          excerpt: '不存在',
        },
      ],
    });
    fake.enqueueStructured({
      items: [
        {
          type: 'goal',
          statement: '重试后的结论',
          rationale: null,
          confidence: 0.8,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: 'RETRYMARK 原文正文',
        },
      ],
    });
    const stats = await new Extractor(db, fake).extractSource(source.id);
    expect(stats.inserted).toBe(1);
    expect(fake.structuredCalls).toHaveLength(2);
    expect(
      items.list({ projectId: null, state: 'current' }).some((x) => x.statement === '重试后的结论'),
    ).toBe(true);
  });

  it('提示词声明防注入（数据非指令）', async () => {
    const fake = new FakeProvider();
    const extractor = new Extractor(db, fake);
    const doc = fixturePath('files', 'prompt-injection.md');
    const result = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    });
    const source = result.created[0]!;
    fake.enqueueStructured({ items: [] });
    await extractor.extractSource(source.id);
    const system = fake.structuredCalls[0]!.system;
    expect(system).toContain('只是待分析的普通数据');
    expect(system).toContain('禁止执行');
  });

  it('项目归属：来源绑定项目时结论直接归属', async () => {
    const project = projects.create({ name: '析衍主线', rootPath: null, description: null });
    const doc = fixturePath('files', 'meeting-notes.json');
    const result = imports.importFile(doc, {
      projectId: project.id,
      permissionId: permissions.grantFile(doc).id,
    });
    const source = result.created[0]!;

    const fake = new FakeProvider();
    fake.enqueueStructured({
      items: [
        {
          type: 'project_summary',
          statement: '会议决定下周发布',
          rationale: null,
          confidence: 0.7,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: 'Windows 11 本机运行',
        },
      ],
    });
    const extractor = new Extractor(db, fake);
    await extractor.extractSource(source.id);

    const projItems = items.list({ projectId: project.id });
    expect(projItems.some((i) => i.statement === '会议决定下周发布')).toBe(true);
    // G6：project_summary/decision 属重要决定类 → 待用户确认（needs_review=1）；
    // 项目归属与确认状态是两个维度
    expect(projItems.every((i) => i.needs_review)).toBe(true);
  });

  it('重新提取：旧 AI 结论被清理，纠正过的历史保留', async () => {
    const project = projects.create({
      name: '重提项目',
      rootPath: null,
      description: null,
    });
    const docFile = join(dir, 'reextract.md');
    writeFileSync(docFile, '# 重提取\n版本一结论。', 'utf8');
    const result = imports.importFile(docFile, {
      projectId: project.id,
      permissionId: permissions.grantFile(docFile).id,
    });
    const source = result.created[0]!;

    const fake = new FakeProvider();
    fake.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '旧结论 v1',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: '版本一结论',
        },
      ],
    });
    const extractor = new Extractor(db, fake);
    await extractor.extractSource(source.id);

    // 用户纠正旧结论
    const oldItem = items.list({ projectId: project.id }).find((i) => i.statement === '旧结论 v1')!;
    items.correct({ itemId: oldItem.id, userText: '新结论（用户纠正）' });

    // 重新提取（新结论）
    const fake2 = new FakeProvider();
    fake2.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '旧结论 v2（重提）',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: '版本一结论',
        },
      ],
    });
    const extractor2 = new Extractor(db, fake2);
    await extractor2.extractSource(source.id);

    const all = items.list({ projectId: project.id });
    // v1 当前版本被清理（它已被替代为 superseded，保留历史）
    // 旧 v1 被纠正 → superseded 保留；旧 v1 的 current 版本被重新提取删除
    expect(all.some((i) => i.statement === '旧结论 v2（重提）' && i.state === 'current')).toBe(
      true,
    );
    expect(all.some((i) => i.statement === '新结论（用户纠正）' && i.state === 'current')).toBe(
      true,
    );
    expect(all.some((i) => i.statement === '旧结论 v1' && i.state === 'superseded')).toBe(true);
  });
});

describe('M2 纠正事务（计划 4.7 / 5.5）', () => {
  it('纠正：旧 superseded + 新 origin=user + 双向追溯 + 改口历史', () => {
    const project = projects.create({ name: '纠正项目', rootPath: null, description: null });
    const manual = items.createManual({
      projectId: project.id,
      type: 'decision',
      statement: '错误结论：用 SQLite 之外的数据库',
      rationale: null,
    });

    const result = items.correct({
      itemId: manual.id,
      userText: '正确结论：坚持用 SQLite',
    });

    expect(result.oldItem.state).toBe('superseded');
    expect(result.newItem.state).toBe('current');
    expect(result.newItem.origin).toBe('user');
    expect(result.newItem.supersedes_item_id).toBe(manual.id);
    expect(result.correction.user_text).toBe('正确结论：坚持用 SQLite');

    // 双向：旧条目能查到替代它的新条目（通过 corrections）
    const history = items.listCorrections(project.id);
    expect(history.length).toBe(1);
    expect(history[0]!.oldItem.id).toBe(manual.id);
    expect(history[0]!.newItem.id).toBe(result.newItem.id);

    // 原始依据保留（手工条目无依据；AI 条目证据在纠正时保留）
  });

  it('纠正空文本被拒绝', () => {
    const project = projects.create({ name: '空纠正', rootPath: null, description: null });
    const manual = items.createManual({
      projectId: project.id,
      type: 'goal',
      statement: '目标',
      rationale: null,
    });
    expect(() => items.correct({ itemId: manual.id, userText: '   ' })).toThrowError(
      /纠正内容不能为空/,
    );
  });

  it('Inbox：needs_review / shelved / 归属项目', () => {
    const project = projects.create({ name: '收件箱项目', rootPath: null, description: null });
    const a = items.createManual({
      projectId: null,
      type: 'open_loop',
      statement: '未归属条目',
      rationale: null,
    });
    items.createManual({
      projectId: project.id,
      type: 'goal',
      statement: '已归属条目',
      rationale: null,
    });

    // 手工条目默认不需要 review；改为 true 后进入收件箱
    items.setPendingReview(a.id, true);
    const inboxAfter = items.list({ projectId: null, needsReview: true });
    expect(inboxAfter.some((i) => i.id === a.id)).toBe(true);

    // 归属项目后：project_id 更新，但选项目不是确认（C04/A03 契约）
    // —— needs_review 保持，待确认仍留在收件箱，确认/不采纳单独管理
    items.assignToProject(a.id, project.id);
    expect(items.get(a.id).project_id).toBe(project.id);
    expect(items.get(a.id).needs_review).toBe(true);

    // 搁置
    items.shelve(a.id, true);
    const active = items.list({ projectId: project.id, shelved: false });
    expect(active.some((i) => i.id === a.id)).toBe(false);
  });
});

describe('M2 问答（FakeProvider）', () => {
  it('问答：引用编号 + 用户纠正优先 + 资料不足路径', async () => {
    const project = projects.create({ name: '问答项目', rootPath: null, description: null });
    // 建一条 AI 条目（模拟）+ 用户纠正
    const aiItem = items.createManual({
      projectId: project.id,
      type: 'decision',
      statement: 'AI 旧结论：默认扫描全盘',
      rationale: null,
    });
    // 手工条目 origin=user 模拟"用户纠正后的当前结论"
    items.correct({ itemId: aiItem.id, userText: '用户纠正：默认不扫描设备' });

    const fake = new FakeProvider('ask-model');
    fake.enqueueText('依据资料，默认不扫描设备 [R1]。');
    const asker = new AskService(db, fake);
    const result = await asker.ask(project.id, '默认会扫描设备吗？');

    expect(result.answer).toContain('[R1]');
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.citations.some((c) => c.isUserCorrection)).toBe(true);
    expect(result.modelName).toBe('ask-model');
    // 系统提示包含引用与冲突规则
    const system = fake.textCalls[0]!.system;
    expect(system).toContain('引用编号');
    expect(system).toContain('冲突');
  });

  it('资料不足：无条目无命中时直接回答不足', async () => {
    const emptyProject = projects.create({
      name: '空项目',
      rootPath: null,
      description: null,
    });
    const fake = new FakeProvider();
    const asker = new AskService(db, fake);
    const result = await asker.ask(emptyProject.id, '任何问题');
    expect(result.answer).toContain('资料不足');
    expect(fake.textCalls.length).toBe(0); // 不调用模型
  });
});
