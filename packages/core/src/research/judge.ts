import type { ResearchTopic } from '@ixaeon/contracts';
import type { ModelProvider } from '../extraction/model/provider.js';

/**
 * A08（审核 2026-09-13）：研究条目模型研读与价值判断。
 * 解决「找到条目就落发现、研究问题未作为推理输入、无模型研读/比较/价值判断」的问题。
 */

export interface ResearchJudgment {
  /** 是否与研究问题实质相关并有信息增量。 */
  relevant: boolean;
  /** 研读后的结构化核心发现摘要（针对研究问题的答案，非原始 HTML 摘录）。 */
  summary: string;
  /** 对关联目标的实际价值/影响说明。 */
  valueAnalysis: string;
  /** 置信度 0.0 - 1.0 */
  confidence: number;
}

const INJECTION_HINT =
  /upload your (files|data)|run this command|curl |powershell |rm -rf|ignore previous|system prompt/i;

/** 简单分词与关键词提取。 */
function extractTokens(text: string): string[] {
  const cjk = text.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  const ascii = text.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  const list = [...cjk, ...ascii].map((t) => t.toLowerCase());
  // 常见监控场景中英文映射
  if (/版本|新版|发布/.test(text)) list.push('release', 'version', 'v1');
  if (/更新|动态/.test(text)) list.push('update', 'feed');
  return list;
}

/**
 * 研读器：有模型时用模型推理研读，无模型时用严格规则研读兜底。
 */
export class ResearchJudge {
  constructor(
    private readonly provider?:
      | ModelProvider
      | null
      | (() => ModelProvider | null | undefined),
  ) {}

  private get activeProvider(): ModelProvider | null {
    if (typeof this.provider === 'function') {
      return this.provider() ?? null;
    }
    return this.provider ?? null;
  }

  async judge(
    topic: ResearchTopic,
    entry: { title: string; url: string; excerpt: string },
  ): Promise<ResearchJudgment> {
    const text = `${entry.title}\n${entry.excerpt}`;

    // 安全防御：注入提示词直接判定无效
    if (INJECTION_HINT.test(text)) {
      return {
        relevant: false,
        summary: '',
        valueAnalysis: '内容包含诱导性指令，已安全忽略',
        confidence: 0,
      };
    }

    // 1. 若配置了模型提供商，走模型推理研读
    const prov = this.activeProvider;
    if (prov) {
      try {
        const system =
          '你是一个严谨的研究助理。请根据研究主题与研究问题，研读网络资料并做出结构化价值判断。输出有效 JSON。';
        const user = `研究问题/重点：${topic.question || topic.public_description || '获取最新相关进展'}
公开描述：${topic.public_description}

资料标题：${entry.title}
资料来源：${entry.url}
资料摘录：
${entry.excerpt.slice(0, 1500)}

请以 JSON 格式输出：
{
  "relevant": true/false,
  "summary": "针对该研究问题的核心事实或结论提炼（1-2句话）",
  "valueAnalysis": "该发现对目标的参考价值",
  "confidence": 0.0-1.0
}`;
        const res = await prov.chatText({ system, user });
        const jsonMatch = res.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Partial<ResearchJudgment>;
          if (typeof parsed.relevant === 'boolean' && typeof parsed.summary === 'string') {
            return {
              relevant: parsed.relevant && (parsed.confidence ?? 0.8) >= 0.5,
              summary: parsed.summary.trim() || entry.title,
              valueAnalysis: parsed.valueAnalysis ?? '',
              confidence: parsed.confidence ?? 0.8,
            };
          }
        }
      } catch {
        /* 模型调用失败时回退到规则研读 */
      }
    }

    // 2. 规则研读兜底（无模型或模型失败时）
    const question = (
      topic.question ? `${topic.question} ${topic.public_description}` : topic.public_description
    ).toLowerCase();
    const qTokens = extractTokens(question);
    const entryTokens = extractTokens(text);

    if (qTokens.length === 0) {
      // 未写具体问题，默认只要有实质内容就算相关
      return {
        relevant: entry.excerpt.trim().length > 20,
        summary: entry.excerpt.slice(0, 200).trim() || entry.title,
        valueAnalysis: '匹配公开描述领域',
        confidence: 0.6,
      };
    }

    // 计算问题关键词重合度
    const hits = qTokens.filter((token) => entryTokens.some((et) => et.includes(token)));
    const matchRatio = hits.length / qTokens.length;
    const isRelevant = hits.length >= 1 || matchRatio >= 0.2;

    return {
      relevant: isRelevant,
      summary: entry.excerpt.slice(0, 200).trim() || entry.title,
      valueAnalysis: isRelevant
        ? `命中研究关注点（${hits.slice(0, 3).join(', ')}）`
        : '未实质命中研究问题',
      confidence: isRelevant ? 0.7 : 0.2,
    };
  }
}
