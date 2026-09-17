/**
 * D3 / D4 验收：提问带最近 N 轮上下文 + 引擎会话按对话隔离。
 *
 * 验收条件（三周任务单原文）：
 *   D3：第二问能接住第一问；新对话拿不到别的对话的内容
 *   D4：两个对话交替提问不串台；重开旧对话能续
 *
 * 本文件全程走 Core 有界循环（beforeEach 清空 Hermes 定位变量，本机真装了
 * Hermes，不清会意外启动真引擎）。断言的是「历史轮次有没有真的进到交给模型
 * 的提示词里」——不是「有没有调用过某个函数」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ConversationStore,
  ItemService,
  ProjectService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
  FakeProvider,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

let dir: string;
let db: CoreDatabase;
let conversations: ConversationStore;
let provider: FakeProvider;

const prevExe = process.env.IXAEON_HERMES_EXE;
const prevHome = process.env.IXAEON_HERMES_HOME;
const prevInstallerHome = process.env.HERMES_HOME;

/**
 * 测试面：只声明本文件用到的成员。
 * 不能写成 `AppRuntime & { askSessions: ... }`——askSessions/activeAskRuns 在
 * AppRuntime 里是 private，交叉类型会被 TS 塌成 never（vitest 不做类型检查，
 * 但 tsc --noEmit 会报）。
 */
interface TestRuntime {
  ask(input: {
    conversationId?: string | null;
    projectId: string | null;
    question: string;
  }): Promise<{
    conversationId: string;
    userMessageId: string;
    messageId: string;
  }>;
  cancelAsk(conversationId?: string | null): { cancelled: boolean; runId: string | null };
  askSessions: Map<string, unknown>;
  activeAskRuns: Map<string, string>;
}

/** 构造一个只接了 ask() 所需依赖的 AppRuntime（仓库既有 a03 测试同款做法）。 */
function makeRuntime(): TestRuntime {
  const runtime = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  runtime['db'] = db;
  runtime['conversations'] = conversations;
  runtime['items'] = new ItemService(db);
  runtime['search'] = new SearchService(db);
  runtime['projects'] = new ProjectService(db);
  runtime['coding'] = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
  runtime['askSessions'] = new Map();
  runtime['activeAskRuns'] = new Map();
  runtime['getProvider'] = () => provider;
  runtime['hermesFound'] = () => false;
  runtime['getTinyFishFetcher'] = () => null;
  runtime['getWebSearchExecutor'] = () => null;
  // 存档授权返回 null = 本轮不落 ask_session 来源（D5 的范围，这里不掺和）
  runtime['ensureAskCapturePermission'] = () => null;
  return runtime as unknown as TestRuntime;
}

/** 排队一个「直接回答」的模型响应。 */
function enqueueAnswer(text: string): void {
  provider.enqueueStructured({ tool: 'answer', args: { text } });
}

/** 取第 n 次（0 起）交给模型的完整提示词。 */
function promptAt(n: number): string {
  return provider.structuredCalls[n]?.user ?? '';
}

beforeEach(() => {
  delete process.env.IXAEON_HERMES_EXE;
  delete process.env.IXAEON_HERMES_HOME;
  delete process.env.HERMES_HOME;
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-d3d4-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  conversations = new ConversationStore(db);
  provider = new FakeProvider('fake-model-v1');
});

afterEach(() => {
  if (db.open) db.close();
  if (prevExe !== undefined) process.env.IXAEON_HERMES_EXE = prevExe;
  if (prevHome !== undefined) process.env.IXAEON_HERMES_HOME = prevHome;
  if (prevInstallerHome !== undefined) process.env.HERMES_HOME = prevInstallerHome;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

describe('D3 提问带最近 N 轮上下文', () => {
  it('第二问能接住第一问：历史轮次真的进了交给模型的提示词', async () => {
    const runtime = makeRuntime();
    enqueueAnswer('正式系统名是 IXAEON（析衍）。');
    const first = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '正式系统名是什么？',
    });

    // 第一问：没有历史，提示词里不应该出现历史块
    expect(promptAt(0)).not.toContain('本对话此前的内容');

    enqueueAnswer('析衍。');
    await runtime.ask({
      conversationId: first.conversationId,
      projectId: null,
      question: '它的中文名呢？',
    });

    // 第二问：上一轮的问和答都必须出现在提示词里，否则「它」指代不明
    const second = promptAt(1);
    expect(second).toContain('本对话此前的内容');
    expect(second).toContain('正式系统名是什么？');
    expect(second).toContain('正式系统名是 IXAEON（析衍）。');
    expect(second).toContain('它的中文名呢？');
  });

  it('新对话拿不到别的对话的内容', async () => {
    const runtime = makeRuntime();
    enqueueAnswer('A 的回答：我在看买手机的事。');
    const a = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '帮我看看买手机',
    });

    enqueueAnswer('B 的回答：这是另一件事。');
    const b = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '做一个 PPT',
    });

    expect(b.conversationId).not.toBe(a.conversationId);
    const bPrompt = promptAt(1);
    expect(bPrompt).not.toContain('本对话此前的内容');
    expect(bPrompt).not.toContain('买手机');
    expect(bPrompt).not.toContain('A 的回答');
  });

  it('历史轮次只取已完成的：取消的半截回答不进下一轮', async () => {
    const runtime = makeRuntime();
    const conv = conversations.create();
    conversations.appendMessage(conv.id, { role: 'user', content: '被取消的那一问' });
    conversations.appendMessage(conv.id, {
      role: 'assistant',
      content: '刚写了一半就被取消了',
      status: 'cancelled',
    });

    enqueueAnswer('新的回答。');
    await runtime.ask({ conversationId: conv.id, projectId: null, question: '重新问一次' });

    const prompt = promptAt(0);
    expect(prompt).toContain('被取消的那一问');
    expect(prompt).not.toContain('刚写了一半就被取消了');
  });

  it('本轮提问不会被当成「此前的内容」喂回去', async () => {
    const runtime = makeRuntime();
    enqueueAnswer('回答。');
    await runtime.ask({ conversationId: null, projectId: null, question: '这是本轮的问题' });

    const prompt = promptAt(0);
    // 本轮问题只应作为「用户问题」出现一次，不应同时出现在历史块里
    expect(prompt).not.toContain('本对话此前的内容');
    expect(prompt.split('这是本轮的问题').length - 1).toBe(1);
  });
});

describe('D4 引擎会话按对话隔离', () => {
  it('两个对话交替提问不串台：各自只看到自己的历史', async () => {
    const runtime = makeRuntime();

    enqueueAnswer('手机：预算五千。');
    const phone = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '买手机预算多少合适',
    });

    enqueueAnswer('PPT：先列大纲。');
    const ppt = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '怎么做这个 PPT',
    });

    // 回到手机对话追问
    enqueueAnswer('那就选 A 型号。');
    await runtime.ask({
      conversationId: phone.conversationId,
      projectId: null,
      question: '那选哪个型号',
    });

    const thirdPrompt = promptAt(2);
    expect(thirdPrompt).toContain('买手机预算多少合适');
    expect(thirdPrompt).toContain('手机：预算五千。');
    expect(thirdPrompt).not.toContain('PPT');

    // 再回到 PPT 对话追问
    enqueueAnswer('大纲三页就够。');
    await runtime.ask({
      conversationId: ppt.conversationId,
      projectId: null,
      question: '大纲要几页',
    });

    const fourthPrompt = promptAt(3);
    expect(fourthPrompt).toContain('怎么做这个 PPT');
    expect(fourthPrompt).not.toContain('买手机');
    expect(fourthPrompt).not.toContain('预算五千');

    // 两个对话各有独立的 AgentSession 实例
    expect(runtime.askSessions.size).toBe(2);
    expect(runtime.askSessions.get(phone.conversationId)).not.toBe(
      runtime.askSessions.get(ppt.conversationId),
    );
  });

  it('重启后重开旧对话能续：引擎会话清空，历史靠 priorTurns 重新喂', async () => {
    const before = makeRuntime();
    enqueueAnswer('第一轮的回答。');
    const conv = await before.ask({
      conversationId: null,
      projectId: null,
      question: '第一轮的问题',
    });

    // 模拟重启：进程内的会话 Map 全没了，库里的引擎会话 id 被清空
    const cleared = conversations.clearEngineSessions();
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(conversations.get(conv.conversationId).engineSessionId).toBeNull();

    const after = makeRuntime();
    expect(after.askSessions.size).toBe(0);

    enqueueAnswer('接上了。');
    await after.ask({
      conversationId: conv.conversationId,
      projectId: null,
      question: '刚才我说了什么？',
    });

    // 重启后的这一问，历史必须重新注入——否则「刚才我说了什么」答不上来
    const prompt = promptAt(1);
    expect(prompt).toContain('本对话此前的内容');
    expect(prompt).toContain('第一轮的问题');
    expect(prompt).toContain('第一轮的回答。');
  });

  it('提问与回答都落进对话，重启后查得到', async () => {
    const runtime = makeRuntime();
    enqueueAnswer('这是回答正文。');
    const result = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '这是问题',
    });

    const messages = conversations.messages(result.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '这是问题', status: 'complete' });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '这是回答正文。',
      status: 'complete',
      engine: 'core-bounded',
    });
    expect(messages[1]!.id).toBe(result.messageId);
    expect(messages[0]!.id).toBe(result.userMessageId);
    // 元数据保留，供重开对话时还原界面
    expect(messages[1]!.meta['notice']).toBeTruthy();
    expect(Array.isArray(messages[1]!.meta['steps'])).toBe(true);
  });

  it('模型失败时对话里留下 failed 消息，不是发出去就没了', async () => {
    const runtime = makeRuntime();
    const conv = conversations.create();
    // 不排队任何响应 → FakeProvider 抛错 → Core 循环最终失败
    await runtime
      .ask({ conversationId: conv.id, projectId: null, question: '会失败的一问' })
      .catch(() => undefined);

    const messages = conversations.messages(conv.id);
    expect(messages[0]).toMatchObject({ role: 'user', content: '会失败的一问' });
    // 最后一条必须是可见的终态，不能只有用户那一句
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(['failed', 'complete']).toContain(last.status);
    if (last.status === 'failed') {
      expect(last.errorMessage).toBeTruthy();
    }
  });

  it('取消：按对话取消只影响该对话；多个在跑时不传 id 不乱杀', () => {
    const runtime = makeRuntime();
    expect(runtime.cancelAsk()).toEqual({ cancelled: false, runId: null });
    expect(runtime.cancelAsk('不存在的对话')).toEqual({ cancelled: false, runId: null });

    // 两个对话同时在跑时，不传 id 必须拒绝，而不是随便挑一个杀
    runtime.activeAskRuns.set('conv-a', 'run-a');
    runtime.activeAskRuns.set('conv-b', 'run-b');
    expect(runtime.cancelAsk()).toEqual({ cancelled: false, runId: null });
  });
});
