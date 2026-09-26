/**
 * W2：研究的发现与搜索候选显示中文。
 *
 * 发给模型的只有网页上的公开文字（发现的标题与摘录、候选的标题与摘要）。
 * 不带主题的内部问题、出门说法、用户的记忆或要求——那些可能含用户背景。
 * 中文为主的不发、不写，界面照旧显示原文。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';

const CJK = /[一-鿿]/gu;

/** 去掉空白后中文字符占比 ≥ 30% 算中文为主。空文本不算。 */
export function isMostlyChinese(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  if (compact.length === 0) return false;
  const cjk = compact.match(CJK)?.length ?? 0;
  return cjk / compact.length >= 0.3;
}

const TITLE_LIMIT = 40;
const SUMMARY_LIMIT = 120;
const EXCERPT_LIMIT = 800;
const BATCH_SIZE = 10;

const translationSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      title_zh: z.string(),
      summary_zh: z.string(),
    }),
  ),
});

const SYSTEM = [
  '把下面每条网页内容译成中文。',
  '逐条返回 title_zh（不超过 40 字的中文标题）和 summary_zh（不超过 120 字的中文摘要）。',
  '摘要只根据给出的摘录写，不添加摘录里没有的内容。',
  '只输出 JSON：{"items":[{"id":"…","title_zh":"…","summary_zh":"…"}]}',
].join('');

interface PendingFinding {
  id: string;
  title: string;
  excerpt: string;
}

/** 这个主题里还没翻、且标题加摘录不是中文为主的发现。 */
function pendingFindings(db: CoreDatabase, topicId: string): PendingFinding[] {
  const rows = db
    .prepare(
      `SELECT id, title, excerpt FROM research_findings
        WHERE topic_id = ? AND title_zh IS NULL`,
    )
    .all(topicId) as PendingFinding[];
  return rows.filter((r) => !isMostlyChinese(`${r.title}${r.excerpt}`));
}

/**
 * 翻译一个主题里还没翻的英文发现。
 * 没配模型、模型出错：什么都不写，不抛错，下次检查再试。
 */
export async function translateFindings(
  db: CoreDatabase,
  provider: ModelProvider | null,
  topicId: string,
): Promise<void> {
  const pending = pendingFindings(db, topicId);
  if (pending.length === 0 || !provider) return;
  const update = db.prepare(
    'UPDATE research_findings SET title_zh = ?, summary_zh = ? WHERE id = ? AND title_zh IS NULL',
  );
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const allowed = new Set(batch.map((f) => f.id));
    let out: z.infer<typeof translationSchema>;
    try {
      out = await provider.chatStructured({
        system: SYSTEM,
        user: batch
          .map((f) => `id：${f.id}\n标题：${f.title}\n摘录：${f.excerpt.slice(0, EXCERPT_LIMIT)}`)
          .join('\n\n'),
        schema: translationSchema,
      });
    } catch {
      continue;
    }
    for (const item of out.items) {
      const title = item.title_zh.trim().slice(0, TITLE_LIMIT);
      if (!allowed.has(item.id) || title.length === 0) continue;
      update.run(title, item.summary_zh.trim().slice(0, SUMMARY_LIMIT), item.id);
    }
  }
}

export interface TranslatableCandidate {
  title: string;
  url: string;
  snippet: string;
  titleZh?: string | null;
  snippetZh?: string | null;
}

/**
 * 不是中文为主的候选合成一次调用，翻标题和摘要。
 * 失败时两项为空，候选照常返回。候选不入库。
 */
export async function translateCandidates<T extends TranslatableCandidate>(
  provider: ModelProvider | null,
  candidates: T[],
): Promise<T[]> {
  const need = candidates.filter((c) => !isMostlyChinese(`${c.title}${c.snippet}`));
  if (need.length === 0 || !provider) return candidates;
  // 候选不入库、没有自己的 id，这里临时编号，只为对上模型逐条返回的译文。
  const byId = new Map<string, T>(need.map((c) => [randomUUID(), c]));
  try {
    const out = await provider.chatStructured({
      system: SYSTEM,
      user: [...byId.entries()]
        .map(([id, c]) => `id：${id}\n标题：${c.title}\n摘录：${c.snippet.slice(0, EXCERPT_LIMIT)}`)
        .join('\n\n'),
      schema: translationSchema,
    });
    for (const item of out.items) {
      const candidate = byId.get(item.id);
      const title = item.title_zh.trim().slice(0, TITLE_LIMIT);
      if (!candidate || title.length === 0) continue;
      candidate.titleZh = title;
      candidate.snippetZh = item.summary_zh.trim().slice(0, SUMMARY_LIMIT);
    }
  } catch {
    /* 翻译失败：两项保持为空，候选照常返回 */
  }
  return candidates;
}
