import type { ResearchFinding, ResearchRun, ResearchTopic } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { fetchApprovedSource, type FetchDeps } from './fetchApproved.js';
import { parseFeed, parsePage } from './parse.js';
import { isSpaOrDynamicSkeleton } from './tinyfishFetch.js';
import { ResearchStore } from './researchStore.js';
import { assertPublicHttpsUrl } from './urlSafety.js';
import { sanitizePublicQuery } from '../memory/querySanitize.js';
import type { WebSearchExecutor, WebSearchHit } from './webSearch.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import { ResearchJudge } from './judge.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const RUN_LEASE_MS = 5 * 60 * 1000;
const INJECTION_HINT =
  /upload your (files|data)|run this command|curl |powershell |rm -rf|ignore previous|system prompt/i;
/**
 * S2-04（审核 2026-09-15）：重整计划 §6.3 起始上限——每轮（每次检查运行）
 * 模型研读最多调用 8 次。与搜索预算（request_cap）相互独立：
 * 搜索预算只控制搜索，模型调用上限控制研读；「0 次搜索」不等于「0 次模型调用」。
 */
export const MAX_MODEL_CALLS_PER_RUN = 8;

/** 搜索返回的候选 URL：不是发现，等用户批准后才成为来源（计划：搜索→批准→抓取）。 */
export interface SearchCandidate {
  title: string;
  url: string;
  snippet: string;
}

export interface CheckResult {
  run: ResearchRun;
  findings: ResearchFinding[];
  mode: 'approved-sources-only' | 'approved-sources-plus-search';
  searchUsed: boolean;
  /** 本轮搜索候选（仅手动检查返回；空数组=未搜索或无结果） */
  searchCandidates: SearchCandidate[];
  /** 搜索失败不毁掉批准来源轮次，如实带回 */
  searchError: string | null;
}

/**
 * 研究检查：读用户批准的来源；配置了搜索执行器且主题写了公开描述时，
 * 额外做一次受控搜索并返回候选 URL（不落 findings——批准后才成为来源）。
 * 不把网页指令当授权。
 */
export class ResearchChecker {
  readonly store: ResearchStore;
  private running = false;
  private readonly judge: ResearchJudge;

  constructor(
    private readonly db: CoreDatabase,
    private readonly clock: Clock = systemClock,
    private readonly fetchDeps: FetchDeps = {},
    /** 惰性提供：每次检查时重新解析当前配置（保存 Key 后无需重启） */
    private readonly webSearchProvider?: () => WebSearchExecutor | undefined,
    modelProvider?: ModelProvider | null | (() => ModelProvider | null | undefined),
  ) {
    this.store = new ResearchStore(db);
    this.judge = new ResearchJudge(modelProvider);
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

  /** 搜索是否可用（设置页配置 + Key 解密成功）。 */
  get searchAvailable(): boolean {
    return this.resolveWebSearch() !== undefined;
  }

  private resolveWebSearch(): WebSearchExecutor | undefined {
    return this.webSearchProvider?.();
  }

  /**
   * 受控搜索：仅当主题写了公开描述（出门说法）才外发；查询再过一遍本地脱敏。
   * 结果是候选 URL，不是发现——用户批准后才成为来源。
   * attempted=false 表示没有外发（未配置/未写公开描述/脱敏后为空）。
   */
  private async searchCandidates(
    topic: ResearchTopic,
  ): Promise<{ attempted: boolean; candidates: SearchCandidate[]; error: string | null }> {
    const webSearch = this.resolveWebSearch();
    if (!webSearch || topic.public_description.trim().length === 0) {
      return { attempted: false, candidates: [], error: null };
    }
    const sanitized = sanitizePublicQuery(topic.public_description);
    if (!sanitized.query) {
      return { attempted: false, candidates: [], error: null };
    }
    try {
      const outcome = await webSearch.search(sanitized.query, 5);
      const seen = new Set<string>();
      const candidates = outcome.hits.filter((h: WebSearchHit) => {
        if (seen.has(h.url)) return false;
        seen.add(h.url);
        try {
          assertPublicHttpsUrl(h.url);
          return true;
        } catch {
          return false;
        }
      });
      return { attempted: true, candidates, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { attempted: true, candidates: [], error: msg };
    }
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
    // A08（审核 2026-09-13）：手动检查用户在场，照旧可搜；
    // 定时轮次只在**显式预批的搜索预算**（paid_budget_mode='request_cap' 且
    // request_cap>0）下自主搜索，'none' 不擅自付费。每次定时搜索消耗 1 个额度。
    const searchConfigured = this.resolveWebSearch() !== undefined;
    const budgetAllows = topic.paid_budget_mode === 'request_cap' && (topic.request_cap ?? 0) > 0;
    const wantSearch = searchConfigured && (!opts.scheduled || budgetAllows);
    let searchCandidates: SearchCandidate[] = [];
    let searchError: string | null = null;
    let searchUsed = false;
    const autoSourceIds = new Set<string>();
    // S2-04（审核 2026-09-15）：重整计划 §6.3 起始上限——每轮模型研读最多 8 次调用，
    // 与搜索预算相互独立；超出部分走规则研读（mode='rules'，不计故障）。
    let modelCallsUsed = 0;
    let modelDegraded = 0;
    const sources = this.store.listSources(topic.id);
    try {
      if (sources.length === 0 && !(wantSearch && topic.public_description.trim().length > 0)) {
        throw new IxaError(
          ErrorCodes.VALIDATION_FAILED,
          '没有批准来源，不能声称已搜索全网（写了公开描述并配置搜索后，无来源也可先搜候选）',
        );
      }
      if (wantSearch) {
        const searched = await this.searchCandidates(topic);
        searchCandidates = searched.candidates;
        searchError = searched.error;
        searchUsed = searched.attempted;
        // 定时轮次消耗预批额度；手动轮次用户在场不扣（预算面向无人值守）
        if (searchUsed && opts.scheduled) {
          this.db
            .prepare(
              'UPDATE research_topics SET request_cap = MAX(0, request_cap - 1), updated_at = ? WHERE id = ?',
            )
            .run(now, topic.id);
        }

        // A08 / D06（审核 2026-09-14）：定时自主轮次（opts.scheduled）下，
        // 搜索候选在已批准公开领域内自动建立来源记录并纳入本轮研读（无人值守闭环）。
        // 关键防御（C07）：在执行副作用前必须检查 generation 与 paused 状态；
        // 若搜索期间已被暂停/撤权，晚到候选绝不登记到数据库 sources 中。
        if (opts.scheduled) {
          const currentTopic = this.store.getTopic(topic.id);
          if (
            currentTopic.generation !== generation ||
            currentTopic.paused ||
            !currentTopic.enabled
          ) {
            throw new IxaError(ErrorCodes.JOB_CANCELLED, '关注已暂停/撤权，晚到搜索结果作废');
          }
          for (const candidate of searchCandidates) {
            try {
              const added = this.store.addSource(
                topic.id,
                { url: candidate.url, kind: 'page' },
                now,
                // S2-05（审核 2026-09-15）：发现方式持久保存（迁移 22 discovered_by 列），
                // 不再借用 last_error（成功抓取即清空，导致跨周期身份丢失）。
                { discoveredBy: 'auto' },
              );
              autoSourceIds.add(added.id);
            } catch {
              /* 已存在或冲突不阻塞 */
            }
          }
        }
      }

      // 重新读取包含新增自动来源的完整来源列表
      const allSources = this.store.listSources(topic.id);
      let renderError: string | null = null;
      for (const src of allSources) {
        if (pages >= topic.max_pages_per_run) break;
        const checkTopicBefore = this.store.getTopic(topic.id);
        if (checkTopicBefore.paused || checkTopicBefore.generation !== generation) {
          throw new IxaError(ErrorCodes.JOB_CANCELLED, '关注已暂停/撤权，晚到结果作废');
        }
        try {
          const fetched = await fetchApprovedSource(src.url, this.fetchDeps);
          pages += 1;
          let entries =
            src.kind === 'feed'
              ? parseFeed(fetched.body, fetched.finalUrl)
              : [parsePage(fetched.body, fetched.finalUrl)];

          // B3 阶段 2：SPA 动态骨架检测与 TinyFish 渲染抓取降级增强
          if (
            src.kind === 'page' &&
            entries[0] &&
            this.fetchDeps?.tinyfishFetcher &&
            isSpaOrDynamicSkeleton(fetched.body, entries[0].excerpt)
          ) {
            // Q04 / T06：在发起新的外部云渲染前再次检查关注状态与暂停
            const checkTopicRender = this.store.getTopic(topic.id);
            if (checkTopicRender.paused || checkTopicRender.generation !== generation) {
              throw new IxaError(ErrorCodes.JOB_CANCELLED, '关注已暂停/撤权，晚到结果作废');
            }
            try {
              const rendered = await this.fetchDeps.tinyfishFetcher.fetchRendered(src.url);
              if (rendered.content && rendered.content.trim().length > 0) {
                // 用渲染得到的正文替换原单页骨架
                entries = [parsePage(rendered.content, fetched.finalUrl)];
              }
            } catch (renderErr) {
              // Q04 / T07：云渲染抛出错误不能静默丢弃，必须反映在运行状态中
              renderError = `SPA 骨架云端渲染失败: ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`;
            }
          }

          // 页面指纹未变：自上次检查以来毫无新变化，不重复研读与通知
          if (
            src.kind === 'page' &&
            src.last_fingerprint &&
            entries[0] &&
            src.last_fingerprint === entries[0].fingerprint
          ) {
            continue;
          }

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

            // A08 / S2-04：调用模型/规则研读器研读与判断价值。
            // 每轮模型调用上限 MAX_MODEL_CALLS_PER_RUN=8，超出走规则研读。
            const allowModel = modelCallsUsed < MAX_MODEL_CALLS_PER_RUN;
            const judgment = await this.judge.judge(
              topic,
              {
                title: entry.title,
                url: entryUrl,
                excerpt: entry.excerpt,
              },
              { allowModel },
            );
            if (judgment.mode === 'model') modelCallsUsed += 1;
            if (judgment.mode === 'rules-degraded') {
              modelDegraded += 1;
              modelCallsUsed += 1;
            }

            // D06 / S2-05（审核 2026-09-15）：自动搜索发现的候选来源，若研读判定不相关，
            // 无论第 1 轮还是跨周期第 2 轮（discovered_by 持久化标记）都必须保持安静，绝不生成 finding。
            // 用户显式批准监控的来源，用户指定监控其更新，即使泛化内容也予以记录。
            const isAutoSource = autoSourceIds.has(src.id) || src.discovered_by === 'auto';
            if (isAutoSource && !judgment.relevant) {
              continue;
            }

            const excerptContent = judgment.relevant
              ? `${judgment.summary}\n\n【价值分析】${judgment.valueAnalysis}`
              : entry.excerpt;

            const inserted = this.store.insertFinding({
              topicId: topic.id,
              sourceId: src.id,
              title: entry.title,
              url: entryUrl,
              excerpt: excerptContent,
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
          mode: searchUsed ? 'approved-sources-plus-search' : 'approved-sources-only',
          searchUsed,
          searchCandidates: [],
          searchError,
        };
      }
      const runError = error ?? (searchError !== null ? `搜索失败：${searchError}` : null);
      // S2-06（审核 2026-09-15）：模型研读降级必须可见——
      // 配置了模型但调用失败时，run.error 如实记录降级原因，
      // 不允许看起来像「模型研读成功」。已抓取资料与部分成果保留。
      const degradedNote =
        modelDegraded > 0
          ? `模型研读失败 ${modelDegraded} 次，已降级为规则研读（模型服务故障或返回无效）`
          : null;
      const finalRunError =
        [runError, degradedNote, renderError].filter(Boolean).join('；') || null;
      // 成功的最低标准：读了批准来源，或完成了一次真实搜索；
      // 零来源+搜索失败=这轮什么都没干成，如实记失败
      if (pages === 0 && (!searchUsed || searchError !== null)) {
        const fail = finalRunError ?? '没有成功读取任何批准来源';
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
        if (finalRunError) {
          this.db
            .prepare(
              'UPDATE research_topics SET last_failure = ?, last_failure_at = ? WHERE id = ?',
            )
            .run(finalRunError.slice(0, 500), now, topic.id);
        }
        this.store.finishRun(run.id, {
          status: 'succeeded',
          pagesFetched: pages,
          findingsNew: findings.length,
          error: finalRunError,
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
      mode: searchUsed ? 'approved-sources-plus-search' : 'approved-sources-only',
      searchUsed,
      searchCandidates,
      searchError,
    };
  }

  private iso(): string {
    return this.clock.now().toISOString();
  }

  private lease(): string {
    return new Date(this.clock.now().getTime() + RUN_LEASE_MS).toISOString();
  }
}
