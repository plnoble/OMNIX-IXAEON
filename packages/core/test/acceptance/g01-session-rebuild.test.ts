/**
 * G01 验收（规格 docs/委派/G01-会话重建后补历史.md）：
 * Hermes 会话重建了就补上前几轮；新增记忆不再触发重建。
 * 条件 1–5 逐条对应下面的用例；「记忆版本」一组把契约 2 的算法写死。
 * 协议替身（PassThrough），不启动本机 Hermes；看 session.create 的次数与
 * prompt.submit 实际发出去的文字。
 *
 * 契约 2 的记忆版本（整合方复审时改写，2026-09-24）：
 * 执行方原稿用五段指纹（拒绝/取代/结束的条数与最大更新时间、updated_at > created_at 的
 * `id:scope` 串、getDisclosureEpoch 每次把全部 item id 写进 app_settings 来数删除）。复审发现：
 * 搁置、归档资料、换项目都会让模型看不到记忆，却不在五段里；有的写法改范围不动 updated_at；
 * 读函数带写副作用、存的串随条数一直涨。改为：
 *   记忆段 = app_settings 里 disclosure.memory_revision 的值。迁移 36（整合方写）的触发器在
 *   「收回可见性」时加 1：删除记忆；标「不对」；被取代（state 离开 current/disputed）；
 *   搁置；标「结束没结束」（time_status 变）；改范围或归属项目；归档来源。新增记忆、标争议、
 *   重算待处理原因、点「对」都不加。**getDisclosureEpoch 只读不写。**
 *   授权段、披露段照旧。
 *   设置段只看会改变「模型能看到什么」的设置，目前只有 memory.personal_to_chat；不再取
 *   全部 app_settings 的最大 updated_at——否则点「都看过了」（overview.*_seen_at）、
 *   「不关注」（research.watch_directions.rejected）也会让会话重建。
 * 规格契约 2 点名的五种（拒绝、标过时、被取代、改范围、删除）一条没少。
 *
 * 条件 4 整合方复审实现时补（2026-09-24）：应用会预热一个空会话（P1），重开旧对话的第一问
 * 接的就是它。适配器里有活着的长驻会话、版本也没变，但那个会话没见过这个对话的前几轮——
 * 只看「会不会复用」就不补历史，重开旧对话丢了上文。原来的条件 4 用的是不预热的新适配器，
 * 测不到这条最常走的路。
 *
 * 契约 1 的判断方法：规格举例 willReuseSession(contextRef)。适配器不持有数据库，
 * 披露版本由调用方算好传入，故签名为
 * willReuseSession(contextRef: string, permissionVersion: string): boolean
 * （同一 contextRef 有活着的长驻会话、启动参数与披露版本都没变 → true）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AgentSession,
  CodingOrchestrator,
  CORE_TOOL_NAMES,
  CoreToolBroker,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  ImportService,
  ItemService,
  JsonRpcStdio,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  Vault,
  getDisclosureEpoch,
  migrate,
  openDatabase,
  setPersonalMemoryToChat,
  type CoreDatabase,
  type PriorTurn,
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface RpcMsg {
  id?: number;
  method?: string;
  params?: { text?: string };
}

interface Spawn {
  hostIn: PassThrough;
  outbound: string[];
  cursor: number;
}

/** 一轮对话的替身环境：协议替身 + AgentSession，drive 一轮返回派出去的文字。 */
function harness(): {
  db: CoreDatabase;
  adapter: HermesRuntimeAdapter;
  session: AgentSession;
  spawns: Spawn[];
  drive: (goal: string, priorTurns: PriorTurn[]) => Promise<string>;
  reopen: () => AgentSession;
  prewarm: () => Promise<void>;
} {
  const dir = tempDir('ixa-g01-');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const exe = join(tempDir('ixa-g01-exe-'), 'hermes.exe');
  writeFileSync(exe, 'fake');
  chmodSync(exe, 0o755);
  process.env.IXAEON_HERMES_EXE = exe;

  const spawns: Spawn[] = [];
  const factory = () => {
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (chunk: Buffer | string) => outbound.push(String(chunk)));
    spawns.push({ hostIn, outbound, cursor: 0 });
    return {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    } as TuiTransport;
  };
  const database = db;
  const broker = new CoreToolBroker(
    database,
    new ItemService(database),
    new SearchService(database),
    new CodingOrchestrator(database, new FakeCodingExecutor(), dir),
    new ProjectService(database),
  );
  const launch = { chatModel: null as string | null, bridgeToken: null as string | null };
  const adapter = new HermesRuntimeAdapter(broker, factory as never, () => launch);
  const session = new AgentSession(database, adapter, broker, new FakeProvider('g01'), {
    mcpBridgedTools: [],
  });

  const messages = (s: Spawn): RpcMsg[] =>
    s.outbound
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RpcMsg);

  async function nextRequest(): Promise<{ spawn: Spawn; msg: RpcMsg }> {
    const start = Date.now();
    while (Date.now() - start < 4000) {
      for (const s of spawns) {
        const msgs = messages(s);
        const req = msgs
          .slice(s.cursor)
          .find((m) => m.method === 'session.create' || m.method === 'prompt.submit');
        if (req) {
          s.cursor = msgs.indexOf(req) + 1;
          return { spawn: s, msg: req };
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('没等到协议请求');
  }

  async function drive(goal: string, priorTurns: PriorTurn[]): Promise<string> {
    const pending = session.run({ goal, projectId: null, priorTurns });
    let req = await nextRequest();
    if (req.msg.method === 'session.create') {
      req.spawn.hostIn.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.msg.id,
          result: { session_id: `s-${spawns.length}` },
        }) + '\n',
      );
      req = await nextRequest();
    }
    expect(req.msg.method).toBe('prompt.submit');
    const text = req.msg.params?.text ?? '';
    req.spawn.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: req.msg.id, result: { ok: true } }) + '\n',
    );
    req.spawn.hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          session_id: `s-${spawns.indexOf(req.spawn) + 1}`,
          payload: { text: '好的', status: 'complete' },
        },
      }) + '\n',
    );
    await pending;
    return text;
  }

  /** 应用重启：新适配器、新 AgentSession，长驻会话清空，旧对话的历史由调用方传入。 */
  function reopen(): AgentSession {
    const restarted = new HermesRuntimeAdapter(broker, factory as never, () => launch);
    return new AgentSession(database, restarted, broker, new FakeProvider('g01'), {
      mcpBridgedTools: [],
    });
  }

  /** 应用的会话预热（P1）：进程起好、会话建好，还没有任何一轮对话。 */
  async function prewarm(): Promise<void> {
    const warming = adapter.prewarm({
      runId: 'prewarm-g01',
      goal: '',
      contextRef: 'personal',
      allowedTools: [...CORE_TOOL_NAMES],
      permissionVersion: getDisclosureEpoch(database),
      budget: { maxToolCalls: 4, timeoutMs: 120_000 },
      idempotencyKey: 'prewarm-personal',
    });
    const req = await nextRequest();
    expect(req.msg.method).toBe('session.create');
    req.spawn.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: req.msg.id, result: { session_id: 's-1' } }) + '\n',
    );
    expect(await warming).toBe(true);
  }

  return { db: database, adapter, session, spawns, drive, reopen, prewarm };
}

/** 往库里直接插入一条记忆（提炼器产物的形状：origin=ai、said_by=user）。 */
function insertMemory(database: CoreDatabase, statement: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO items (id, type, statement, origin, said_by, created_at, updated_at)
       VALUES (?, 'goal', ?, 'ai', 'user', ?, ?)`,
    )
    .run(id, statement, now, now);
  return id;
}

const PASSPHRASE = '口令：青柠七九';
const HISTORY_MARK = '本对话此前的内容';

describe('G01 会话重建后补历史', () => {
  it('条件 1：新增一条无关记忆后第二轮仍复用同一会话，不重复补历史', async () => {
    const h = harness();
    const first = await h.drive(PASSPHRASE, []);
    expect(first).not.toContain(HISTORY_MARK);
    insertMemory(h.db, '一条无关的新记忆');
    const prior: PriorTurn[] = [
      { role: 'user', content: PASSPHRASE },
      { role: 'assistant', content: '好的' },
    ];
    const second = await h.drive('第二轮随便说点什么', prior);
    // 协议替身里只建过一次会话
    expect(h.spawns.length).toBe(1);
    expect(second).not.toContain(HISTORY_MARK);
    expect(second).not.toContain(PASSPHRASE);
    h.adapter.disposeAll();
  });

  it('条件 2：把记忆标成「不对」后下一轮新开会话并补上前几轮（含口令）', async () => {
    const h = harness();
    const items = new ItemService(h.db);
    const memoryId = insertMemory(h.db, '第一轮注入过的记忆');
    const prior: PriorTurn[] = [
      { role: 'user', content: PASSPHRASE },
      { role: 'assistant', content: '记住了' },
    ];
    await h.drive(PASSPHRASE, []);
    items.reject(memoryId);
    const next = await h.drive('那件事还算数吗', prior);
    expect(h.spawns.length).toBe(2);
    expect(next).toContain(HISTORY_MARK);
    expect(next).toContain(PASSPHRASE);
    h.adapter.disposeAll();
  });

  it('条件 3：授权撤销后新开会话并补历史', async () => {
    const h = harness();
    const perms = new PermissionService(h.db);
    const grant = perms.grantFile(join(tempDir('ixa-g01-grant-'), 'note.txt'));
    const prior: PriorTurn[] = [
      { role: 'user', content: PASSPHRASE },
      { role: 'assistant', content: '好的' },
    ];
    await h.drive(PASSPHRASE, []);
    perms.revoke(grant.id);
    const next = await h.drive('现在还能读那份吗', prior);
    expect(h.spawns.length).toBe(2);
    expect(next).toContain(HISTORY_MARK);
    expect(next).toContain(PASSPHRASE);
    h.adapter.disposeAll();
  });

  it('条件 3：关掉「个人记忆给聊天用」后新开会话并补历史', async () => {
    const h = harness();
    setPersonalMemoryToChat(h.db, true);
    const prior: PriorTurn[] = [
      { role: 'user', content: PASSPHRASE },
      { role: 'assistant', content: '好的' },
    ];
    await h.drive(PASSPHRASE, []);
    setPersonalMemoryToChat(h.db, false);
    const next = await h.drive('别再拿我的记忆了', prior);
    expect(h.spawns.length).toBe(2);
    expect(next).toContain(HISTORY_MARK);
    h.adapter.disposeAll();
  });

  it('条件 4：应用重启后重开旧对话补历史（原有行为）', async () => {
    const h = harness();
    await h.drive(PASSPHRASE, []);
    h.adapter.disposeAll();
    const restarted = h.reopen();
    const prior: PriorTurn[] = [
      { role: 'user', content: PASSPHRASE },
      { role: 'assistant', content: '好的' },
    ];
    const pending = restarted.run({
      goal: '我刚才说的口令是什么',
      projectId: null,
      priorTurns: prior,
    });
    const start = Date.now();
    while (h.spawns.length < 2 && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const spawn = h.spawns[1]!;
    const read = (): RpcMsg[] =>
      spawn.outbound
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RpcMsg);
    const wait = async (method: string): Promise<RpcMsg> => {
      const begun = Date.now();
      while (Date.now() - begun < 4000) {
        const hit = read().find((m) => m.method === method);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`重启后没等到 ${method}`);
    };
    const create = await wait('session.create');
    spawn.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's-restart' } }) + '\n',
    );
    const submit = await wait('prompt.submit');
    expect(submit.params?.text).toContain(HISTORY_MARK);
    expect(submit.params?.text).toContain(PASSPHRASE);
    spawn.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n',
    );
    spawn.hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          payload: { text: '好的', status: 'complete' },
        },
      }) + '\n',
    );
    await pending;
  });

  it('条件 4（整合方补）：预热好的会话接给一个旧对话，第一问也补历史', async () => {
    const h = harness();
    await h.prewarm();
    const prior: PriorTurn[] = [
      { role: 'user', content: PASSPHRASE },
      { role: 'assistant', content: '好的' },
    ];
    const text = await h.drive('我刚才说的口令是什么', prior);
    // 用的就是预热好的那个进程与会话
    expect(h.spawns.length).toBe(1);
    expect(text).toContain(HISTORY_MARK);
    expect(text).toContain(PASSPHRASE);
    // 接着聊：这回它已经在这个会话里了，不再重复补
    const next = await h.drive('再说一遍', [
      ...prior,
      { role: 'user', content: '我刚才说的口令是什么' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(next).not.toContain(HISTORY_MARK);
    h.adapter.disposeAll();
  });

  it('条件 5：同一会话连续复用时每一轮都不重复补历史', async () => {
    const h = harness();
    const turns: PriorTurn[] = [];
    const first = await h.drive('第一轮', turns);
    expect(first).not.toContain(HISTORY_MARK);
    for (const goal of ['第二轮', '第三轮']) {
      turns.push({ role: 'user', content: '之前的话' }, { role: 'assistant', content: '好的' });
      const text = await h.drive(goal, turns);
      expect(text).not.toContain(HISTORY_MARK);
    }
    expect(h.spawns.length).toBe(1);
    h.adapter.disposeAll();
  });

  it('契约 1：willReuseSession 只在会话会复用时为真', async () => {
    const h = harness();
    const epoch = () => getDisclosureEpoch(h.db);
    expect(h.adapter.willReuseSession('personal', epoch())).toBe(false);
    await h.drive('第一轮', []);
    expect(h.adapter.willReuseSession('personal', epoch())).toBe(true);
    insertMemory(h.db, '新增记忆不改版本');
    expect(h.adapter.willReuseSession('personal', epoch())).toBe(true);
    new ItemService(h.db).reject(insertMemory(h.db, '马上被标不对的记忆'));
    expect(h.adapter.willReuseSession('personal', epoch())).toBe(false);
    h.adapter.disposeAll();
  });
});

describe('G01 记忆版本（契约 2：只有收回可见性才让版本变）', () => {
  function fresh(): { db: CoreDatabase; items: ItemService } {
    const dir = tempDir('ixa-g01-epoch-');
    db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    return { db, items: new ItemService(db) };
  }

  it('新提炼一条记忆不改变版本', () => {
    const { db: database } = fresh();
    const before = getDisclosureEpoch(database);
    insertMemory(database, '今天想学做面包');
    expect(getDisclosureEpoch(database)).toBe(before);
  });

  it('拒绝、标过时、被取代、改范围、删除都会改变版本', () => {
    const { db: database, items } = fresh();
    const rejected = insertMemory(database, '记一条准备拒绝');
    const ended = insertMemory(database, '记一条准备标结束');
    const superseded = insertMemory(database, '记一条准备被取代');
    const rescoped = insertMemory(database, '记一条准备改范围');
    const removed = insertMemory(database, '记一条准备删除');
    // 插入本身不改变版本：先取基线
    const base = getDisclosureEpoch(database);

    items.reject(rejected);
    const afterReject = getDisclosureEpoch(database);
    expect(afterReject).not.toBe(base);

    items.setTimeStatus(ended, 'ended');
    const afterEnded = getDisclosureEpoch(database);
    expect(afterEnded).not.toBe(afterReject);

    items.correct({ itemId: superseded, userText: '其实不是这样' });
    const afterCorrect = getDisclosureEpoch(database);
    expect(afterCorrect).not.toBe(afterEnded);

    items.setScope(rescoped, 'personal');
    const afterScope = getDisclosureEpoch(database);
    expect(afterScope).not.toBe(afterCorrect);

    database.prepare('DELETE FROM items WHERE id = ?').run(removed);
    expect(getDisclosureEpoch(database)).not.toBe(afterScope);
  });

  it('整合方补：搁置、换归属项目、归档资料也会改变版本', () => {
    const { db: database, items } = fresh();
    const shelved = insertMemory(database, '记一条准备搁置');
    const moved = insertMemory(database, '记一条准备换项目');
    const projects = new ProjectService(database);
    const first = projects.create({ name: '合成项目甲', rootPath: null, description: null });
    const second = projects.create({ name: '合成项目乙', rootPath: null, description: null });
    items.assignToProject(moved, first.id);
    let epoch = getDisclosureEpoch(database);

    items.shelve(shelved, true);
    expect(getDisclosureEpoch(database)).not.toBe(epoch);
    epoch = getDisclosureEpoch(database);

    // 从甲换到乙：在甲的对话里它就不该再出现了
    items.assignToProject(moved, second.id);
    expect(getDisclosureEpoch(database)).not.toBe(epoch);

    const dir = tempDir('ixa-g01-archive-');
    const doc = join(dir, 'note.md');
    writeFileSync(doc, ['# 合成资料', '', '一段合成的笔记。'].join('\n'), 'utf8');
    const permissions = new PermissionService(database);
    const sources = new SourceStore(database);
    const imports = new ImportService(
      database,
      new Vault(join(dir, 'vault')),
      permissions,
      sources,
    );
    const source = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    }).created[0]!;
    // 导入时授权段已经变了，这里重新取基线
    epoch = getDisclosureEpoch(database);
    sources.archive(source.id, '合成资料的经验摘要');
    expect(getDisclosureEpoch(database)).not.toBe(epoch);
  });

  it('整合方补：标争议、重算待处理原因、点「对」不改变版本（每轮提炼后都会发生）', async () => {
    const { db: database, items } = fresh();
    const disputed = insertMemory(database, '记一条会被标争议');
    const confirmed = insertMemory(database, '记一条会被确认');
    const base = getDisclosureEpoch(database);
    // 提炼器发现冲突时的写法（extractor.ts）：争议条目照旧注入，只多一个标签
    database.prepare(`UPDATE items SET state = 'disputed' WHERE id = ?`).run(disputed);
    // 待处理原因重算（needsReview.ts）。更新时间故意推后：靠 updated_at 算版本的实现在这里必挂
    database
      .prepare('UPDATE items SET needs_reasons = ?, needs_review = 1, updated_at = ? WHERE id = ?')
      .run('unconfirmed', new Date(Date.now() + 60_000).toISOString(), confirmed);
    await new Promise((r) => setTimeout(r, 5));
    items.confirm(confirmed);
    expect(getDisclosureEpoch(database)).toBe(base);
  });

  it('整合方补：写别的设置（都看过了、不关注）不改变版本；「个人记忆给聊天用」会', () => {
    const { db: database } = fresh();
    const base = getDisclosureEpoch(database);
    const now = new Date().toISOString();
    const put = database.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    put.run('overview.findings_seen_at', now, now);
    put.run('overview.matched_seen_at', now, now);
    put.run('research.watch_directions.rejected', '[]', now);
    expect(getDisclosureEpoch(database)).toBe(base);
    setPersonalMemoryToChat(database, true);
    expect(getDisclosureEpoch(database)).not.toBe(base);
  });

  it('整合方补：读版本不写库', () => {
    const { db: database } = fresh();
    insertMemory(database, '一条记忆');
    const snapshot = () =>
      JSON.stringify(database.prepare('SELECT * FROM app_settings ORDER BY key').all());
    const before = snapshot();
    getDisclosureEpoch(database);
    getDisclosureEpoch(database);
    expect(snapshot()).toBe(before);
  });
});
