/**
 * G02 验收（规格 docs/委派/G02-项目简报尊重授权撤销.md）
 *
 * 条件 1：两个编码代理会话来源，撤销其中一个的授权 → 简报里没有它的标题和
 *         最后一句话，另一个照常；counts.sessions 为 1。
 * 条件 2：撤销 project_snapshot 来源的授权 → 不跑 git（替身调用 0 次），
 *         简报里没有提交块；会话、任务照常。
 * 条件 3：项目根目录改到快照授权范围之外 → 不跑 git。
 * 条件 4：授权都有效 → 和 P3 原来的行为一致：跑 git，提交、会话、任务都在。
 *
 * 直接测 buildProjectBrief（git 用注入的替身计数），不启动 Hermes。
 *
 * 整合方复审时补（2026-09-24）：根目录在快照授权的文件夹之内（子目录）照样跑 git——
 * 「覆盖」是 isPathInside(授权路径, 根目录)，不是两者相等；只写条件 3 的话，
 * 按「路径相等」实现也能过，授权了上级文件夹的项目就悄悄没了提交块（P3 退化）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  CodingTaskStore,
  PermissionService,
  ProjectService,
  SourceStore,
  buildProjectBrief,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 一个项目 + 快照来源 + 两个编码代理会话来源 + 一条编码任务，各自独立授权。 */
function seed() {
  const dir = tempDir('ixa-g02-');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const root = tempDir('ixa-g02-root-');
  const projects = new ProjectService(db);
  const project = projects.create({ name: '合成项目', rootPath: root, description: null });
  const perms = new PermissionService(db);
  const snapshotPerm = perms.grantFolder(root);
  const sessionPermA = perms.grantFile(join(root, 'session-a.jsonl'));
  const sessionPermB = perms.grantFile(join(root, 'session-b.jsonl'));
  const store = new SourceStore(db);
  const insert = (
    permId: string,
    input: {
      kind: 'conversation' | 'project_snapshot';
      provider: 'coding_agent' | 'project';
      title: string;
      segments: Array<{ role: 'user' | 'assistant' | 'document'; text: string }>;
    },
  ) =>
    store.insertParsed(
      {
        kind: input.kind,
        provider: input.provider,
        accountNamespace: 'local',
        externalId: randomUUID(),
        title: input.title,
        contentHash: randomUUID().replace(/-/g, '').slice(0, 64).padEnd(64, 'a'),
        capturedAt: '2026-09-20T08:00:00.000Z',
        importMethod: input.kind === 'project_snapshot' ? 'project_snapshot' : 'history_export',
        segments: input.segments.map((s, i) => ({
          sequence: i,
          role: s.role,
          externalNodeId: null,
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: '2026-09-20T08:00:00.000Z',
          text: s.text,
          metadata: {},
        })),
        metadata: {},
      },
      { permissionId: permId, projectId: project.id, rawPath: 'sha256/aa/' + 'a'.repeat(64) },
    );
  insert(snapshotPerm.id, {
    kind: 'project_snapshot',
    provider: 'project',
    title: '快照',
    segments: [{ role: 'document', text: '目录快照' }],
  });
  insert(sessionPermA.id, {
    kind: 'conversation',
    provider: 'coding_agent',
    title: '会话甲',
    segments: [{ role: 'user', text: '会话甲的最后一句' }],
  });
  insert(sessionPermB.id, {
    kind: 'conversation',
    provider: 'coding_agent',
    title: '会话乙',
    segments: [{ role: 'user', text: '会话乙的最后一句' }],
  });
  const tasks = new CodingTaskStore(db);
  const task = tasks.create({
    projectId: project.id,
    goal: '合成编码任务',
    scope: ['a.txt'],
    allowedCommands: [['node', '-e', 'process.exit(0)']],
  });
  tasks.setStatus(task.id, 'queued');
  return { db, root, project, perms, snapshotPerm, sessionPermA, sessionPermB };
}

function briefWith(database: CoreDatabase, projectId: string) {
  const calls: string[] = [];
  const brief = buildProjectBrief(database, projectId, {
    runGit: (r) => {
      calls.push(r);
      return 'abcdef1 合成提交：加了验收';
    },
  });
  return { brief, calls };
}

it('条件 4：授权都有效时和 P3 原来一致——跑 git，提交、会话、任务都在', () => {
  const { db: database, project } = seed();
  const { brief, calls } = briefWith(database, project.id);
  expect(calls).toHaveLength(1);
  expect(brief.block).toContain('最近的提交');
  expect(brief.block).toContain('abcdef1 合成提交：加了验收');
  expect(brief.block).toContain('会话甲');
  expect(brief.block).toContain('会话甲的最后一句');
  expect(brief.block).toContain('会话乙');
  expect(brief.block).toContain('合成编码任务');
  expect(brief.counts).toEqual({ commits: 1, sessions: 2, tasks: 1 });
});

it('条件 1：撤销一个编码代理会话来源的授权，简报不再取用它', () => {
  const { db: database, project, perms, sessionPermA } = seed();
  perms.revoke(sessionPermA.id);
  const { brief } = briefWith(database, project.id);
  expect(brief.block).not.toContain('会话甲');
  expect(brief.block).not.toContain('会话甲的最后一句');
  expect(brief.block).toContain('会话乙');
  expect(brief.block).toContain('会话乙的最后一句');
  expect(brief.counts.sessions).toBe(1);
});

it('条件 2：撤销快照来源的授权后不跑 git，没有提交块，会话和任务照常', () => {
  const { db: database, project, perms, snapshotPerm } = seed();
  perms.revoke(snapshotPerm.id);
  const { brief, calls } = briefWith(database, project.id);
  expect(calls).toHaveLength(0);
  expect(brief.block).not.toContain('最近的提交');
  expect(brief.block).not.toContain('合成提交');
  expect(brief.block).toContain('会话甲');
  expect(brief.block).toContain('会话乙');
  expect(brief.block).toContain('合成编码任务');
  expect(brief.counts).toEqual({ commits: 0, sessions: 2, tasks: 1 });
});

it('条件 3：项目根目录改到快照授权范围之外，不跑 git', () => {
  const { db: database, project } = seed();
  const outside = tempDir('ixa-g02-outside-');
  database.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(outside, project.id);
  const { brief, calls } = briefWith(database, project.id);
  expect(calls).toHaveLength(0);
  expect(brief.block).not.toContain('最近的提交');
  expect(brief.block).toContain('会话甲');
  expect(brief.counts.sessions).toBe(2);
});

it('整合方补：根目录是快照授权文件夹里的子目录，照样跑 git', () => {
  const { db: database, root, project } = seed();
  const inner = join(root, 'packages', 'app');
  mkdirSync(inner, { recursive: true });
  database.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(inner, project.id);
  const { brief, calls } = briefWith(database, project.id);
  expect(calls).toEqual([inner]);
  expect(brief.block).toContain('abcdef1 合成提交：加了验收');
});
