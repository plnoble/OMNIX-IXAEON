import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import type { Job } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
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
  private readonly logger: Pick<Logger, 'warn' | 'info'>;

  constructor(
    private readonly db: CoreDatabase,
    logger?: Pick<Logger, 'warn' | 'info'>,
  ) {
    this.logger = logger ?? {
      warn: (msg: string, fields?: Record<string, unknown>) =>
        console.warn(JSON.stringify({ level: 'warn', message: msg, ...fields })),
      info: (msg: string, fields?: Record<string, unknown>) =>
        console.log(JSON.stringify({ level: 'info', message: msg, ...fields })),
    };
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
      const job = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
        .get() as Job | undefined;
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
        if (abort.signal.aborted) {
          this.finishJob(job.id, 'cancelled', null);
        } else {
          this.finishJob(job.id, 'succeeded', null);
        }
      } catch (err) {
        // 修复 F4 要求 5：取消/暂停类中止必须有可见状态，不得伪装成成功或普通失败。
        // 处理器抛出带 jobCancelled 标记的错误时，任务以 cancelled 落库（可重试）。
        const cancelled = (err as { jobCancelled?: boolean }).jobCancelled === true;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn('任务结束', {
          jobId: job.id,
          kind: job.kind,
          status: cancelled ? 'cancelled' : 'failed',
          error: message,
        });
        this.finishJob(job.id, cancelled ? 'cancelled' : 'failed', message);
      } finally {
        this.currentAbort = null;
        this.currentJobId = null;
      }
    } finally {
      this.running = false;
    }
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
        "UPDATE jobs SET status = 'queued', error = NULL, progress = 0, retry_count = ?, updated_at = ? WHERE id = ?",
      )
      .run(job.retry_count + 1, new Date().toISOString(), id);
    this.kick();
    return this.get(id) as Job;
  }

  /** 取消排队或运行中的任务。 */
  cancel(id: string): Job {
    const job = this.get(id);
    if (!job) throw new IxaError(ErrorCodes.NOT_FOUND, `任务不存在: ${id}`);
    if (job.status === 'queued') {
      this.finishJob(id, 'cancelled', null);
    } else if (job.status === 'running') {
      if (this.currentJobId === id) this.currentAbort?.abort();
    }
    return this.get(id) as Job;
  }
}
