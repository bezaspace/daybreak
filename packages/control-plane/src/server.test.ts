import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

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
    process.env.DAYBREAK_HEAL_COOLDOWN_SECONDS = "0";
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
    expect(json.status).toBe("pending");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const tasksRes = await app.request("/api/tasks");
    expect(tasksRes.status).toBe(200);
    const tasks = (await tasksRes.json()) as Array<{ repo: string; triggerSource: string; githubSender: string; status: string }>;
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks.find((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git");
    expect(task).toBeDefined();
    expect(task?.triggerSource).toBe("issue_comment");
    expect(task?.githubSender).toBe("testuser");
    expect(["pending", "running", "complete", "failed"]).toContain(task?.status);
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

describe("check_run webhooks", () => {
    function makeCheckRunBody({ branch, conclusion, repo = "bezaspace/daybreak-target", prNumber = 42, checkRunId = 987654321, headSha = "abc123def456" }: { branch: string; conclusion: string; repo?: string; prNumber?: number; checkRunId?: number; headSha?: string }) {
      const [owner, name] = repo.split("/");
      return {
        action: "completed",
        repository: { full_name: repo, clone_url: `https://github.com/${repo}.git`, default_branch: "main", owner: { login: owner }, name },
        check_run: {
          id: checkRunId,
          name: "test",
          head_sha: headSha,
          status: "completed",
          conclusion,
          output: { title: null, summary: "", text: "", annotations_count: 0, annotations_url: "" },
          check_suite: {
            id: 123456789,
            head_branch: branch,
            head_sha: headSha,
            status: "completed",
            conclusion,
            pull_requests: [{ number: prNumber, head: { ref: branch }, base: { ref: "main" } }],
          },
          pull_requests: [{ number: prNumber, head: { ref: branch }, base: { ref: "main" } }],
        },
        sender: { login: "ghost" },
      };
    }

    it("creates a running heal task from a failed check_run on a daybreak branch", async () => {
      const branch = "daybreak/check-run-test-1";
      const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ branch, conclusion: "failure" })));
      expect(res.status).toBe(202);
      const json = (await res.json()) as { taskId?: string; prBranch?: string; status?: string; headSha?: string };
      expect(json.taskId).toBeDefined();
      expect(json.prBranch).toBe(branch);
      expect(json.status).toBe("pending");
      expect(json.headSha).toBe("abc123def456");

      await new Promise((resolve) => setTimeout(resolve, 50));
      const tasksRes = await app.request("/api/tasks");
      expect(tasksRes.status).toBe(200);
      const tasks = (await tasksRes.json()) as Array<{ repo: string; prBranch: string; triggerSource?: string; status: string; headSha?: string; checkRunId?: string }>;
      const task = tasks.find((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git" && t.prBranch === branch);
      expect(task).toBeDefined();
      expect(task?.triggerSource).toBe("check_run");
      expect(["pending", "running", "complete", "failed"]).toContain(task?.status);
      expect(task?.headSha).toBe("abc123def456");
      expect(task?.checkRunId).toBe("987654321");

      const healCall = (spawn as ReturnType<typeof vi.fn>).mock.calls.find((call: unknown[]) => (call[1] as string[])?.includes("--heal"));
      expect(healCall).toBeDefined();
    });

    it("ignores a check_run with conclusion success", async () => {
      const branch = "daybreak/check-run-success-1";
      const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ branch, conclusion: "success" })));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; note?: string };
      expect(json.ok).toBe(true);
      expect(json.note).toContain("conclusion");

      const tasksRes = await app.request("/api/tasks");
      const tasks = (await tasksRes.json()) as Array<{ repo: string; prBranch: string; triggerSource?: string }>;
      const task = tasks.find((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git" && t.prBranch === branch && t.triggerSource === "check_run");
      expect(task).toBeUndefined();
    });

    it("ignores a failed check_run on a protected branch", async () => {
      const branch = "main";
      const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ branch, conclusion: "failure" })));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; note?: string };
      expect(json.ok).toBe(true);
      expect(json.note).toContain("protected branch");

      const tasksRes = await app.request("/api/tasks");
      const tasks = (await tasksRes.json()) as Array<{ repo: string; prBranch: string; triggerSource?: string }>;
      const task = tasks.find((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git" && t.prBranch === branch && t.triggerSource === "check_run");
      expect(task).toBeUndefined();
    });

    it("ignores a failed check_run on a non-daybreak branch", async () => {
      const branch = "feature/not-daybreak";
      const res = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ branch, conclusion: "failure", prNumber: 99 })));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; note?: string };
      expect(json.ok).toBe(true);
      expect(json.note).toContain("Daybreak PR");

      const tasksRes = await app.request("/api/tasks");
      const tasks = (await tasksRes.json()) as Array<{ repo: string; prBranch: string; triggerSource?: string }>;
      const task = tasks.find((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git" && t.prBranch === branch && t.triggerSource === "check_run");
      expect(task).toBeUndefined();
    });

    it("skips a third heal attempt for the same PR within 24 hours", async () => {
      const branch = "daybreak/heal-limit-test";
      const base = { branch, conclusion: "failure" as const, prNumber: 100 };

      const first = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ ...base, checkRunId: 1000001 })));
      expect(first.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ ...base, checkRunId: 1000002 })));
      expect(second.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const third = await app.request("/api/webhooks/github", await makeGitHubWebhookPayload("check_run", makeCheckRunBody({ ...base, checkRunId: 1000003 })));
      expect(third.status).toBe(200);
      const thirdJson = (await third.json()) as { ok: boolean; note?: string };
      expect(thirdJson.ok).toBe(true);
      expect(thirdJson.note).toContain("max heal attempts");

      const tasksRes = await app.request("/api/tasks");
      const allTasks = (await tasksRes.json()) as Array<{ repo: string; prBranch: string; triggerSource?: string }>;
      const prTasks = allTasks.filter((t) => t.repo === "https://github.com/bezaspace/daybreak-target.git" && t.prBranch === branch && t.triggerSource === "check_run");
      expect(prTasks.length).toBe(2);
    });
  });
});
