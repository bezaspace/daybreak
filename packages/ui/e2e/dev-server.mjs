import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");

const tasks = new Map();
const clients = new Map();

function sendEvent(taskId, event) {
  const task = tasks.get(taskId);
  if (!task) return;
  const payload = { timestamp: Date.now(), ...event };
  task.events.push(payload);
  const list = clients.get(taskId) || [];
  for (const res of list) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function parseUrl(reqUrl) {
  return new URL(reqUrl, "http://localhost");
}

function taskResponse(task) {
  const { events: _, ...rest } = task;
  return { ...rest, costUsd: rest.costUsd ?? 0 };
}

function writeJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = parseUrl(req.url);
  const path = url.pathname;
  const taskIdMatch = path.match(/^\/api\/tasks\/([^/]+)(?:\/.+)?$/);
  const taskId = taskIdMatch ? taskIdMatch[1] : null;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/api/repos") {
    writeJson(res, 200, { repos: [] });
    return;
  }

  if (path === "/api/config") {
    writeJson(res, 200, { providers: ["openai"], defaultProvider: "openai" });
    return;
  }

  if (path === "/api/queue-status") {
    writeJson(res, 200, { running: 0, queued: 0, max: 5 });
    return;
  }

  if (path === "/api/tasks" && req.method === "GET") {
    writeJson(res, 200, Array.from(tasks.values()).map(taskResponse));
    return;
  }

  if (path === "/api/tasks" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const data = body ? JSON.parse(body) : {};
      const id = `task-${Math.random().toString(36).slice(2, 9)}`;
      const task = {
        id,
        repo: data.repo || "https://github.com/daybreak/test",
        branch: data.branch || "main",
        mode: data.mode || "autopilot",
        status: "running",
        createdAt: Date.now(),
        costUsd: 0,
        prUrl: null,
        prBranch: null,
        events: [],
      };
      tasks.set(id, task);
      writeJson(res, 200, { taskId: id });

      setTimeout(() => {
        sendEvent(id, { type: "task_start", data: { repo: task.repo, branch: task.branch } });
        sendEvent(id, { type: "message_update", data: { kind: "delta", delta: "I'll create a PR for this change." } });
        sendEvent(id, {
          type: "approval_request",
          data: { toolCallId: "tool-1", toolName: "gh pr create", reason: "Create a pull request", kind: "tool" },
        });
      }, 300);
    });
    return;
  }

  if (taskId && path.endsWith("/events") && req.method === "GET") {
    writeJson(res, 200, []);
    return;
  }

  if (taskId && path.endsWith("/messages") && req.method === "GET") {
    writeJson(res, 200, []);
    return;
  }

  if (taskId && path.endsWith("/stream") && req.method === "GET") {
    const task = tasks.get(taskId);
    if (!task) {
      res.writeHead(404);
      res.end("task not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // flush queued events to this client, then listen for new ones
    for (const event of task.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const list = clients.get(taskId) || [];
    list.push(res);
    clients.set(taskId, list);

    const heartbeat = setInterval(() => {
      res.write("data: {}\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      const current = clients.get(taskId) || [];
      clients.set(
        taskId,
        current.filter((r) => r !== res),
      );
    });
    return;
  }

  if (taskId && path.endsWith("/approve") && req.method === "POST") {
    const task = tasks.get(taskId);
    if (task) {
      setTimeout(() => {
        sendEvent(taskId, { type: "approval_resolved", data: { toolCallId: "tool-1", decision: "approved" } });
        sendEvent(taskId, {
          type: "tool_execution_end",
          data: { toolName: "gh pr create", result: { prUrl: "https://github.com/daybreak/test/pull/42", prBranch: "devin/task-123" } },
        });
        sendEvent(taskId, { type: "task_complete", data: { success: true, summary: "Done" } });
        sendEvent(taskId, { type: "pr_created", data: { prUrl: "https://github.com/daybreak/test/pull/42", prBranch: "devin/task-123" } });
        task.prUrl = "https://github.com/daybreak/test/pull/42";
        task.prBranch = "devin/task-123";
        task.status = "complete";
      }, 300);
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  if (taskId && req.method === "GET") {
    const task = tasks.get(taskId);
    if (!task) {
      res.writeHead(404);
      res.end("task not found");
      return;
    }
    writeJson(res, 200, taskResponse(task));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(8787, () => {
  console.log("[e2e] Mock API server listening on http://localhost:8787");

  const vite = spawn("pnpm", ["--filter", "ui", "dev"], { cwd: rootDir, stdio: "inherit" });

  function shutdown() {
    vite.kill("SIGTERM");
    server.close(() => process.exit(0));
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", () => vite.kill("SIGTERM"));
});
