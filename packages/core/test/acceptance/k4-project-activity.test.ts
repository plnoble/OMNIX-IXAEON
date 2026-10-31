/**
 * K4 验收（项目最近活动）：规格 docs/委派/K4-额度与项目活动.md，B 档——先只推测试。
 *
 * 每个 it 对应规格「验收条件」里的一条：
 * 条件 7：合成 git 项目（有 `project_snapshot` 来源，7 天内 3 次提交、20 天前 1 次）→
 *         `commits7d` 是 3、`lastCommitAt` 是最近那次；没有登记读取的项目 `readable = false`，
 *         测试证明没跑 git。
 * 条件 9：授权被撤销（`permissions.status` 不是 `active`）的项目 → `readable = false`，没跑 git。
 *
 * 「有没有跑 git」不靠猜：测试把 GIT_TRACE 指到一个临时文件，构建快照时任何 git 子进程都会往里写；
 * 文件空 = 没跑。比「根目录不是 git 仓库、所以看不出」强，也不给实现加测试专用参数。
 *
 * 「能不能读」照 packages/core/src/runtime/projectBrief.ts 的判断（规格要求抽成一个函数两处共用）：
 * 有 project_snapshot 来源、对应授权 active、且项目的 root_path 在授权目录里面（含子目录）。
 *
 * 先测试后实现：`packages/core/src/cockpit/snapshot.ts` 现在没有 activity 那块，整合方锁定这些测试之后才写。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  migrate,
  openDatabase,
  PermissionService,
  ProjectService,
  SourceStore,
  type CoreDatabase,
} from '../../src/index.js';

type SourceStatus = 'ok' | 'stale' | 'missing' | 'error';

interface SourceHealth {
  status: SourceStatus;
  readAt: string;
  lastEventAt: string | null;
  note: string | null;
}

interface ProjectActivity {
  lastCommitAt: string | null;
  commits7d: number | null;
  readable: boolean;
}

interface ProjectCard {
  id: string;
  name: string;
  status: string;
  description: string | null;
  currentState: string | null;
  updatedAt: string;
  activity: ProjectActivity;
}

interface CockpitSnapshot {
  generatedAt: string;
  sources: { relay: SourceHealth; queue: SourceHealth; projects: SourceHealth };
  attention: Array<{ kind: string; text: string }>;
  running: Array<{ kind: string; text: string }>;
  projects: { active: ProjectCard[]; paused: ProjectCard[]; archived: ProjectCard[] };
  recent: Array<{ at: string; taskId: string | null; outcome: string; text: string }>;
  today: { finishedTurns: number };
}

type BuildCockpitSnapshot = (
  db: CoreDatabase,
  opts: { relayDir: string; ixaeonRepo: string; now?: Date },
) => CockpitSnapshot;

let buildSnapshot: BuildCockpitSnapshot | null = null;

beforeAll(async () => {
  try {
    // 实现写出来之前 ProjectCard 还没有 activity，先按测试契约转一次；写出来后类型就对上了。
    const mod = (await import('../../src/cockpit/snapshot.js')) as unknown as {
      buildCockpitSnapshot?: BuildCockpitSnapshot;
    };
    buildSnapshot =
      typeof mod.buildCockpitSnapshot === 'function' ? mod.buildCockpitSnapshot : null;
  } catch {
    buildSnapshot = null;
  }
});

function build(): BuildCockpitSnapshot {
  if (!buildSnapshot) {
    throw new Error(
      'buildCockpitSnapshot 还没实现：本任务是 B 档，先只推测试，实现等整合方锁定后写（见规格 K4）',
    );
  }
  return buildSnapshot;
}

/** 用真实的「现在」：git 的 `--since=7.days` 按它自己的时钟算，提交也按这个时钟往前推。 */
const NOW = new Date();

const dirs: string[] = [];
const dbs: CoreDatabase[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function freshDb(): CoreDatabase {
  const db = openDatabase(join(tempDir('ixaeon-k4-act-db-'), 'ixaeon.db'));
  migrate(db);
  dbs.push(db);
  return db;
}

function noRelayDir(): string {
  return join(tempDir('ixaeon-k4-act-relay-'), '根本没有这个目录');
}

function snapshotOf(db: CoreDatabase): CockpitSnapshot {
  return build()(db, { relayDir: noRelayDir(), ixaeonRepo: '', now: NOW });
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      if (db.open) db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows 上 git 有时还占着临时仓库里的文件，留给系统清 */
    }
  }
});

// ---------------------------------------------------------------------------
// 合成 git 仓库
// ---------------------------------------------------------------------------

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'K4',
      GIT_AUTHOR_EMAIL: 'k4@example.invalid',
      GIT_COMMITTER_NAME: 'K4',
      GIT_COMMITTER_EMAIL: 'k4@example.invalid',
      ...env,
    },
    stdio: 'ignore',
  });
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'K4']);
  git(repo, ['config', 'user.email', 'k4@example.invalid']);
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function commitAt(repo: string, file: string, message: string, when: string): void {
  writeFileSync(join(repo, file), message, 'utf8');
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
}

/** 7 天内 3 次（1、3、5 天前），再加一次 20 天前的。 */
function seedRepo(): string {
  const repo = tempDir('ixaeon-k4-act-repo-');
  initRepo(repo);
  commitAt(repo, 'old.txt', '20 天前的提交', daysAgo(20));
  commitAt(repo, 'a.txt', '5 天前', daysAgo(5));
  commitAt(repo, 'b.txt', '3 天前', daysAgo(3));
  commitAt(repo, 'c.txt', '1 天前', daysAgo(1));
  return repo;
}

function insertSnapshotSource(
  db: CoreDatabase,
  projectId: string,
  permissionId: string,
): void {
  new SourceStore(db).insertParsed(
    {
      kind: 'project_snapshot',
      provider: 'project',
      accountNamespace: 'local',
      externalId: randomUUID(),
      title: 'K4 合成目录快照',
      contentHash: randomUUID().replace(/-/g, '').slice(0, 64).padEnd(64, 'a'),
      capturedAt: new Date().toISOString(),
      importMethod: 'project_snapshot',
      segments: [
        {
          sequence: 0,
          role: 'document',
          externalNodeId: null,
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: new Date().toISOString(),
          text: '合成目录快照',
          metadata: {},
        },
      ],
      metadata: {},
    },
    { permissionId, projectId, rawPath: 'sha256/aa/' + 'a'.repeat(64) },
  );
}

/** 一个项目，连同目录读取登记的来源和授权；`revoked` 时把授权撤掉。 */
function seedProject(opts: {
  root: string;
  snapshot: 'active' | 'revoked' | 'none';
}): { db: CoreDatabase; projectId: string } {
  const db = freshDb();
  const project = new ProjectService(db).create({
    name: 'K4 合成项目',
    rootPath: opts.root,
    description: null,
  });
  if (opts.snapshot !== 'none') {
    const perms = new PermissionService(db);
    const perm = perms.grantFolder(opts.root);
    insertSnapshotSource(db, project.id, perm.id);
    if (opts.snapshot === 'revoked') perms.revoke(perm.id);
  }
  return { db, projectId: project.id };
}

// ---------------------------------------------------------------------------
// GIT_TRACE：证明「没跑 git」
// ---------------------------------------------------------------------------

function tracePath(): string {
  return join(tempDir('ixaeon-k4-trace-'), 'git-trace.log');
}

function withGitTrace<T>(file: string, fn: () => T): T {
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = file;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
}

function gitRan(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe('K4 项目最近活动（验收条件 7、9）', () => {
  it('条件 7：登记的 git 项目 → commits7d 3、lastCommitAt 最近一次；没登记的项目 readable=false 且没跑 git', () => {
    const repo = seedRepo();
    const oneDayAgo = daysAgo(1);

    const registered = seedProject({ root: repo, snapshot: 'active' });
    const registeredTrace = tracePath();
    const withActivity = withGitTrace(registeredTrace, () => snapshotOf(registered.db));
    const card = withActivity.projects.active[0]!;
    expect(card.activity.readable).toBe(true);
    expect(card.activity.commits7d).toBe(3);
    expect(card.activity.lastCommitAt).not.toBeNull();
    expect(Date.parse(card.activity.lastCommitAt!)).toBe(Date.parse(oneDayAgo));
    expect(gitRan(registeredTrace), '登记过的项目应该真跑了 git').toBe(true);

    // 同一个 git 仓库，但没登记读取：不跑 git（GIT_TRACE 空），也不给活动数字。
    const bare = seedProject({ root: repo, snapshot: 'none' });
    const bareTrace = tracePath();
    const without = withGitTrace(bareTrace, () => snapshotOf(bare.db));
    const bareCard = without.projects.active[0]!;
    expect(bareCard.activity).toEqual({ lastCommitAt: null, commits7d: null, readable: false });
    expect(gitRan(bareTrace), '没登记读取的项目不许跑 git').toBe(false);
  });

  it('条件 9：授权被撤销的项目 → readable=false，没跑 git', () => {
    const repo = seedRepo();
    const revoked = seedProject({ root: repo, snapshot: 'revoked' });
    const trace = tracePath();

    const snap = withGitTrace(trace, () => snapshotOf(revoked.db));
    const card = snap.projects.active[0]!;
    expect(card.activity).toEqual({ lastCommitAt: null, commits7d: null, readable: false });
    expect(gitRan(trace), '授权撤销之后不许跑 git').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 规格「要什么」写了「照 projectBrief 的判断」：补两处同一个判断的分支
// ---------------------------------------------------------------------------

describe('K4 项目最近活动（和 projectBrief 同一个判断）', () => {
  it('项目根目录在授权文件夹的子目录里 → 照样可读（不是要求路径相等）', () => {
    const repo = seedRepo();
    const inner = join(repo, 'packages', 'app');
    mkdirSync(inner, { recursive: true });
    const { db } = seedProject({ root: repo, snapshot: 'active' });
    db.prepare('UPDATE projects SET root_path = ? WHERE name = ?').run(inner, 'K4 合成项目');

    const trace = tracePath();
    const snap = withGitTrace(trace, () => snapshotOf(db));
    const card = snap.projects.active[0]!;
    expect(card.activity.readable).toBe(true);
    expect(card.activity.commits7d).toBe(3);
    expect(gitRan(trace)).toBe(true);
  });

  it('项目根目录跑到授权范围外 → readable=false，没跑 git', () => {
    const repo = seedRepo();
    const outside = tempDir('ixaeon-k4-outside-');
    mkdirSync(outside, { recursive: true });
    const { db } = seedProject({ root: repo, snapshot: 'active' });
    db.prepare('UPDATE projects SET root_path = ? WHERE name = ?').run(outside, 'K4 合成项目');

    const trace = tracePath();
    const snap = withGitTrace(trace, () => snapshotOf(db));
    const card = snap.projects.active[0]!;
    expect(card.activity).toEqual({ lastCommitAt: null, commits7d: null, readable: false });
    expect(gitRan(trace)).toBe(false);
  });

  it('7 天内没有提交 → commits7d 是 0，lastCommitAt 仍是最后一次（20 天前）', () => {
    const repo = tempDir('ixaeon-k4-quiet-repo-');
    initRepo(repo);
    commitAt(repo, 'old1.txt', '30 天前', daysAgo(30));
    commitAt(repo, 'old2.txt', '20 天前', daysAgo(20));
    const { db } = seedProject({ root: repo, snapshot: 'active' });

    const snap = snapshotOf(db);
    const card = snap.projects.active[0]!;
    expect(card.activity.readable).toBe(true);
    expect(card.activity.commits7d).toBe(0);
    expect(card.activity.lastCommitAt).not.toBeNull();
    expect(Date.parse(card.activity.lastCommitAt!)).toBe(Date.parse(daysAgo(20)));
  });
});

// ---------------------------------------------------------------------------
// 规格「约束」：任何读取失败都只记 error，不抛错（git 不是仓库 / 目录没了）
// ---------------------------------------------------------------------------

describe('K4 项目最近活动（读不了也不抛错）', () => {
  it('登记过但根目录不是 git 仓库 → readable 照判断，活动数字为空，快照照常返回', () => {
    const notRepo = tempDir('ixaeon-k4-notrepo-');
    writeFileSync(join(notRepo, 'README.md'), '合成目录', 'utf8');
    const { db } = seedProject({ root: notRepo, snapshot: 'active' });

    const snap = snapshotOf(db);
    const card = snap.projects.active[0]!;
    expect(card.activity.readable).toBe(true);
    expect(card.activity.commits7d).toBeNull();
    expect(card.activity.lastCommitAt).toBeNull();
    expect(snap.sources.projects.status).toBe('ok');
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });
});