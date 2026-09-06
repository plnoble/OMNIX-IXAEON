import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  Extractor,
  FakeProvider,
  sha256,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { LocalServer } from '../../src/main/server/localServer.js';

/**
 * 用户复核反馈的两个回归：
 * 1. 切回旧回答（分支切换，无新增文字）必须触发自动分析——不能
 *    「知道内容版本变了，却因 accepted=0 不开始处理」。
 * 2. 人工单独分配过项目的 AI 条目，重新提取时不得被删除——
 *    manual_project=1 与确认/不采纳同属人工决定保护。
 */

let dir: string;
let db: CoreDatabase;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
const servers: FastifyInstance[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-review-follow-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
  perms.grantDomain('chatgpt.com');
});

afterAll(async () => {
  for (const s of servers.splice(0)) await s.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 采集环境（真实 LocalServer + Fastify 路由 + onCaptured 计数）。 */
async function captureEnv(onCaptured: (sourceId: string) => void) {
  let config: AppConfig = {
    ...defaultAppConfig(),
    extension: { token: 'follow-token', pairedAt: new Date().toISOString() },
  };
  config.capture.enabled = true;
  config.capture.autoAnalyze = true;
  const server = new LocalServer({
    db,
    vault: new Vault(join(dir, 'vault')),
    permissions: perms,
    sources,
    getConfig: () => config,
    updateConfig: (m) => {
      config = m(config);
    },
    onCaptured: (sourceId) => onCaptured(sourceId),
  });
  const http = Fastify();
  servers.push(http);
  await server.register(http);
  await http.ready();
  const capture = (externalId: string, texts: string[], sessionId: string) =>
    http.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: {
        authorization: 'Bearer follow-token',
        origin: 'chrome-extension://follow',
      },
      payload: {
        conversation: { externalId, sessionId, title: 'Follow-up' },
        clientTimestamp: new Date().toISOString(),
        turns: texts.map((text, order) => ({
          order,
          role: order % 2 === 0 ? 'user' : 'assistant',
          text,
          contentHash: sha256(text),
        })),
      },
    });
  return { capture };
}

describe('反馈回归 1：切回旧回答必须触发自动分析', () => {
  it('分支切换（accepted=0，防抖窗口已过）后 onCaptured 被调用且版本递增', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const captured: string[] = [];
      const { capture } = await captureEnv((sourceId) => captured.push(sourceId));

      // 同一对话：A→B（两次批次），再切回 A（第三次批次，无新增文字）
      const a = await capture('/c/branch-switch-001', ['问题', '回答 A'], 's-branch-1');
      expect(a.statusCode).toBe(200);
      const sourceId = a.json().sourceId;
      const before = sources.getRevisions(sourceId);
      expect(captured.length).toBe(1); // 首批立即触发

      // 追加 B（新文字）—— 防抖窗口内：合并为待补分析（trailing 计时器）
      const b = await capture('/c/branch-switch-001', ['问题', '回答 B'], 's-branch-1');
      expect(b.statusCode).toBe(200);
      expect(sources.getRevisions(sourceId).content).toBe(before.content + 1);
      expect(captured.length).toBe(1); // 窗口内不重复入队

      // 推进虚拟时钟越过 60 秒防抖窗口：待补分析触发
      await vi.advanceTimersByTimeAsync(61_000);
      expect(captured.length).toBe(2);

      // 切回 A：同首批内容 → 旧指纹重新激活、accepted=0、分支切换。
      // 窗口内变更 → trailing 补分析已安排（知道内容变了就开始排队）
      const switchBack = await capture('/c/branch-switch-001', ['问题', '回答 A'], 's-branch-1');
      expect(switchBack.statusCode).toBe(200);
      const body = switchBack.json() as { accepted: number; deduplicated: number };
      expect(body.accepted).toBe(0); // 没有新增文字
      expect(sources.getRevisions(sourceId).content).toBe(before.content + 2); // 版本递增
      // 修复核心断言：分支切换安排的补分析在窗口结束后必然触发
      //（修复前：accepted=0 直接 return，永远不排队）
      await vi.advanceTimersByTimeAsync(61_000);
      expect(captured.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('反馈回归 2：人工分配项目的条目不被重提删除', () => {
  it('manual_project=1 的 AI 条目在重新提取后保留', async () => {
    const projectA = projects.create({
      name: `反馈2-${Math.random().toString(36).slice(2)}`,
      rootPath: null,
      description: null,
    });
    const file = join(dir, `fb2-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, '# 反馈2\n\nREBUILD_KEEP_MARK 内容。\n', 'utf8');
    const created = imports.importFile(file, {
      projectId: projectA.id,
      permissionId: perms.grantFile(file).id,
    }).created[0]!;

    // 首轮提取一条 AI 条目
    const fake1 = new FakeProvider('fb2-v1');
    fake1.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '反馈2待保护结论',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: 'REBUILD_KEEP_MARK',
        },
      ],
    });
    await new Extractor(db, fake1).extractSource(created.id);
    const item = db
      .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
      .get(created.id) as { id: string };

    // 用户对该条目单独分配项目（走生产的 assignToProject：置 manual_project=1）
    const { ItemService } = await import('@ixaeon/core');
    new ItemService(db).assignToProject(item.id, projectA.id);

    // 重新提取：deleteOld 必须排除 manual_project=1
    const fake2 = new FakeProvider('fb2-v2');
    fake2.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '反馈2新结论（重提后）',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: 'REBUILD_KEEP_MARK',
        },
      ],
    });
    await new Extractor(db, fake2).extractSource(created.id);

    const survived = db
      .prepare('SELECT project_id, manual_project FROM items WHERE id = ?')
      .get(item.id) as { project_id: string | null; manual_project: number };
    expect(survived).toEqual({ project_id: projectA.id, manual_project: 1 });
  });
});
