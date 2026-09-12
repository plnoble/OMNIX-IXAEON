import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  ProjectService,
  ItemService,
  ResearchChecker,
  CodingTaskStore,
  ArchiveService,
  Vault,
  PermissionService,
  SourceStore,
  ImportService,
  buildPersonalOverview,
  type CoreDatabase,
  type FetchDeps,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let items: ItemService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s6-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  projects = new ProjectService(db);
  items = new ItemService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function pages(map: Record<string, { body?: string; type?: string }>): FetchDeps {
  return {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (url) => {
      const hit = map[url.split('?')[0]!] ?? map[url];
      return new Response(hit?.body ?? '', {
        status: 200,
        headers: { 'content-type': hit?.type ?? 'text/html' },
      });
    },
  };
}

describe('A04 角色与观点', () => {
  it('全新库迁移版本为 16 或更新', () => {
    expect(currentMigrationVersion(db)).toBeGreaterThanOrEqual(16);
  });

  it('助手建议不能写成用户目标；研究发现 origin=research 且不进目标列表', async () => {
    expect(() =>
      items.createAssistantSuggestion({
        projectId: null,
        type: 'goal',
        statement: 'AI 替你决定去创业',
        rationale: null,
        scope: 'personal',
      }),
    ).toThrow(/不能直接写成用户目标/);

    const suggestion = items.createAssistantSuggestion({
      projectId: null,
      type: 'open_loop',
      statement: '可以考虑每周回顾一次',
      rationale: null,
      scope: 'personal',
    });
    expect(suggestion.origin).toBe('assistant_suggestion');
    expect(suggestion.confirmation).toBe('none');

    const userGoal = items.createManual({
      projectId: null,
      type: 'goal',
      statement: '我要写完个人内核',
      rationale: null,
      scope: 'personal',
    });
    expect(userGoal.origin).toBe('user');

    const checker = new ResearchChecker(
      db,
      { now: () => new Date('2026-09-09T12:00:00.000Z') },
      pages({
        'https://example.com/feed.xml': {
          body: `<rss><channel><item><title>外部新版本</title><link>https://example.com/r</link><description>publisher claim</description></item></channel></rss>`,
          type: 'application/rss+xml',
        },
      }),
    );
    expect(() =>
      checker.createTopic({
        question: '仓库发布了吗',
        publicDescription: '公开仓库发布页',
        relatedGoalId: suggestion.id,
        sources: [{ url: 'https://example.com/feed.xml', kind: 'feed' }],
      }),
    ).toThrow(/用户确认的目标/);

    const topic = checker.createTopic({
      question: '仓库发布了吗',
      publicDescription: '公开仓库发布页',
      relatedGoalId: userGoal.id,
      sources: [{ url: 'https://example.com/feed.xml', kind: 'feed' }],
    });
    await checker.checkNow(topic.id);
    const researchItems = db
      .prepare(`SELECT origin, type, statement FROM items WHERE origin = 'research'`)
      .all() as Array<{ origin: string; type: string; statement: string }>;
    expect(researchItems.length).toBeGreaterThan(0);
    expect(
      researchItems.every(
        (r) => r.origin === 'research' && r.type !== 'goal' && r.type !== 'preference',
      ),
    ).toBe(true);

    const overview = buildPersonalOverview(db);
    expect(overview.goals.some((g) => g.id === userGoal.id)).toBe(true);
    expect(overview.goals.some((g) => g.origin !== 'user')).toBe(false);
    expect(overview.goals.some((g) => g.id === suggestion.id)).toBe(false);
  });
});

describe('A11 研究与任务背景不泄露未分享个人资料', () => {
  it('公开描述不含私人语句；任务背景排除未分享 personal', () => {
    const secret = items.createManual({
      projectId: null,
      type: 'constraint',
      statement: '我的私人健康约束绝不外发XYZ',
      rationale: null,
      scope: 'personal',
    });
    const project = projects.create({ name: '公开项目', rootPath: null, description: null });
    const publicGoal = items.createManual({
      projectId: project.id,
      type: 'goal',
      statement: '公开项目目标',
      rationale: null,
    });

    const checker = new ResearchChecker(db);
    const topic = checker.createTopic({
      question: '公开仓库',
      publicDescription: '只描述公开主题',
      relatedProjectId: project.id,
      sources: [{ url: 'https://example.com/feed.xml', kind: 'feed' }],
    });
    expect(topic.public_description).not.toContain('私人健康');
    expect(topic.public_description).not.toContain('XYZ');

    const store = new CodingTaskStore(db);
    const task = store.create({
      projectId: project.id,
      goal: '写说明',
      scope: ['note.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    const bg = store.taskBackground(task);
    expect(bg.statements.join(' ')).toContain('公开项目目标');
    expect(bg.statements.join(' ')).not.toContain('私人健康约束绝不外发XYZ');
    void secret;
    void publicGoal;
  });
});

describe('A12 恢复不复用执行批准、不自动联网', () => {
  it('导出再恢复后研究关闭、编码批准作废', async () => {
    const vault = new Vault(join(dir, 'vault'));
    const perms = new PermissionService(db);
    const sources = new SourceStore(db);
    const imports = new ImportService(db, vault, perms, sources);
    const file = join(dir, 'seed.md');
    writeFileSync(file, '# seed\n', 'utf8');
    imports.importFile(file, { projectId: null, permissionId: perms.grantFile(file).id });

    const project = projects.create({ name: '恢复项目', rootPath: null, description: null });
    const store = new CodingTaskStore(db);
    const task = store.create({
      projectId: project.id,
      goal: '写文件',
      scope: ['a.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    store.prepareWorkspace(task.id, dir);
    store.approve({ taskId: task.id, workspacePath: store.get(task.id).workspace_path! });
    expect(store.get(task.id).approval_id).not.toBeNull();

    const checker = new ResearchChecker(db);
    const topic = checker.createTopic({
      question: '关注',
      publicDescription: '公开',
      sources: [{ url: 'https://example.com/feed.xml', kind: 'feed' }],
    });
    checker.store.setEnabled(topic.id, true);

    const archive = new ArchiveService(db, {
      dataDir: dir,
      dbPath: join(dir, 'ixaeon.db'),
      vault,
      closeCurrentDb: () => {
        db.close();
      },
    });
    const zipPath = join(dir, 's6.zip');
    await archive.exportData(zipPath);
    expect(existsSync(zipPath)).toBe(true);
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    expect(zip.file('data/coding-tasks.json')).toBeTruthy();
    expect(zip.file('data/runtime-runs.json')).toBeTruthy();
    expect(zip.file('data/skill-candidates.json')).toBeTruthy();

    await archive.restoreData(zipPath);
    db = openDatabase(join(dir, 'ixaeon.db'));
    const restoredTopic = db
      .prepare('SELECT enabled, paused FROM research_topics LIMIT 1')
      .get() as { enabled: number; paused: number };
    expect(restoredTopic.enabled).toBe(0);
    expect(restoredTopic.paused).toBe(1);
    const restoredTask = db
      .prepare('SELECT approval_id, status FROM coding_tasks LIMIT 1')
      .get() as { approval_id: string | null; status: string };
    expect(restoredTask.approval_id).toBeNull();
    const approvals = db.prepare('SELECT revoked_at FROM coding_approvals').all() as Array<{
      revoked_at: string | null;
    }>;
    expect(approvals.every((a) => a.revoked_at !== null)).toBe(true);
  });
});
