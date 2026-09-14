import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_EVAL_SCENARIOS, type MemoryEvalScenario } from '../../src/memory/evalScenarios.js';

/**
 * B2 三轮真实模型评测的离线重评分（2026-09-13）。
 *
 * 背景：首轮评分器的关键词匹配把「问句回声」误判为侵入/召回——模型正确否定
 * 权限边界时复述问句词汇（pm1/pm2/pm8/r4 实证：问句含「自由泳/外发/跑步」，
 * 模型答「材料中没有…记录」被记为侵入）。评分器已加入问句回声规则（问句中
 * 出现的关键词双向不构成证据）。
 *
 * 本测试**不发任何模型请求**：读取 docs/memory-eval-2026-09-13/round-*-outcomes.jsonl
 * 中全量原始回答，用修正后的规则重评分，落盘 corrected-summary.json 供验收
 * 对照表引用；原始 JSONL 保持不动（原始口径与修正口径并列可查，不覆盖）。
 * 若原始数据文件缺失则跳过（评测探针尚未跑过）。
 */

const OUT_DIR =
  process.env.IXAEON_MEMORY_EVAL_OUT ?? join(process.cwd(), 'docs', 'memory-eval-2026-09-13');

const KEY_FACTS: Record<string, string[]> = {
  p1: ['本地优先'],
  p2: ['中文'],
  p3: ['自由泳'],
  p4: ['外发'],
  p5: ['红色主题'],
  p6: ['跑步'],
  a1: ['桌面问答', '真实引擎'],
  a2: ['编码任务'],
  b1: ['花园浇水', '浇水计划'],
  b2: ['雨水收集'],
  c1: ['半程马拉松'],
  correctionOld: ['深色主题'],
  correctionNew: ['浅色主题'],
};

const PROMOTION_PHRASES = ['以后都用红色', '以后都用', '长期用红色', '以后不再跑步', '以后都不'];

interface RawOutcome {
  scenarioId: string;
  category: string;
  answer: string;
  missingRecall: string[];
  intruded: string[];
  promoted: boolean;
  passed: boolean;
}

function evidenceKeys(
  scenario: MemoryEvalScenario,
  keys: string[],
): Array<{ key: string; kws: string[] }> {
  const out: Array<{ key: string; kws: string[] }> = [];
  for (const k of keys) {
    const kws = (KEY_FACTS[k] ?? []).filter((kw) => !scenario.question.includes(kw));
    if (kws.length > 0) out.push({ key: k, kws });
  }
  return out;
}

interface RescoreResult {
  missingRecall: string[];
  intruded: string[];
  unscoreable?: boolean;
  rejectReason?: string;
}

const ERROR_PATTERNS = [
  /IxaError/i,
  /API error/i,
  /ECONNREFUSED/i,
  /SERVER_UNAVAILABLE/i,
  /模型未配置/i,
  /网络超时/i,
];

const NEGATION_PATTERNS = [
  /没有.*约束/i,
  /没有任何.*要求/i,
  /无要求/i,
  /没有提到/i,
  /未提及/i,
  /没有相关信息/i,
  /不存在.*约束/i,
];

function rescore(scenario: MemoryEvalScenario, answer: string): RescoreResult {
  const trimmed = answer.trim();

  // Q01：空回答 → 必答全缺失
  if (trimmed.length === 0) {
    return { missingRecall: [...scenario.expectRecallKeys], intruded: [] };
  }

  // A07 反例 1：报错/异常回答 → 直接判定未通过，不进入关键词匹配
  if (ERROR_PATTERNS.some((p) => p.test(trimmed))) {
    return {
      missingRecall: [...scenario.expectRecallKeys],
      intruded: [],
      rejectReason: 'execution_error',
    };
  }

  // A07 反例 2：照抄问句（回答与问句完全一致，无额外答案内容）
  if (trimmed === scenario.question.trim()) {
    return {
      missingRecall: [...scenario.expectRecallKeys],
      intruded: [],
      rejectReason: 'verbatim_echo',
    };
  }

  // A07 反例 3：否认事实（回答明确说「没有/未提及」，但期望召回该事实）
  const deniesFact =
    scenario.expectRecallKeys.length > 0 &&
    NEGATION_PATTERNS.some((p) => p.test(trimmed)) &&
    trimmed.length < 40;
  if (deniesFact) {
    return {
      missingRecall: [...scenario.expectRecallKeys],
      intruded: [],
      rejectReason: 'denied_fact',
    };
  }

  const missingRecall = evidenceKeys(scenario, scenario.expectRecallKeys)
    .filter(({ kws }) => !kws.some((kw) => answer.includes(kw)))
    .map(({ key }) => key);
  const intruded = evidenceKeys(scenario, scenario.expectSilentKeys)
    .filter(({ kws }) => kws.some((kw) => answer.includes(kw)))
    .map(({ key }) => key);
  return { missingRecall, intruded };
}

describe('B2 三轮评测离线重评分（问句回声规则；不发模型请求）', () => {
  it('用修正规则重算三轮原始回答并落盘 corrected-summary.json', () => {
    if (!existsSync(join(OUT_DIR, 'round-1-outcomes.jsonl'))) {
      console.warn('未找到评测原始数据（探针未运行），跳过重评分');
      return;
    }
    const byId = new Map(MEMORY_EVAL_SCENARIOS.map((s) => [s.id, s]));
    const corrected: Array<Record<string, unknown>> = [];
    for (let round = 1; round <= 3; round++) {
      const path = join(OUT_DIR, `round-${round}-outcomes.jsonl`);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as RawOutcome);
      expect(raw.length).toBe(60);
      const rescored = raw.map((o) => {
        const scenario = byId.get(o.scenarioId);
        expect(scenario).toBeTruthy();
        const { missingRecall, intruded } = rescore(scenario!, o.answer);
        const promoted =
          scenario!.category === 'ephemeral' &&
          PROMOTION_PHRASES.some((ph) => o.answer.includes(ph));
        return {
          scenarioId: o.scenarioId,
          category: scenario!.category,
          rawPassed: o.passed,
          correctedPassed: missingRecall.length === 0 && intruded.length === 0 && !promoted,
          changed: o.passed !== (missingRecall.length === 0 && intruded.length === 0 && !promoted),
          missingRecall,
          intruded,
          promoted,
        };
      });
      const byCat = new Map<string, { total: number; passed: number }>();
      for (const o of rescored) {
        const c = byCat.get(o.category) ?? { total: 0, passed: 0 };
        c.total += 1;
        if (o.correctedPassed) c.passed += 1;
        byCat.set(o.category, c);
      }
      const recall = byCat.get('relevant_recall')!;
      const unrelated = byCat.get('unrelated_topic')!;
      const ephemeral = byCat.get('ephemeral')!;
      const summary = {
        round,
        overallCorrected: `${rescored.filter((o) => o.correctedPassed).length}/60`,
        categories: [...byCat.entries()].map(([cat, v]) => ({
          category: cat,
          passed: v.passed,
          total: v.total,
        })),
        recallRate: recall.passed / recall.total,
        nonIntrusionRate: unrelated.passed / unrelated.total,
        ephemeralNonPromotionRate: ephemeral.passed / ephemeral.total,
        changedScenarios: rescored.filter((o) => o.changed).map((o) => o.scenarioId),
      };
      corrected.push(summary);
      writeFileSync(
        join(OUT_DIR, `round-${round}-corrected.json`),
        JSON.stringify(summary, null, 2),
        'utf8',
      );
    }
    expect(corrected.length).toBe(3);
    writeFileSync(
      join(OUT_DIR, 'corrected-summary.json'),
      JSON.stringify(corrected, null, 2),
      'utf8',
    );
    // 修正只可能把「问句回声」型失败翻成通过；不允许把通过翻成失败
    // （若出现，说明规则改动影响了既有通过判定，必须人工复查）
    for (const round of corrected) {
      const raw = readFileSync(join(OUT_DIR, `round-${String(round.round)}-outcomes.jsonl`), 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as RawOutcome);
      const rawPassedCount = raw.filter((o) => o.passed).length;
      const correctedCount = Number(String(round.overallCorrected).split('/')[0]);
      expect(correctedCount).toBeGreaterThanOrEqual(rawPassedCount);
    }
  });

  describe('A07 评分器反例扩充（不可评分/异常/否认/照抄）', () => {
    const mockScenario: MemoryEvalScenario = {
      id: 'r6',
      category: 'relevant_recall',
      question: '编码任务的约束是什么？',
      perspective: 'A',
      expectRecallKeys: ['a2'],
      expectSilentKeys: ['p3'],
    };

    it('Q01 空回答：必答全缺失', () => {
      const res = rescore(mockScenario, '');
      expect(res.missingRecall).toEqual(['a2']);
      expect(res.intruded).toEqual([]);
    });

    it('Q02 报错/异常回答：直接标记未通过', () => {
      const res = rescore(mockScenario, 'IxaError: MODEL_NOT_CONFIGURED 模型未配置');
      expect(res.missingRecall).toEqual(['a2']);
      expect(res.rejectReason).toBe('execution_error');
    });

    it('Q03 照抄问句：记为缺失', () => {
      const res = rescore(mockScenario, '编码任务的约束是什么？');
      expect(res.missingRecall).toEqual(['a2']);
      expect(res.rejectReason).toBe('verbatim_echo');
    });

    it('Q04 否认事实：回答「没有约束」不因去词误判通过', () => {
      const res = rescore(mockScenario, '项目中没有任何约束和要求。');
      expect(res.missingRecall).toEqual(['a2']);
      expect(res.rejectReason).toBe('denied_fact');
    });

    it('正常正确召回：命中关键词正常通过', () => {
      const res = rescore(mockScenario, '当前项目中编码任务需要经过用户显式批准。');
      expect(res.missingRecall).toEqual([]);
      expect(res.intruded).toEqual([]);
    });
  });
});
