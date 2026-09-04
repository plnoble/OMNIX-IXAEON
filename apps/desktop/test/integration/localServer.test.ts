import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  type CoreDatabase,
} from '@ixaeon/core';
import { LocalServer } from '../../src/main/server/localServer.js';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';

/**
 * P1-6 修复回归：采集闭环。
 * - autoAnalyze=false：采集成功、原文落库、模型调用 0 次
 * - autoAnalyze=true：采集后出现提取回调；重复批次不重复回调（防抖去重）
 * - 暂停对话 A 后 A 被拒（403 DISABLED）；对话 B 仍可提交
 * - 新对话 page:<hash> → 正式 /c/<id>：合并后只有一个来源，内容不丢
 * - 回答重新生成：旧版 is_active_branch=0，新版=1
 * - 每次成功追加刷新 imported_at（最近同步时间）
 */

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let perms: PermissionService;
let sources: SourceStore;
let app: FastifyInstance;
let config: AppConfig;

/** onCaptured 回调记录（模拟 AppRuntime 提取入队）。 */
let capturedEvents: Array<{ sourceId: string; accepted: number }> = [];
let extensionToken: string;
let localToken: string;

const EXTENSION_ORIGIN = 'chrome-extension://abc123';

function headers(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    origin: EXTENSION_ORIGIN,
  };
}

/** 直接注入配对（绕过一次性码，测试聚焦采集行为本身）。 */
async function pairDirect(): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/extension/pair',
    payload: { code: '000000' },
  });
  expect(res.statusCode).toBe(401); // 无未配对码：无效（预期路径）

  // 通过配置直接发令牌 + 域授权（等价于配对成功后的状态）
  const token = 'ext-token-'.padEnd(64, '0');
  config = {
    ...config,
    extension: { token, pairedAt: new Date().toISOString() },
  };
  perms.grantDomain('chatgpt.com');
  extensionToken = token;
}

function capturePayload(
  externalId: string,
  turns: Array<{ order: number; role: 'user' | 'assistant'; text: string }>,
): {
  conversation: { externalId: string; title: string };
  turns: Array<{ order: number; role: string; text: string; contentHash: string }>;
  clientTimestamp: string;
} {
  return {
    conversation: { externalId, title: '测试对话' },
    turns: turns.map((t) => ({
      order: t.order,
      role: t.role,
      text: t.text,
      contentHash: '0'.repeat(64),
    })),
    clientTimestamp: new Date().toISOString(),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-local-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  new ProjectService(db); // 触发表结构
  config = { ...defaultAppConfig(), localToken: 'local-token-'.padEnd(64, '1') };
  localToken = config.localToken!;

  const server = new LocalServer({
    db,
    permissions: perms,
    sources,
    vault,
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    onCaptured: (sourceId, acceptedCount) => {
      capturedEvents.push({ sourceId, accepted: acceptedCount });
    },
  });
  app = Fastify();
  await server.register(app);
  await app.listen({ port: 43991, host: '127.0.0.1' }); // 独立端口：不与桌面主服务冲突
  await pairDirect();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P1-6 自动分析与暂停（LocalServer 采集闭环）', () => {
  it('autoAnalyze=false：采集成功、原文落库、无模型调用回调', async () => {
    capturedEvents = [];
    config = { ...config, capture: { ...config.capture, enabled: true, autoAnalyze: false } };
    const res = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-aaa-001', [
        { order: 0, role: 'user', text: '问题：IXAEON 是什么？' },
        { order: 1, role: 'assistant', text: '答：本地项目记忆系统。' },
      ]),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { accepted: number; sourceId: string };
    expect(body.accepted).toBe(2);
    // 原文落库
    const { segments } = sources.getSegments(body.sourceId, 0, 100);
    expect(segments.length).toBe(2);
    expect(capturedEvents.length).toBe(0); // 模型调用 0 次（无提取回调）
  });

  it('autoAnalyze=true：新内容触发提取回调；重复提交同批次不重复回调（防抖）', async () => {
    capturedEvents = [];
    config = { ...config, capture: { ...config.capture, enabled: true, autoAnalyze: true } };
    // 已存在 conv-aaa-001（上例创建），追加新一轮
    const res = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-aaa-001', [
        { order: 0, role: 'user', text: '问题：IXAEON 是什么？' },
        { order: 1, role: 'assistant', text: '答：本地项目记忆系统。' },
        { order: 2, role: 'user', text: '追问：数据存哪里？' },
        { order: 3, role: 'assistant', text: '答：全部本地。' },
      ]),
    });
    expect(res.statusCode).toBe(200);
    expect(capturedEvents.length).toBe(1); // 触发一次提取
    // 重复提交同一批次（全部 deduplicated、无新内容）→ 不再回调
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-aaa-001', [
        { order: 0, role: 'user', text: '问题：IXAEON 是什么？' },
        { order: 1, role: 'assistant', text: '答：本地项目记忆系统。' },
        { order: 2, role: 'user', text: '追问：数据存哪里？' },
        { order: 3, role: 'assistant', text: '答：全部本地。' },
      ]),
    });
    expect(res2.statusCode).toBe(200);
    const b2 = JSON.parse(res2.body) as { accepted: number; deduplicated: number };
    expect(b2.accepted).toBe(0);
    expect(b2.deduplicated).toBe(4);
    expect(capturedEvents.length).toBe(1); // 无新内容 → 不重复生成任务
  });

  it('暂停对话 A：A 被拒绝（403）；同时打开的对话 B 仍可提交', async () => {
    // 暂停 A（经扩展端点，服务端记录）
    const pauseRes = await app.inject({
      method: 'POST',
      url: '/api/extension/pause-conversation',
      headers: headers(extensionToken),
      payload: { externalId: '/c/conv-paused-A', paused: true },
    });
    expect(pauseRes.statusCode).toBe(200);
    // A 提交被拒
    const resA = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-paused-A', [
        { order: 0, role: 'user', text: '暂停中的内容不应上传' },
      ]),
    });
    expect(resA.statusCode).toBe(403);
    expect(JSON.parse(resA.body).code).toBe('IXA0022'); // DISABLED
    // B 正常提交
    const resB = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-active-B', [
        { order: 0, role: 'user', text: '对话 B 的内容正常上传' },
      ]),
    });
    expect(resB.statusCode).toBe(200);
    expect(JSON.parse(resB.body).accepted).toBe(1);
    // A 的内容确实没有入库
    const aSource = db
      .prepare("SELECT id FROM sources WHERE external_id = '/c/conv-paused-A'")
      .get() as { id: string } | undefined;
    expect(aSource).toBeUndefined();
  });

  it('全局暂停（capture.enabled=false）：所有提交被拒', async () => {
    config = { ...config, capture: { ...config.capture, enabled: false } };
    const res = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-active-B', [
        { order: 1, role: 'user', text: '全局暂停后不应上传' },
      ]),
    });
    expect(res.statusCode).toBe(403);
    config = { ...config, capture: { ...config.capture, enabled: true } };
  });

  it('新对话 page:<hash> → 正式 /c/<id>：合并为单一来源，不重复不丢内容', async () => {
    capturedEvents = [];
    // 第一批：无正式 ID（临时身份）
    const tempText = '新对话第一轮：临时身份测试内容';
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('page:abcdef123456', [
        { order: 0, role: 'user', text: tempText },
        { order: 1, role: 'assistant', text: '回复：收到。' },
      ]),
    });
    expect(res1.statusCode).toBe(200);
    // 第二批：ChatGPT 分配了正式 ID（含第一轮内容 + 新一轮）
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/formal-id-999', [
        { order: 0, role: 'user', text: tempText },
        { order: 1, role: 'assistant', text: '回复：收到。' },
        { order: 2, role: 'user', text: '第二轮新问题' },
      ]),
    });
    expect(res2.statusCode).toBe(200);
    // 数据库中只有一个来源（临时来源被合并删除）
    const count = (
      db
        .prepare("SELECT COUNT(*) c FROM sources WHERE provider='chatgpt_web' AND (external_id = 'page:abcdef123456' OR external_id = '/c/formal-id-999')")
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
    // 内容不丢：3 轮都在正式来源
    const formal = db
      .prepare("SELECT id FROM sources WHERE external_id = '/c/formal-id-999'")
      .get() as { id: string } | undefined;
    expect(formal).toBeDefined();
    const { segments } = sources.getSegments(formal!.id, 0, 100);
    expect(segments.filter((s) => s.is_active_branch).length).toBe(3);
    expect(segments.some((s) => s.text === tempText)).toBe(true);
    expect(segments.some((s) => s.text === '第二轮新问题')).toBe(true);
  });

  it('回答重新生成：旧版本保留为非活动分支，新版本为唯一活动版本', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-regen', [
        { order: 0, role: 'user', text: '重新生成测试问题' },
        { order: 1, role: 'assistant', text: '旧版本回答 V1' },
      ]),
    });
    expect(res1.statusCode).toBe(200);
    const sourceId = (JSON.parse(res1.body) as { sourceId: string }).sourceId;
    // 同一顺序的答案被重新生成（新文本）
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-regen', [
        { order: 0, role: 'user', text: '重新生成测试问题' },
        { order: 1, role: 'assistant', text: '新版本回答 V2（重新生成）' },
      ]),
    });
    expect(res2.statusCode).toBe(200);
    const { segments } = sources.getSegments(sourceId, 0, 100);
    const order1Versions = segments.filter((s) => s.external_node_id === '1');
    expect(order1Versions.length).toBe(2); // 旧版 + 新版都保留
    const active = order1Versions.filter((s) => s.is_active_branch);
    expect(active.length).toBe(1);
    expect(active[0]!.text).toBe('新版本回答 V2（重新生成）');
    const old = order1Versions.find((s) => !s.is_active_branch);
    expect(old?.text).toBe('旧版本回答 V1');
  });

  it('每次成功追加都更新 imported_at（最近同步时间不停留在首采）', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-sync-time', [
        { order: 0, role: 'user', text: '同步时间测试' },
      ]),
    });
    const sourceId = (JSON.parse(res1.body) as { sourceId: string }).sourceId;
    const first = (
      db.prepare('SELECT imported_at FROM sources WHERE id = ?').get(sourceId) as {
        imported_at: string;
      }
    ).imported_at;
    // 等待至少 1ms 确保 ISO 时间不同
    await new Promise((r) => setTimeout(r, 1100));
    await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: headers(extensionToken),
      payload: capturePayload('/c/conv-sync-time', [
        { order: 0, role: 'user', text: '同步时间测试' },
        { order: 1, role: 'user', text: '追加一轮（新）' },
      ]),
    });
    const second = (
      db.prepare('SELECT imported_at FROM sources WHERE id = ?').get(sourceId) as {
        imported_at: string;
      }
    ).imported_at;
    expect(second > first).toBe(true);
  });

  it('令牌错误：返回 401 与可操作错误信息', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token-000000000000',
        origin: EXTENSION_ORIGIN,
      },
      payload: capturePayload('/c/conv-token', [{ order: 0, role: 'user', text: 'x' }]),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { code: string; message: string };
    expect(body.message).toContain('令牌');
  });

  it('MCP 端点：localToken 调用 prepare_task（桌面服务运行时真实调用）', async () => {
    // 用 MCP 端点验证（localToken 可用、扩展令牌不可用）
    const projects = new ProjectService(db);
    const project = projects.create({
      name: 'MCP闭环项目',
      rootPath: null,
      description: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/prepare-task',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${localToken}`,
      },
      payload: { project_ref: 'MCP闭环项目', task: '测试准备', max_chars: 12000 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { project_id: string; char_budget: number };
    expect(body.project_id).toBe(project.id);
    // 扩展令牌不能访问 MCP 端点
    const resExt = await app.inject({
      method: 'POST',
      url: '/api/mcp/prepare-task',
      headers: headers(extensionToken),
      payload: { project_ref: 'MCP闭环项目', task: 'x', max_chars: 12000 },
    });
    expect(resExt.statusCode).toBe(401);
  });
});
