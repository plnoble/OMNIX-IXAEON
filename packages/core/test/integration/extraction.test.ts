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
  it('提取：有效 segment_ref 入库 + 无依据的跳过 + prompt_version 记录', async () => {
    const doc = fixturePath('files', 'project-notes.md');
    const result = imports.importFile(doc, {
      projectId: null,
      allowedPaths: [doc],
    });
    const source = result.created[0]!;

    const fake = new FakeProvider('fake-m2');
    // 回应：一条带有效 segment_ref（S1 = 第一个片段）、一条无效 ref
    fake.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '项目名定为 IXAEON（析衍）',
          rationale: '文档明确命名',
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: 'IXAEON 析衍',
        },
        {
          type: 'goal',
          statement: '坏引用条目',
          rationale: null,
          confidence: 0.8,
          segment_ref: 'S99',
          project_hint: null,
          excerpt: '不存在',
        },
      ],
    });
    const extractor = new Extractor(db, fake);
    const stats = await extractor.extractSource(source.id);

    expect(stats.inserted).toBe(1);
    expect(stats.skippedBadRef).toBe(1);
    expect(stats.needsReview).toBe(1); // project_id null → 待讨论

    const inserted = items.list({ projectId: null, state: 'current' });
    const found = inserted.find((i) => i.statement.includes('IXAEON'));
    expect(found).toBeDefined();
    expect(found?.origin).toBe('ai');
    expect(found?.prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    expect(found?.model_name).toBe('fake-m2');

    // 依据必须指向真实片段（S1 = sequence 0）
    const evidence = items.getEvidence(found!.id);
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.segment.sequence).toBe(0);
  });

  it('提示词声明防注入（数据非指令）', async () => {
    const fake = new FakeProvider();
    const extractor = new Extractor(db, fake);
    const doc = fixturePath('files', 'prompt-injection.md');
    const result = imports.importFile(doc, { projectId: null, allowedPaths: [doc] });
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
      allowedPaths: [doc],
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
          excerpt: '下周发布',
        },
      ],
    });
    const extractor = new Extractor(db, fake);
    await extractor.extractSource(source.id);

    const projItems = items.list({ projectId: project.id });
    expect(projItems.some((i) => i.statement === '会议决定下周发布')).toBe(true);
    expect(projItems.every((i) => !i.needs_review)).toBe(true);
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
      allowedPaths: [docFile],
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

    // 归属项目后退出收件箱
    items.assignToProject(a.id, project.id);
    expect(items.get(a.id).project_id).toBe(project.id);
    expect(items.get(a.id).needs_review).toBe(false);

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
