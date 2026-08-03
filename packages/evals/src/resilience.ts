// Force in-memory control-plane paths in this eval so resilience checks are deterministic.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_KEY = "";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_TOKEN = "";

import { MetricsCollector } from "@daybreak/agent-runner";
import {
  TaskQueue,
  type TaskSpec,
} from "@daybreak/control-plane/queue";

import { RetryClassifier, RetryScheduler } from "@daybreak/control-plane/retry";
import { TenantService, type TenantConfig } from "@daybreak/control-plane/tenants";
import { BudgetService } from "@daybreak/control-plane/budgets";
import { CleanupService, type CleanupServiceOptions } from "@daybreak/control-plane/cleanup";
import { TaskRejectedError } from "@daybreak/control-plane/errors";
import { SafetyMiddleware, loadConfig, type DaybreakConfig } from "@daybreak/shared";
import { pathToFileURL } from "node:url";

interface EvalResult {
  name: string;
  ok: boolean;
  error?: string;
}

function ok(name: string): EvalResult {
  return { name, ok: true };
}

function fail(name: string, error: unknown): EvalResult {
  return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSpec(repo: string, branch = "main", overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    repo,
    branch,
    triggerSource: "dashboard",
    ...overrides,
  };
}

async function queueFloodCheck(): Promise<void> {
  const processed = new Set<string>();
  let maxRunning = 0;
  const queue = new TaskQueue({
    maxConcurrent: 2,
    pollMs: 10,
    async onClaim(task) {
      maxRunning = Math.max(maxRunning, queue.getStatus().running);
      await wait(50);
      processed.add(task.id);
    },
    async onEvent() {},
  });

  const specs = Array.from({ length: 10 }, (_, i) => buildSpec(`https://github.com/flood/repo-${i}`));
  for (const spec of specs) {
    await queue.enqueue(spec);
  }
  queue.start();
  await wait(600);
  queue.stop();

  if (maxRunning > 2) throw new Error(`max running ${maxRunning} exceeded concurrency limit 2`);
  if (processed.size !== specs.length) throw new Error(`processed ${processed.size}/${specs.length}`);
}

async function idempotencyCheck(): Promise<void> {
  const queue = new TaskQueue({
    maxConcurrent: 1,
    pollMs: 10,
    async onClaim() {
      await wait(10);
    },
    async onEvent() {},
  });

  const spec = buildSpec("https://github.com/example/repo");
  const first = await queue.enqueue(spec, { idempotencyKey: "dedupe-1" });
  const second = await queue.enqueue(spec, { idempotencyKey: "dedupe-1" });
  if (first.id !== second.id) throw new Error("idempotency key produced two different tasks");
}

async function retryDeadLetterCheck(): Promise<void> {
  const originalNextRetryAt = RetryScheduler.nextRetryAt;
  RetryScheduler.nextRetryAt = () => Date.now();

  const events: { type: string; taskId: string }[] = [];
  let attempts = 0;

  const queue = new TaskQueue({
    maxConcurrent: 1,
    pollMs: 10,
    maxRetries: 1,
    async onClaim(task) {
      attempts++;
      if ((task.retryCount ?? 0) < 1) {
        throw new Error("E2B sandbox timeout");
      }
      await wait(10);
    },
    async onEvent(taskId, type) {
      events.push({ taskId, type });
    },
  });

  await queue.enqueue(buildSpec("https://github.com/example/retry"));
  queue.start();
  await wait(300);
  queue.stop();
  RetryScheduler.nextRetryAt = originalNextRetryAt;

  const retryScheduled = events.some((e) => e.type === "task_retry_scheduled");
  const success = events.some((e) => e.type === "task_complete");
  if (!retryScheduled) throw new Error("retry was not scheduled");
  if (!success && attempts < 2) throw new Error(`task did not succeed after retry (attempts=${attempts})`);

  // Dead-letter path: maxRetries=0 and a transient failure goes straight to dead-letter.
  const deadLetterEvents: { type: string; taskId: string }[] = [];
  const dlQueue = new TaskQueue({
    maxConcurrent: 1,
    pollMs: 10,
    maxRetries: 0,
    async onClaim() {
      throw new Error("E2B sandbox timeout");
    },
    async onEvent(taskId, type) {
      deadLetterEvents.push({ taskId, type });
    },
  });

  await dlQueue.enqueue(buildSpec("https://github.com/example/dead"));
  dlQueue.start();
  await wait(200);
  dlQueue.stop();

  if (!deadLetterEvents.some((e) => e.type === "dead_letter")) {
    throw new Error("failed task was not moved to dead-letter");
  }
}

async function tenantRateLimitCheck(): Promise<void> {
  const tenant = await TenantService.getOrCreateTenant("pat", `rate-limit-${Date.now()}`, {
    tasksPerHour: 2,
    dailyCostUsd: 100,
    maxConcurrent: 10,
  });

  TenantService.recordTaskCreation(tenant.id, "task-1");
  TenantService.recordTaskCreation(tenant.id, "task-2");

  let thrown: TaskRejectedError | undefined;
  try {
    await TenantService.assertCanCreateTask(tenant);
  } catch (error) {
    if (error instanceof TaskRejectedError) thrown = error;
    else throw error;
  }

  if (!thrown) throw new Error("third task was not rejected");
  if (thrown.status !== 429) throw new Error(`expected 429, got ${thrown.status}`);
}

async function securityCheck(): Promise<void> {
  const config = loadConfig();
  const safety = new SafetyMiddleware(config);
  safety.setCwd("/tmp/workspace");

  const dotenv = safety.beforeToolCall("read", { path: ".env" });
  if (dotenv.allowed) throw new Error("read .env was allowed");

  const traversal = safety.beforeToolCall("read", { path: "../.env" });
  if (traversal.allowed) throw new Error("read ../.env was allowed");

  const bashDotenv = safety.beforeToolCall("bash", { command: "cat /tmp/workspace/.env" });
  if (bashDotenv.allowed) throw new Error("bash cat .env was allowed");

  const bashTraversal = safety.beforeToolCall("bash", { command: "cat ../.env" });
  if (bashTraversal.allowed) throw new Error("bash cat ../.env was allowed");
}

async function circuitBreakerCheck(): Promise<void> {
  const config = loadConfig();
  const metrics = new MetricsCollector();
  const maxTurns = config.maxTurns;

  for (let i = 0; i < maxTurns; i++) {
    metrics.recordTurn();
  }

  if (metrics.current().turns < maxTurns) {
    throw new Error(`turn count ${metrics.current().turns} did not reach maxTurns ${maxTurns}`);
  }

  // Simulate a message that pushes estimatedCostUsd over MAX_COST_USD.
  const pricing = { "custom/gpt-4o-mini": { input: 0.15, output: 0.6 } };
  const pricedMetrics = new MetricsCollector(pricing);
  pricedMetrics.recordMessage({
    role: "assistant",
    provider: "custom",
    model: "gpt-4o-mini",
    api: "openai-completions",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input: 10_000_000,
      output: 1_000_000,
      totalTokens: 11_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as Parameters<MetricsCollector["recordMessage"]>[0]);

  if (pricedMetrics.current().estimatedCostUsd <= config.maxCostUsd) {
    throw new Error("cost did not exceed MAX_COST_USD with extreme usage");
  }
}

function makeFakeSupabase(taskRows: unknown[]) {
  class Builder {
    private table: string;
    private state: {
      op?: "select" | "insert" | "delete" | "update";
      filters: Array<{ type: string; args: unknown[] }>;
      forceEmpty: boolean;
    } = { filters: [], forceEmpty: false };

    constructor(table: string) {
      this.table = table;
    }

    select() {
      this.state.op = "select";
      return this;
    }

    like(col: string, val: string) {
      this.state.filters.push({ type: "like", args: [col, val] });
      return this;
    }

    in(col: string, vals: unknown[]) {
      this.state.filters.push({ type: "in", args: [col, vals] });
      return this;
    }

    lt(col: string, val: string) {
      this.state.filters.push({ type: "lt", args: [col, val] });
      return this;
    }

    eq(col: string, val: unknown) {
      this.state.filters.push({ type: "eq", args: [col, val] });
      return this;
    }

    not() {
      return this;
    }

    or() {
      this.state.forceEmpty = true;
      return this;
    }

    delete() {
      this.state.op = "delete";
      return this;
    }

    update() {
      this.state.op = "update";
      return this;
    }

    insert() {
      this.state.op = "insert";
      return { then: (_onF: (v: unknown) => unknown, _onR?: unknown) => _onF({ data: [], error: null }) };
    }

    then(onFulfilled?: (value: unknown) => unknown, _onRejected?: unknown): Promise<unknown> {
      const resolve = onFulfilled ?? ((v: unknown) => v);
      if (this.state.op === "insert" || this.state.op === "delete" || this.state.op === "update") {
        return Promise.resolve(resolve({ data: [], error: null }));
      }

      if (this.state.forceEmpty || this.table !== "tasks") {
        return Promise.resolve(resolve({ data: [], error: null }));
      }

      let rows = [...taskRows] as Array<Record<string, unknown>>;
      for (const filter of this.state.filters) {
        if (filter.type === "like" && filter.args[0] === "pr_branch") {
          const prefix = (filter.args[1] as string).replace(/%$/, "");
          rows = rows.filter((r) => String(r.pr_branch).startsWith(prefix));
        }
        if (filter.type === "in" && filter.args[0] === "status") {
          const vals = filter.args[1] as string[];
          rows = rows.filter((r) => vals.includes(String(r.status)));
        }
        if (filter.type === "lt" && filter.args[0] === "ended_at") {
          const cutoff = filter.args[1] as string;
          rows = rows.filter((r) => String(r.ended_at) < cutoff);
        }
      }

      return Promise.resolve(resolve({ data: rows, error: null }));
    }
  }

  return {
    from: (table: string) => new Builder(table),
  } as unknown as NonNullable<CleanupServiceOptions["supabase"]>;
}

async function branchCleanupCheck(): Promise<void> {
  const branchTaskId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const branchName = `daybreak/${branchTaskId}`;
  const repo = "https://github.com/example/cleanup-repo";
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  const taskRows = [
    {
      id: branchTaskId,
      repo,
      pr_branch: branchName,
      status: "complete",
      ended_at: oldDate,
      started_at: oldDate,
      sandbox_id: null,
    },
  ];

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(urlString);
    if (u.pathname.endsWith("/branches")) {
      const branches = [
        {
          name: branchName,
          commit: {
            sha: "abc123",
            commit: { committer: { date: oldDate } },
          },
        },
      ];
      return { ok: true, json: async () => branches } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  };

  const config = loadConfig();
  const service = new CleanupService({
    config,
    githubToken: "fake-token",
    fetchImpl: fakeFetch,
    supabase: makeFakeSupabase(taskRows),
  });

  const result = await service.cleanupBranches(true);
  if (result.deletedCount !== 1) throw new Error(`expected 1 dry-run deletion, got ${result.deletedCount}`);
  const details = result.details.deleted as Array<Record<string, unknown>>;
  if (!details || details.length !== 1 || details[0].dryRun !== true) {
    throw new Error("dry-run branch deletion detail missing");
  }
}

export async function runResilienceChecks(): Promise<{ passed: number; failed: number; results: EvalResult[] }> {
  const checks: { name: string; fn: () => Promise<void> }[] = [
    { name: "queue-flood", fn: queueFloodCheck },
    { name: "idempotency", fn: idempotencyCheck },
    { name: "retry-dead-letter", fn: retryDeadLetterCheck },
    { name: "tenant-rate-limit", fn: tenantRateLimitCheck },
    { name: "security", fn: securityCheck },
    { name: "circuit-breaker", fn: circuitBreakerCheck },
    { name: "branch-cleanup", fn: branchCleanupCheck },
  ];

  const results: EvalResult[] = [];
  for (const { name, fn } of checks) {
    try {
      await fn();
      results.push(ok(name));
    } catch (error) {
      results.push(fail(name, error));
    }
  }

  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runResilienceChecks().then(({ passed, failed, results }) => {
    for (const result of results) {
      const line = result.ok ? `✓ ${result.name}` : `✗ ${result.name}: ${result.error}`;
      console.log(line);
    }
    console.log(`\nResilience: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
}
