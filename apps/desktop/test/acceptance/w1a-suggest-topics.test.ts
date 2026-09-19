/**
 * W1a 验收（v2 规格，执行方写、整合方 2026-09-19 复审后补全并重锁）：docs/委派/W1a-关注方向.md
 * 2. 确认后发给模型的只有有效的目标、约束（不含没采纳的 AI 建议、被拒绝的、已结束的、别的个人记忆）
 *    和项目名称与描述，最多 40 条（取最近更新的）；
 * 3（核心部分）. 模型返回的格式坏了：报错，不编；超过 5 个只留 5 个；依据按记忆编号对回原文；
 * 4. 「关注」建出研究主题：启用、一天一次、关联目标与项目；搜索已配置时每天最多搜 3 次，没配置时只看来源；
 * 5. 「不关注」后再提同样或相似的方向不显示；已有同名研究主题也不显示。
 * 界面部分（条件 1、3）在 w1a-suggest-topics-page.test.ts。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeProvider,
  ItemService,
  ProjectService,
  ResearchChecker,
  migrate,
  openDatabase,
  type CoreDatabase,
  type WebSearchExecutor,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

type WatchDirection = {
  question: string;
  publicDescription: string;
  basis: Array<{ id: string; statement: string }>;
  relatedGoalId: string | null;
  relatedProjectId: string | null;
};

type W1aRuntime = AppRuntime & {
  previewWatchDirections: () => Promise<{ memoryCount: number }>;
  suggestWatchDirections: () => Promise<{
    searchConfigured: boolean;
    directions: WatchDirection[];
  }>;
  followWatchDirection: (input: {
    question: string;
    publicDescription: string;
    relatedGoalId: string | null;
    relatedProjectId: string | null;
  }) => Promise<unknown>;
  skipWatchDirection: (input: { question: string; publicDescription: string }) => Promise<unknown>;
};

let dir: string;
let db: CoreDatabase;
let provider: FakeProvider;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-w1a-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  provider = new FakeProvider('w1a');
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runtime(opts: { searchConfigured?: boolean } = {}) {
  const items = new ItemService(db);
  const projects = new ProjectService(db);
  const search = { search: async () => ({ results: [] }) } as unknown as WebSearchExecutor;
  const research = new ResearchChecker(db, undefined, {}, () =>
    opts.searchConfigured ? search : undefined,
  );
  const rt = Object.create(AppRuntime.prototype) as W1aRuntime;
  Object.assign(rt, {
    db,
    items,
    projects,
    research,
    logger: { warn: () => undefined, info: () => undefined },
    getProvider: () => provider,
  });
  return { rt, items, projects, research };
}

/** 提炼出来、还没被你采纳的 AI 建议（said_by = ai，未确认）。 */
function aiAdvice(items: ItemService, projectId: string, statement: string, adopted = false) {
  const it = items.createManual({ projectId, type: 'goal', statement, rationale: null });
  db.prepare("UPDATE items SET origin = 'ai', said_by = 'ai', confirmation = ? WHERE id = ?").run(
    adopted ? 'confirmed' : 'none',
    it.id,
  );
  return it;
}

const sentText = () =>
  `${provider.structuredCalls[0]!.system}\n${provider.structuredCalls[0]!.user}`;

it('条件 2：只发有效的目标、约束和项目；没采纳的 AI 建议、被拒绝的、已结束的、别的记忆都不发；最多 40 条取最近的', async () => {
  const { rt, items, projects } = runtime();
  const p = projects.create({ name: '析衍桌面', rootPath: null, description: '本地助手' });
  // 50 条较早的填充目标：超过 40 条时它们里旧的被挤掉
  for (let i = 0; i < 50; i++) {
    const f = items.createManual({
      projectId: p.id,
      type: 'goal',
      statement: `填充目标 ${i}`,
      rationale: null,
    });
    db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(
      `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      f.id,
    );
  }
  items.createManual({
    projectId: p.id,
    type: 'goal',
    statement: '想做一个全天记录的个人助理',
    rationale: null,
  });
  items.createManual({
    projectId: p.id,
    type: 'constraint',
    statement: '不把真实日记发到网上',
    rationale: null,
  });
  aiAdvice(items, p.id, '采纳过的 AI 建议可以发', true);
  aiAdvice(items, p.id, '没采纳的 AI 建议不该发给模型');
  const rejected = items.createManual({
    projectId: p.id,
    type: 'goal',
    statement: '被拒绝的目标不该发',
    rationale: null,
  });
  items.reject(rejected.id);
  const ended = items.createManual({
    projectId: p.id,
    type: 'goal',
    statement: '已经结束的目标不该发',
    rationale: null,
  });
  items.setTimeStatus(ended.id, 'ended');
  items.createManual({
    projectId: p.id,
    type: 'preference',
    statement: '喜欢深色主题，这条不该发给模型',
    rationale: null,
  });

  const preview = await rt.previewWatchDirections();
  expect(preview.memoryCount).toBe(40);

  provider.enqueueStructured({ directions: [] });
  await rt.suggestWatchDirections();
  expect(provider.structuredCalls).toHaveLength(1);
  const sent = sentText();
  expect(sent).toContain('想做一个全天记录的个人助理');
  expect(sent).toContain('不把真实日记发到网上');
  expect(sent).toContain('采纳过的 AI 建议可以发');
  expect(sent).toContain('析衍桌面');
  expect(sent).toContain('本地助手');
  for (const not of ['没采纳的 AI 建议', '被拒绝的目标', '已经结束的目标', '喜欢深色主题']) {
    expect(sent).not.toContain(not);
  }
  // 40 条 = 3 条新的 + 37 条最近的填充（最早的 0–12 被挤掉）
  const fillers = [...sent.matchAll(/填充目标 (\d+)/g)].map((m) => Number(m[1]));
  expect(new Set(fillers)).toEqual(new Set(Array.from({ length: 37 }, (_, i) => i + 13)));
});

it('条件 3：模型返回的格式坏了就报错、什么都不返回；超过 5 个只留 5 个', async () => {
  const { rt, items, projects } = runtime();
  const p = projects.create({ name: '机器人观察', rootPath: null, description: null });
  items.createManual({
    projectId: p.id,
    type: 'goal',
    statement: '关注人形机器人',
    rationale: null,
  });

  provider.enqueueStructured({ nope: true });
  await expect(rt.suggestWatchDirections()).rejects.toThrow();
  provider.enqueueStructured({ directions: [{ question: '缺对外检索描述' }] });
  await expect(rt.suggestWatchDirections()).rejects.toThrow();

  provider.enqueueStructured({
    directions: Array.from({ length: 7 }, (_, i) => ({
      question: `方向 ${i} 的内部问题`,
      publicDescription: `topic ${i} ${'abcdefghij'.slice(i)} news`,
      why: [],
    })),
  });
  const r = await rt.suggestWatchDirections();
  expect(r.directions).toHaveLength(5);
});

it('条件 3：依据按记忆编号对回原文，认不出的编号丢掉；关联目标取依据里第一条目标，项目取它的项目', async () => {
  const { rt, items, projects } = runtime();
  const p = projects.create({ name: '机器人观察', rootPath: null, description: null });
  const constraint = items.createManual({
    projectId: p.id,
    type: 'constraint',
    statement: '预算一万以内',
    rationale: null,
  });
  const goal = items.createManual({
    projectId: p.id,
    type: 'goal',
    statement: '关注人形机器人',
    rationale: null,
  });
  provider.enqueueStructured({
    directions: [
      {
        question: '一万以内能买到的人形机器人（我在观察这个方向）',
        publicDescription: 'affordable humanoid robots',
        why: [constraint.id, 'not-a-real-id', goal.id],
      },
    ],
  });
  const r = await rt.suggestWatchDirections();
  expect(r.directions).toHaveLength(1);
  const d = r.directions[0]!;
  expect(d.basis.map((b) => b.statement)).toEqual(['预算一万以内', '关注人形机器人']);
  expect(d.relatedGoalId).toBe(goal.id);
  expect(d.relatedProjectId).toBe(p.id);
});

it('条件 4：关注后研究主题已启用、一天一次、关联目标与项目；搜索没配置时只看来源', async () => {
  const { rt, items, projects, research } = runtime({ searchConfigured: false });
  const p = projects.create({ name: '机器人观察', rootPath: null, description: null });
  const goal = items.createManual({
    projectId: p.id,
    type: 'goal',
    statement: '关注人形机器人',
    rationale: null,
  });
  await rt.followWatchDirection({
    question: '人形机器人有哪些新进展（我在做本地助手）',
    publicDescription: 'humanoid robot news',
    relatedGoalId: goal.id,
    relatedProjectId: p.id,
  });
  const topics = research.store.listTopics();
  expect(topics).toHaveLength(1);
  expect(topics[0]).toMatchObject({
    public_description: 'humanoid robot news',
    related_goal_id: goal.id,
    related_project_id: p.id,
    enabled: true,
    interval_ms: 86_400_000,
    paid_budget_mode: 'none',
  });
});

it('条件 4：搜索已配置时，每天最多搜 3 次', async () => {
  const { rt, research } = runtime({ searchConfigured: true });
  await rt.followWatchDirection({
    question: '能跑本地大模型的手机',
    publicDescription: 'phones that run local LLMs',
    relatedGoalId: null,
    relatedProjectId: null,
  });
  expect(research.store.listTopics()[0]).toMatchObject({
    enabled: true,
    interval_ms: 86_400_000,
    paid_budget_mode: 'request_cap',
    request_cap: 3,
  });
});

it('条件 5：拒绝过的相似方向、已有同名研究主题，再提时不显示；拒绝重启后仍记得', async () => {
  const { rt, research } = runtime();
  await rt.skipWatchDirection({
    question: '关注人形机器人最新进展',
    publicDescription: 'humanoid robot news',
  });
  research.createTopic({
    question: '能跑本地大模型的手机',
    publicDescription: 'on-device llm phones',
    sources: [],
  });
  const again = () =>
    provider.enqueueStructured({
      directions: [
        { question: '关注人形机器人最新进展', publicDescription: 'humanoid robot news', why: [] },
        {
          question: '人形机器人最近有什么新样机',
          publicDescription: 'humanoid robot news similar',
          why: [],
        },
        { question: '能跑本地大模型的手机', publicDescription: 'on-device llm phones', why: [] },
        { question: '全天智记工具', publicDescription: 'all-day personal logging tools', why: [] },
      ],
    });
  again();
  const r = await rt.suggestWatchDirections();
  expect(r.directions.map((d) => d.publicDescription)).toEqual(['all-day personal logging tools']);

  // 拒绝记在库里（app_settings），换一个运行时实例照样认得
  const { rt: rt2 } = runtime();
  again();
  const r2 = await rt2.suggestWatchDirections();
  expect(r2.directions.map((d) => d.publicDescription)).toEqual(['all-day personal logging tools']);
});
