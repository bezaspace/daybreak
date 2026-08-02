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
  type Task,
  type StreamEvent,
} from "./db.js";

const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../..");

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

function taskFrom(body: { repo: string; branch: string; id?: string; prBranch?: string; triggerSource?: string; githubSender?: string; prNumber?: number; prompt?: string; status?: Task["status"] }): Task {
  const id = body.id ?? randomUUID();
  const prBranch = body.prBranch ?? `daybreak/${id}`;
  return { id, repo: body.repo, branch: body.branch, prBranch, status: body.status ?? "running", startedAt: Date.now(), triggerSource: body.triggerSource, githubSender: body.githubSender, prNumber: body.prNumber, prompt: body.prompt };
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

function verifyWebhookSignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const provided = signature.trim();
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function stripMention(text: string): string {
  return text.replace(/(^|\s)@daybreak-bot(\b|$)/gi, " ").replace(/\s{2,}/g, " ").trim();
}

function buildIssuePrompt(repoUrl: string, branch: string, issue: unknown, commentBody: string): string {
  const issueTitle = (issue && typeof issue === "object" && "title" in issue && typeof issue.title === "string") ? issue.title : "No title";
  const issueBody = (issue && typeof issue === "object" && "body" in issue && typeof issue.body === "string") ? `\n\nBody:\n${issue.body}` : "";
  return `A GitHub issue was opened in ${repoUrl} (branch: ${branch}):\n\nTitle: ${issueTitle}${issueBody}\n\nA user then commented:\n${commentBody}\n\nPlease investigate the issue, make the minimal fix, run the tests until they pass, then commit the fix and open a pull request.`;
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

async function spawnTask(spec: { repo: string; branch: string; prBranch?: string; prompt?: string; triggerSource?: string; githubSender?: string; prNumber?: number; maxTurns?: number; maxCostUsd?: number; maxWallClockMinutes?: number }): Promise<Task> {
  await assertCanSpawn(spec.repo, spec.githubSender);
  const task = taskFrom({ ...spec, status: "running" });
  tasks.set(task.id, task);
  await persistTask(task);

  const taskMaxTurns = spec.maxTurns ?? config.maxTurns;
  const taskMaxCostUsd = spec.maxCostUsd ?? config.maxCostUsd;
  const taskMaxWallClockMinutes = spec.maxWallClockMinutes ?? config.maxWallClockMinutes;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2B_TEMPLATE: config.e2bTemplate || "base",
    TASK_ID: task.id,
    PR_BRANCH_NAME: task.prBranch,
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN || "",
    LANGFUSE_PUBLIC_KEY: config.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY || "",
    LANGFUSE_SECRET_KEY: config.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY || "",
    LANGFUSE_BASE_URL: config.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "",
    MAX_TURNS: String(taskMaxTurns),
    MAX_WALL_CLOCK_MINUTES: String(taskMaxWallClockMinutes),
    MAX_COST_USD: String(taskMaxCostUsd),
    COMPACTION_ENABLED: String(config.compactionEnabled),
    COMPACTION_RESERVE_TOKENS: String(config.compactionReserveTokens),
    COMPACTION_KEEP_RECENT_TOKENS: String(config.compactionKeepRecentTokens),
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
  if (spec.prompt) {
    sandboxArgs.push(`--prompt=${spec.prompt}`);
    env.TASK_PROMPT = spec.prompt;
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
    await syncEventsFromRedis(task.id);

    try {
      const redis = getRedis();
      const raw = await redis.lrange(`daybreak:stream:${task.id}`, 0, -1);
      const events = raw.map((item) => (typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent)));

      const created = events.find((e) => e.type === "sandbox_created" || e.type === "sandbox_keep_alive");
      if (created?.data && typeof created.data === "object") {
        const d = created.data as Record<string, unknown>;
        const sandboxId = typeof d.sandboxId === "string" ? d.sandboxId : undefined;
        const keepAliveUntil = typeof d.keepAliveUntil === "number" ? d.keepAliveUntil : undefined;
        if (sandboxId) {
          task.sandboxId = sandboxId;
          task.keepAliveUntil = keepAliveUntil;
        }
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

    if (task.status === "complete" && config.githubToken) {
      const pr = await createPullRequest(task.repo, task.prBranch, task.branch, config.githubToken);
      if (pr) {
        task.prUrl = pr.url;
        task.prNumber = pr.number;
        tasks.set(task.id, task);
        await updateTask(task.id, { prUrl: pr.url, prNumber: pr.number });
        await publishEvent(task.id, "pr_created", { prUrl: pr.url, prNumber: pr.number, prBranch: task.prBranch, baseBranch: task.branch });
      }
    }
  });

  return task;
}

async function createPendingTask(spec: { repo: string; branch: string; prBranch: string; prompt?: string; triggerSource: string; githubSender?: string; prNumber?: number }): Promise<Task> {
  const task = taskFrom({ ...spec, status: "pending" });
  tasks.set(task.id, task);
  await persistTask(task);
  await publishEvent(task.id, "task_pending", { triggerSource: task.triggerSource, githubSender: task.githubSender, prNumber: task.prNumber });
  return task;
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

async function isRateLimited(repo: string, sender: string | undefined): Promise<boolean> {
  const limit = config.githubWebhookRateLimit ?? 10;
  const windowMs = 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const all = await getTasks();
  let repoCount = 0;
  let senderCount = 0;
  for (const t of all) {
    if (t.startedAt >= cutoff) {
      if (t.repo === repo) repoCount++;
      if (sender && t.githubSender === sender) senderCount++;
    }
    if (repoCount >= limit || senderCount >= limit) return true;
  }
  return false;
}

async function assertCanSpawn(repo: string, sender: string | undefined): Promise<void> {
  if (await isRateLimited(repo, sender)) {
    throw new TaskRejectedError("rate limit exceeded for repo or sender", 429);
  }
  if (!config.githubToken) {
    throw new TaskRejectedError("GITHUB_TOKEN not configured", 500);
  }
  const validation = await validatePat(repo, config.githubToken);
  if (!validation.ok) {
    throw new TaskRejectedError(validation.error || `missing PAT permissions: ${validation.missing?.join(", ") || "unknown"}`, 403);
  }
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

async function runReview(spec: { repo: string; baseBranch: string; headBranch: string; prNumber: number; prompt: string; githubSender?: string }): Promise<Task> {
  await assertCanSpawn(spec.repo, spec.githubSender);
  const repoUrl = spec.repo;
  const baseRef = spec.baseBranch;
  const headRef = spec.headBranch;
  const prNumber = spec.prNumber;

  const originalTask = await findOriginalTask(repoUrl, prNumber, headRef);
  const taskId = originalTask?.id ?? randomUUID();
  const prBranch = originalTask?.prBranch ?? headRef;

  let task: Task;
  if (!originalTask) {
    task = taskFrom({
      id: taskId,
      repo: repoUrl,
      branch: baseRef,
      prBranch,
      prNumber,
      triggerSource: "review_comment",
      githubSender: spec.githubSender,
      prompt: spec.prompt,
      status: "running",
    });
  } else {
    task = { ...originalTask, status: "running", prNumber: originalTask.prNumber ?? prNumber, prompt: spec.prompt };
  }
  tasks.set(taskId, task);
  await persistTask(task);

  const sandboxArgs = [
    "--filter",
    "agent-runner",
    "sandbox",
    `--repo=${repoUrl}`,
    `--branch=${baseRef}`,
    `--task-id=${taskId}`,
    `--pr-branch=${prBranch}`,
    `--template=${config.e2bTemplate || "base"}`,
    "--review",
    "--keep-alive",
  ];

  if (task.sandboxId && task.keepAliveUntil && Date.now() < task.keepAliveUntil) {
    sandboxArgs.push(`--connect=${task.sandboxId}`, "--fallback-create");
  }
  if (spec.prompt) {
    sandboxArgs.push(`--prompt=${spec.prompt}`);
  }

  const env = buildSpawnEnv(taskId, prBranch, repoUrl, baseRef);
  if (spec.prompt) {
    env.TASK_PROMPT = spec.prompt;
    env.REVIEW_MODE = "true";
  }

  ensureLogDir();
  const logPath = getLogPath(taskId);
  await appendFile(logPath, `[${new Date().toISOString()}] review ${taskId} spawned\n`).catch(() => {});

  const child = spawn("pnpm", sandboxArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  function forwardLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    appendLog(taskId, text).catch(() => {});
  }

  if (child.stdout) child.stdout.on("data", forwardLog);
  if (child.stderr) child.stderr.on("data", forwardLog);

  child.unref();

  child.on("exit", async (code) => {
    await syncEventsFromRedis(taskId);
    const t = tasks.get(taskId);
    if (!t) return;
    t.endedAt = Date.now();
    t.exitCode = code ?? undefined;
    t.status = code === 0 ? "complete" : "failed";
    tasks.set(taskId, t);
    await updateTask(taskId, t);
  });

  return task;
}

const config = loadConfig();

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
    const task = await spawnTask({
      repo,
      branch,
      prompt,
      triggerSource: "dashboard",
      maxTurns: body.maxTurns,
      maxCostUsd: body.maxCostUsd,
      maxWallClockMinutes: body.maxWallClockMinutes,
    });
    return c.json({ taskId: task.id, repo, branch, status: task.status });
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
        return c.json({ ok: true, event: "check_run" }, 200);
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
        const prompt = buildIssuePrompt(repoUrl, defaultBranch, { title: issueTitle, body: issueBody }, stripMention(commentBody));
        const task = await spawnTask({ repo: repoUrl, branch: defaultBranch, prompt, triggerSource: "issue_comment", githubSender: typeof sender === "string" ? sender : undefined });
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
        const task = await runReview({ repo: repoUrl, baseBranch: baseRef, headBranch: headRef, prNumber, prompt, githubSender: typeof sender === "string" ? sender : undefined });
        return c.json({ taskId: task.id, repo: repoFullName, branch: baseRef, prBranch: headRef, status: task.status }, 202);
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
        const task = await runReview({ repo: repoUrl, baseBranch: baseRef, headBranch: headRef, prNumber, prompt, githubSender: typeof sender === "string" ? sender : undefined });
        return c.json({ taskId: task.id, repo: repoFullName, branch: baseRef, prBranch: headRef, status: task.status }, 202);
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
console.log(`[control-plane] starting on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
