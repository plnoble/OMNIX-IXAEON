/**
 * P3 真机检查：临时库 + 合成项目（临时 git 仓库、合成提交、合成会话与任务），
 * 用本机的真 Hermes 问「这个项目做到哪了？」「接下来该做什么？」。
 * 问题与数据全是合成的；不碰用户的数据目录；用掉少量模型额度。
 *   node_modules/.bin/jiti scripts/real/p3-hermes-brief.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentSession,
  CodingOrchestrator,
  CodingTaskStore,
  CoreToolBroker,
  FakeCodingExecutor,
  HermesRuntimeAdapter,
  ItemService,
  ProjectService,
  SearchService,
  SourceStore,
  PermissionService,
  locateHermes,
  migrate,
  openDatabase,
} from '../../packages/core/src/index.js';

if (!locateHermes().found) {
  console.error('本机没找到 IXAEON 专属的 Hermes 安装，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'ixaeon-p3-real-'));
const db = openDatabase(join(dir, 'ixaeon.db'));
migrate(db);
const repo = join(dir, 'repo');
mkdirSync(repo, { recursive: true });
const git = (args: string[], env: NodeJS.ProcessEnv = {}) =>
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
git(['init']);
const commit = (file: string, msg: string, when: string) => {
  writeFileSync(join(repo, file), msg, 'utf8');
  git(['add', file]);
  git(['commit', '-m', msg], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
};
commit('a.txt', '搭好骨架', '2026-09-17T03:00:00');
commit('b.txt', '修好导入乱码', '2026-09-18T03:00:00');
commit('c.txt', '补上重试', '2026-09-19T03:00:00');
const project = new ProjectService(db).create({
  name: 'P3 合成项目',
  rootPath: repo,
  description: null,
});
const perm = new PermissionService(db).grantFolder(repo);
const sources = new SourceStore(db);
const insert = (
  kind: 'conversation' | 'project_snapshot',
  title: string,
  segments: Array<{ role: 'user' | 'assistant' | 'document'; text: string }>,
) =>
  sources.insertParsed(
    {
      kind,
      provider: kind === 'project_snapshot' ? 'project' : 'coding_agent',
      accountNamespace: 'local',
      externalId: randomUUID(),
      title,
      contentHash: randomUUID().replace(/-/g, '').slice(0, 64).padEnd(64, 'a'),
      capturedAt: new Date().toISOString(),
      importMethod: kind === 'project_snapshot' ? 'project_snapshot' : 'history_export',
      segments: segments.map((s, i) => ({
        sequence: i,
        role: s.role,
        externalNodeId: null,
        externalParentId: null,
        isActiveBranch: true,
        occurredAt: new Date().toISOString(),
        text: s.text,
        metadata: {},
      })),
      metadata: {},
    },
    { permissionId: perm.id, projectId: project.id, rawPath: 'sha256/aa/' + 'a'.repeat(64) },
  );
insert('project_snapshot', '目录快照', [{ role: 'document', text: 'README' }]);
insert('conversation', '修导入乱码', [
  { role: 'user', text: '帮我把导入时的乱码修一下' },
  { role: 'assistant', text: '改好了。' },
  { role: 'user', text: '再把测试跑一下' },
]);
const tasks = new CodingTaskStore(db);
const queued = tasks.create({
  projectId: project.id,
  goal: '把验收测试补上',
  scope: ['a.txt'],
  allowedCommands: [['node', '-e', 'process.exit(0)']],
});
tasks.setStatus(queued.id, 'queued');
tasks.create({
  projectId: project.id,
  goal: '写交付说明',
  scope: ['b.txt'],
  allowedCommands: [['node', '-e', 'process.exit(0)']],
});

const broker = new CoreToolBroker(
  db,
  new ItemService(db),
  new SearchService(db),
  new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
  new ProjectService(db),
);
const adapter = new HermesRuntimeAdapter(broker);
const session = new AgentSession(db, adapter, broker, null, { mcpBridgedTools: [] });
for (const q of ['这个项目做到哪了？', '接下来该做什么？']) {
  const t0 = Date.now();
  try {
    const r = await session.run({ goal: q, projectId: project.id });
    console.log(`\n=== 问：${q}｜引擎 ${r.engine}｜${Math.round((Date.now() - t0) / 1000)} 秒`);
    console.log('带上近况：', JSON.stringify(r.projectBrief ?? null));
    console.log('--- 回答：');
    console.log(r.answer);
  } catch (err) {
    console.log(`\n=== 问：${q}｜失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
adapter.disposeAll();
db.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
