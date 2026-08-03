import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IdempotencyStore, createIdempotencyKey } from "./idempotency.js";

describe("IdempotencyStore", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore();
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_TOKEN;
  });

  it("creates a new idempotency entry", async () => {
    const result = await store.tryCreate("key-1", "task-1");
    expect(result).toBeDefined();
    expect(result?.taskId).toBe("task-1");
  });

  it("returns the original task id for a duplicate key", async () => {
    await store.tryCreate("key-1", "task-1");
    const duplicate = await store.tryCreate("key-1", "task-2");
    expect(duplicate?.taskId).toBe("task-1");
  });

  it("get returns the stored task id", async () => {
    await store.tryCreate("key-1", "task-1");
    const entry = await store.get("key-1");
    expect(entry?.taskId).toBe("task-1");
  });

  it("returns undefined for unknown keys", async () => {
    const entry = await store.get("missing");
    expect(entry).toBeUndefined();
  });

  it("createIdempotencyKey returns a stable 32-char hash", () => {
    const key1 = createIdempotencyKey("repo|branch|prompt");
    const key2 = createIdempotencyKey("repo|branch|prompt");
    expect(key1).toBe(key2);
    expect(key1.length).toBe(32);
    expect(/^[a-f0-9]{32}$/.test(key1)).toBe(true);
  });
});
