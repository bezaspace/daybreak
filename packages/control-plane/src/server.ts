#!/usr/bin/env node
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { Redis } from "@upstash/redis";
import { loadConfig } from "@daybreak/shared";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  getTasks,
  getTask,
  persistTask,
  updateTask,
  persistEvent,
  getEvents,
  ensureWorkspace,
  countTasksByWorkspace,
  listCheckpoints,
  getCheckpoint,
  updateCheckpoint,
  type Task,
  type StreamEvent,
} from "./db.js";
import { CiLogFetcher, CiLogParser, type CheckRunOutput } from "./ci-logs.js";
import { TaskQueue, type TaskSpec } from "./queue.js";

const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../..");

let e2bSandboxClass: typeof import("e2b").Sandbox | undefined;

async function getE2BSandboxClass(): Promise<typeof import("e2b").Sandbox> {
  if (!e2bSandboxClass) {
    const e2b = await import("e2b");
    e2bSandboxClass = e2b.Sandbox;
  }
  return e2bSandboxClass;
}

function parseRepo(repoUrl: string): { owner: string; repo: string } | undefined {
  try {
    const url = new URL(repoUrl);
    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return undefined;
}

async function createPullRequest(repoUrl: string, headBranch: string, baseBranch: string, token: string): Promise<{ url: string; number: number } | undefined> {
  const parsed = parseRepo(repoUrl);
  if (!parsed) return undefined;
  const title = `fix: automated fix from Daybreak`;
  const body = `This PR was created by the Daybreak agent. Task branch: \`${headBranch}\` → \`${baseBranch}\`.`;
  const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, head: headBranch, base: baseBranch }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    console.error(`[control-plane] PR creation failed: ${res.status} ${text}`);
    return undefined;
  }
  const data = (await res.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}

function getRedis() {
  const config = loadConfig();
  const url = config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL;
  const token = config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_TOKEN are required");
  }
  return new Redis({ url, token });
}

const LOG_DIR = join(tmpdir(), "daybreak-logs");
function getLogPath(taskId: string) {
  return join(LOG_DIR, `${taskId}.log`);
}
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

async function appendLog(taskId: string, chunk: string) {
  ensureLogDir();
  await appendFile(getLogPath(taskId), chunk).catch(() => {});
  try {
    const redis = getRedis();
    const key = `daybreak:logs:${taskId}`;
    await redis.pipeline().rpush(key, chunk).ltrim(key, -1000, -1).exec();
  } catch {
    // Redis logging is best-effort.
  }
}

function langfuseBasicAuthHeader(): string | undefined {
  const config = loadConfig();
  const publicKey = config.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

function langfuseBaseUrl(): string {
  const config = loadConfig();
  return config.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
}

async function publishToRedis(taskId: string, event: StreamEvent) {
  const redis = getRedis();
  const pipe = redis.pipeline();
  pipe.rpush(`daybreak:stream:${taskId}`, JSON.stringify(event));
  pipe.ltrim(`daybreak:stream:${taskId}`, -1000, -1);
  await pipe.exec();
}

async function publishEvent(taskId: string, type: string, data: unknown) {
  const event: StreamEvent = { id: `${taskId}-pr`, taskId, type, timestamp: Date.now(), data };
  try {
    await persistEvent(taskId, event);
    await publishToRedis(taskId, event);
  } catch (error) {
    console.error(`[control-plane] failed to publish event ${type} for ${taskId}:`, error);
  }
}

const tasks = new Map<string, Task>();
const rewindingTasks = new Set<string>();

function taskFrom(body: { repo: string; branch: string; id?: string; prBranch?: string; triggerSource?: string; githubSender?: string; prNumber?: number; prompt?: string; status?: Task["status"]; workspaceId?: string; parentTaskId?: string; parentCheckpointId?: string; headSha?: string; checkRunId?: string; healAttempt?: number }): Task {
  const id = body.id ?? randomUUID();
  const prBranch = body.prBranch ?? `daybreak/${id}`;
  return { id, repo: body.repo, branch: body.branch, prBranch, status: body.status ?? "running", startedAt: Date.now(), triggerSource: body.triggerSource, githubSender: body.githubSender, prNumber: body.prNumber, prompt: body.prompt, workspaceId: body.workspaceId, parentTaskId: body.parentTaskId, parentCheckpointId: body.parentCheckpointId, headSha: body.headSha, checkRunId: body.checkRunId, healAttempt: body.healAttempt };
}

async function syncEventsFromRedis(taskId: string) {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(`daybreak:stream:${taskId}`, 0, -1);
    for (const item of raw) {
      const event = typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent);
      await persistEvent(taskId, event);
    }
  } catch (error) {
    console.error(`[control-plane] syncEventsFromRedis error for ${taskId}:`, error);
  }
}

const DAYBREAK_MENTION = /(^|\s)@daybreak-bot(\b|$)/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasMention(text: string): boolean {
  return DAYBREAK_MENTION.test(text);
}

function matchesAllowlist(repoFullName: string, pattern: string): boolean {
  const [owner, repoName] = repoFullName.split("/");
  const [pOwner, pRepo] = pattern.trim().split("/");
  if (!owner || !pOwner) return false;
  if (pOwner.toLowerCase() !== owner.toLowerCase()) return false;
  if (pRepo === "*") return true;
  return pRepo?.toLowerCase() === repoName?.toLowerCase();
}

function isRepoAllowed(repoFullName: string, allowlist?: string): boolean {
  if (!allowlist) return false;
  const patterns = allowlist.split(",").map((p) => p.trim()).filter(Boolean);
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => matchesAllowlist(repoFullName, pattern));
}

function getFirstPullRequest(checkRun: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!checkRun) return undefined;
  const fromRun = Array.isArray(checkRun.pull_requests) ? checkRun.pull_requests : [];
  if (fromRun.length > 0) {
    return asRecord(fromRun[0]);
  }
  const checkSuite = asRecord(checkRun.check_suite);
  const fromSuite = Array.isArray(checkSuite?.pull_requests) ? checkSuite.pull_requests : [];
  if (fromSuite.length > 0) {
    return asRecord(fromSuite[0]);
  }
  return undefined;
}

function verifyWebhookSignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const provided = signature.trim();
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function stripMention(text: string): string {
  return text.replace(/(^|\s)@daybreak-bot(\b|$)/gi, " ").replace(/\s{2,}/g, " ").trim();
}

function buildIssuePrompt(repoUrl: string, branch: string, prBranch: string, issue: unknown, commentBody: string): string {
  const issueTitle = (issue && typeof issue === "object" && "title" in issue && typeof issue.title === "string") ? issue.title : "No title";
  const issueBody = (issue && typeof issue === "object" && "body" in issue && typeof issue.body === "string") ? `\n\nBody:\n${issue.body}` : "";
  return `A GitHub issue was opened in ${repoUrl} (base branch: ${branch}). The checked-out feature branch is "${prBranch}".\n\nTitle: ${issueTitle}${issueBody}\n\nA user then commented:\n${commentBody}\n\nPlease investigate the issue, make the minimal fix, run the tests until they pass, then stage and commit the fix on the "${prBranch}" branch. Do NOT create a new branch, switch branches, run git push, or open a pull request; the control plane will push "${prBranch}" and open the PR.`;
}

function buildReviewPrompt(repoUrl: string, prNumber: number, baseBranch: string, headBranch: string, body: string): string {
  return `A reviewer left feedback on PR #${prNumber} in ${repoUrl} (base: ${baseBranch}, head: ${headBranch}):\n\n${body}\n\nPlease address the feedback on the existing PR branch ${headBranch}, run the tests, and push a follow-up commit.`;
}

async function isDuplicateDelivery(deliveryId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = `daybreak:webhook:${deliveryId}`;
    const stored = await redis.set(key, "1", { nx: true, ex: 60 * 60 * 24 });
    return stored === null;
  } catch (error) {
    console.error(`[control-plane] failed to check webhook delivery idempotency:`, error);
    return false;
  }
}

async function executeTask(task: Task): Promise<void> {
  try {
    const { repoWorkspaceId } = await assertCanSpawn(task.repo, task.githubSender);
    task.workspaceId = repoWorkspaceId;
    await updateTask(task.id, { workspaceId: repoWorkspaceId });
  } catch (error) {
    console.error(`[control-plane] task ${task.id} rejected:`, error);
    task.status = "failed";
    task.endedAt = Date.now();
    tasks.set(task.id, task);
    await updateTask(task.id, { status: "failed", endedAt: task.endedAt });
    await publishEvent(task.id, "task_failed", { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  task.status = "running";
  task.claimedAt = Date.now();
  tasks.set(task.id, task);
  await publishEvent(task.id, "task_start", { repo: task.repo, branch: task.branch, prBranch: task.prBranch, triggerSource: task.triggerSource });
  await updateTask(task.id, { status: "running", claimedAt: task.claimedAt });

  if (task.triggerSource === "check_run") {
    await executeHeal(task);
  } else if (task.triggerSource === "review_comment" || task.triggerSource === "pull_request_review") {
    await executeReview(task);
  } else {
    await executeSpawn(task);
  }
}

async function finalizeTask(task: Task, code: number | null, shouldCreatePr: boolean): Promise<void> {
  await syncEventsFromRedis(task.id);

  try {
    const redis = getRedis();
    const raw = await redis.lrange(`daybreak:stream:${task.id}`, 0, -1);
    const events = raw.map((item) => (typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent)));

    const created = events.find((e) => e.type === "sandbox_created");
    if (created?.data && typeof created.data === "object") {
      const d = created.data as Record<string, unknown>;
      const sandboxId = typeof d.sandboxId === "string" ? d.sandboxId : undefined;
      if (sandboxId) task.sandboxId = sandboxId;
    }
    const keepAlive = events.find((e) => e.type === "sandbox_keep_alive");
    if (keepAlive?.data && typeof keepAlive.data === "object") {
      const d = keepAlive.data as Record<string, unknown>;
      const sandboxId = typeof d.sandboxId === "string" ? d.sandboxId : undefined;
      const keepAliveUntil = typeof d.keepAliveUntil === "number" ? d.keepAliveUntil : undefined;
      if (sandboxId) task.sandboxId = sandboxId;
      if (keepAliveUntil) task.keepAliveUntil = keepAliveUntil;
    }

    const final = events.find((e) => e.type === "task_complete" || e.type === "task_failed");
    if (final?.data && typeof final.data === "object") {
      const d = final.data as Record<string, unknown>;
      const metrics = d.metrics as { estimatedCostUsd?: number } | undefined;
      task.traceId = typeof d.traceId === "string" ? d.traceId : undefined;
      task.provider = typeof d.provider === "string" ? d.provider : undefined;
      task.costUsd = typeof metrics?.estimatedCostUsd === "number" ? metrics.estimatedCostUsd : undefined;
    }
  } catch (error) {
    console.error(`[control-plane] failed to read final event for ${task.id}:`, error);
  }

  task.endedAt = Date.now();
  task.exitCode = code ?? undefined;
  task.status = code === 0 ? "complete" : "failed";
  tasks.set(task.id, task);
  await updateTask(task.id, task);

  if (shouldCreatePr && task.status === "complete" && config.githubToken) {
    const pr = await createPullRequest(task.repo, task.prBranch, task.branch, config.githubToken);
    if (pr) {
      task.prUrl = pr.url;
      task.prNumber = pr.number;
      tasks.set(task.id, task);
      await updateTask(task.id, { prUrl: pr.url, prNumber: pr.number });
      await publishEvent(task.id, "pr_created", { prUrl: pr.url, prNumber: pr.number, prBranch: task.prBranch, baseBranch: task.branch });
    }
  }
}

async function executeSpawn(task: Task): Promise<void> {
  const taskMaxTurns = task.maxTurns ?? config.maxTurns;
  const taskMaxCostUsd = task.maxCostUsd ?? config.maxCostUsd;
  const taskMaxWallClockMinutes = task.maxWallClockMinutes ?? config.maxWallClockMinutes;

  const env: NodeJS.ProcessEnv = {
    ...buildSpawnEnv(task.id, task.prBranch, task.repo, task.branch),
    MAX_TURNS: String(taskMaxTurns),
    MAX_WALL_CLOCK_MINUTES: String(taskMaxWallClockMinutes),
    MAX_COST_USD: String(taskMaxCostUsd),
  };

  const sandboxArgs = [
    "--filter",
    "agent-runner",
    "sandbox",
    `--repo=${task.repo}`,
    `--branch=${task.branch}`,
    `--task-id=${task.id}`,
    `--pr-branch=${task.prBranch}`,
    `--template=${config.e2bTemplate || "base"}`,
    "--keep-alive",
  ];

  if (task.prompt) {
    sandboxArgs.push(`--prompt=${task.prompt}`);
    env.TASK_PROMPT = task.prompt;
  }

  ensureLogDir();
  const logPath = getLogPath(task.id);
  await appendFile(logPath, `[${new Date().toISOString()}] task ${task.id} spawned\n`).catch(() => {});

  const child = spawn("pnpm", sandboxArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  function forwardLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    appendLog(task.id, text).catch(() => {});
  }

  if (child.stdout) child.stdout.on("data", forwardLog);
  if (child.stderr) child.stderr.on("data", forwardLog);

  child.unref();

  child.on("exit", async (code) => {
    await finalizeTask(task, code, true);
  });

  child.on("error", async (error) => {
    console.error(`[control-plane] failed to spawn task ${task.id}:`, error);
    task.status = "failed";
    task.endedAt = Date.now();
    tasks.set(task.id, task);
    await updateTask(task.id, { status: "failed", endedAt: task.endedAt });
    await publishEvent(task.id, "task_failed", { error: error.message });
  });
}

async function spawnRewind(parent: Task, sandboxId: string, checkpointId: string, prompt: string): Promise<Task> {
  rewindingTasks.add(parent.id);
  parent.status = "running";
  parent.endedAt = undefined;
  await updateTask(parent.id, { status: "running", endedAt: undefined });
  await publishEvent(parent.id, "task_rewind", { checkpointId, prompt });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2B_TEMPLATE: config.e2bTemplate || "base",
    TASK_ID: parent.id,
    PR_BRANCH_NAME: parent.prBranch,
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN || "",
    LANGFUSE_PUBLIC_KEY: config.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY || "",
    LANGFUSE_SECRET_KEY: config.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY || "",
    LANGFUSE_BASE_URL: config.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "",
    MAX_TURNS: String(config.maxTurns),
    MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
    MAX_COST_USD: String(config.maxCostUsd),
    COMPACTION_ENABLED: String(config.compactionEnabled),
    COMPACTION_RESERVE_TOKENS: String(config.compactionReserveTokens),
    COMPACTION_KEEP_RECENT_TOKENS: String(config.compactionKeepRecentTokens),
    TASK_PROMPT: prompt,
  };

  const sandboxArgs = [
    "--filter",
    "agent-runner",
    "sandbox",
    `--repo=${parent.repo}`,
    `--branch=${parent.branch}`,
    `--pr-branch=${parent.prBranch}`,
    `--task-id=${parent.id}`,
    `--parent-task-id=${parent.id}`,
    `--connect=${sandboxId}`,
    `--rewind-to-checkpoint=${checkpointId}`,
    `--prompt=${prompt}`,
  ];

  ensureLogDir();
  const logPath = getLogPath(parent.id);
  await appendFile(logPath, `[${new Date().toISOString()}] rewind ${parent.id} to ${checkpointId}\n`).catch(() => {});

  const child = spawn("pnpm", sandboxArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  function forwardLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    appendLog(parent.id, text).catch(() => {});
  }

  if (child.stdout) child.stdout.on("data", forwardLog);
  if (child.stderr) child.stderr.on("data", forwardLog);

  child.unref();

  child.on("exit", async (code) => {
    rewindingTasks.delete(parent.id);
    await syncEventsFromRedis(parent.id);

    try {
      const redis = getRedis();
      const raw = await redis.lrange(`daybreak:stream:${parent.id}`, 0, -1);
      const events = raw.map((item) => (typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent)));

      const final = events.find((e) => e.type === "task_complete" || e.type === "task_failed");
      if (final?.data && typeof final.data === "object") {
        const d = final.data as Record<string, unknown>;
        const metrics = d.metrics as { estimatedCostUsd?: number } | undefined;
        parent.traceId = typeof d.traceId === "string" ? d.traceId : undefined;
        parent.provider = typeof d.provider === "string" ? d.provider : undefined;
        parent.costUsd = typeof metrics?.estimatedCostUsd === "number" ? metrics.estimatedCostUsd : undefined;
      }
    } catch (error) {
      console.error(`[control-plane] failed to read final rewind event for ${parent.id}:`, error);
    }

    parent.endedAt = Date.now();
    parent.exitCode = code ?? undefined;
    parent.status = code === 0 ? "complete" : "failed";
    tasks.set(parent.id, parent);
    await updateTask(parent.id, parent);

    if (parent.status === "complete" && config.githubToken) {
      const pr = await createPullRequest(parent.repo, parent.prBranch, parent.branch, config.githubToken);
      if (pr) {
        parent.prUrl = pr.url;
        parent.prNumber = pr.number;
        tasks.set(parent.id, parent);
        await updateTask(parent.id, { prUrl: pr.url, prNumber: pr.number });
        await publishEvent(parent.id, "pr_created", { prUrl: pr.url, prNumber: pr.number, prBranch: parent.prBranch, baseBranch: parent.branch });
      }
    }
  });

  return parent;
}

async function resolveParentSandboxId(parent: Task): Promise<string | undefined> {
  if (parent.sandboxId) return parent.sandboxId;
  await syncEventsFromRedis(parent.id);
  const events = await getEvents(parent.id);
  const created = events.find((e) => e.type === "sandbox_created" || e.type === "sandbox_resumed");
  return created?.data && typeof created.data === "object" ? (created.data as Record<string, unknown>).sandboxId as string | undefined : undefined;
}

async function spawnFork(
  parent: Task,
  checkpoint: { id: string; taskId: string },
  prompt: string,
  strategy: "git-reinstall" | "snapshot" = "git-reinstall",
  snapshotId?: string,
): Promise<Task> {
  const prBranch = `daybreak/fork-${randomUUID()}`;
  const child = taskFrom({
    repo: parent.repo,
    branch: parent.branch,
    prBranch,
    prompt,
    status: "running",
    parentTaskId: parent.id,
    parentCheckpointId: checkpoint.id,
    triggerSource: "fork",
  });
  tasks.set(child.id, child);
  await persistTask(child);
  await updateCheckpoint(checkpoint.id, { branchTaskId: child.id });
  await publishEvent(child.id, "task_start", { repo: child.repo, branch: child.branch, prBranch: child.prBranch, parentTaskId: parent.id, parentCheckpointId: checkpoint.id });

  let e2bSnapshotId = snapshotId;
  if (strategy === "snapshot") {
    if (e2bSnapshotId) {
      console.log(`[control-plane] using provided snapshot ${e2bSnapshotId} for fork ${child.id}`);
    } else {
      const sandboxId = await resolveParentSandboxId(parent);
      if (!sandboxId) {
        throw new Error(`Cannot create E2B snapshot: parent sandbox id not found for ${parent.id}`);
      }
      console.log(`[control-plane] creating E2B snapshot from sandbox ${sandboxId} for fork ${child.id}...`);
      const Sandbox = await getE2BSandboxClass();
      const snapshot = await Sandbox.createSnapshot(sandboxId, { apiKey: config.e2bApiKey });
      e2bSnapshotId = snapshot.snapshotId;
      console.log(`[control-plane] snapshot created: ${e2bSnapshotId}`);
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2B_TEMPLATE: config.e2bTemplate || "base",
    TASK_ID: child.id,
    PR_BRANCH_NAME: child.prBranch,
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN || "",
    LANGFUSE_PUBLIC_KEY: config.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY || "",
    LANGFUSE_SECRET_KEY: config.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY || "",
    LANGFUSE_BASE_URL: config.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "",
    MAX_TURNS: String(config.maxTurns),
    MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
    MAX_COST_USD: String(config.maxCostUsd),
    COMPACTION_ENABLED: String(config.compactionEnabled),
    COMPACTION_RESERVE_TOKENS: String(config.compactionReserveTokens),
    COMPACTION_KEEP_RECENT_TOKENS: String(config.compactionKeepRecentTokens),
    TASK_PROMPT: prompt,
    FORK_SOURCE_BRANCH: parent.prBranch,
  };

  const sandboxArgs = [
    "--filter",
    "agent-runner",
    "sandbox",
    `--repo=${child.repo}`,
    `--branch=${child.branch}`,
    `--pr-branch=${child.prBranch}`,
    `--task-id=${child.id}`,
    `--parent-task-id=${parent.id}`,
    `--fork-from-checkpoint=${checkpoint.id}`,
    `--fork-prompt=${prompt}`,
    `--template=${config.e2bTemplate || "base"}`,
  ];
  if (e2bSnapshotId) {
    sandboxArgs.push(`--e2b-snapshot-id=${e2bSnapshotId}`);
  }

  ensureLogDir();
  const logPath = getLogPath(child.id);
  await appendFile(logPath, `[${new Date().toISOString()}] fork ${child.id} from checkpoint ${checkpoint.id} (${strategy})\n`).catch(() => {});

  const pnpm = spawn("pnpm", sandboxArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  function forwardLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    appendLog(child.id, text).catch(() => {});
  }

  if (pnpm.stdout) pnpm.stdout.on("data", forwardLog);
  if (pnpm.stderr) pnpm.stderr.on("data", forwardLog);

  pnpm.unref();

  pnpm.on("exit", async (code) => {
    await syncEventsFromRedis(child.id);

    try {
      const redis = getRedis();
      const raw = await redis.lrange(`daybreak:stream:${child.id}`, 0, -1);
      const events = raw.map((item) => (typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent)));

      const final = events.find((e) => e.type === "task_complete" || e.type === "task_failed");
      if (final?.data && typeof final.data === "object") {
        const d = final.data as Record<string, unknown>;
        const metrics = d.metrics as { estimatedCostUsd?: number } | undefined;
        child.traceId = typeof d.traceId === "string" ? d.traceId : undefined;
        child.provider = typeof d.provider === "string" ? d.provider : undefined;
        child.costUsd = typeof metrics?.estimatedCostUsd === "number" ? metrics.estimatedCostUsd : undefined;
      }
    } catch (error) {
      console.error(`[control-plane] failed to read final fork event for ${child.id}:`, error);
    }

    child.endedAt = Date.now();
    child.exitCode = code ?? undefined;
    child.status = code === 0 ? "complete" : "failed";
    tasks.set(child.id, child);
    await updateTask(child.id, child);

    if (child.status === "complete" && config.githubToken) {
      const pr = await createPullRequest(child.repo, child.prBranch, child.branch, config.githubToken);
      if (pr) {
        child.prUrl = pr.url;
        child.prNumber = pr.number;
        tasks.set(child.id, child);
        await updateTask(child.id, { prUrl: pr.url, prNumber: pr.number });
        await publishEvent(child.id, "pr_created", { prUrl: pr.url, prNumber: pr.number, prBranch: child.prBranch, baseBranch: child.branch });
      }
    }
  });

  return child;
}

class TaskRejectedError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function validatePat(repoUrl: string, token: string): Promise<{ ok: boolean; missing?: string[]; error?: string }> {
  const parsed = parseRepo(repoUrl);
  if (!parsed) return { ok: false, error: "invalid repo URL" };
  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      return { ok: false, error: `GitHub API returned ${res.status}: ${text}` };
    }
    const data = (await res.json()) as { permissions?: Record<string, unknown> };
    const perms = data.permissions || {};
    const contentsOk = perms.push === true || perms.admin === true || perms.contents === true || perms.contents === "write";
    const prsOk = perms.push === true || perms.admin === true || perms.pull_requests === true || perms.pull_requests === "write";
    if (contentsOk && prsOk) return { ok: true };
    const missing: string[] = [];
    if (!contentsOk) missing.push("contents:write");
    if (!prsOk) missing.push("pull_requests:write");
    return { ok: false, missing };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function killSandbox(sandboxId: string): Promise<boolean> {
  try {
    const Sandbox = await getE2BSandboxClass();
    return await Sandbox.kill(sandboxId, { apiKey: config.e2bApiKey });
  } catch (error) {
    console.error(`[control-plane] failed to kill sandbox ${sandboxId}:`, error);
    return false;
  }
}

async function resolveTaskSandboxId(task: Task): Promise<string | undefined> {
  if (task.sandboxId) return task.sandboxId;
  await syncEventsFromRedis(task.id);
  const events = await getEvents(task.id);
  const sandboxEventTypes = new Set(["sandbox_created", "sandbox_resumed", "sandbox_keep_alive"]);
  const latest = [...events].reverse().find((ev) => sandboxEventTypes.has(ev.type));
  return latest?.data && typeof latest.data === "object" ? (latest.data as Record<string, unknown>).sandboxId as string | undefined : undefined;
}

async function abandonTask(task: Task): Promise<void> {
  if (task.status === "abandoned") return;
  const sandboxId = await resolveTaskSandboxId(task);
  task.status = "abandoned";
  task.endedAt = Date.now();
  tasks.set(task.id, task);
  await updateTask(task.id, { status: "abandoned", endedAt: task.endedAt });
  await publishEvent(task.id, "branch_abandoned", { childTaskId: task.id });
  if (sandboxId) {
    const killed = await killSandbox(sandboxId);
    await publishEvent(task.id, "sandbox_killed", { sandboxId, killed });
  }
}

async function promoteTask(task: Task): Promise<{ url: string; number: number } | undefined> {
  if (task.status === "promoted") return undefined;
  if (!task.parentTaskId) throw new Error("Cannot promote a task with no parent");
  if (!config.githubToken) throw new Error("GITHUB_TOKEN not configured");
  if (task.prBranch === task.branch || task.branch === "main" || task.branch === "master") {
    throw new TaskRejectedError("Promotion cannot override the protected base branch", 400);
  }

  const pr = await createPullRequest(task.repo, task.prBranch, task.branch, config.githubToken);
  if (!pr) throw new Error("PR creation failed during promotion");

  task.status = "promoted";
  task.prUrl = pr.url;
  task.prNumber = pr.number;
  task.endedAt = Date.now();
  tasks.set(task.id, task);
  await updateTask(task.id, { status: "promoted", prUrl: pr.url, prNumber: pr.number, endedAt: task.endedAt });
  await publishEvent(task.id, "branch_promoted", { childTaskId: task.id, prUrl: pr.url, prNumber: pr.number });

  const parent = tasks.get(task.parentTaskId) ?? (await getTask(task.parentTaskId));
  if (parent) {
    parent.prUrl = pr.url;
    parent.prNumber = pr.number;
    tasks.set(parent.id, parent);
    await updateTask(parent.id, { prUrl: pr.url, prNumber: pr.number });
  }

  const all = await getTasks();
  for (const sibling of all) {
    if (sibling.id !== task.id && sibling.parentTaskId === task.parentTaskId && sibling.status !== "abandoned" && sibling.status !== "promoted") {
      const inMemory = tasks.get(sibling.id);
      if (inMemory) await abandonTask(inMemory);
      else await abandonTask(sibling);
    }
  }

  return pr;
}

async function checkWorkspaceLimit(workspace: { id: string; tasksPerHour: number } | undefined, label: string): Promise<void> {
  if (!workspace) return;
  const windowMs = 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const count = await countTasksByWorkspace(workspace.id, cutoff);
  if (count >= workspace.tasksPerHour) {
    throw new TaskRejectedError(`rate limit exceeded for ${label}`, 429);
  }
}

async function assertCanSpawn(repo: string, sender: string | undefined): Promise<{ repoWorkspaceId?: string; senderWorkspaceId?: string }> {
  if (!config.githubToken) {
    throw new TaskRejectedError("GITHUB_TOKEN not configured", 500);
  }

  const defaultLimit = config.githubWebhookRateLimit ?? 10;
  const repoWorkspace = await ensureWorkspace("repo", repo, defaultLimit);
  const senderWorkspace = sender ? await ensureWorkspace("sender", sender, defaultLimit) : undefined;

  await checkWorkspaceLimit(repoWorkspace, `repo ${repo}`);
  await checkWorkspaceLimit(senderWorkspace, `sender ${sender}`);

  const validation = await validatePat(repo, config.githubToken);
  if (!validation.ok) {
    throw new TaskRejectedError(validation.error || `missing PAT permissions: ${validation.missing?.join(", ") || "unknown"}`, 403);
  }

  return { repoWorkspaceId: repoWorkspace?.id, senderWorkspaceId: senderWorkspace?.id };
}

async function findOriginalTask(repo: string, prNumber: number, prBranch: string): Promise<Task | undefined> {
  const memory = Array.from(tasks.values()).find((t) => t.repo === repo && (t.prNumber === prNumber || t.prBranch === prBranch));
  if (memory) return memory;
  const db = await getTasks();
  return db.find((t) => t.repo === repo && (t.prNumber === prNumber || t.prBranch === prBranch));
}

function buildSpawnEnv(taskId: string, prBranch: string, repo: string, branch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    E2B_TEMPLATE: config.e2bTemplate || "base",
    TASK_ID: taskId,
    PR_BRANCH_NAME: prBranch,
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN || "",
    LANGFUSE_PUBLIC_KEY: config.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY || "",
    LANGFUSE_SECRET_KEY: config.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY || "",
    LANGFUSE_BASE_URL: config.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "",
    MAX_TURNS: String(config.maxTurns),
    MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
    MAX_COST_USD: String(config.maxCostUsd),
    COMPACTION_ENABLED: String(config.compactionEnabled),
    COMPACTION_RESERVE_TOKENS: String(config.compactionReserveTokens),
    COMPACTION_KEEP_RECENT_TOKENS: String(config.compactionKeepRecentTokens),
    GITHUB_TOKEN: config.githubToken || "",
    TARGET_REPO_URL: repo,
    TARGET_BRANCH: branch,
  };
}

async function executeReview(task: Task): Promise<void> {
  const env = buildSpawnEnv(task.id, task.prBranch, task.repo, task.branch);
  if (task.prompt) {
    env.TASK_PROMPT = task.prompt;
  }
  env.REVIEW_MODE = "true";
  if (task.maxTurns !== undefined) env.MAX_TURNS = String(task.maxTurns);
  if (task.maxCostUsd !== undefined) env.MAX_COST_USD = String(task.maxCostUsd);
  if (task.maxWallClockMinutes !== undefined) env.MAX_WALL_CLOCK_MINUTES = String(task.maxWallClockMinutes);

  const sandboxArgs = [
    "--filter",
    "agent-runner",
    "sandbox",
    `--repo=${task.repo}`,
    `--branch=${task.branch}`,
    `--task-id=${task.id}`,
    `--pr-branch=${task.prBranch}`,
    `--template=${config.e2bTemplate || "base"}`,
    "--review",
    "--keep-alive",
  ];

  if (task.sandboxId && task.keepAliveUntil && Date.now() < task.keepAliveUntil) {
    sandboxArgs.push(`--connect=${task.sandboxId}`, "--fallback-create");
  }
  if (task.prompt) {
    sandboxArgs.push(`--prompt=${task.prompt}`);
  }

  ensureLogDir();
  const logPath = getLogPath(task.id);
  await appendFile(logPath, `[${new Date().toISOString()}] review ${task.id} spawned\n`).catch(() => {});

  const child = spawn("pnpm", sandboxArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  function forwardLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    appendLog(task.id, text).catch(() => {});
  }

  if (child.stdout) child.stdout.on("data", forwardLog);
  if (child.stderr) child.stderr.on("data", forwardLog);

  child.unref();

  child.on("exit", async (code) => {
    await finalizeTask(task, code, false);
  });

  child.on("error", async (error) => {
    console.error(`[control-plane] failed to spawn review ${task.id}:`, error);
    task.status = "failed";
    task.endedAt = Date.now();
    tasks.set(task.id, task);
    await updateTask(task.id, { status: "failed", endedAt: task.endedAt });
    await publishEvent(task.id, "task_failed", { error: error.message });
  });
}

function buildCiHealPrompt(repoUrl: string, prNumber: number | undefined, headBranch: string, headSha: string, checkName: string, errorContext: string): string {
  return `CI check '${checkName}' failed on PR #${prNumber ?? "unknown"} (branch ${headBranch}, commit ${headSha}) in ${repoUrl}:

${errorContext || "No detailed error context was available."}

Investigate the repo, reproduce the failure, apply the minimal fix, run the failing test command, and push a follow-up commit to branch ${headBranch}. Do not open a new PR.`;
}

async function getCheckRunTasks(repo: string, prNumber: number | undefined, prBranch: string): Promise<Task[]> {
  const inMemory = Array.from(tasks.values()).filter(
    (t) => t.repo === repo && t.triggerSource === "check_run" && (t.prNumber === prNumber || t.prBranch === prBranch),
  );
  const db = await getTasks();
  const dbMatches = db.filter(
    (t) => t.repo === repo && t.triggerSource === "check_run" && (t.prNumber === prNumber || t.prBranch === prBranch),
  );
  const seen = new Set<string>();
  const all: Task[] = [];
  for (const t of [...inMemory, ...dbMatches]) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      all.push(t);
    }
  }
  return all.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

async function countHealAttempts(repo: string, prNumber: number | undefined, prBranch: string, windowMs?: number): Promise<number> {
  const all = await getCheckRunTasks(repo, prNumber, prBranch);
  if (!windowMs) {
    return all.length;
  }
  const since = Date.now() - windowMs;
  return all.filter((t) => t.startedAt > since).length;
}

async function findRunningHealTask(repo: string, prNumber: number | undefined, prBranch: string): Promise<Task | undefined> {
  const all = await getCheckRunTasks(repo, prNumber, prBranch);
  return all.find((t) => t.status === "running");
}

async function findRecentHealForSha(repo: string, headSha: string, windowMs: number): Promise<Task | undefined> {
  const inMemory = Array.from(tasks.values()).filter(
    (t) => t.repo === repo && t.triggerSource === "check_run" && t.headSha === headSha && t.startedAt > Date.now() - windowMs,
  );
  const db = await getTasks();
  const dbMatches = db.filter(
    (t) => t.repo === repo && t.triggerSource === "check_run" && t.headSha === headSha && t.startedAt > Date.now() - windowMs,
  );
  const seen = new Set<string>();
  const all: Task[] = [];
  for (const t of [...inMemory, ...dbMatches]) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      all.push(t);
    }
  }
  return all.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

async function getHealingTaskForCheckRun(checkRunId: string): Promise<string | undefined> {
  try {
    const redis = getRedis();
    const value = (await redis.get(`daybreak:heal-checkrun:${checkRunId}`)) as string | null;
    return value || undefined;
  } catch (error) {
    console.error(`[control-plane] failed to check check-run dedupe key for ${checkRunId}:`, error);
    return undefined;
  }
}

async function markCheckRunAsHealed(checkRunId: string, taskId: string) {
  try {
    const redis = getRedis();
    await redis.set(`daybreak:heal-checkrun:${checkRunId}`, taskId, { ex: 60 * 60 * 24 });
  } catch (error) {
    console.error(`[control-plane] failed to mark check-run ${checkRunId} as healed:`, error);
  }
}

async function buildHealContext(task: Task): Promise<{ prompt: string; annotationsCount: number; logBytes: number; errorContextLength: number }> {
  const repoUrl = task.repo;
  const parsed = parseRepo(repoUrl);
  const metadata = task.metadata ?? {};
  let errorContext = "";
  let logBytes = 0;
  let annotationsCount = 0;

  if (parsed && config.githubToken && task.checkRunId) {
    try {
      const fetcher = new CiLogFetcher(config.githubToken);
      const annotations = await fetcher.fetchAnnotations(parsed.owner, parsed.repo, task.checkRunId);
      annotationsCount = annotations.length;

      let logs = "";
      try {
        logs = await fetcher.fetchJobLogs(parsed.owner, parsed.repo, task.checkRunId, config.maxCiLogBytes);
      } catch (logErr) {
        console.log(`[control-plane] failed to fetch job logs for ${task.checkRunId}:`, logErr);
      }
      logBytes = logs.length;

      const parser = new CiLogParser({ contextLines: config.ciLogContextLines });
      const output = metadata.output as CheckRunOutput | undefined;
      errorContext = parser.parseErrorContext(logs, annotations, output);
    } catch (err) {
      console.error("[control-plane] failed to build CI error context:", err);
    }
  } else if (metadata.output) {
    const parser = new CiLogParser({ contextLines: config.ciLogContextLines });
    errorContext = parser.parseErrorContext("", [], metadata.output as CheckRunOutput);
  }

  const prompt = buildCiHealPrompt(repoUrl, task.prNumber, task.prBranch || `daybreak/${task.id}`, task.headSha || "", String(metadata.checkName || ""), errorContext);
  return { prompt, annotationsCount, logBytes, errorContextLength: errorContext.length };
}

async function executeHeal(task: Task): Promise<void> {
  const { prompt, annotationsCount, logBytes, errorContextLength } = await buildHealContext(task);
  task.prompt = prompt;
  await updateTask(task.id, { prompt });

  await publishEvent(task.id, "ci_failure_received", {
    checkRunId: task.checkRunId,
    checkSuiteId: task.metadata?.checkSuiteId,
    checkName: task.metadata?.checkName,
    headBranch: task.prBranch,
    headSha: task.headSha,
    prNumber: task.prNumber,
    repo: parseRepo(task.repo)?.owner ? `${parseRepo(task.repo)!.owner}/${parseRepo(task.repo)!.repo}` : task.repo,
    repoUrl: task.repo,
    healAttempt: task.healAttempt,
  });

  await publishEvent(task.id, "ci_logs_fetched", {
    checkRunId: task.checkRunId,
    headSha: task.headSha,
    annotationsCount,
    logBytes,
    errorContextLength,
  });

  const env = buildSpawnEnv(task.id, task.prBranch, task.repo, task.branch);
  env.TASK_PROMPT = prompt;
  env.REVIEW_MODE = "true";
  env.HEAL_MODE = "true";
  if (task.maxTurns !== undefined) env.MAX_TURNS = String(task.maxTurns);
  if (task.maxCostUsd !== undefined) env.MAX_COST_USD = String(task.maxCostUsd);
  if (task.maxWallClockMinutes !== undefined) env.MAX_WALL_CLOCK_MINUTES = String(task.maxWallClockMinutes);

  const sandboxArgs = [
    "--filter",
    "agent-runner",
    "sandbox",
    `--repo=${task.repo}`,
    `--branch=${task.branch}`,
    `--task-id=${task.id}`,
    `--pr-branch=${task.prBranch}`,
    `--template=${config.e2bTemplate || "base"}`,
    "--heal",
    "--keep-alive",
  ];

  if (task.sandboxId && task.keepAliveUntil && Date.now() < task.keepAliveUntil) {
    sandboxArgs.push(`--connect=${task.sandboxId}`, "--fallback-create");
  }
  if (prompt) {
    sandboxArgs.push(`--prompt=${prompt}`);
  }

  ensureLogDir();
  const logPath = getLogPath(task.id);
  await appendFile(logPath, `[${new Date().toISOString()}] heal ${task.id} spawned\n`).catch(() => {});

  const child = spawn("pnpm", sandboxArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  function forwardLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    appendLog(task.id, text).catch(() => {});
  }

  if (child.stdout) child.stdout.on("data", forwardLog);
  if (child.stderr) child.stderr.on("data", forwardLog);

  child.unref();

  child.on("exit", async (code) => {
    await finalizeTask(task, code, false);
  });

  child.on("error", async (error) => {
    console.error(`[control-plane] failed to spawn heal ${task.id}:`, error);
    task.status = "failed";
    task.endedAt = Date.now();
    tasks.set(task.id, task);
    await updateTask(task.id, { status: "failed", endedAt: task.endedAt });
    await publishEvent(task.id, "task_failed", { error: error.message });
  });
}

const config = loadConfig();

const queue = new TaskQueue({
  maxConcurrent: config.maxConcurrentTasks,
  pollMs: config.queueWorkerPollMs,
  onClaim: executeTask,
  onEvent: (taskId, type, data) => publishEvent(taskId, type, data),
  workerId: process.env.HOSTNAME || `worker-${randomUUID().slice(0, 8)}`,
});

if (config.queueWorkerEnabled && process.env.NODE_ENV !== "test") {
  queue.start();
}

const app = new Hono();

app.use("/api/*", cors({ origin: "*" }));

app.get("/", (c) => c.text("Daybreak control plane"));

app.get("/api/config", (c) => {
  return c.json({
    maxTurns: config.maxTurns,
    maxWallClockMinutes: config.maxWallClockMinutes,
    maxCostUsd: config.maxCostUsd,
    compactionEnabled: config.compactionEnabled,
    e2bTemplate: config.e2bTemplate,
    provider: config.llm.provider,
    maxConcurrentTasks: config.maxConcurrentTasks,
    queueWorkerEnabled: config.queueWorkerEnabled,
  });
});

app.get("/api/tasks", async (c) => {
  const dbTasks = await getTasks();
  const merged = new Map<string, Task>();
  for (const task of dbTasks) {
    merged.set(task.id, task);
  }
  for (const task of tasks.values()) {
    merged.set(task.id, task);
  }
  return c.json(Array.from(merged.values()));
});

app.get("/api/queue/status", async (c) => {
  const dbTasks = await getTasks();
  const merged = new Map<string, Task>();
  for (const task of dbTasks) {
    merged.set(task.id, task);
  }
  for (const task of tasks.values()) {
    merged.set(task.id, task);
  }
  const all = Array.from(merged.values());
  const pending = all.filter((t) => t.status === "pending").length;
  const running = all.filter((t) => t.status === "running").length;
  const queueStatus = queue.getStatus();
  return c.json({
    pending,
    running,
    maxConcurrent: config.maxConcurrentTasks,
    workerEnabled: config.queueWorkerEnabled,
    workerPollMs: config.queueWorkerPollMs,
    workerPending: queueStatus.pending,
    workerRunning: queueStatus.running,
  });
});

app.post("/api/tasks", async (c) => {
  const body = await c.req.json<{
    repo?: string;
    branch?: string;
    prompt?: string;
    maxTurns?: number;
    maxCostUsd?: number;
    maxWallClockMinutes?: number;
  }>().catch(() => ({}) as { repo?: string; branch?: string; prompt?: string; maxTurns?: number; maxCostUsd?: number; maxWallClockMinutes?: number });
  const repo = body.repo;
  const branch = body.branch || "main";
  const prompt = body.prompt;

  if (!repo) {
    return c.json({ error: "repo is required" }, 400);
  }

  try {
    const task = await queue.enqueue({
      repo,
      branch,
      prompt,
      triggerSource: "dashboard",
      maxTurns: body.maxTurns,
      maxCostUsd: body.maxCostUsd,
      maxWallClockMinutes: body.maxWallClockMinutes,
    });
    return c.json({ taskId: task.id, repo, branch, status: task.status }, 202);
  } catch (error) {
    if (error instanceof TaskRejectedError) {
      return c.json({ error: error.message }, error.status as 403 | 429 | 500);
    }
    throw error;
  }
});

app.post(
  "/api/webhooks/github",
  bodyLimit({ maxSize: 1 * 1024 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }),
  async (c) => {
    try {
      const signature = c.req.header("x-hub-signature-256") || "";
      const event = c.req.header("x-github-event") || "";
      const deliveryId = c.req.header("x-github-delivery") || "";

    if (!config.githubWebhookSecret) {
      return c.json({ error: "webhook secret not configured" }, 500);
    }
    if (!signature) {
      return c.json({ error: "missing X-Hub-Signature-256" }, 400);
    }
    if (!deliveryId) {
      return c.json({ error: "missing X-GitHub-Delivery" }, 400);
    }

    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!verifyWebhookSignature(config.githubWebhookSecret, raw, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    if (await isDuplicateDelivery(deliveryId)) {
      return c.json({ ok: true, note: "duplicate delivery" }, 200);
    }

    const payload = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
    const repository = asRecord(payload.repository);
    const repoFullName = typeof repository?.full_name === "string" ? repository.full_name : undefined;
    const repoUrl = typeof repository?.clone_url === "string" ? repository.clone_url : undefined;

    if (!repoFullName || !repoUrl) {
      return c.json({ error: "missing repository" }, 400);
    }

    if (!isRepoAllowed(repoFullName, config.githubWebhookRepoAllowlist)) {
      console.warn(`[control-plane] webhook from disallowed repo: ${repoFullName}`);
      return c.json({ error: "repository not in allowlist" }, 403);
    }

    const sender = typeof payload.sender === "object" && payload.sender !== null ? asRecord(payload.sender)?.login : undefined;

    switch (event) {
      case "ping": {
        return c.json({ ok: true, event: "ping" }, 200);
      }
      case "check_run": {
        if (!config.ciSelfHealEnabled) {
          return c.json({ ok: true, note: "CI self-healing is disabled" }, 200);
        }

        const action = typeof payload.action === "string" ? payload.action : "";
        if (action !== "completed") {
          return c.json({ ok: true, note: "ignored non-completed check_run" }, 200);
        }

        const checkRun = asRecord(payload.check_run);
        if (!checkRun) {
          return c.json({ error: "missing check_run" }, 400);
        }

        const conclusion = typeof checkRun.conclusion === "string" ? checkRun.conclusion : "";
        if (conclusion !== "failure") {
          return c.json({ ok: true, note: `ignored check_run with conclusion: ${conclusion}` }, 200);
        }

        const checkSuite = asRecord(checkRun.check_suite);
        const pr = getFirstPullRequest(checkRun);

        const headBranch = typeof checkSuite?.head_branch === "string"
          ? checkSuite.head_branch
          : (pr && typeof pr.head === "object" && pr.head !== null
              ? asRecord(pr.head)?.ref
              : undefined);
        if (typeof headBranch !== "string" || !headBranch) {
          return c.json({ error: "missing head branch" }, 400);
        }

        const baseRef = (pr && typeof pr.base === "object" && pr.base !== null
          ? asRecord(pr.base)?.ref
          : undefined);
        const baseBranch = typeof baseRef === "string" && baseRef
          ? baseRef
          : (typeof repository?.default_branch === "string" && repository.default_branch
              ? repository.default_branch
              : "main");

        const headSha = typeof checkRun.head_sha === "string"
          ? checkRun.head_sha
          : (typeof checkSuite?.head_sha === "string" ? checkSuite.head_sha : "");

        const prNumber = typeof pr?.number === "number" ? pr.number : undefined;

        if (config.protectedBranches.includes(headBranch)) {
          return c.json({ ok: true, note: "ignored check_run on protected branch" }, 200);
        }

        const originalTask = await findOriginalTask(repoUrl, prNumber ?? 0, headBranch);
        if (!originalTask && !headBranch.startsWith(config.prBranchPrefix)) {
          return c.json({ ok: true, note: "branch is not a Daybreak PR" }, 200);
        }

        const checkRunId = typeof checkRun.id === "number" ? String(checkRun.id) : (typeof checkRun.id === "string" ? checkRun.id : "");
        const checkSuiteId = typeof checkSuite?.id === "number" ? String(checkSuite.id) : (typeof checkSuite?.id === "string" ? String(checkSuite.id) : "");
        const checkName = typeof checkRun.name === "string" ? checkRun.name : "";
        const checkRunOutput = asRecord(checkRun.output) as CheckRunOutput | undefined;

        const duplicateCheckRunTaskId = checkRunId ? await getHealingTaskForCheckRun(checkRunId) : undefined;
        if (duplicateCheckRunTaskId) {
          await publishEvent(duplicateCheckRunTaskId, "heal_skipped", { reason: "duplicate check run", checkRunId, headSha, prBranch: headBranch });
          return c.json({ ok: true, note: "duplicate check run" }, 200);
        }

        const inFlight = await findRunningHealTask(repoUrl, prNumber, headBranch);
        if (inFlight) {
          await publishEvent(inFlight.id, "heal_skipped", { reason: "heal already in flight", checkRunId, headSha, prBranch: headBranch });
          return c.json({ ok: true, note: "heal already in flight" }, 200);
        }

        const recentHealCount = await countHealAttempts(repoUrl, prNumber, headBranch, 24 * 60 * 60 * 1000);
        if (recentHealCount >= config.maxHealAttemptsPerPr) {
          const latest = (await getCheckRunTasks(repoUrl, prNumber, headBranch))[0];
          if (latest) {
            await publishEvent(latest.id, "heal_skipped", { reason: "max heal attempts reached", checkRunId, headSha, prBranch: headBranch });
          }
          return c.json({ ok: true, note: "max heal attempts reached" }, 200);
        }

        const cooldownMs = config.healCooldownSeconds * 1000;
        const recentSha = await findRecentHealForSha(repoUrl, headSha, cooldownMs);
        if (recentSha) {
          await publishEvent(recentSha.id, "heal_skipped", { reason: "heal cooldown", checkRunId, headSha, prBranch: headBranch });
          return c.json({ ok: true, note: "heal cooldown" }, 200);
        }

        const healAttempt = (await countHealAttempts(repoUrl, prNumber, headBranch)) + 1;

        const task = await queue.enqueue({
          repo: repoUrl,
          branch: baseBranch,
          prBranch: originalTask?.prBranch ?? headBranch,
          triggerSource: "check_run",
          githubSender: typeof sender === "string" ? sender : undefined,
          prNumber,
          headSha,
          checkRunId,
          checkSuiteId,
          checkName,
          output: checkRunOutput as Record<string, unknown>,
          healAttempt,
          parentTaskId: originalTask?.id,
          metadata: { checkSuiteId, checkName, output: checkRunOutput as Record<string, unknown> },
        });

        if (checkRunId) {
          await markCheckRunAsHealed(checkRunId, task.id);
        }

        return c.json({ taskId: task.id, repo: repoFullName, branch: baseBranch, prBranch: headBranch, headSha, status: task.status }, 202);
      }
      case "issue_comment": {
        const action = typeof payload.action === "string" ? payload.action : "";
        if (action !== "created") {
          return c.json({ ok: true, note: "ignored non-created issue_comment" }, 200);
        }
        const issue = asRecord(payload.issue);
        if (!issue) {
          return c.json({ error: "missing issue" }, 400);
        }
        if ("pull_request" in issue) {
          return c.json({ ok: true, note: "ignored issue_comment on pull request" }, 200);
        }
        const comment = asRecord(payload.comment);
        const commentBody = typeof comment?.body === "string" ? comment.body : "";
        if (!hasMention(commentBody)) {
          return c.json({ ok: true, note: "no @daybreak-bot mention" }, 200);
        }
        const defaultBranch = typeof repository?.default_branch === "string" ? repository.default_branch : "main";
        const issueTitle = typeof issue.title === "string" ? issue.title : "";
        const issueBody = typeof issue.body === "string" ? issue.body : "";
        const issuePrBranch = `daybreak/${randomUUID()}`;
        const prompt = buildIssuePrompt(repoUrl, defaultBranch, issuePrBranch, { title: issueTitle, body: issueBody }, stripMention(commentBody));
        const task = await queue.enqueue({ repo: repoUrl, branch: defaultBranch, prBranch: issuePrBranch, prompt, triggerSource: "issue_comment", githubSender: typeof sender === "string" ? sender : undefined });
        return c.json({ taskId: task.id, repo: repoFullName, branch: defaultBranch, status: task.status }, 202);
      }
      case "pull_request_review_comment": {
        const action = typeof payload.action === "string" ? payload.action : "";
        if (action !== "created") {
          return c.json({ ok: true, note: "ignored non-created pull_request_review_comment" }, 200);
        }
        const comment = asRecord(payload.comment);
        const commentBody = typeof comment?.body === "string" ? comment.body : "";
        if (!hasMention(commentBody)) {
          return c.json({ ok: true, note: "no @daybreak-bot mention" }, 200);
        }
        const pullRequest = asRecord(payload.pull_request);
        if (!pullRequest) {
          return c.json({ error: "missing pull_request" }, 400);
        }
        const base = asRecord(pullRequest.base);
        const head = asRecord(pullRequest.head);
        const baseRef = typeof base?.ref === "string" ? base.ref : "main";
        const headRef = typeof head?.ref === "string" ? head.ref : `daybreak/${randomUUID()}`;
        const prNumber = typeof pullRequest.number === "number" ? pullRequest.number : 0;
        const prompt = buildReviewPrompt(repoUrl, prNumber, baseRef, headRef, stripMention(commentBody));
        const reviewOriginalTask = await findOriginalTask(repoUrl, prNumber, headRef);
        const prBranch = reviewOriginalTask?.prBranch ?? headRef;
        const task = await queue.enqueue({
          repo: repoUrl,
          branch: baseRef,
          prBranch,
          prompt,
          triggerSource: "review_comment",
          githubSender: typeof sender === "string" ? sender : undefined,
          prNumber,
          sandboxId: reviewOriginalTask?.sandboxId,
          keepAliveUntil: reviewOriginalTask?.keepAliveUntil,
          parentTaskId: reviewOriginalTask?.id,
        });
        return c.json({ taskId: task.id, repo: repoFullName, branch: baseRef, prBranch, status: task.status }, 202);
      }
      case "pull_request_review": {
        const action = typeof payload.action === "string" ? payload.action : "";
        if (action !== "submitted") {
          return c.json({ ok: true, note: "ignored non-submitted pull_request_review" }, 200);
        }
        const review = asRecord(payload.review);
        const reviewBody = typeof review?.body === "string" ? review.body : "";
        if (!reviewBody || !hasMention(reviewBody)) {
          return c.json({ ok: true, note: "no @daybreak-bot mention" }, 200);
        }
        const pullRequest = asRecord(payload.pull_request);
        if (!pullRequest) {
          return c.json({ error: "missing pull_request" }, 400);
        }
        const base = asRecord(pullRequest.base);
        const head = asRecord(pullRequest.head);
        const baseRef = typeof base?.ref === "string" ? base.ref : "main";
        const headRef = typeof head?.ref === "string" ? head.ref : `daybreak/${randomUUID()}`;
        const prNumber = typeof pullRequest.number === "number" ? pullRequest.number : 0;
        const prompt = buildReviewPrompt(repoUrl, prNumber, baseRef, headRef, stripMention(reviewBody));
        const prReviewOriginalTask = await findOriginalTask(repoUrl, prNumber, headRef);
        const prBranch = prReviewOriginalTask?.prBranch ?? headRef;
        const task = await queue.enqueue({
          repo: repoUrl,
          branch: baseRef,
          prBranch,
          prompt,
          triggerSource: "pull_request_review",
          githubSender: typeof sender === "string" ? sender : undefined,
          prNumber,
          sandboxId: prReviewOriginalTask?.sandboxId,
          keepAliveUntil: prReviewOriginalTask?.keepAliveUntil,
          parentTaskId: prReviewOriginalTask?.id,
        });
        return c.json({ taskId: task.id, repo: repoFullName, branch: baseRef, prBranch, status: task.status }, 202);
      }
      default: {
        return c.json({ ok: true, note: `unhandled event: ${event}` }, 200);
      }
    }
  } catch (error) {
    if (error instanceof TaskRejectedError) {
      return c.json({ ok: false, error: error.message }, error.status as 403 | 429 | 500);
    }
    throw error;
  }
  },
);

app.get("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getTask(id);
  const task = db ?? tasks.get(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json(task);
});

app.get("/api/tasks/:id/events", async (c) => {
  const id = c.req.param("id");
  await syncEventsFromRedis(id);
  const events = await getEvents(id);
  return c.json(events);
});

app.get("/api/tasks/:id/checkpoints", async (c) => {
  const id = c.req.param("id");
  const checkpoints = await listCheckpoints(id);
  return c.json(checkpoints);
});

app.get("/api/checkpoints/:id", async (c) => {
  const id = c.req.param("id");
  const checkpoint = await getCheckpoint(id);
  if (!checkpoint) return c.json({ error: "checkpoint not found" }, 404);
  return c.json(checkpoint);
});

app.post("/api/checkpoints/:checkpointId/fork", async (c) => {
  const checkpointId = c.req.param("checkpointId");
  const body = await c.req.json().catch(() => ({}));
  const prompt = (body as Record<string, unknown>).prompt;
  const rawStrategy = (body as Record<string, unknown>).strategy ?? config.forkStrategy ?? "git-reinstall";
  const strategy = rawStrategy === "auto" ? "git-reinstall" : rawStrategy;
  const snapshotId = (body as Record<string, unknown>).snapshotId;
  if (typeof prompt !== "string") {
    return c.json({ error: "prompt is required" }, 400);
  }
  if (strategy !== "git-reinstall" && strategy !== "snapshot") {
    return c.json({ error: "strategy must be git-reinstall or snapshot" }, 400);
  }

  const checkpoint = await getCheckpoint(checkpointId);
  if (!checkpoint) return c.json({ error: "checkpoint not found" }, 404);

  const parent = tasks.get(checkpoint.taskId) ?? (await getTask(checkpoint.taskId));
  if (!parent) return c.json({ error: "parent task not found" }, 404);

  const child = await spawnFork(
    parent,
    checkpoint,
    prompt,
    strategy as "git-reinstall" | "snapshot",
    typeof snapshotId === "string" ? snapshotId : undefined,
  );
  await publishEvent(parent.id, "branch_forked", { childTaskId: child.id, checkpointId, prompt, strategy });
  return c.json({ taskId: child.id, status: child.status, prBranch: child.prBranch, strategy }, 202);
});

app.post("/api/tasks/:id/rewind", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const checkpointId = (body as Record<string, unknown>).checkpointId;
  const prompt = (body as Record<string, unknown>).prompt;
  if (typeof checkpointId !== "string" || typeof prompt !== "string") {
    return c.json({ error: "checkpointId and prompt are required" }, 400);
  }

  const task = tasks.get(id) ?? (await getTask(id));
  if (!task) return c.json({ error: "task not found" }, 404);

  const checkpoint = await getCheckpoint(checkpointId);
  if (!checkpoint) return c.json({ error: "checkpoint not found" }, 404);
  if (checkpoint.taskId !== id) return c.json({ error: "checkpoint does not belong to task" }, 400);

  await syncEventsFromRedis(id);
  const events = await getEvents(id);
  const created = events.find((e) => e.type === "sandbox_created" || e.type === "sandbox_resumed");
  const sandboxId = created?.data && typeof created.data === "object" ? (created.data as Record<string, unknown>).sandboxId : undefined;
  if (typeof sandboxId !== "string") {
    return c.json({ error: "sandbox not yet created" }, 400);
  }

  await spawnRewind(task, sandboxId, checkpointId, prompt);
  return c.json({ taskId: task.id, checkpointId, status: task.status }, 202);
});

app.post("/api/tasks/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const task = tasks.get(id) ?? (await getTask(id));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "pending") {
    return c.json({ error: "only pending tasks can be cancelled" }, 400);
  }
  queue.cancel(id);
  task.status = "cancelled";
  task.endedAt = Date.now();
  tasks.set(task.id, task);
  await updateTask(id, { status: "cancelled", endedAt: task.endedAt });
  await publishEvent(id, "task_cancelled", { reason: "user requested cancel" });
  return c.json({ taskId: id, status: "cancelled" }, 202);
});

app.post("/api/tasks/:id/abandon", async (c) => {
  const id = c.req.param("id");
  const task = tasks.get(id) ?? (await getTask(id));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status === "complete" || task.status === "failed" || task.status === "abandoned" || task.status === "promoted" || task.status === "cancelled") {
    return c.json({ error: "task is already finished" }, 400);
  }
  if (task.status === "pending") {
    queue.cancel(id);
  }
  await abandonTask(task);
  return c.json({ taskId: task.id, status: task.status }, 202);
});

app.post("/api/tasks/:id/promote", async (c) => {
  const id = c.req.param("id");
  const task = tasks.get(id) ?? (await getTask(id));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (!task.parentTaskId) return c.json({ error: "task is not a branch" }, 400);
  if (task.status !== "complete") {
    return c.json({ error: "task must be complete before promotion" }, 400);
  }
  try {
    const pr = await promoteTask(task);
    if (!pr) return c.json({ error: "task is already promoted or PR creation failed" }, 500);
    return c.json({ taskId: task.id, status: task.status, prUrl: pr.url, prNumber: pr.number }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof TaskRejectedError ? error.status : 500;
    return c.json({ error: message }, status as 400 | 500);
  }
});

app.get("/api/tasks/:id/stream", (c) => {
  const id = c.req.param("id");
  const last = Number(c.req.query("last") || "0");

  return streamSSE(c, async (stream) => {
    const redis = getRedis();
    let cursor = last;
    const heartbeat = setInterval(() => {
      stream.writeSSE({ data: "", event: "heartbeat" }).catch(() => {});
    }, 15000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
    });

    while (!stream.aborted) {
      const raw = await redis.lrange(`daybreak:stream:${id}`, cursor, -1);
      if (raw.length > 0) {
        for (const item of raw) {
          const event = typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent);
          await persistEvent(id, event);
          await stream.writeSSE({ data: JSON.stringify(event) });
          cursor++;
        }
      }
      await stream.sleep(500);
    }

    clearInterval(heartbeat);
  });
});

app.get("/api/tasks/:id/trace", async (c) => {
  const id = c.req.param("id");
  const task = (await getTask(id)) ?? tasks.get(id);
  if (!task?.traceId) {
    return c.json({ error: "trace not found" }, 404);
  }

  const redirect = c.req.query("redirect") === "1";
  const baseUrl = langfuseBaseUrl();
  const traceUrl = new URL(`/trace/${task.traceId}`, baseUrl).toString();

  if (redirect) {
    return c.redirect(traceUrl);
  }

  const auth = langfuseBasicAuthHeader();
  if (!auth) {
    return c.json({ error: "Langfuse credentials not configured" }, 500);
  }

  const res = await fetch(`${baseUrl}/api/public/traces/${task.traceId}`, {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    console.error(`[control-plane] trace fetch failed: ${res.status} ${text}`);
    return c.json({ error: "failed to fetch trace from Langfuse" }, 502);
  }

  const trace = (await res.json()) as Record<string, unknown>;
  return c.json({ trace, traceUrl });
});

app.get("/api/tasks/:id/logs", async (c) => {
  const id = c.req.param("id");
  const logPath = getLogPath(id);
  try {
    const text = await readFile(logPath, "utf8");
    const max = 500_000;
    return c.text(text.length > max ? `...${text.slice(-max)}` : text);
  } catch {
    return c.json({ error: "log not found" }, 404);
  }
});

const port = Number(process.env.PORT || "8787");
if (process.env.NODE_ENV !== "test") {
  console.log(`[control-plane] starting on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}

export { app };
