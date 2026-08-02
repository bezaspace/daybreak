#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import pc from "picocolors";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");

interface EvalCase {
  name: string;
  fixture: string;
  prompt: string;
}

interface EvalResult {
  name: string;
  status: "complete" | "failed" | "timeout" | "error";
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
  estimatedCostUsd?: number;
  totalTokens?: number;
  prUrl?: string;
  traceUrl?: string;
  provider?: string;
  traceId?: string;
  error?: string;
}

interface TaskResponse {
  id: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  prUrl?: string;
  exitCode?: number;
  traceId?: string;
  provider?: string;
  costUsd?: number;
}

interface StreamEvent {
  type: string;
  timestamp: number;
  data: unknown;
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function loadFixtures(): Promise<EvalCase[]> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      fixture: join(fixturesDir, entry.name),
      prompt: `Fix the failing test in this repository. Read the source and test files, understand the bug, make the minimal fix, and run the test command until it passes.`,
    }));
}

async function waitForTask(
  controlPlaneUrl: string,
  taskId: string,
  timeoutMs: number,
  pollIntervalMs = 2000,
): Promise<TaskResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${controlPlaneUrl}/api/tasks/${taskId}`);
    if (res.ok) {
      const task = (await res.json()) as TaskResponse;
      if (task.status === "complete" || task.status === "failed") {
        return task;
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const res = await fetch(`${controlPlaneUrl}/api/tasks/${taskId}`);
  if (res.ok) {
    return (await res.json()) as TaskResponse;
  }
  throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`);
}

async function fetchTaskEvents(controlPlaneUrl: string, taskId: string): Promise<StreamEvent[]> {
  const res = await fetch(`${controlPlaneUrl}/api/tasks/${taskId}/events`);
  if (!res.ok) return [];
  return (await res.json()) as StreamEvent[];
}

function extractMetrics(events: StreamEvent[]): Partial<EvalResult> {
  for (const event of events) {
    if (event.type === "task_complete" || event.type === "task_failed") {
      const data = event.data as {
        provider?: string;
        traceId?: string;
        metrics?: {
          turns?: number;
          toolCalls?: number;
          estimatedCostUsd?: number;
          totalTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
          wallClockMs?: number;
        };
      } | undefined;
      if (data?.metrics) {
        return {
          provider: data.provider,
          traceId: data.traceId,
          turns: data.metrics.turns,
          toolCalls: data.metrics.toolCalls,
          estimatedCostUsd: data.metrics.estimatedCostUsd,
          totalTokens: data.metrics.totalTokens ?? (data.metrics.promptTokens || 0) + (data.metrics.completionTokens || 0),
          durationMs: data.metrics.wallClockMs,
        };
      }
    }
  }
  return {};
}

async function fetchTask(controlPlaneUrl: string, taskId: string): Promise<TaskResponse | undefined> {
  const res = await fetch(`${controlPlaneUrl}/api/tasks/${taskId}`);
  if (!res.ok) return undefined;
  return (await res.json()) as TaskResponse;
}

async function fetchTraceUrl(controlPlaneUrl: string, taskId: string): Promise<string | undefined> {
  const res = await fetch(`${controlPlaneUrl}/api/tasks/${taskId}/trace`);
  if (!res.ok) return undefined;
  const data = (await res.json()) as { traceUrl?: string };
  return data.traceUrl;
}

function extractPrUrl(events: StreamEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "pr_created") {
      const data = event.data as { prUrl?: string } | undefined;
      return data?.prUrl;
    }
  }
  return undefined;
}

async function main() {
  const envPath = resolve(__dirname, "../../.env");
  loadConfig(envPath);

  const controlPlaneUrl = getArg("control-plane-url") || process.env.CONTROL_PLANE_URL || "http://localhost:8787";
  const targetRepo = getArg("target-repo") || process.env.EVAL_TARGET_REPO || "https://github.com/bezaspace/daybreak-target";
  const targetBranch = getArg("target-branch") || process.env.EVAL_TARGET_BRANCH || "main";
  const timeoutMs = Number.parseInt(getArg("timeout") || process.env.EVAL_TIMEOUT_MS || "600000", 10);

  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    console.log(pc.yellow("No fixtures found. Add one to fixtures/ and rerun."));
    process.exit(0);
  }

  console.log(pc.bold(`\nRunning ${fixtures.length} eval case(s) end-to-end through ${controlPlaneUrl}...\n`));
  const results: EvalResult[] = [];

  for (const evalCase of fixtures) {
    console.log(pc.bold(`--- ${evalCase.name} ---`));
    const start = Date.now();
    let result: EvalResult = { name: evalCase.name, status: "error" };
    try {
      const res = await fetch(`${controlPlaneUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: targetRepo, branch: targetBranch }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to start task: ${res.status} ${text}`);
      }
      const { taskId } = (await res.json()) as { taskId: string };
      console.log(`Task ${taskId} started for ${targetRepo} @ ${targetBranch}`);

      let task = await waitForTask(controlPlaneUrl, taskId, timeoutMs);
      const events = await fetchTaskEvents(controlPlaneUrl, taskId);
      const metrics = extractMetrics(events);
      const prUrlFromEvent = extractPrUrl(events);

      // PR creation happens after task status flips to complete; give it a brief grace window.
      let prUrl = task.prUrl ?? prUrlFromEvent;
      if (task.status === "complete" && !prUrl) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !prUrl) {
          await new Promise((r) => setTimeout(r, 1000));
          task = (await fetchTask(controlPlaneUrl, taskId)) ?? task;
          const moreEvents = await fetchTaskEvents(controlPlaneUrl, taskId);
          prUrl = task.prUrl ?? extractPrUrl(moreEvents);
        }
      }

      const taskDetails = (await fetchTask(controlPlaneUrl, taskId)) ?? task;
      const traceUrl = taskDetails.traceId ? await fetchTraceUrl(controlPlaneUrl, taskId) : undefined;

      result = {
        name: evalCase.name,
        status: taskDetails.status as EvalResult["status"],
        durationMs: taskDetails.endedAt && taskDetails.startedAt ? taskDetails.endedAt - taskDetails.startedAt : Date.now() - start,
        prUrl,
        traceUrl,
        provider: taskDetails.provider ?? metrics.provider,
        traceId: taskDetails.traceId ?? metrics.traceId,
        estimatedCostUsd: typeof metrics.estimatedCostUsd === "number" ? metrics.estimatedCostUsd : taskDetails.costUsd,
        ...metrics,
      };

      if (result.status === "complete") {
        console.log(pc.green(`Completed in ${result.durationMs}ms`));
      } else {
        console.log(pc.red(`Failed with status ${result.status}`));
      }
      if (result.prUrl) console.log(`PR: ${result.prUrl}`);
      if (result.traceUrl) console.log(`Trace: ${result.traceUrl}`);
      if (result.provider) console.log(`Provider: ${result.provider}`);
      if (typeof result.estimatedCostUsd === "number") console.log(`Cost: $${result.estimatedCostUsd.toFixed(4)}`);
      console.log("Metrics:", JSON.stringify(metrics, null, 2));

      if (result.status === "complete") {
        if (!result.traceId) throw new Error("completed task has no traceId");
        if (typeof result.estimatedCostUsd !== "number" || result.estimatedCostUsd < 0) {
          throw new Error("estimatedCostUsd is missing or negative");
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`Error running ${evalCase.name}: ${errorMessage}`));
      result = { name: evalCase.name, status: "error", durationMs: Date.now() - start, error: errorMessage };
    }
    results.push(result);
    console.log();
  }

  console.log(pc.bold("=== E2E eval summary ==="));
  console.table(
    results.map((r) => ({
      name: r.name,
      status: r.status,
      durationMs: r.durationMs ?? "-",
      turns: r.turns ?? "-",
      toolCalls: r.toolCalls ?? "-",
      totalTokens: r.totalTokens ?? "-",
      estimatedCostUsd: typeof r.estimatedCostUsd === "number" ? `$${r.estimatedCostUsd.toFixed(4)}` : "-",
      provider: r.provider ?? "-",
      traceUrl: r.traceUrl ?? "-",
      prUrl: r.prUrl ?? "-",
    })),
  );

  const failed = results.filter((r) => r.status !== "complete").length;
  if (failed === 0) {
    console.log(pc.bold(pc.green("All eval cases passed.")));
  } else {
    console.log(pc.bold(pc.red(`${failed} eval case(s) failed.`)));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
