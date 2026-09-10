import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import type { Job } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { ModelError } from '../extraction/model/provider.js';
import type { Logger } from '../logging/logger.js';

export type JobHandler = (
  job: Job,
  ctx: { reportProgress(p: number): void; signal: AbortSignal },
) => Promise<void>;

export interface JobContext {
  reportProgress(p: number): void;
  signal: AbortSignal;
}

/**
 * 进程内后台任务队列（jobs 表 + 轮询执行器）。不引入 Redis 或外部队列。
 * 任务可中断（cancelled 状态在下次 tick 生效）与重试（retry 重新入队）。
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentAbort: AbortController | null = null;
  private currentJobId: string | null = null;
  private currentSettled: Promise<void> = Promise.resolve();
  private settleCurrentRun: (() => void) | null = null;
  private readonly logger: Pick<Logger, 'warn' | 'info'>;
  /** 暂时性失败的自动重试上限与退避间隔（毫秒；测试可覆盖） */
  private readonly maxAutoRetries: number;
  private readonly retryBackoffMs: number[];

  constructor(
    private readonly db: CoreDatabase,
    logger?: Pick<Logger, 'warn' | 'info'>,
    opts?: { maxAutoRetries?: number; retryBackoffMs?: number[] },
  ) {
    this.logger = logger ?? {
      warn: (msg: string, fields?: Record<string, unknown>) =>
        console.warn(JSON.stringify({ level: 'warn', message: msg, ...fields })),
      info: (msg: string, fields?: Record<string, unknown>) =>
        console.log(JSON.stringify({ level: 'info', message: msg, ...fields })),
    };
    this.maxAutoRetries = opts?.maxAutoRetries ?? 3;
    this.retryBackoffMs = opts?.retryBackoffMs ?? [5_000, 30_000, 120_000];
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  enqueue(kind: string, payload: Record<string, unknown>): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      kind,
      status: 'queued',
      payload_json: JSON.stringify(payload),
      progress: 0,
      error: null,
      retry_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, payload_json, progress, error, retry_count, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, 0, NULL, 0, ?, ?)`,
      )
      .run(job.id, kind, job.payload_json, now, now);
    return job;
  }

  start(intervalMs = 300): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentAbort?.abort();
  }

  /** 立即尝试执行一个排队任务（导入等用户等待的操作用）。 */
  kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowIso = new Date().toISOString();
      const job = this.db
        .prepare(
          "SELECT * FROM jobs WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at LIMIT 1",
        )
        .get(nowIso) as Job | undefined;
      if (!job) return;
      // 原子抢占：queued → running
      const claimed = this.db
        .prepare(
          "UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(new Date().toISOString(), job.id);
      if (claimed.changes === 0) return;

      const handler = this.handlers.get(job.kind);
      if (!handler) {
        this.finishJob(job.id, 'failed', `没有注册的任务类型: ${job.kind}`);
        return;
      }

      this.currentJobId = job.id;
      const abort = new AbortController();
      this.currentAbort = abort;
      let settleRun: () => void = () => {};
      this.currentSettled = new Promise<void>((resolve) => {
        settleRun = resolve;
      });
      this.settleCurrentRun = settleRun;
      const ctx: JobContext = {
        reportProgress: (p: number) => {
          this.db
            .prepare('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?')
            .run(Math.max(0, Math.min(1, p)), new Date().toISOString(), job.id);
        },
        signal: abort.signal,
      };
      try {
        await handler(job, ctx);
        // C02：执行期间任务状态可能被外部改写（如取消把 running 改成 cancelled）。
        // 任务终态以**数据库当前状态**为准：只有仍是 running 时本执行才有权落终态；
        // 已被改为 cancelled 的不得回写成 succeeded。
        const currentStatus = (
          this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as {
            status: string;
          }
        )?.status;
        if (abort.signal.aborted && currentStatus !== 'cancelled') {
          this.finishJob(job.id, 'cancelled', null);
        } else if (currentStatus === 'running') {
          this.finishJob(job.id, 'succeeded', null);
        }
        // currentStatus 已是 cancelled 等：外部已落终态，本执行不改写
      } catch (err) {
        // 修复 F4 要求 5：取消/暂停类中止必须有可见状态，不得伪装成成功或普通失败。
        // 处理器抛出带 jobCancelled 标记的错误时，任务以 cancelled 落库（可重试）。
        const cancelled = (err as { jobCancelled?: boolean }).jobCancelled === true;
        const message = err instanceof Error ? err.message : String(err);
        // 修复 v0.1.1 M0.2 第 7 条：仅暂时性失败有限重试（默认 3 次退避）；
        // 认证失败、预算限制、权限拒绝、校验失败、取消不循环重试。
        if (!cancelled && isTransientJobError(err) && job.retry_count < this.maxAutoRetries) {
          const backoff =
            this.retryBackoffMs[Math.min(job.retry_count, this.retryBackoffMs.length - 1)] ?? 5_000;
          const notBefore = new Date(Date.now() + backoff).toISOString();
          this.db
            .prepare(
              "UPDATE jobs SET status = 'queued', error = ?, retry_count = retry_count + 1, not_before = ?, updated_at = ? WHERE id = ?",
            )
            .run(message, notBefore, new Date().toISOString(), job.id);
          this.logger.warn('任务暂时性失败，已安排退避重试', {
            jobId: job.id,
            kind: job.kind,
            attempt: job.retry_count + 1,
            notBefore,
            error: message,
          });
        } else {
          this.logger.warn('任务结束', {
            jobId: job.id,
            kind: job.kind,
            status: cancelled ? 'cancelled' : 'failed',
            error: message,
          });
          this.finishJob(job.id, cancelled ? 'cancelled' : 'failed', message);
        }
      } finally {
        this.currentAbort = null;
        this.currentJobId = null;
        this.settleCurrentRun?.();
        this.settleCurrentRun = null;
      }
    } finally {
      this.running = false;
    }
  }

  /** 等待当前正在执行的任务结束（无在途任务时立即返回）。 */
  async idle(): Promise<void> {
    await this.currentSettled;
  }

  private finishJob(id: string, status: Job['status'], error: string | null): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, error = ?, progress = ?, updated_at = ? WHERE id = ?')
      .run(status, error, status === 'succeeded' ? 1 : 0, new Date().toISOString(), id);
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
    return row ?? null;
  }

  list(limit = 50): Job[] {
    return this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Job[];
  }

  /** 重试失败任务（保持原 id，retry_count + 1）。 */
  retry(id: string): Job {
    const job = this.get(id);
    if (!job) throw new IxaError(ErrorCodes.NOT_FOUND, `任务不存在: ${id}`);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new IxaError(ErrorCodes.CONFLICT, `任务 ${job.status}，不能重试`);
    }
    this.db
      .prepare(
        "UPDATE jobs SET status = 'queued', error = NULL, progress = 0, retry_count = ?, not_before = NULL, updated_at = ? WHERE id = ?",
      )
      .run(job.retry_count + 1, new Date().toISOString(), id);
    this.kick();
    return this.get(id) as Job;
  }

  /** 取消某来源上排队或运行中的提取任务（归档时调用）。 */
  cancelExtractJobsForSource(sourceId: string): number {
    const rows = this.db
      .prepare(
        `SELECT id FROM jobs
         WHERE kind = 'extract' AND status IN ('queued', 'running')
           AND payload_json LIKE ?
         ORDER BY created_at`,
      )
      .all(`%"sourceId":"${sourceId}"%`) as Array<{ id: string }>;
    for (const row of rows) this.cancel(row.id);
    return rows.length;
  }

  /** 取消排队或运行中的任务。 */
  cancel(id: string): Job {
    const job = this.get(id);
    if (!job) throw new IxaError(ErrorCodes.NOT_FOUND, `任务不存在: ${id}`);
    if (job.status === 'queued') {
      this.finishJob(id, 'cancelled', null);
    } else if (job.status === 'running') {
      // C02：数据库状态可能被外部改写（如误判为遗留任务时 running→queued）。
      // 取消必须依据**本队列内存中的真实执行任务 ID**发出中止信号：
      // - 仍在本队列执行 → abort 在途执行（即使数据库状态已被改回 queued）；
      // - 不在本队列执行 → 该记录只是被改写的状态，恢复其真实语义为取消。
      if (this.currentJobId === id) {
        this.currentAbort?.abort();
      } else {
        this.finishJob(id, 'cancelled', null);
      }
    }
    return this.get(id) as Job;
  }

  /** C02：该队列实例当前是否正在执行此任务（内存事实，不受数据库状态改写影响）。 */
  isExecuting(id: string): boolean {
    return this.running && this.currentJobId === id;
  }

  /** C02：该队列实例当前是否完全空闲（无任何在途执行）。 */
  get idleExecution(): boolean {
    return !this.running;
  }
}

/** 暂时性失败分类：模型调用失败 / 服务暂不可用 / 可重试的 ModelError。 */
function isTransientJobError(err: unknown): boolean {
  if (err instanceof ModelError) return err.retriable;
  if (err instanceof IxaError) {
    return err.code === ErrorCodes.MODEL_CALL_FAILED || err.code === ErrorCodes.SERVER_UNAVAILABLE;
  }
  return false;
}
