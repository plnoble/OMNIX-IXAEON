/**
 * MP3d：编码任务的一串候选（按顺序换下一个，5 分钟内先跳过刚不行的）。
 */
import type { CodingExecutor, ExecutorReport, ExecutorRunOptions } from './executor.js';
import type { CodingTask } from '@ixaeon/contracts';
import { EXECUTOR_CHANNEL_FILE, hashWorkspace } from './executor.js';
import { acceptableFallback, reasonText } from '../models/fallbackRules.js';

export interface CodingCandidate {
  key: string;
  label: string;
  executor: CodingExecutor | null;
}

export interface CodingChainOptions {
  /** 键 → 到期毫秒数；由运行时持有，保存编码候选 / 供应商 / 开发工具位置时清空。 */
  skip: Map<string, number>;
  now?: () => number;
}

function sameHash(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

const QUOTA = ['usage_limit_reached', 'rate_limit_exceeded', 'session limit'];

function looksQuota(text: string): boolean {
  const lower = text.toLowerCase();
  return QUOTA.some((p) => lower.includes(p));
}

function reasonOf(err: unknown, report: ExecutorReport | null): string | null {
  const raw = report
    ? `${String(report.summary ?? '')} ${String((report as { raw?: unknown }).raw ?? '')}`
    : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (looksQuota(msg) || looksQuota(raw)) return '额度用完';
  if (err && acceptableFallback(err)) return reasonText(err);
  return null;
}

export class CodingChainExecutor implements CodingExecutor {
  private currentName = '';
  constructor(
    private readonly candidates: () => CodingCandidate[],
    private readonly opts: CodingChainOptions,
  ) {
    this.currentName = this.firstAvailable()?.executor?.name ?? '';
  }

  get name(): string {
    return this.currentName;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** 5 分钟内刚不行的排到最后（不删）。 */
  private ordered(): CodingCandidate[] {
    const list = this.candidates();
    const now = this.now();
    const fresh = list.filter((c) => (this.opts.skip.get(c.key) ?? 0) <= now);
    const cooling = list.filter((c) => (this.opts.skip.get(c.key) ?? 0) > now);
    return [...fresh, ...cooling];
  }

  private firstAvailable(): CodingCandidate | null {
    return this.ordered().find((c) => c.executor) ?? null;
  }

  async run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
    const order = this.ordered();
    const failures: Array<{ label: string; reason: string }> = [];
    for (let i = 0; i < order.length; i += 1) {
      const candidate = order[i]!;
      if (!candidate.executor) continue; // 没找到 / 解析不出：跳过，不算失败
      const before = hashWorkspace(workspace);
      void EXECUTOR_CHANNEL_FILE;
      let report: ExecutorReport | null = null;
      try {
        report = await candidate.executor.run(task, workspace, signal, options);
      } catch (err) {
        if (signal.aborted) throw err;
        const after = hashWorkspace(workspace);
        if (!sameHash(after, before)) throw err; // 工作区改过了：不换，不叠半截改动
        const reason = reasonOf(err, null);
        if (!reason) {
          if (failures.length > 0) {
            failures.push({
              label: candidate.label,
              reason: (err instanceof Error ? err.message : '失败') || '失败',
            });
            break;
          }
          throw err;
        }
        failures.push({ label: candidate.label, reason });
        this.opts.skip.set(candidate.key, this.now() + 5 * 60_000);
        continue;
      }
      const after = hashWorkspace(workspace);
      if (!report.claimedSuccess) {
        if (!sameHash(after, before)) {
          this.currentName = candidate.executor.name;
          return report;
        }
        const reason = reasonOf(null, report);
        if (!reason) {
          if (failures.length > 0) {
            failures.push({ label: candidate.label, reason: '没做完' });
            break;
          }
          this.currentName = candidate.executor.name;
          return report;
        }
        failures.push({ label: candidate.label, reason });
        this.opts.skip.set(candidate.key, this.now() + 5 * 60_000);
        continue;
      }
      this.currentName = candidate.executor.name;
      if (failures.length > 0) {
        const first = failures[0]!;
        return {
          ...report,
          summary: `「${first.label}」这次不行（${first.reason}），由替补「${candidate.label}」来做${report.summary ? `；${report.summary}` : ''}`,
        };
      }
      return report;
    }
    this.currentName = order[order.length - 1]?.executor?.name ?? this.currentName;
    const tried = failures.map((f) => `「${f.label}」：${f.reason}`).join('；');
    throw new Error(tried ? `试过的候选：${tried}` : '没有可用的候选');
  }
}
