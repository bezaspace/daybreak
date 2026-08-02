#!/usr/bin/env node
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { Redis } from "@upstash/redis";
import { loadConfig } from "@daybreak/shared";
import { randomUUID } from "node:crypto";
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

async function createPullRequest(repoUrl: string, headBranch: string, baseBranch: string, token: string): Promise<string | undefined> {
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
  const data = (await res.json()) as { html_url: string };
  return data.html_url;
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
  await persistEvent(taskId, event);
  await publishToRedis(taskId, event);
}

const tasks = new Map<string, Task>();

function taskFrom(body: { repo: string; branch: string; id?: string; prBranch?: string }): Task {
  const id = body.id ?? randomUUID();
  const prBranch = body.prBranch ?? `daybreak/${id}`;
  return { id, repo: body.repo, branch: body.branch, prBranch, status: "running", startedAt: Date.now() };
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

const app = new Hono();

app.use("/api/*", cors({ origin: "*" }));

app.get("/", (c) => c.text("Daybreak control plane"));

const config = loadConfig();

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
  return c.json(dbTasks.length ? dbTasks : Array.from(tasks.values()));
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

  const taskMaxTurns = body.maxTurns ?? config.maxTurns;
  const taskMaxCostUsd = body.maxCostUsd ?? config.maxCostUsd;
  const taskMaxWallClockMinutes = body.maxWallClockMinutes ?? config.maxWallClockMinutes;

  const task = taskFrom({ repo, branch });
  tasks.set(task.id, task);
  await persistTask(task);

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
    `--repo=${repo}`,
    `--branch=${branch}`,
    `--task-id=${task.id}`,
    `--template=${config.e2bTemplate || "base"}`,
  ];
  if (prompt) {
    sandboxArgs.push(`--prompt=${prompt}`);
    env.TASK_PROMPT = prompt;
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
    task.endedAt = Date.now();
    task.exitCode = code ?? undefined;
    task.status = code === 0 ? "complete" : "failed";
    tasks.set(task.id, task);

    await syncEventsFromRedis(task.id);
    try {
      const redis = getRedis();
      const raw = await redis.lrange(`daybreak:stream:${task.id}`, 0, -1);
      const final = raw
        .map((item) => (typeof item === "string" ? (JSON.parse(item) as StreamEvent) : (item as StreamEvent)))
        .find((e) => e.type === "task_complete" || e.type === "task_failed");
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
    await updateTask(task.id, task);

    if (task.status === "complete" && config.githubToken) {
      const prUrl = await createPullRequest(task.repo, task.prBranch, task.branch, config.githubToken);
      if (prUrl) {
        task.prUrl = prUrl;
        tasks.set(task.id, task);
        await updateTask(task.id, { prUrl });
        await publishEvent(task.id, "pr_created", { prUrl, prBranch: task.prBranch, baseBranch: task.branch });
      }
    }
  });

  return c.json({ taskId: task.id, repo, branch, status: task.status });
});

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
