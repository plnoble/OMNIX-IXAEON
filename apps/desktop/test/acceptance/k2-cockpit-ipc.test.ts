/**
 * K2 验收 条件 8（规格 docs/委派/K2-驾驶舱快照.md，B 档：先只推测试）。
 *
 * 条件 8：projects 按 status 分三组；IPC `getCockpitSnapshot` 返回和 `buildCockpitSnapshot`
 *         同样的内容（`generatedAt` 除外）。
 *
 * 做法：合成一个数据库（active / paused / archived 各一个项目）和一个 git 仓库的队列、
 * 一个合成 relay 目录；用测试固定的时间冻结 `Date`，让两次读取的 `readAt` 也是同一个时刻。
 * 直接调 `buildCockpitSnapshot` 一次，再按通道名取 `registerIpc` 注册的 `getCockpitSnapshot`
 * 调一次，两边除 `generatedAt` 外逐字段相等。
 *
 * 先测试后实现：`buildCockpitSnapshot` 现在还没有（B 档先只推测试）。这里从 `@ixaeon/core`
 * 具名导入，加了 `@ts-ignore` 只是让实现还不存在时 typecheck-acceptance 过得去；
 * 运行时拿不到函数就明确报「还没实现」，不是靠类型检查糊过去。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import {
  migrate,
  openDatabase,
  ProjectService,
  setSetting,
  type CoreDatabase,
} from '@ixaeon/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- 实现还没写；@ts-ignore 在实现写出来后也不报「多余指令」
// @ts-ignore 实现在 packages/core/src/cockpit/snapshot.ts，等整合方锁定测试之后才写（B 档先只推测试）
import { buildCockpitSnapshot } from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
  shell: {},
}));

interface SourceHealth {
  status: 'ok' | 'stale' | 'missing' | 'error';
  readAt: string;
  lastEventAt: string | null;
  note: string | null;
}

interface ProjectCard {
  id: string;
  name: string;
  status: string;
  description: string | null;
  currentState: string | null;
  updatedAt: string;
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

const NOW = new Date('2026-10-31T12:00:00+08:00');

let dir: string;
let db: CoreDatabase;
let relayDir: string;
let repo: string;
const savedRelayDir = process.env.IXAEON_RELAY_DIR;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 一个只有一行「已完成」的主表，够让 queue 来源读到东西。 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ixaeon-k2-ipc-repo-'));
  dirs.push(root);
  mkdirSync(join(root, 'docs', '委派'), { recursive: true });
  writeFileSync(
    join(root, 'docs', '委派', '队列.md'),
    [
      '# 委派队列（合成）',
      '',
      '## 可以领的',
      '',
      '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
      '| ---- | ---- | ------------ | ---- | ---- | ---- |',
      '| 138 | K1 合成行 | — | A | 无 | 已完成（2026-10-31） |',
      '',
      '',
    ].join('\n'),
    'utf8',
  );
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=K2 合成仓库',
    '-c',
    'user.email=k2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    '合成队列',
  ]);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

const dirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-k2-ipc-db-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);

  relayDir = mkdtempSync(join(tmpdir(), 'ixaeon-k2-ipc-relay-'));
  dirs.push(relayDir);
  writeFileSync(
    join(relayDir, 'lock.json'),
    `${JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() })}\n`,
    'utf8',
  );
  repo = makeRepo();
});

afterEach(() => {
  if (savedRelayDir === undefined) delete process.env.IXAEON_RELAY_DIR;
  else process.env.IXAEON_RELAY_DIR = savedRelayDir;
  try {
    if (db.open) db.close();
  } catch {
    /* 已关 */
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

/** 真 runtime 的 db（registerIpc 从这里取），按通道名调用注册好的处理函数。 */
function ipc() {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    const handler = entry[1] as (event: unknown) => Promise<T>;
    return handler({} as never);
  };
}

describe('K2 驾驶舱快照（projects 分组 + IPC，条件 8）', () => {
  it('projects 按 status 分三组，getCockpitSnapshot 与 buildCockpitSnapshot 内容一致（generatedAt 除外）', async () => {
    const projects = new ProjectService(db);
    const active = projects.create({
      name: 'K2-active',
      rootPath: null,
      description: '合成 active 项目',
      currentState: '正在做的事',
    });
    const paused = projects.create({
      name: 'K2-paused',
      rootPath: null,
      description: '合成 paused 项目',
    });
    projects.updateStatus(paused.id, 'paused');
    const archived = projects.create({
      name: 'K2-archived',
      rootPath: null,
      description: '合成 archived 项目',
    });
    projects.updateStatus(archived.id, 'archived');

    const directFn = buildCockpitSnapshot as unknown as BuildCockpitSnapshot | undefined;
    expect(
      typeof directFn,
      'buildCockpitSnapshot 还没实现：本任务是 B 档，先只推测试，实现等整合方锁定后写（见规格 K2）',
    ).toBe('function');

    // IPC 那条路按规格从环境变量取 relayDir、从设置项取 ixaeonRepo。冻结时间，好让两次读取的
    // readAt 相同（规格只允许 generatedAt 不同）。
    process.env.IXAEON_RELAY_DIR = relayDir;
    setSetting(db, 'cockpit.ixaeon_repo', repo);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const direct = directFn!(db, { relayDir, ixaeonRepo: repo, now: NOW });
      const call = ipc();
      const viaIpc = await call<CockpitSnapshot>('getCockpitSnapshot');

      // 分组：按 status 三组，各组的项目卡字段按库里那行给。
      expect(direct.projects.active.map((p) => p.name)).toEqual(['K2-active']);
      expect(direct.projects.paused.map((p) => p.name)).toEqual(['K2-paused']);
      expect(direct.projects.archived.map((p) => p.name)).toEqual(['K2-archived']);
      const card = direct.projects.active[0]!;
      expect(card.id).toBe(active.id);
      expect(card.status).toBe('active');
      expect(card.description).toBe('合成 active 项目');
      expect(card.currentState).toBe('正在做的事');
      expect(Number.isNaN(Date.parse(card.updatedAt))).toBe(false);
      expect(direct.sources.projects.status).not.toBe('missing');

      // 两张快照逐字段相等（只允许 generatedAt 不同）。
      const withoutGeneratedAt = (s: CockpitSnapshot) => ({ ...s, generatedAt: '' });
      expect(withoutGeneratedAt(viaIpc)).toEqual(withoutGeneratedAt(direct));
    } finally {
      vi.useRealTimers();
    }
  });
});