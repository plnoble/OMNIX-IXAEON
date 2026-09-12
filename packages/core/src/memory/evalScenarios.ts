import type { CoreDatabase } from '../db/database.js';
import { ProjectService } from '../projects.js';
import { ItemService } from '../storage/itemStore.js';
import { modelMayReadItem } from '../access.js';
import { selectRelevantItems } from '../storage/askStore.js';

/**
 * 计划 §9.1 记忆质量评测的起始门槛（B0 固定，B2 扩展）。
 *
 * 这里只做**与模型无关的确定性子集**：检索选择器（selectRelevantItems，
 * 与 AskService 同一路径）、一次性要求降格、权限过滤、纠正链。
 * ≥90% 召回 / ≥95% 不侵入等指标需要真实模型独立跑三轮，本文件不冒充。
 */

export type EvalCategory =
  | 'relevant_recall'
  | 'unrelated_topic'
  | 'ephemeral'
  | 'negation_correction'
  | 'cross_project'
  | 'permission';

export interface MemoryEvalScenario {
  id: string;
  category: EvalCategory;
  question: string;
  /** 提问视角：null=个人视角，'A'|'B'|'C'=项目视角 */
  perspective: string | null;
  expectRecallKeys: string[];
  expectSilentKeys: string[];
  note?: string;
}

export interface MemoryEvalFailure {
  scenarioId: string;
  missing: string[];
  intruded: string[];
}

export interface MemoryEvalCategoryResult {
  category: EvalCategory;
  total: number;
  passed: number;
  failures: MemoryEvalFailure[];
}

export interface MemoryEvalReport {
  generatedAt: string;
  scenarioCount: number;
  corpusCount: number;
  categories: MemoryEvalCategoryResult[];
  /** 已知词法限制：如实记录，不靠改期望掩盖 */
  knownLimitations: string[];
  modelRunNote: string;
}

/**
 * 共享语料：三个项目 + 个人条目。p1/p2/p5/p6 已披露给模型；
 * p3/p4 未披露（权限类场景用）。correction-old 为 AI 旧推断，
 * 被用户纠正为 correction-new。
 */
const CORPUS = {
  personal: [
    {
      key: 'p1',
      statement: '长期做一个本地优先的个人助手',
      type: 'goal' as const,
      disclosed: true,
    },
    { key: 'p2', statement: '回复一律用中文', type: 'preference' as const, disclosed: true },
    { key: 'p3', statement: '今年学会自由泳', type: 'goal' as const, disclosed: false },
    {
      key: 'p4',
      statement: '不要在未批准时外发我的聊天原文',
      type: 'constraint' as const,
      disclosed: false,
    },
    {
      key: 'p5',
      statement: '这次会议用红色主题，仅本次',
      type: 'open_loop' as const,
      disclosed: true,
    },
    {
      key: 'p6',
      statement: '今天先不跑步，明天再说',
      type: 'open_loop' as const,
      disclosed: true,
    },
  ],
  projects: {
    A: [
      { key: 'a1', statement: '把桌面问答接到真实引擎', type: 'goal' as const },
      { key: 'a2', statement: '编码任务必须先经我批准', type: 'constraint' as const },
    ],
    B: [
      { key: 'b1', statement: '整理花园浇水计划', type: 'goal' as const },
      { key: 'b2', statement: '浇花只用雨水收集的水', type: 'constraint' as const },
    ],
    C: [{ key: 'c1', statement: '三个月内完成半程马拉松', type: 'goal' as const }],
  },
  correctionOld: '界面用深色主题好看',
  correctionNew: '界面默认浅色主题',
};

export const MEMORY_EVAL_SCENARIOS: MemoryEvalScenario[] = [
  // --- 相关召回（10） ---
  {
    id: 'r1',
    category: 'relevant_recall',
    question: '你目前理解我想做什么？',
    perspective: null,
    expectRecallKeys: ['p1'],
    expectSilentKeys: ['p3', 'p5'],
  },
  {
    id: 'r2',
    category: 'relevant_recall',
    question: '析衍助手的桌面问答要接什么？',
    perspective: 'A',
    expectRecallKeys: ['a1'],
    expectSilentKeys: ['b1'],
  },
  {
    id: 'r3',
    category: 'relevant_recall',
    question: '花园浇水有什么计划？',
    perspective: 'B',
    expectRecallKeys: ['b1'],
    expectSilentKeys: ['a1'],
  },
  {
    id: 'r4',
    category: 'relevant_recall',
    question: '跑步和马拉松的目标是什么？',
    perspective: null,
    expectRecallKeys: ['c1'],
    expectSilentKeys: ['p6'],
  },
  {
    id: 'r5',
    category: 'relevant_recall',
    question: '我对回复语言有什么偏好？',
    perspective: null,
    expectRecallKeys: ['p2'],
    expectSilentKeys: [],
  },
  {
    id: 'r6',
    category: 'relevant_recall',
    question: '编码任务的约束是什么？',
    perspective: 'A',
    expectRecallKeys: ['a2'],
    expectSilentKeys: ['b2'],
  },
  {
    id: 'r7',
    category: 'relevant_recall',
    question: '这次会议定了什么主题？',
    perspective: null,
    expectRecallKeys: ['p5'],
    expectSilentKeys: [],
  },
  {
    id: 'r8',
    category: 'relevant_recall',
    question: '界面主题最终定了什么？',
    perspective: 'A',
    expectRecallKeys: ['correctionNew'],
    expectSilentKeys: ['correctionOld'],
  },
  {
    id: 'r9',
    category: 'relevant_recall',
    question: '半程马拉松准备得如何？',
    perspective: 'C',
    expectRecallKeys: ['c1'],
    expectSilentKeys: ['a1'],
  },
  {
    id: 'r10',
    category: 'relevant_recall',
    question: '浇花能用什么水？',
    perspective: 'B',
    expectRecallKeys: ['b2'],
    expectSilentKeys: ['a2'],
  },

  // --- 无关话题不侵入（10） ---
  {
    id: 'u1',
    category: 'unrelated_topic',
    question: '最近天气怎么样？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6', 'p3', 'p4'],
  },
  {
    id: 'u2',
    category: 'unrelated_topic',
    question: '量子计算的最新进展？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u3',
    category: 'unrelated_topic',
    question: '附近有什么好吃的餐厅？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u4',
    category: 'unrelated_topic',
    question: '世界杯夺冠热门是谁？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u5',
    category: 'unrelated_topic',
    question: '怎么煮一杯手冲咖啡？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u6',
    category: 'unrelated_topic',
    question: '火星探测器到哪了？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u7',
    category: 'unrelated_topic',
    question: '股票大盘最近走势如何？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u8',
    category: 'unrelated_topic',
    question: '推荐一部电影？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u9',
    category: 'unrelated_topic',
    question: '什么是傅里叶变换？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },
  {
    id: 'u10',
    category: 'unrelated_topic',
    question: '公交卡在哪里办理？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p1', 'p2', 'p5', 'p6'],
  },

  // --- 一次性要求不升格（10） ---
  {
    id: 'e1',
    category: 'ephemeral',
    question: '我长期的主题偏好是什么？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p5'],
  },
  {
    id: 'e2',
    category: 'ephemeral',
    question: '以后开会的默认主题色？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p5'],
  },
  {
    id: 'e3',
    category: 'ephemeral',
    question: '今天的安排是什么？',
    perspective: null,
    expectRecallKeys: ['p6'],
    expectSilentKeys: [],
  },
  {
    id: 'e4',
    category: 'ephemeral',
    question: '明天的锻炼计划怎么安排？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p6', 'p5'],
    note: '「计划」词法命中花园计划属已知词法噪音；本场景只断言一次性要求被压下',
  },
  {
    id: 'e5',
    category: 'ephemeral',
    question: '这次演示用了什么配色？',
    perspective: null,
    expectRecallKeys: ['p5'],
    expectSilentKeys: [],
  },
  {
    id: 'e6',
    category: 'ephemeral',
    question: '界面颜色有长期偏好吗？',
    perspective: 'A',
    expectRecallKeys: ['correctionNew'],
    expectSilentKeys: ['correctionOld'],
  },
  {
    id: 'e7',
    category: 'ephemeral',
    question: '长期看我希望助手怎么发展？',
    perspective: null,
    expectRecallKeys: ['p1'],
    expectSilentKeys: ['p5', 'p6'],
  },
  {
    id: 'e8',
    category: 'ephemeral',
    question: '今晚吃什么好？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p5', 'p6'],
  },
  {
    id: 'e9',
    category: 'ephemeral',
    question: '会议还定了别的一次性要求吗？',
    perspective: null,
    expectRecallKeys: ['p5'],
    expectSilentKeys: [],
  },
  {
    id: 'e10',
    category: 'ephemeral',
    question: '下周的锻炼打算？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p6'],
  },

  // --- 否定与纠正（10） ---
  {
    id: 'n1',
    category: 'negation_correction',
    question: '深色界面还算数吗？',
    perspective: 'A',
    expectRecallKeys: ['correctionNew'],
    expectSilentKeys: ['correctionOld'],
  },
  {
    id: 'n2',
    category: 'negation_correction',
    question: '之前说界面用深色，现在呢？',
    perspective: 'A',
    expectRecallKeys: ['correctionNew'],
    expectSilentKeys: ['correctionOld'],
  },
  {
    id: 'n3',
    category: 'negation_correction',
    question: '编码前需要我做什么？',
    perspective: 'A',
    expectRecallKeys: ['a2'],
    expectSilentKeys: [],
  },
  {
    id: 'n4',
    category: 'negation_correction',
    question: '编码任务有什么不要做的约束？',
    perspective: 'A',
    expectRecallKeys: ['a2'],
    expectSilentKeys: ['b2'],
  },
  {
    id: 'n5',
    category: 'negation_correction',
    question: '浇花用水有什么约束？',
    perspective: 'B',
    expectRecallKeys: ['b2'],
    expectSilentKeys: ['a2'],
  },
  {
    id: 'n6',
    category: 'negation_correction',
    question: '马拉松目标改过吗？',
    perspective: 'C',
    expectRecallKeys: ['c1'],
    expectSilentKeys: [],
  },
  {
    id: 'n7',
    category: 'negation_correction',
    question: '深色界面是长期偏好吗？',
    perspective: 'A',
    expectRecallKeys: ['correctionNew'],
    expectSilentKeys: ['correctionOld'],
  },
  {
    id: 'n8',
    category: 'negation_correction',
    question: '浇花的水源有什么要求？',
    perspective: 'B',
    expectRecallKeys: ['b2'],
    expectSilentKeys: ['a2'],
  },
  {
    id: 'n9',
    category: 'negation_correction',
    question: '没经我批准能派编码任务吗？',
    perspective: 'A',
    expectRecallKeys: ['a2'],
    expectSilentKeys: [],
  },
  {
    id: 'n10',
    category: 'negation_correction',
    question: '界面配色纠正过吗？',
    perspective: 'A',
    expectRecallKeys: ['correctionNew'],
    expectSilentKeys: ['correctionOld'],
  },

  // --- 跨项目（10） ---
  {
    id: 'x1',
    category: 'cross_project',
    question: '花园的计划是什么？',
    perspective: 'B',
    expectRecallKeys: ['b1'],
    expectSilentKeys: ['a1'],
  },
  {
    id: 'x2',
    category: 'cross_project',
    question: '析衍的问答目标是什么？',
    perspective: 'A',
    expectRecallKeys: ['a1'],
    expectSilentKeys: ['b1'],
  },
  {
    id: 'x3',
    category: 'cross_project',
    question: '健身的目标是什么？',
    perspective: 'C',
    expectRecallKeys: ['c1'],
    expectSilentKeys: ['a1', 'b1'],
  },
  {
    id: 'x4',
    category: 'cross_project',
    question: '个人助手和桌面问答有什么共同点？',
    perspective: null,
    expectRecallKeys: ['p1', 'a1'],
    expectSilentKeys: ['b1'],
  },
  {
    id: 'x5',
    category: 'cross_project',
    question: '浇水和马拉松训练有冲突吗？',
    perspective: null,
    expectRecallKeys: ['b1', 'c1'],
    expectSilentKeys: ['a1'],
  },
  {
    id: 'x6',
    category: 'cross_project',
    question: '跟雨水有关的限制是什么？',
    perspective: null,
    expectRecallKeys: ['b2'],
    expectSilentKeys: ['a2'],
  },
  {
    id: 'x7',
    category: 'cross_project',
    question: '哪些项目在做桌面产品？',
    perspective: null,
    expectRecallKeys: ['a1'],
    expectSilentKeys: ['b1', 'c1'],
  },
  {
    id: 'x8',
    category: 'cross_project',
    question: '花园和健身哪个更急？',
    perspective: null,
    expectRecallKeys: ['b1'],
    expectSilentKeys: ['a1', 'c1'],
    note: '健身与马拉松无词法重叠：已知词法限制，语义召回待模型/LanceDB',
  },
  {
    id: 'x9',
    category: 'cross_project',
    question: '批准编码这件事在花园项目里适用吗？',
    perspective: 'B',
    expectRecallKeys: ['b1'],
    expectSilentKeys: ['a2'],
  },
  {
    id: 'x10',
    category: 'cross_project',
    question: '助手项目里有什么约束？',
    perspective: 'A',
    expectRecallKeys: ['a2'],
    expectSilentKeys: ['b2'],
  },

  // --- 权限（10） ---
  {
    id: 'pm1',
    category: 'permission',
    question: '自由泳学得怎么样了？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p3'],
  },
  {
    id: 'pm2',
    category: 'permission',
    question: '聊天原文能外发吗？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p4'],
  },
  {
    id: 'pm3',
    category: 'permission',
    question: '我今年想学什么？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p3'],
  },
  {
    id: 'pm4',
    category: 'permission',
    question: '复述一条我的私人目标？',
    perspective: null,
    expectRecallKeys: ['p1'],
    expectSilentKeys: ['p3'],
  },
  {
    id: 'pm5',
    category: 'permission',
    question: '中文回复是长期偏好吗？',
    perspective: null,
    expectRecallKeys: ['p2'],
    expectSilentKeys: ['p3', 'p4'],
  },
  {
    id: 'pm6',
    category: 'permission',
    question: '助手项目能读到我的个人目标吗？',
    perspective: 'A',
    expectRecallKeys: ['a1'],
    expectSilentKeys: ['p1'],
  },
  {
    id: 'pm7',
    category: 'permission',
    question: '游泳学会了没有？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p3'],
  },
  {
    id: 'pm8',
    category: 'permission',
    question: '自由泳进展如何？',
    perspective: null,
    expectRecallKeys: [],
    expectSilentKeys: ['p3'],
  },
  {
    id: 'pm9',
    category: 'permission',
    question: '未批准就把我的聊天发出去会怎样？',
    perspective: null,
    expectRecallKeys: ['a2'],
    expectSilentKeys: ['p4'],
  },
  {
    id: 'pm10',
    category: 'permission',
    question: '今天先不做什么？',
    perspective: null,
    expectRecallKeys: ['p6'],
    expectSilentKeys: ['p3'],
  },
];

function seedCorpus(db: CoreDatabase): {
  statementByKey: Map<string, string>;
  projectIds: Record<'A' | 'B' | 'C', string>;
} {
  const projects = new ProjectService(db);
  const items = new ItemService(db);
  const statementByKey = new Map<string, string>();
  const projectIds = {
    A: projects.create({ name: '析衍助手', rootPath: null, description: null }).id,
    B: projects.create({ name: '花园', rootPath: null, description: null }).id,
    C: projects.create({ name: '健身', rootPath: null, description: null }).id,
  } as Record<'A' | 'B' | 'C', string>;
  for (const p of CORPUS.personal) {
    const item = items.createManual({
      projectId: null,
      scope: 'personal',
      type: p.type,
      statement: p.statement,
      rationale: null,
    });
    if (p.disclosed) {
      items.grantDisclosure({ itemId: item.id, audience: 'model', note: '评测语料披露' });
    }
    statementByKey.set(p.key, p.statement);
  }
  for (const [proj, list] of Object.entries(CORPUS.projects)) {
    for (const it of list) {
      const item = items.createManual({
        projectId: projectIds[proj as 'A' | 'B' | 'C']!,
        type: it.type,
        statement: it.statement,
        rationale: null,
      });
      statementByKey.set(it.key, it.statement);
    }
  }
  const old = items.createAssistantSuggestion({
    projectId: projectIds['A']!,
    type: 'open_loop',
    statement: CORPUS.correctionOld,
    rationale: '演示推断（待纠正）',
  });
  items.correct({
    itemId: old.id,
    userText: CORPUS.correctionNew,
    newType: 'preference',
    projectId: projectIds['A']!,
  });
  statementByKey.set('correctionOld', CORPUS.correctionOld);
  statementByKey.set('correctionNew', CORPUS.correctionNew);
  return { statementByKey, projectIds };
}

/** 与 AskService 相同的候选查询 + 模型可见性过滤。 */
function loadModelVisibleItems(
  db: CoreDatabase,
  projectId: string | null,
): Array<{ id: string; statement: string; type: string; origin: string; confirmation: string }> {
  const rows = db
    .prepare(
      `SELECT i.id, i.type, i.statement, i.state, i.origin, i.updated_at,
              i.extracted_from_source_id, i.confirmation, i.project_id, i.scope, i.rationale
       FROM items i
       LEFT JOIN sources src_i ON src_i.id = i.extracted_from_source_id
       WHERE i.state IN ('current', 'disputed') AND i.shelved_at IS NULL
         AND i.confirmation != 'rejected'
         AND (src_i.archived_at IS NULL OR i.origin = 'user'
              OR (i.origin = 'ai' AND i.type = 'project_summary'
                  AND i.rationale LIKE '归档经验摘要%'))
         ${projectId !== null ? 'AND i.project_id = ?' : ''}
       ORDER BY CASE WHEN i.origin = 'user' THEN 0 ELSE 1 END, i.updated_at DESC`,
    )
    .all(...(projectId !== null ? [projectId] : [])) as Array<{
    id: string;
    statement: string;
    type: string;
    origin: string;
    confirmation: string;
  }>;
  return rows.filter((r) => modelMayReadItem(db, r.id));
}

/**
 * 跑确定性子集。语料为合成数据（计划允许）；结果只代表检索选择器行为，
 * 不代表 ≥90%/95% 的模型指标已达成。
 */
export function runDeterministicMemoryEval(db: CoreDatabase): MemoryEvalReport {
  const { statementByKey, projectIds } = seedCorpus(db);

  const byCategory = new Map<EvalCategory, MemoryEvalCategoryResult>();
  for (const scenario of MEMORY_EVAL_SCENARIOS) {
    if (!byCategory.has(scenario.category)) {
      byCategory.set(scenario.category, {
        category: scenario.category,
        total: 0,
        passed: 0,
        failures: [],
      });
    }
    const cat = byCategory.get(scenario.category)!;
    cat.total += 1;
    const projectId =
      scenario.perspective !== null
        ? (projectIds[scenario.perspective as 'A' | 'B' | 'C'] ?? null)
        : null;
    const visible = loadModelVisibleItems(db, projectId);
    const selected = selectRelevantItems(visible, scenario.question, projectId);
    const selectedStatements = new Set(selected.map((s) => s.statement));
    const missing = scenario.expectRecallKeys
      .map((k) => statementByKey.get(k) ?? k)
      .filter((stmt) => !selectedStatements.has(stmt));
    const intruded = scenario.expectSilentKeys
      .map((k) => statementByKey.get(k) ?? k)
      .filter((stmt) => selectedStatements.has(stmt));
    if (missing.length === 0 && intruded.length === 0) {
      cat.passed += 1;
    } else {
      cat.failures.push({ scenarioId: scenario.id, missing, intruded });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    scenarioCount: MEMORY_EVAL_SCENARIOS.length,
    corpusCount: statementByKey.size,
    categories: [...byCategory.values()],
    knownLimitations: MEMORY_EVAL_SCENARIOS.filter((s) => s.note).map((s) => `${s.id}: ${s.note}`),
    modelRunNote:
      '本报告只覆盖确定性子集（检索选择器/降格/权限/纠正链）。≥90% 召回、≥95% 不侵入等门槛需真实模型独立三轮，尚未运行，不冒充达成。',
  };
}
