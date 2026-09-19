/**
 * P3 验收（v2 规格：执行方按规格条件写成测试；本单 B 档先只交测试）：
 * docs/委派/P3-项目进展简报.md
 *
 * 条件 1：有 project_snapshot + 14 天内提交 + 编码代理会话 + 编码任务时，
 *          派给 Hermes 的 prompt.submit 带上近况；20 天前的提交不在。
 * 条件 2：同一项目没有 project_snapshot：没有提交那块，会话和任务照带。
 * 条件 3：没选项目：没有项目近况。
 * 条件 4：整段超过 2000 字时按「提交 → 会话 → 任务」的顺序截，每块从末尾（最旧的）截起，截后 ≤2000；
 *   计数是实际带上的条数（整合方 2026-09-19 复审时补：原测试只断言了 ≤2000）。
 * 条件 5：目录不是 git 仓库、或 git 超时：跳过提交那块，不报错。
 * 条件 6 的计数：回答带 meta.projectBrief；界面在 p3-brief-line.test.ts。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import {
  AgentSession,
  CodingOrchestrator,
  CodingTaskStore,
  CoreToolBroker,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  ItemService,
  JsonRpcStdio,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  migrate,
  openDatabase,
  type CoreDatabase,
  type TuiTransport,
} from '../../src/index.js';

const previousExe = process.env.IXAEON_HERMES_EXE;
const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) {
    // Windows 上 git 有时还占着临时仓库里的文件（EPERM）。清理失败不该让测试挂掉：
    // 重试几次，还不行就留给系统清（整合方 2026-09-20：门禁上真的挂过一次）。
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* 留给系统清 */
    }
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'P3',
      GIT_AUTHOR_EMAIL: 'p3@example.invalid',
      GIT_COMMITTER_NAME: 'P3',
      GIT_COMMITTER_EMAIL: 'p3@example.invalid',
      ...env,
    },
    stdio: 'pipe',
  });
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'P3']);
  git(repo, ['config', 'user.email', 'p3@example.invalid']);
}

function commitAt(repo: string, file: string, message: string, when: string): void {
  writeFileSync(join(repo, file), message, 'utf8');
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
}

function insertSource(
  store: SourceStore,
  permId: string,
  input: {
    kind: 'conversation' | 'project_snapshot';
    provider: 'coding_agent' | 'project';
    title: string;
    projectId: string | null;
    capturedAt: string;
    segments: Array<{ role: 'user' | 'assistant' | 'document'; text: string }>;
  },
) {
  return store.insertParsed(
    {
      kind: input.kind,
      provider: input.provider,
      accountNamespace: 'local',
      externalId: randomUUID(),
      title: input.title,
      contentHash: randomUUID().replace(/-/g, '').slice(0, 64).padEnd(64, 'a'),
      capturedAt: input.capturedAt,
      importMethod: input.kind === 'project_snapshot' ? 'project_snapshot' : 'history_export',
      segments: input.segments.map((s, i) => ({
        sequence: i,
        role: s.role,
        externalNodeId: null,
        externalParentId: null,
        isActiveBranch: true,
        occurredAt: input.capturedAt,
        text: s.text,
        metadata: {},
      })),
      metadata: {},
    },
    { permissionId: permId, projectId: input.projectId, rawPath: 'sha256/aa/' + 'a'.repeat(64) },
  );
}

async function waitFor(
  outbound: string[],
  method: string,
): Promise<{ id?: number; params?: { text?: string } }> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const hit = outbound
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; method?: string; params?: { text?: string } })
      .find((m) => m.method === method);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`没等到 ${method}`);
}

async function hermesPrompt(input: {
  dir: string;
  projectId: string | null;
  goal: string;
}): Promise<{
  text: string;
  result: { meta?: { projectBrief?: unknown }; projectBrief?: unknown };
}> {
  const exe = join(tempDir('ixa-p3-exe-'), 'hermes.exe');
  writeFileSync(exe, 'fake');
  chmodSync(exe, 0o755);
  process.env.IXAEON_HERMES_EXE = exe;
  const spawns: Array<{ hostIn: PassThrough; outbound: string[] }> = [];
  const factory = () => {
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (chunk: Buffer | string) => outbound.push(String(chunk)));
    spawns.push({ hostIn, outbound });
    return {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    } as TuiTransport;
  };
  const broker = new CoreToolBroker(
    db!,
    new ItemService(db!),
    new SearchService(db!),
    new CodingOrchestrator(db!, new FakeCodingExecutor(), input.dir),
    new ProjectService(db!),
  );
  const adapter = new HermesRuntimeAdapter(broker, factory as never, () => ({
    chatModel: null,
    bridgeToken: null,
  }));
  const session = new AgentSession(db!, adapter, broker, new FakeProvider('p3'), {
    mcpBridgedTools: [],
  });
  const pending = session.run({ goal: input.goal, projectId: input.projectId });
  const start = Date.now();
  while (spawns.length === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const s = spawns[0]!;
  const create = await waitFor(s.outbound, 'session.create');
  s.hostIn.write(
    JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's-p3' } }) + '\n',
  );
  const submit = await waitFor(s.outbound, 'prompt.submit');
  s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
  s.hostIn.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'message.complete',
        session_id: 's-p3',
        payload: { text: '好', status: 'complete' },
      },
    }) + '\n',
  );
  const result = await pending;
  adapter.disposeAll();
  return { text: submit.params?.text ?? '', result };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, '');
}

function seedProject(opts: { withSnapshot: boolean; withGit: boolean; long?: boolean }) {
  const dir = tempDir('ixa-p3-');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const repo = join(dir, 'repo');
  if (opts.withGit) {
    initRepo(repo);
    commitAt(repo, 'old.txt', '二十天前的提交不该出现', daysAgoIso(20));
    commitAt(repo, 'new.txt', '修好导入乱码', daysAgoIso(2));
    commitAt(repo, 'new2.txt', '补上重试', daysAgoIso(1));
    if (opts.long) {
      for (let i = 0; i < 18; i++) {
        commitAt(repo, `pad-${i}.txt`, `近期提交填充 ${i} ${'字'.repeat(80)}`, daysAgoIso(1));
      }
    }
  } else {
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '合成项目', 'utf8');
  }
  const project = new ProjectService(db).create({
    name: 'P3 合成项目',
    rootPath: repo,
    description: null,
  });
  const perm = new PermissionService(db).grantFolder(repo);
  const sources = new SourceStore(db);
  if (opts.withSnapshot) {
    insertSource(sources, perm.id, {
      kind: 'project_snapshot',
      provider: 'project',
      title: '目录快照',
      projectId: project.id,
      capturedAt: '2026-09-18T00:00:00.000Z',
      segments: [{ role: 'document', text: 'README' }],
    });
  }
  insertSource(sources, perm.id, {
    kind: 'conversation',
    provider: 'coding_agent',
    title: '修导入乱码',
    projectId: project.id,
    capturedAt: '2026-09-18T10:00:00.000Z',
    segments: [
      { role: 'user', text: '帮我把导入时的乱码修一下' },
      { role: 'assistant', text: '改好了。' },
      { role: 'user', text: '再把测试跑一下' },
    ],
  });
  insertSource(sources, perm.id, {
    kind: 'conversation',
    provider: 'coding_agent',
    title: '补重试',
    projectId: project.id,
    capturedAt: '2026-09-19T08:00:00.000Z',
    segments: [
      { role: 'user', text: '把重试逻辑补上去重' },
      { role: 'assistant', text: '已经补好。' },
    ],
  });
  if (opts.long) {
    for (let i = 0; i < 3; i++) {
      insertSource(sources, perm.id, {
        kind: 'conversation',
        provider: 'coding_agent',
        title: `长会话 ${i} ${'标'.repeat(40)}`,
        projectId: project.id,
        capturedAt: `2026-09-19T09:0${i}:00.000Z`,
        segments: [{ role: 'user', text: `最后一句用户的话 ${i} ${'话'.repeat(80)}` }],
      });
    }
  }
  const tasks = new CodingTaskStore(db);
  const t1 = tasks.create({
    projectId: project.id,
    goal: '把验收测试补上\n第二行不该当标题',
    scope: ['a.txt'],
    allowedCommands: [['node', '-e', 'process.exit(0)']],
  });
  tasks.setStatus(t1.id, 'queued');
  const t2 = tasks.create({
    projectId: project.id,
    goal: '写交付说明',
    scope: ['b.txt'],
    allowedCommands: [['node', '-e', 'process.exit(0)']],
  });
  tasks.setStatus(t2.id, 'running');
  if (opts.long) {
    for (let i = 0; i < 3; i++) {
      tasks.create({
        projectId: project.id,
        goal: `长任务 ${i} ${'标'.repeat(80)}`,
        scope: [`t${i}.txt`],
        allowedCommands: [['node', '-e', 'process.exit(0)']],
      });
    }
  }
  return { dir, project, repo };
}

it('条件 1：有快照时 Hermes 带上 14 天内提交、会话标题和最后一句、任务中文状态；20 天前的提交不在', async () => {
  const { dir, project } = seedProject({ withSnapshot: true, withGit: true });
  const { text, result } = await hermesPrompt({
    dir,
    projectId: project.id,
    goal: '这个项目做到哪了？',
  });
  expect(text).toContain('修好导入乱码');
  expect(text).toContain('补上重试');
  expect(text).not.toContain('二十天前的提交不该出现');
  expect(text).toContain('修导入乱码');
  expect(text).toContain('再把测试跑一下');
  expect(text).toContain('补重试');
  expect(text).toContain('把重试逻辑补上去重');
  expect(text).toContain('把验收测试补上');
  expect(text).toContain('排队中');
  expect(text).toContain('进行中');
  expect(text).not.toContain('queued');
  expect(text).not.toContain('running');
  const counts =
    (result as { projectBrief?: { commits: number; sessions: number; tasks: number } })
      .projectBrief ??
    (result as { meta?: { projectBrief?: { commits: number; sessions: number; tasks: number } } })
      .meta?.projectBrief;
  expect(counts).toMatchObject({ commits: 2, sessions: 2, tasks: 2 });
});

it('条件 2：没有 project_snapshot 时不带提交，会话和任务照带', async () => {
  const { dir, project } = seedProject({ withSnapshot: false, withGit: true });
  const { text } = await hermesPrompt({ dir, projectId: project.id, goal: '做到哪了？' });
  expect(text).not.toContain('修好导入乱码');
  expect(text).not.toContain('补上重试');
  expect(text).toContain('修导入乱码');
  expect(text).toContain('把验收测试补上');
});

it('条件 3：没选项目时没有项目近况', async () => {
  const { dir } = seedProject({ withSnapshot: true, withGit: true });
  const { text, result } = await hermesPrompt({ dir, projectId: null, goal: '做到哪了？' });
  expect(text).not.toContain('修好导入乱码');
  expect(text).not.toContain('修导入乱码');
  expect(text).not.toContain('把验收测试补上');
  expect(
    (result as { projectBrief?: unknown }).projectBrief ??
      (result as { meta?: { projectBrief?: unknown } }).meta?.projectBrief,
  ).toBeUndefined();
});

it('条件 4：超过 2000 字时先截提交（从最旧的截起），会话和任务保住；截后不超过 2000，计数与实际带上的一致', async () => {
  const { project } = seedProject({ withSnapshot: true, withGit: true, long: true });
  const { buildProjectBrief } = (await import('../../src/index.js')) as {
    buildProjectBrief: (
      database: CoreDatabase,
      projectId: string,
    ) => { block: string; counts: { commits: number; sessions: number; tasks: number } };
  };
  const brief = buildProjectBrief(db!, project.id);
  expect(brief.block.length).toBeGreaterThan(0);
  expect(brief.block.length).toBeLessThanOrEqual(2000);
  // 会话、任务一个不少（整合方复审时补：原测试只断言了不超过 2000）
  for (const s of ['修导入乱码', '补重试', '长会话 0', '长会话 1', '长会话 2']) {
    expect(brief.block).toContain(s);
  }
  for (const t of ['把验收测试补上', '写交付说明', '长任务 0', '长任务 1', '长任务 2']) {
    expect(brief.block).toContain(t);
  }
  expect(brief.counts.sessions).toBe(5);
  expect(brief.counts.tasks).toBe(5);
  // 提交被截了：14 天内有 20 条，留下的是最新的那些，最旧的先被截掉
  expect(brief.counts.commits).toBeGreaterThan(0);
  expect(brief.counts.commits).toBeLessThan(20);
  expect(brief.block).toContain('近期提交填充 17');
  expect(brief.block).not.toContain('修好导入乱码');
  // 计数就是实际带上的提交条数
  const commitLines = brief.block.match(/近期提交填充 \d+|补上重试|修好导入乱码/g) ?? [];
  expect(commitLines).toHaveLength(brief.counts.commits);
});

it('条件 5：不是 git 仓库时跳过提交那块，不报错；git 超时同样跳过', async () => {
  const { project } = seedProject({ withSnapshot: true, withGit: false });
  const mod = (await import('../../src/index.js')) as {
    buildProjectBrief: (
      database: CoreDatabase,
      projectId: string,
      opts?: { runGit?: () => string },
    ) => { block: string; counts: { commits: number; sessions: number; tasks: number } };
  };
  const noGit = mod.buildProjectBrief(db!, project.id);
  expect(noGit.counts.commits).toBe(0);
  expect(noGit.block).toContain('修导入乱码');
  expect(noGit.block).toContain('把验收测试补上');

  const { project: timed } = seedProject({ withSnapshot: true, withGit: true });
  const timedOut = mod.buildProjectBrief(db!, timed.id, {
    runGit: () => {
      const err = new Error('ETIMEDOUT') as Error & { code: string };
      err.code = 'ETIMEDOUT';
      throw err;
    },
  });
  expect(timedOut.counts.commits).toBe(0);
  expect(timedOut.block).toContain('修导入乱码');
});
