import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { createHmac, randomUUID } from "node:crypto";

vi.mock("node:child_process", () => {
  class MockEmitter {
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      (this.listeners[event] || []).forEach((fn) => fn(...args));
    }
  }

  return {
    spawn: vi.fn(() => {
      const child = new MockEmitter() as unknown as NodeJS.EventEmitter & { stdout: NodeJS.EventEmitter; stderr: NodeJS.EventEmitter; unref: () => void };
      child.stdout = new MockEmitter() as unknown as NodeJS.EventEmitter;
      child.stderr = new MockEmitter() as unknown as NodeJS.EventEmitter;
      child.unref = () => {};
      setTimeout(() => (child as unknown as MockEmitter).emit("exit", 0), 0);
      return child;
    }),
  };
});

async function makeGitHubWebhookPayload(event: string, body: unknown) {
  const payload = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;
  return {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    body: payload,
  } as RequestInit;
}

describe("control-plane webhooks", () => {
  let app: Hono;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_WEBHOOK_REPO_ALLOWLIST = "bezaspace/daybreak-target";
    process.env.GITHUB_WEBHOOK_RATE_LIMIT = "100";
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.E2B_API_KEY = "e2b_test";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_TOKEN;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/repos/")) {
          return new Response(JSON.stringify({ permissions: { push: true, pull: true, admin: true } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const mod = await import("./server.js");
    app = mod.app;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("rejects a request with a missing signature", async () => {
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "ping", "x-github-delivery": randomUUID() },
      body: JSON.stringify({ zen: "ping" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a request with an invalid signature", async () => {
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ zen: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a webhook from a repo not in the allowlist", async () => {
    const body = {
      action: "created",
      repository: { full_name: "someone/else", clone_url: "https://github.com/someone/else.git", default_branch: "main" },
      issue: { title: "Bug", body: "Fix it", number: 1 },
      comment: { body: "@daybreak-bot please fix" },
      sender: { login: "testuser" },
    };
    const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("issue_comment", body));
    expect(res.status).toBe(403);
  });

  it("acknowledges a ping", async () => {
    const res = await app.request(
      "/api/webhooks/github",
      await makeGitHubWebhookPayload("ping", {
        zen: "pong",
        repository: { full_name: "bezaspace/daybreak-target", clone_url: "https://github.com/bezaspace/daybreak-target.git", default_branch: "main" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("creates a task from a synthetic issue_comment with @daybreak-bot", async () => {
    const body = {
      action: "created",
      repository: { full_name: "bezaspace/daybreak-target", clone_url: "https://github.com/bezaspace/daybreak-target.git", default_branch: "main" },
      issue: { title: "Fix bug", body: "There is a bug", number: 1 },
      comment: { body: "@daybreak-bot please fix this" },
      sender: { login: "testuser" },
    };
    const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("issue_comment", body));
    expect(res.status).toBe(202);
    const json = (await res.json()) as { taskId?: string; status?: string };
    expect(json.taskId).toBeDefined();
    expect(json.status).toBe("running");

    const tasksRes = await app.request("/api/tasks");
    expect(tasksRes.status).toBe(200);
    const tasks = (await tasksRes.json()) as Array<{ repo: string; triggerSource: string; githubSender: string; status: string }>;
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks.find((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git");
    expect(task).toBeDefined();
    expect(task?.triggerSource).toBe("issue_comment");
    expect(task?.githubSender).toBe("testuser");
    expect(task?.status).toBe("running");
  });

  it("ignores an issue_comment without @daybreak-bot mention", async () => {
    const body = {
      action: "created",
      repository: { full_name: "bezaspace/daybreak-target", clone_url: "https://github.com/bezaspace/daybreak-target.git", default_branch: "main" },
      issue: { title: "Fix bug", body: "There is a bug", number: 1 },
      comment: { body: "never mind" },
      sender: { login: "testuser" },
    };
    const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("issue_comment", body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; note?: string };
    expect(json.ok).toBe(true);
    expect(json.note).toContain("no @daybreak-bot mention");
  });

describe("time-travel endpoints", () => {
    it("rejects a fork request without a prompt", async () => {
      const res = await app.request("/api/checkpoints/does-not-exist/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      expect(res.status).toBe(400);
    });

    it("returns 404 when forking a nonexistent checkpoint", async () => {
      const res = await app.request("/api/checkpoints/does-not-exist/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "try again" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects a rewind request without checkpointId or prompt", async () => {
      const res = await app.request("/api/tasks/does-not-exist/rewind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      expect(res.status).toBe(400);
    });

    it("returns 404 when rewinding a nonexistent task", async () => {
      const res = await app.request("/api/tasks/does-not-exist/rewind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId: "cp-123", prompt: "retry" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects abandoning a nonexistent task", async () => {
      const res = await app.request("/api/tasks/does-not-exist/abandon", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("rejects promoting a nonexistent task", async () => {
      const res = await app.request("/api/tasks/does-not-exist/promote", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  it("creates a review-iteration task from a synthetic pull_request_review_comment", async () => {
    const body = {
      action: "created",
      repository: { full_name: "bezaspace/daybreak-target", clone_url: "https://github.com/bezaspace/daybreak-target.git", default_branch: "main" },
      pull_request: { number: 2, head: { ref: "feature-branch" }, base: { ref: "main" } },
      comment: { body: "@daybreak-bot update this" },
      sender: { login: "reviewer" },
    };
    const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("pull_request_review_comment", body));
    expect(res.status).toBe(202);
    const json = (await res.json()) as { taskId?: string; prBranch?: string };
    expect(json.taskId).toBeDefined();
    expect(json.prBranch).toBe("feature-branch");
  });
});
