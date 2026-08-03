import { randomUUID } from "node:crypto";
import type { Task } from "./db.js";
import { claimNextPendingTask, getSupabase, getTask, persistTask, updateTask } from "./db.js";
import { IdempotencyStore, getExistingTask } from "./idempotency.js";
import { RetryClassifier, RetryScheduler } from "./retry.js";
import { insertDeadLetterTask } from "./db.js";

export interface TaskSpec {
  repo: string;
  branch: string;
  prBranch?: string;
  prompt?: string;
  triggerSource?: string;
  githubSender?: string;
  prNumber?: number;
  headSha?: string;
  checkRunId?: string;
  checkSuiteId?: string;
  checkName?: string;
  output?: Record<string, unknown>;
  healAttempt?: number;
  parentTaskId?: string;
  parentCheckpointId?: string;
  sandboxId?: string;
  keepAliveUntil?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  maxWallClockMinutes?: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  retryCount?: number;
  maxRetries?: number;
}

export interface TaskQueueOptions {
  maxConcurrent: number;
  pollMs: number;
  onClaim: (task: Task) => Promise<void>;
  onEvent: (taskId: string, type: string, data: unknown) => Promise<void>;
  workerId?: string;
  idempotencyStore?: IdempotencyStore;
  maxRetries?: number;
}

function buildTask(spec: TaskSpec): Task {
  const id = randomUUID();
  const prBranch = spec.prBranch ?? `daybreak/${id}`;
  const metadata: Record<string, unknown> = { ...(spec.metadata ?? {}) };
  if (spec.checkSuiteId !== undefined) metadata.checkSuiteId = spec.checkSuiteId;
  if (spec.checkName !== undefined) metadata.checkName = spec.checkName;
  if (spec.output !== undefined) metadata.output = spec.output;
  return {
    id,
    repo: spec.repo,
    branch: spec.branch,
    prBranch,
    status: "pending",
    startedAt: Date.now(),
    triggerSource: spec.triggerSource,
    githubSender: spec.githubSender,
    prNumber: spec.prNumber,
    prompt: spec.prompt,
    headSha: spec.headSha,
    checkRunId: spec.checkRunId,
    healAttempt: spec.healAttempt,
    parentTaskId: spec.parentTaskId,
    parentCheckpointId: spec.parentCheckpointId,
    sandboxId: spec.sandboxId,
    keepAliveUntil: spec.keepAliveUntil,
    maxTurns: spec.maxTurns,
    maxCostUsd: spec.maxCostUsd,
    maxWallClockMinutes: spec.maxWallClockMinutes,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    idempotencyKey: spec.idempotencyKey,
    retryCount: spec.retryCount ?? 0,
    maxRetries: spec.maxRetries ?? 2,
  };
}

export class TaskQueue {
  private maxConcurrent: number;
  private pollMs: number;
  private onClaim: (task: Task) => Promise<void>;
  private onEvent: (taskId: string, type: string, data: unknown) => Promise<void>;
  private workerId: string;
  private pending: Task[] = [];
  private running = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private processing = false;
  private idempotencyStore: IdempotencyStore;
  private maxRetries: number;

  constructor(options: TaskQueueOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.pollMs = Math.max(50, options.pollMs);
    this.onClaim = options.onClaim;
    this.onEvent = options.onEvent;
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.idempotencyStore = options.idempotencyStore ?? new IdempotencyStore();
    this.maxRetries = options.maxRetries ?? 2;
  }

  async enqueue(spec: TaskSpec, options?: { idempotencyKey?: string }): Promise<Task> {
    const idempotencyKey = options?.idempotencyKey ?? spec.idempotencyKey;
    const maxRetries = spec.maxRetries ?? this.maxRetries;

    if (idempotencyKey) {
      const existing = await this.idempotencyStore.get(idempotencyKey);
      if (existing) {
        const existingTask = await getExistingTask(existing);
        if (existingTask) return existingTask;
      }
    }

    const task = buildTask(spec);
    task.maxRetries = maxRetries;

    if (idempotencyKey) {
      const created = await this.idempotencyStore.tryCreate(idempotencyKey, task.id, task);
      if (!created || created.taskId !== task.id) {
        const existingTask = created ? await getExistingTask(created) : undefined;
        return existingTask ?? task;
      }
    }

    const persisted = await persistTask(task);
    if (!persisted && !getSupabase()) {
      this.pending.push(task);
    }
    await this.onEvent(task.id, "task_pending", {
      repo: task.repo,
      branch: task.branch,
      prBranch: task.prBranch,
      triggerSource: task.triggerSource,
    });
    this.scheduleProcess();
    return task;
  }

  start(): void {
    this.stop();
    this.scheduleProcess();
    this.timer = setInterval(() => this.processLoop(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  cancel(taskId: string): boolean {
    const index = this.pending.findIndex((t) => t.id === taskId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      return true;
    }
    return false;
  }

  getStatus(): { pending: number; running: number; maxConcurrent: number } {
    return {
      pending: this.pending.length,
      running: this.running.size,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private scheduleProcess(): void {
    if (this.processing) return;
    setImmediate(() => this.processLoop());
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.running.size < this.maxConcurrent) {
        const task = await this.claimNext();
        if (!task) break;
        this.running.add(task.id);
        this.process(task);
      }
    } finally {
      this.processing = false;
    }
  }

  private async claimNext(): Promise<Task | undefined> {
    const fromDb = await claimNextPendingTask(this.maxConcurrent, this.workerId);
    if (fromDb) {
      return fromDb;
    }
    if (this.running.size < this.maxConcurrent && this.pending.length > 0) {
      const now = Date.now();
      const index = this.pending.findIndex(
        (t) => t.status === "pending" || (t.status === "retry_scheduled" && (!t.nextRetryAt || t.nextRetryAt <= now)),
      );
      if (index < 0) return undefined;
      const [task] = this.pending.splice(index, 1);
      task.status = "running";
      task.claimedAt = Date.now();
      await updateTask(task.id, { status: "running", claimedAt: task.claimedAt });
      return task;
    }
    return undefined;
  }

  private process(task: Task): void {
    Promise.resolve()
      .then(() => this.onClaim(task))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[queue] task ${task.id} failed during claim/execution:`, error);

        if (RetryClassifier.isRetryable(error, task.triggerSource, { task }) && (task.retryCount ?? 0) < (task.maxRetries ?? this.maxRetries)) {
          task.retryCount = (task.retryCount ?? 0) + 1;
          task.lastError = message;
          task.nextRetryAt = RetryScheduler.nextRetryAt(task.retryCount);
          task.status = "retry_scheduled";
          task.endedAt = undefined;
          await updateTask(task.id, {
            retryCount: task.retryCount,
            lastError: task.lastError,
            nextRetryAt: task.nextRetryAt,
            status: "retry_scheduled",
            endedAt: undefined,
          });
          await this.onEvent(task.id, "task_retry_scheduled", {
            retryCount: task.retryCount,
            nextRetryAt: task.nextRetryAt,
            error: message,
          });
          // Keep the task in memory for in-memory queue fallback.
          if (!getSupabase()) {
            this.pending.push(task);
          }
          return;
        }

        task.status = "failed";
        task.endedAt = Date.now();
        task.lastError = message;
        await updateTask(task.id, { status: "failed", endedAt: task.endedAt, lastError: task.lastError });
        await this.onEvent(task.id, "task_failed", { error: message });
        await this.onEvent(task.id, "dead_letter", { error: message });
        await insertDeadLetterTask(task, message);
      })
      .finally(() => {
        this.running.delete(task.id);
        this.scheduleProcess();
      });
  }
}
