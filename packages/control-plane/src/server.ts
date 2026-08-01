#!/usr/bin/env node
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { Redis } from "@upstash/redis";
import { loadConfig } from "@daybreak/shared";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";

interface Task {
  id: string;
  repo: string;
  branch: string;
  status: "running" | "complete" | "failed";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
}

const tasks = new Map<string, Task>();
const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../..");

function getRedis() {
  const config = loadConfig();
  const url = config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL;
  const token = config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_TOKEN are required");
  }
  return new Redis({ url, token });
}

const app = new Hono();

app.use("/api/*", cors({ origin: "*" }));

app.get("/", (c) => c.text("Daybreak control plane"));

app.get("/api/tasks", (c) => {
  return c.json(Array.from(tasks.values()));
});

app.post("/api/tasks", async (c) => {
  const body = await c.req.json<{ repo?: string; branch?: string }>().catch(() => ({}) as { repo?: string; branch?: string });
  const repo = body.repo;
  const branch = body.branch || "main";

  if (!repo) {
    return c.json({ error: "repo is required" }, 400);
  }

  const id = randomUUID();
  const task: Task = { id, repo, branch, status: "running", startedAt: Date.now() };
  tasks.set(id, task);

  const config = loadConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TASK_ID: id,
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN || "",
  };

  const child = spawn(
    "pnpm",
    ["--filter", "agent-runner", "sandbox", `--repo=${repo}`, `--branch=${branch}`, `--task-id=${id}`],
    { cwd: repoRoot, env, stdio: "ignore", detached: true },
  );

  child.unref();

  child.on("exit", (code) => {
    task.endedAt = Date.now();
    task.exitCode = code ?? undefined;
    task.status = code === 0 ? "complete" : "failed";
    tasks.set(id, task);
  });

  return c.json({ taskId: id, repo, branch, status: task.status });
});

app.get("/api/tasks/:id", (c) => {
  const task = tasks.get(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json(task);
});

app.get("/api/tasks/:id/events", async (c) => {
  const id = c.req.param("id");
  const redis = getRedis();
  const raw = await redis.lrange(`daybreak:stream:${id}`, 0, -1);
  const events = raw.map((item) => (typeof item === "string" ? JSON.parse(item) : item));
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
          const event = typeof item === "string" ? JSON.parse(item) : item;
          await stream.writeSSE({ data: JSON.stringify(event) });
          cursor++;
        }
      }
      await stream.sleep(500);
    }

    clearInterval(heartbeat);
  });
});

const port = Number(process.env.PORT || "8787");
console.log(`[control-plane] starting on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
