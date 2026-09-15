import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonRpcStdio,
  locateHermes,
  hermesSpawnEnv,
  hermesGatewayArgs,
  openDatabase,
  migrate,
  type CoreDatabase,
} from '../../src/index.js';
import { ContextSelector } from '../../src/memory/contextSelector.js';
import {
  MEMORY_EVAL_SCENARIOS,
  seedCorpus,
  type MemoryEvalScenario,
} from '../../src/memory/evalScenarios.js';

/**
 * B2/§9.1 记忆评测真实模型三轮（门槛：相关召回 ≥90%、无关不侵入 ≥95%、
 * 一次性要求不升为长期约束 ≥95%；每轮单独算，波动如实落盘）。
 *
 * 运行条件：IXAEON_REAL_HERMES=1（用户专属 Hermes，锁定 v2026.9.11，
 * provider 用户 2026-09-12 配置）。消耗用户网关额度，默认跳过。
 *
 * 与确定性评测**同源**（不允许评测另写近似实现——2026-09-13 第一版教训：
 * 评测自写 SQL 漏掉 modelMayReadItem 披露过滤、字段映射失真，导致未披露
 * 条目入料、材料缺料，已废弃重跑）：
 * - 语料：seedCorpus（与 runDeterministicMemoryEval 同一函数）
 * - 可见条目：loadModelVisibleItems（含披露/权限/归档过滤，与 AskService 同路径）
 * - 检索选择：selectRelevantItems（与 AskService 同一函数）
 * - 会话：每场景独立 session.create/close（与产品 ask 一问一会话一致）
 *
 * 已知噪声（如实记录不掩盖）：Hermes 引擎自身的系统上下文/技能示例可能
 * 进入回答（第一版观察到 CORS/Tokio 类示例文本）；评分按关键词对语料事实
 * 判定，原始回答全量落盘供人工复核。
 */

const run = process.env.IXAEON_REAL_HERMES === '1';
const ROUNDS = Number(process.env.IXAEON_MEMORY_EVAL_ROUNDS ?? '3');
const OUT_DIR =
  process.env.IXAEON_MEMORY_EVAL_OUT ?? join(process.cwd(), 'docs', 'memory-eval-2026-09-13');

/** 语料区分关键词（合成语料唯一标记；命中=回答引用了该事实）。 */
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

/** 临时要求（p5 红色主题仅本次 / p6 今天不跑步）被升格为长期说法的措辞。 */
const PROMOTION_PHRASES = ['以后都用红色', '以后都用', '长期用红色', '以后不再跑步', '以后都不'];

interface ScenarioOutcome {
  scenarioId: string;
  category: string;
  answer: string;
  missingRecall: string[];
  intruded: string[];
  promoted: boolean;
  passed: boolean;
}

/**
 * 问句回声规则（2026-09-13 三轮实测后加入，对已存原始回答离线重评分验证）：
 * 问句本身出现的关键词不构成证据（双向）——模型正确否定边界时会复述问句词
 * （如「自由泳学得怎么样了？」→「材料中没有关于自由泳的记录」被误判侵入 p3；
 * 「跑步和马拉松的目标？」→答句复述「跑步」被误判侵入 p6）；
 * 反之问句含关键词时也不能作为召回证据（无法区分复述与真正引用材料）。
 */
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

function scoreScenario(
  scenario: MemoryEvalScenario,
  answer: string,
): { missingRecall: string[]; intruded: string[] } {
  const recallEvidence = evidenceKeys(scenario, scenario.expectRecallKeys);
  const missingRecall = recallEvidence
    .filter(({ kws }) => !kws.some((kw) => answer.includes(kw)))
    .map(({ key }) => key);
  const silentEvidence = evidenceKeys(scenario, scenario.expectSilentKeys);
  const intruded = silentEvidence
    .filter(({ kws }) => kws.some((kw) => answer.includes(kw)))
    .map(({ key }) => key);
  return { missingRecall, intruded };
}

/** 构建与生产 AskService / Hermes 完全同源的上下文选材（走 ContextSelector 生产路径）。 */
function buildContextPackage(
  db: CoreDatabase,
  scenario: MemoryEvalScenario,
  projectIds: Record<string, string>,
): string {
  const projectId =
    scenario.perspective !== null ? (projectIds[scenario.perspective] ?? null) : null;
  const selector = new ContextSelector(db);
  const selection = selector.selectForQuestion(scenario.question, projectId);
  if (selection.items.length === 0) {
    return '（当前问题没有相关已披露记忆。请直接依据常识简短回答，不要编造用户偏好或约束。）';
  }
  const lines = selection.items.map((s) => `- [${s.type}] ${s.statement}`);
  return ['以下是与本次问题相关的用户记忆（已获披露）：', ...lines].join('\n');
}

/** 一次会话一个场景：session.create → prompt.submit → message.complete → session.close。 */
function runScenario(
  rpc: JsonRpcStdio,
  scenario: MemoryEvalScenario,
  context: string,
  round: number,
): Promise<{ answer: string }> {
  return new Promise((resolve, reject) => {
    let sessionId: string | null = null;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      rpc.removeListener('notification', onNotification);
      if (sessionId) {
        try {
          rpc.notify('session.close', { session_id: sessionId });
        } catch {
          // 尽力收尾
        }
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`场景 ${scenario.id} 超时（150s）`));
    }, 150_000);
    const onNotification = (method: string, params: unknown): void => {
      const p = params as
        { type?: string; payload?: { text?: string; status?: string } } | undefined;
      if (method !== 'event' || !p?.type || settled) return;
      if (p.type === 'message.complete') {
        settled = true;
        cleanup();
        resolve({ answer: p.payload?.text ?? '' });
      } else if (p.type === 'error') {
        settled = true;
        cleanup();
        reject(new Error(`网关错误: ${JSON.stringify(p.payload).slice(0, 300)}`));
      }
    };
    rpc.on('notification', onNotification);
    void rpc
      .request('session.create', { cols: 120 }, 60_000)
      .then((created) => {
        sessionId = (created as { session_id?: string }).session_id ?? null;
        if (!sessionId) throw new Error('session.create 未返回 session_id');
        return rpc.request(
          'prompt.submit',
          {
            session_id: sessionId,
            text:
              `${context}\n\n` +
              `问题：${scenario.question}\n\n` +
              `要求：只依据上面提供的用户记忆回答本次问题；材料里没有的就明说没有，` +
              `不要编造用户的偏好、目标或约束，也不要引入与本问题无关的背景知识或示例。` +
              `这是第 ${round} 轮评测的独立提问，与其他提问无关。用中文简短回答。`,
          },
          140_000,
        );
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

describe.skipIf(!run)('B2 记忆评测：真实模型三轮（§9.1 门槛，同源路径）', () => {
  it(
    `三轮完整评测（${ROUNDS}×60 场景，每场景独立会话，语料/检索与确定性评测同源）`,
    async () => {
      const locator = locateHermes();
      expect(locator.found).toBe(true);
      expect(locator.cwd).toBeTruthy();

      mkdirSync(OUT_DIR, { recursive: true });
      // 记录评测固定信息（模型/配置/检索版本口径）
      writeFileSync(
        join(OUT_DIR, 'meta.json'),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            engine: 'Hermes v2026.9.11（锁定安装，专属目录）',
            provider: 'custom → 用户自建 OpenAI 兼容网关（用户 2026-09-12 配置）',
            corpus: '合成语料（seedCorpus，与确定性评测同源）',
            retrieval: 'loadModelVisibleItems + selectRelevantItems（与 AskService 同路径）',
            sessionMode: '每场景独立会话（与产品 ask 一问一会话一致）',
            knownNoise:
              'Hermes 引擎自身系统上下文/技能示例可能进入回答；按语料关键词评分，原始回答全量落盘',
            thresholds: { recall: 0.9, nonIntrusion: 0.95, ephemeralNonPromotion: 0.95 },
          },
          null,
          2,
        ),
        'utf8',
      );

      const child = spawn(locator.exe!, hermesGatewayArgs(), {
        cwd: locator.cwd ?? undefined,
        env: { ...process.env, ...hermesSpawnEnv(locator) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const rpc = new JsonRpcStdio(child.stdout!, child.stdin!);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等 gateway.ready 超时（60s）')), 60_000);
          rpc.on('notification', (method: string, params: unknown) => {
            const p = params as { type?: string } | undefined;
            if (method === 'event' && p?.type === 'gateway.ready') {
              clearTimeout(timer);
              resolve();
            }
          });
          child.on('exit', () => {
            clearTimeout(timer);
            reject(new Error('网关进程提前退出'));
          });
        });

        const report: Array<Record<string, unknown>> = [];
        for (let round = 1; round <= ROUNDS; round++) {
          // 每轮全新合成库（seedCorpus 只能播种一次）
          const dir = mkdtempSync(join(tmpdir(), `memeval-r${round}-`));
          const db = openDatabase(join(dir, 'eval.db'));
          migrate(db);
          const { projectIds } = seedCorpus(db);

          const outcomes: ScenarioOutcome[] = [];
          const jsonlPath = join(OUT_DIR, `round-${round}-outcomes.jsonl`);
          for (const scenario of MEMORY_EVAL_SCENARIOS) {
            const context = buildContextPackage(db, scenario, projectIds);
            let answer = '';
            try {
              const result = await runScenario(rpc, scenario, context, round);
              answer = result.answer;
            } catch (err) {
              answer = `[评估执行失败] ${String(err)}`;
            }
            const { missingRecall, intruded } = scoreScenario(scenario, answer);
            const promoted =
              scenario.category === 'ephemeral' &&
              PROMOTION_PHRASES.some((ph) => answer.includes(ph));
            const passed = missingRecall.length === 0 && intruded.length === 0 && !promoted;
            const outcome: ScenarioOutcome = {
              scenarioId: scenario.id,
              category: scenario.category,
              answer,
              missingRecall,
              intruded,
              promoted,
              passed,
            };
            outcomes.push(outcome);
            // 每场景即时落盘（中断不丢已完成部分）
            appendFileSync(jsonlPath, JSON.stringify(outcome) + '\n', 'utf8');
            writeFileSync(
              join(OUT_DIR, 'progress.txt'),
              `round ${round}: ${outcomes.length}/60（${scenario.id}）\n`,
              'utf8',
            );
          }

          // 每轮指标
          const byCat = new Map<string, { total: number; passed: number }>();
          for (const o of outcomes) {
            const c = byCat.get(o.category) ?? { total: 0, passed: 0 };
            c.total += 1;
            if (o.passed) c.passed += 1;
            byCat.set(o.category, c);
          }
          const catRates = [...byCat.entries()].map(([cat, v]) => ({
            category: cat,
            passed: v.passed,
            total: v.total,
          }));
          const recall = byCat.get('relevant_recall')!;
          const unrelated = byCat.get('unrelated_topic')!;
          const ephemeral = byCat.get('ephemeral')!;
          const roundReport = {
            round,
            overall: `${outcomes.filter((o) => o.passed).length}/${outcomes.length}`,
            categories: catRates,
            recallRate: recall.passed / recall.total,
            nonIntrusionRate: unrelated.passed / unrelated.total,
            ephemeralNonPromotionRate: ephemeral.passed / ephemeral.total,
          };
          report.push(roundReport);
          writeFileSync(
            join(OUT_DIR, `round-${round}-summary.json`),
            JSON.stringify(roundReport, null, 2),
            'utf8',
          );

          db.close();
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Windows 句柄延迟：尽力清理
          }
        }

        writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(report, null, 2), 'utf8');

        // 门槛检查（每轮单独算；波动如实落盘，不取最好一轮）
        for (const r of report) {
          expect(r.recallRate).toBeGreaterThanOrEqual(0.9);
          expect(r.nonIntrusionRate).toBeGreaterThanOrEqual(0.95);
          expect(r.ephemeralNonPromotionRate).toBeGreaterThanOrEqual(0.95);
        }
        // 每轮 60 个场景全跑满（缺场景=评测不完整，如实失败）
        for (const r of report) {
          const jsonl = readFileSync(
            join(OUT_DIR, `round-${String(r.round)}-outcomes.jsonl`),
            'utf8',
          );
          expect(jsonl.split('\n').filter((l) => l.trim().length > 0).length).toBe(60);
        }
      } finally {
        child.kill();
      }
    },
    // 每场景最坏 150s + 会话开销；全量 3×60 场景，上限 50 分钟
    (ROUNDS * 60 * 160 + 300) * 1000,
  );
});
