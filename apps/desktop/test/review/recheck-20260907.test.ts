/** Independent follow-up: synthetic data only; no production edits or real model calls. */
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  JobQueue,
  McpService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  saveConfig,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';

// RF08：electron safeStorage mock —— 加密可用性可控（默认不可用）
let encryptionAvailable = false;
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plain: string) => Buffer.from(`enc(${plain})`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf8');
      return text.startsWith('enc(') && text.endsWith(')') ? text.slice(4, -1) : null;
    },
  },
}));

import { AppRuntime } from '../../src/main/appRuntime.js';
import { decodeLegacyPlainApiKey, decryptApiKey, encryptApiKey } from '../../src/main/ipc.js';

const databases: CoreDatabase[] = [];
const queues: JobQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.stop();
  for (const db of databases.splice(0)) if (db.open) db.close();
  encryptionAvailable = false;
  vi.restoreAllMocks();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-recheck-20260907-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  databases.push(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, vault, permissions, sources);
  const items = new ItemService(db);
  const projects = new ProjectService(db);
  const p = projects.create({ name: 'Recheck', rootPath: null, description: null });
  const mcp = new McpService(db);
  function source(projectId: string | null = p.id) {
    const path = join(dir, `${randomUUID()}.md`);
    writeFileSync(path, '# Recheck\n\nRECHECK_EVIDENCE\n', 'utf8');
    return imports.importFile(path, { projectId, permissionId: permissions.grantFile(path).id })
      .created[0]!;
  }
  async function extract(
    sourceId: string,
    statements: string[],
    type: 'decision' | 'constraint' | 'open_loop' = 'decision',
  ) {
    const fake = new FakeProvider().enqueueStructured({
      items: statements.map((statement) => ({
        type,
        statement,
        excerpt: 'RECHECK_EVIDENCE',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.95,
        project_hint: null,
      })),
    });
    return new Extractor(db, fake).extractSource(sourceId);
  }
  return { dir, db, sources, items, p, mcp, source, extract };
}

it('B01: ordinary unchanged AI conclusions must survive re-extraction alongside a new conclusion', async () => {
  const f = fixture();
  const s = f.source();
  await f.extract(s.id, ['UNCHANGED_OLD_CONCLUSION']);
  await f.extract(s.id, ['UNCHANGED_OLD_CONCLUSION', 'BRAND_NEW_CONCLUSION']);
  const current = f.items.list({ projectId: f.p.id, state: 'current' });
  expect.soft(current.map((i) => i.statement)).toContain('UNCHANGED_OLD_CONCLUSION');
  expect(current.map((i) => i.statement)).toContain('BRAND_NEW_CONCLUSION');
});

it('B02: after two successive corrections the latest user constraint must be in the protection chain', async () => {
  const f = fixture();
  const s = f.source();
  await f.extract(s.id, ['日志保留期限为三十天'], 'constraint');
  const original = f.items.list({ projectId: f.p.id })[0]!;
  const middle = f.items.correct({
    itemId: original.id,
    userText: '日志字段统一脱敏，访问令牌只能显示末尾四位',
  }).newItem;
  f.items.correct({ itemId: middle.id, userText: '项目日志可以发送到远程服务器保存和分析' });
  await f.extract(s.id, ['项目日志不可以发送到远程服务器保存和分析'], 'constraint');
  const opposite = f.items.list({ projectId: f.p.id }).find((i) => i.statement.includes('不可以'))!;
  expect(opposite.needs_review || opposite.state === 'disputed').toBe(true);
});

for (const method of ['item', 'source'] as const) {
  it(`B03-${method}: assigning the only missing project must resolve an ordinary open-loop Inbox reason`, async () => {
    const f = fixture();
    const s = f.source(null);
    await f.extract(s.id, ['等待性能测量数据'], 'open_loop');
    const i = f.items.list({ projectId: null })[0]!;
    expect(i.needs_review).toBe(true);
    if (method === 'item') f.items.assignToProject(i.id, f.p.id);
    else f.sources.bindProject(s.id, f.p.id);
    expect.soft(f.items.get(i.id).confirmation).toBe('none');
    expect(f.items.get(i.id).needs_review).toBe(false);
  });
}

it('B04: near-budget responses must include truncation notice and chars_used digits without overflow', () => {
  const failures: Array<{ statementLength: number; outputLength: number }> = [];
  for (let size = 1300; size <= 1510; size += 10) {
    const f = fixture();
    f.items.createManual({
      projectId: f.p.id,
      type: 'decision',
      statement: '甲'.repeat(size),
      rationale: null,
    });
    f.items.createManual({
      projectId: f.p.id,
      type: 'decision',
      statement: '乙'.repeat(1900),
      rationale: null,
    });
    const brief = f.mcp.prepareTask({ project_ref: f.p.id, task: 'audit', max_chars: 2000 });
    const length = JSON.stringify(brief).length;
    if (length > 2000) failures.push({ statementLength: size, outputLength: length });
  }
  expect(failures, JSON.stringify(failures)).toEqual([]);
});

it('B05: a corrected user conclusion returned by the briefing must have a usable reference', async () => {
  const f = fixture();
  const s = f.source();
  await f.extract(s.id, ['OLD_REFERENCE']);
  const original = f.items.list({ projectId: f.p.id })[0]!;
  const corrected = f.items.correct({
    itemId: original.id,
    userText: 'CURRENT_USER_REFERENCE',
  }).newItem;
  const brief = f.mcp.prepareTask({ project_ref: f.p.id, task: 'audit', max_chars: 12000 });
  expect(brief.decisions.some((e) => e.ref === corrected.id)).toBe(true);
  expect(() => f.mcp.getSourceExcerpt(corrected.id, 2000)).not.toThrow();
});

it('B06: a manually created conclusion returned by the briefing must have a usable reference', () => {
  const f = fixture();
  const manual = f.items.createManual({
    projectId: f.p.id,
    type: 'decision',
    statement: 'MANUAL_USER_REFERENCE',
    rationale: null,
  });
  const brief = f.mcp.prepareTask({ project_ref: f.p.id, task: 'audit', max_chars: 12000 });
  expect(brief.decisions.some((e) => e.ref === manual.id)).toBe(true);
  expect(() => f.mcp.getSourceExcerpt(manual.id, 2000)).not.toThrow();
});

it('B07: control - one correction still protects the old conclusion and recent-work references now expand', async () => {
  const f = fixture();
  const s = f.source();
  await f.extract(s.id, ['CONTROL_OLD']);
  const old = f.items.list({ projectId: f.p.id })[0]!;
  const corrected = f.items.correct({ itemId: old.id, userText: 'CONTROL_NEW_USER' }).newItem;
  await f.extract(s.id, ['CONTROL_OLD']);
  expect(f.items.get(old.id).state).toBe('superseded');
  expect(f.items.get(corrected.id).state).toBe('current');
  const work = f.mcp.recordWorkResult({
    project_ref: f.p.id,
    agent_name: 'review-agent',
    task: 'control',
    outcome: 'success',
    summary: 'synthetic self report',
    changes: [],
    tests: [],
    open_loops: [],
  });
  expect(f.mcp.getSourceExcerpt(work.work_run_id, 2000).excerpt).toContain('用户尚未验收');
});


// --- RF08：旧 plain: 密钥迁移与错误提示（合成密钥，非真实凭据） ---

/** 构造带 plain: 旧密钥的最小 runtime（与 project-audit 测试同款装配方式）。 */
function runtimeWithLegacyPlainKey(dir: string, plain: string) {
  const db = openDatabase(join(dir, 'ixaeon.db'));
  databases.push(db);
  migrate(db);
  const config = defaultAppConfig();
  config.setupComplete = true;
  config.model.modelName = 'synthetic-model';
  config.model.apiKeyEncrypted = `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
  config.model.apiKeyPresent = true;
  const configFile = join(dir, 'config.json');
  saveConfig(configFile, config);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this;
    },
  };
  const jobs = new JobQueue(db, logger);
  queues.push(jobs);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    config,
    jobs,
    logger,
    configFile,
  });
  return { runtime, configFile };
}

it('B08: legacy plain: key must be upgraded to system encryption when safeStorage is available', () => {
  encryptionAvailable = true;
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-recheck-rf08a-'));
  const { runtime, configFile } = runtimeWithLegacyPlainKey(dir, 'SYNTHETIC_KEY_RF08');
  const result = runtime.migrateLegacyPlainApiKey();
  expect(result).toBe('migrated');
  // 配置里不再有 plain: 前缀，且能通过 safeStorage 解回原值
  const migrated = runtime.getConfig().model.apiKeyEncrypted!;
  expect(migrated.startsWith('plain:')).toBe(false);
  expect(decryptApiKey(migrated)).toBe('SYNTHETIC_KEY_RF08');
  // 落盘副本同样完成迁移（读文件本身，不是内存态）
  const onDisk = JSON.parse(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync(configFile, 'utf8'),
  ) as { model: { apiKeyEncrypted: string | null } };
  expect(onDisk.model.apiKeyEncrypted?.startsWith('plain:')).toBe(false);
  // 审计有迁移记录，且不含密钥内容
  const audit = (
    runtime as unknown as { db: CoreDatabase }
  ).db
    .prepare(`SELECT kind FROM audit_events WHERE kind LIKE 'settings.api_key_%'`)
    .all() as Array<{ kind: string }>;
  expect(audit.some((a) => a.kind === 'settings.api_key_migrated')).toBe(true);
  expect(JSON.stringify(audit)).not.toContain('SYNTHETIC_KEY_RF08');
});

it('B09: legacy plain: key must be cleared (not silently kept) when system encryption is unavailable', () => {
  encryptionAvailable = false;
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-recheck-rf08b-'));
  const { runtime, configFile } = runtimeWithLegacyPlainKey(dir, 'SYNTHETIC_KEY_RF08B');
  const result = runtime.migrateLegacyPlainApiKey();
  expect(result).toBe('cleared');
  const config = runtime.getConfig();
  expect(config.model.apiKeyEncrypted).toBe(null);
  expect(config.model.apiKeyPresent).toBe(false);
  // 磁盘上可解码的原文不复存在（读文件本身验证）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const raw = require('node:fs').readFileSync(configFile, 'utf8') as string;
  expect(raw.includes('plain:')).toBe(false);
  expect(raw.includes(Buffer.from('SYNTHETIC_KEY_RF08B').toString('base64'))).toBe(false);
  // 可恢复：设置页能提示重新输入
  expect(runtime.apiKeyNeedsReentry()).toBe(true);
});

it('B10: runtime decrypt must not directly decode plain: keys, and save error must not promise session keys', () => {
  // 运行期读取路径拒绝明文直读（旧格式只能经启动迁移处理）
  const legacy = `plain:${Buffer.from('SYNTHETIC_KEY_RF08C', 'utf8').toString('base64')}`;
  expect(decodeLegacyPlainApiKey(legacy)).toBe('SYNTHETIC_KEY_RF08C'); // 迁移专用入口可用
  expect(decryptApiKey(legacy)).toBe(null); // 普通读取路径不再解码
  // 系统加密不可用时保存报错；错误消息不再承诺「仅本次会话的密钥」
  encryptionAvailable = false;
  let message = '';
  try {
    encryptApiKey('SYNTHETIC_KEY_RF08D');
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message.length).toBeGreaterThan(0);
  expect(message).not.toContain('仅本次会话');
  expect(message).not.toContain('重启后需重新输入');
  expect(message).toContain('未能保存');
});
