/**
 * W1a 验收条件 2、4、5：docs/委派/W1a-关注方向.md
 * 2. 确认后发给模型的只有有效目标、约束、项目，不含没采纳的 AI 建议和其他个人记忆，最多 40。
 * 4. 「关注」建出研究主题：一天间隔、关联目标/项目、已启用；搜索没配置时 budget none。
 * 5. 「不关注」后再提同样或相似方向不显示；已有同名研究主题也不显示。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeProvider,
  ItemService,
  ProjectService,
  ResearchStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

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

function runtime() {
  const items = new ItemService(db);
  const projects = new ProjectService(db);
  const research = new ResearchStore(db);
  const rt = Object.create(AppRuntime.prototype) as AppRuntime & {
    suggestWatchDirections: () => Promise<{
      searchConfigured: boolean;
      directions: Array<{ question: string; publicDescription: string; why: string[] }>;
    }>;
    followWatchDirection: (input: {
      question: string;
      publicDescription: string;
      relatedGoalId?: string | null;
      relatedProjectId?: string | null;
    }) => Promise<unknown>;
    skipWatchDirection: (input: {
      question: string;
      publicDescription: string;
    }) => Promise<unknown>;
    previewWatchDirections: () => Promise<{ memoryCount: number }>;
  };
  Object.assign(rt, {
    db,
    items,
    projects,
    research,
    logger: { warn: () => undefined, info: () => undefined },
    getProvider: () => provider,
    getWebSearchExecutor: () => null,
    config: { webSearch: null },
  });
  return { rt, items, projects, research };
}

const FIVE = Array.from({ length: 5 }, (_, i) => ({
  question: `内部方向 ${i} 带用户背景`,
  publicDescription: `人形机器人进展 ${i}`,
  why: ['m1'],
}));

it('条件 2：发给模型的只有有效目标、约束、项目名与描述，最多 40，不含 AI 建议和其他记忆', async () => {
  const { rt, items, projects } = runtime();
  const p = projects.create({ name: '析衍桌面', rootPath: null, description: '本地助手' });
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
  items.createManual({
    projectId: p.id,
    type: 'preference',
    statement: '喜欢深色主题，这条不该发给模型',
    rationale: null,
  });
  items.createAssistantSuggestion({
    projectId: p.id,
    type: 'open_loop',
    statement: '没采纳的 AI 建议不该发给模型',
    rationale: null,
  });
  for (let i = 0; i < 50; i++) {
    items.createManual({
      projectId: p.id,
      type: 'goal',
      statement: `填充目标 ${i}`,
      rationale: null,
    });
  }
  provider.enqueueStructured({ directions: FIVE });
  await rt.suggestWatchDirections();
  expect(provider.structuredCalls).toHaveLength(1);
  const sent = `${provider.structuredCalls[0]!.system}\n${provider.structuredCalls[0]!.user}`;
  expect(sent).toContain('想做一个全天记录的个人助理');
  expect(sent).toContain('不把真实日记发到网上');
  expect(sent).toContain('析衍桌面');
  expect(sent).not.toContain('喜欢深色主题');
  expect(sent).not.toContain('没采纳的 AI 建议');
  const goalHits = sent.match(/填充目标 /g) ?? [];
  expect(goalHits.length).toBeLessThanOrEqual(40);
});

it('条件 4：关注后主题已启用；一天间隔；搜索没配置时 none；关联第一条目标', async () => {
  const { rt, items, projects, research } = runtime();
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
  const topics = research.listTopics();
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

it('条件 5：拒绝过的相似方向、已有同名主题，再提时不显示', async () => {
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
  provider.enqueueStructured({
    directions: [
      {
        question: '关注人形机器人最新进展',
        publicDescription: 'humanoid robot news',
        why: [],
      },
      {
        question: '人形机器人最近有什么新样机',
        publicDescription: 'humanoid robot news similar',
        why: [],
      },
      {
        question: '能跑本地大模型的手机',
        publicDescription: 'on-device llm phones',
        why: [],
      },
      {
        question: '全天智记工具',
        publicDescription: 'all-day personal logging tools',
        why: [],
      },
    ],
  });
  const r = await rt.suggestWatchDirections();
  expect(r.directions.map((d) => d.publicDescription)).toEqual(['all-day personal logging tools']);
});
