import type { ResearchFinding, ResearchRun, ResearchTopic } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { fetchApprovedSource, type FetchDeps } from './fetchApproved.js';
import { parseFeed, parsePage } from './parse.js';
import { ResearchStore } from './researchStore.js';
import { assertPublicHttpsUrl } from './urlSafety.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const RUN_LEASE_MS = 5 * 60 * 1000;
const INJECTION_HINT =
  /upload your (files|data)|run this command|curl |powershell |rm -rf|ignore previous|system prompt/i;

export interface CheckResult {
  run: ResearchRun;
  findings: ResearchFinding[];
  mode: 'approved-sources-only';
  searchUsed: false;
}

/**
 * 第一版研究检查：只读用户批准的来源。不调用搜索 API，不把网页指令当授权。
 */
export class ResearchChecker {
  readonly store: ResearchStore;
  private running = false;

  constructor(
    private readonly db: CoreDatabase,
    private readonly clock: Clock = systemClock,
    private readonly fetchDeps: FetchDeps = {},
  ) {
    this.store = new ResearchStore(db);
  }

  createTopic(input: Parameters<ResearchStore['createTopic']>[0]): ResearchTopic {
    return this.store.createTopic({ ...input, now: this.iso() });
  }

  /** 立即检查。未启用的主题也可手动跑一次（不偷偷开启自动监控）。 */
  async checkNow(topicId: string): Promise<CheckResult> {
    if (this.running || this.store.runningCount() > 0) {
      throw new IxaError(ErrorCodes.CONFLICT, '全局同时只允许一个研究任务运行');
    }
    const topic = this.store.getTopic(topicId);
    if (topic.paused) {
      throw new IxaError(ErrorCodes.DISABLED, '该关注已暂停');
    }
    return this.runTopic(topic, { scheduled: false });
  }

  /**
   * 调度一次到期主题。错过的周期合并为一次，不补跑所有旧轮次。
   * 返回 null 表示没有到期任务或未启用。
   */
  async tick(): Promise<CheckResult | null> {
    if (this.running || this.store.runningCount() > 0) return null;
    const due = this.store.dueTopics(this.iso());
    if (due.length === 0) return null;
    return this.runTopic(due[0]!, { scheduled: true });
  }

  private async runTopic(topic: ResearchTopic, opts: { scheduled: boolean }): Promise<CheckResult> {
    if (opts.scheduled && (!topic.enabled || topic.paused)) {
      throw new IxaError(ErrorCodes.DISABLED, '未启用或已暂停的关注不会自动发请求');
    }
    this.running = true;
    const now = this.iso();
    const generation = topic.generation;
    const run = this.store.startRun(topic.id, now, this.lease());
    const findings: ResearchFinding[] = [];
    let pages = 0;
    let error: string | null = null;
    try {
      const sources = this.store.listSources(topic.id);
      if (sources.length === 0) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, '没有批准来源，不能声称已搜索全网');
      }
      for (const src of sources) {
        if (pages >= topic.max_pages_per_run) break;
        if (this.store.getTopic(topic.id).generation !== generation) {
          throw new IxaError(ErrorCodes.JOB_CANCELLED, '关注已暂停/撤权，晚到结果作废');
        }
        try {
          const fetched = await fetchApprovedSource(src.url, this.fetchDeps);
          pages += 1;
          const entries =
            src.kind === 'feed'
              ? parseFeed(fetched.body, fetched.finalUrl)
              : [parsePage(fetched.body, fetched.finalUrl)];
          let anyNew = false;
          for (const entry of entries) {
            if (INJECTION_HINT.test(entry.excerpt) || INJECTION_HINT.test(entry.title)) {
              // 网页诱导上传/执行：当数据，不当授权
              continue;
            }
            let entryUrl = entry.url;
            try {
              entryUrl = assertPublicHttpsUrl(
                new URL(entry.url, fetched.finalUrl).toString(),
              ).toString();
            } catch {
              continue;
            }
            const inserted = this.store.insertFinding({
              topicId: topic.id,
              sourceId: src.id,
              title: entry.title,
              url: entryUrl,
              excerpt: entry.excerpt,
              fingerprint: entry.fingerprint,
              claimedPublishedAt: entry.claimedPublishedAt,
              fetchedAt: now,
              relatedGoalId: topic.related_goal_id,
              relatedProjectId: topic.related_project_id,
              expectedGeneration: generation,
            });
            if (inserted) {
              anyNew = true;
              findings.push(inserted);
              this.store.markNotified(inserted.id);
            }
          }
          this.store.updateSourceCheck(src.id, {
            ok: true,
            fingerprint: entries[0]?.fingerprint ?? null,
            now,
          });
          void anyNew;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.store.updateSourceCheck(src.id, { ok: false, error: msg, now });
          error = msg;
        }
      }
      const still = this.store.getTopic(topic.id);
      if (still.generation !== generation) {
        this.store.finishRun(run.id, {
          status: 'cancelled',
          pagesFetched: pages,
          findingsNew: findings.length,
          error: '晚到结果作废',
          now: this.iso(),
        });
        return {
          run: this.store.getRun(run.id),
          findings: [],
          mode: 'approved-sources-only',
          searchUsed: false,
        };
      }
      if (pages === 0) {
        const fail = error ?? '没有成功读取任何批准来源';
        this.store.markFailure(topic.id, now, fail, topic.interval_ms);
        this.store.finishRun(run.id, {
          status: 'failed',
          pagesFetched: 0,
          findingsNew: 0,
          error: fail,
          now,
        });
      } else {
        this.store.markSuccess(topic.id, now, topic.interval_ms);
        if (error) {
          this.db
            .prepare(
              'UPDATE research_topics SET last_failure = ?, last_failure_at = ? WHERE id = ?',
            )
            .run(error.slice(0, 500), now, topic.id);
        }
        this.store.finishRun(run.id, {
          status: 'succeeded',
          pagesFetched: pages,
          findingsNew: findings.length,
          error,
          now,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.markFailure(topic.id, now, msg, topic.interval_ms);
      this.store.finishRun(run.id, {
        status:
          err instanceof IxaError && err.code === ErrorCodes.JOB_CANCELLED ? 'cancelled' : 'failed',
        pagesFetched: pages,
        findingsNew: findings.length,
        error: msg,
        now: this.iso(),
      });
    } finally {
      this.running = false;
    }
    return {
      run: this.store.getRun(run.id),
      findings,
      mode: 'approved-sources-only',
      searchUsed: false,
    };
  }

  private iso(): string {
    return this.clock.now().toISOString();
  }

  private lease(): string {
    return new Date(this.clock.now().getTime() + RUN_LEASE_MS).toISOString();
  }
}
