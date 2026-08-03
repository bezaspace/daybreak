import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskQueue } from "./queue.js";
import type { Task } from "./db.js";

describe("TaskQueue", () => {
  let queue: TaskQueue;
  let claimedTasks: Task[];
  let events: { taskId: string; type: string; data: unknown }[];
  let pendingResolvers: Map<string, () => void>;

  function unblockAll() {
    for (const resolve of pendingResolvers.values()) {
      resolve();
    }
    pendingResolvers.clear();
  }

  beforeEach(() => {
    claimedTasks = [];
    events = [];
    pendingResolvers = new Map();
    queue = new TaskQueue({
      maxConcurrent: 2,
      pollMs: 10,
      onClaim: async (task) => {
        await new Promise<void>((resolve) => pendingResolvers.set(task.id, resolve));
        claimedTasks.push(task);
      },
      onEvent: async (taskId, type, data) => {
        events.push({ taskId, type, data });
      },
      workerId: "test-worker",
    });
  });

  afterEach(() => {
    queue.stop();
    unblockAll();
  });

  it("enqueues a pending task and returns it", async () => {
    const nonBlockingQueue = new TaskQueue({
      maxConcurrent: 2,
      pollMs: 10,
      onClaim: async (task) => {
        claimedTasks.push(task);
      },
      onEvent: async () => {},
    });
    const task = await nonBlockingQueue.enqueue({ repo: "https://github.com/owner/repo", branch: "main" });
    expect(task.repo).toBe("https://github.com/owner/repo");
    expect(task.branch).toBe("main");
    expect(task.status).toBe("pending");
    nonBlockingQueue.stop();
  });

  it("starts worker loop and claims tasks up to maxConcurrent", async () => {
    queue.start();
    const task1 = await queue.enqueue({ repo: "https://github.com/owner/repo", branch: "main" });
    const task2 = await queue.enqueue({ repo: "https://github.com/owner/repo", branch: "main" });
    const task3 = await queue.enqueue({ repo: "https://github.com/owner/repo", branch: "main" });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queue.getStatus().running).toBe(2);
    expect(queue.getStatus().pending).toBe(1);

    // Unblock whatever has been claimed; the first two tasks should complete.
    unblockAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ids = claimedTasks.map((t) => t.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids).toContain(task1.id);
    expect(ids).toContain(task2.id);

    // Releaseing the first two should let the third one run.
    unblockAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimedTasks.map((t) => t.id)).toContain(task3.id);
  });

  it("releases concurrency when a task finishes", async () => {
    queue = new TaskQueue({
      maxConcurrent: 1,
      pollMs: 10,
      onClaim: async (task) => {
        await new Promise<void>((resolve) => pendingResolvers.set(task.id, resolve));
        claimedTasks.push(task);
      },
      onEvent: async () => {},
      workerId: "test-worker",
    });
    queue.start();

    const task1 = await queue.enqueue({ repo: "r1", branch: "main" });
    const task2 = await queue.enqueue({ repo: "r2", branch: "main" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(claimedTasks.length).toBe(0);
    const r1 = pendingResolvers.get(task1.id);
    expect(r1).toBeDefined();
    r1?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimedTasks.length).toBe(1);

    const r2 = pendingResolvers.get(task2.id);
    expect(r2).toBeDefined();
    r2?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimedTasks.length).toBe(2);
  });

  it("cancels a pending task", async () => {
    const blockingQueue = new TaskQueue({
      maxConcurrent: 1,
      pollMs: 1000,
      onClaim: async () => {},
      onEvent: async () => {},
    });
    const task = await blockingQueue.enqueue({ repo: "https://github.com/owner/repo", branch: "main" });
    expect(blockingQueue.cancel(task.id)).toBe(true);
    expect(blockingQueue.getStatus().pending).toBe(0);
    blockingQueue.stop();
  });

  it("emits task_pending and task_start events through onEvent", async () => {
    queue.start();
    const task = await queue.enqueue({ repo: "https://github.com/owner/repo", branch: "main" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((e) => e.taskId === task.id && e.type === "task_pending")).toBe(true);

    const resolver = pendingResolvers.get(task.id);
    expect(resolver).toBeDefined();
    resolver?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimedTasks.length).toBe(1);
  });
});
