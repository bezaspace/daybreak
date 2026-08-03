import { createHash, randomUUID } from "node:crypto";
import { getRedis } from "./redis.js";
import { getSupabase, getTask } from "./db.js";
import type { Task } from "./db.js";

export interface IdempotencyEntry {
  taskId: string;
  task?: Task;
}

export class IdempotencyStore {
  private memory = new Map<string, IdempotencyEntry>();

  async tryCreate(key: string, taskId: string, task?: Task): Promise<IdempotencyEntry | undefined> {
    const existing = await this.get(key);
    if (existing) return existing;

    const ok = (await this.setRedis(key, taskId)) || (await this.setSupabase(key, taskId)) || this.setMemory(key, taskId, task);
    if (!ok) {
      // Another caller may have won the race; return whatever is stored now.
      return this.get(key);
    }
    return { taskId, task };
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const redisTaskId = await this.getRedis(key);
    if (redisTaskId) return { taskId: redisTaskId };

    const supabaseTaskId = await this.getSupabase(key);
    if (supabaseTaskId) return { taskId: supabaseTaskId };

    return this.memory.get(key);
  }

  private async setRedis(key: string, taskId: string): Promise<boolean> {
    try {
      const redis = getRedis();
      const result = await redis.set(`daybreak:idempotency:${key}`, taskId, { nx: true, ex: 60 * 60 * 24 });
      return result === "OK";
    } catch {
      return false;
    }
  }

  private async getRedis(key: string): Promise<string | undefined> {
    try {
      const redis = getRedis();
      const value = (await redis.get(`daybreak:idempotency:${key}`)) as string | null;
      return value ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async setSupabase(key: string, taskId: string): Promise<boolean> {
    const supabase = getSupabase();
    if (!supabase) return false;
    const { error } = await supabase.from("idempotency_keys").insert({ key, task_id: taskId });
    if (error) {
      // 23505 = unique_violation, i.e. the key already exists.
      if (error.code === "23505") return false;
      console.error("[idempotency] Supabase insert error:", error.message);
      return false;
    }
    return true;
  }

  private async getSupabase(key: string): Promise<string | undefined> {
    const supabase = getSupabase();
    if (!supabase) return undefined;
    const { data, error } = await supabase.from("idempotency_keys").select("task_id").eq("key", key).single();
    if (error) return undefined;
    return (data?.task_id as string) ?? undefined;
  }

  private setMemory(key: string, taskId: string, task?: Task): boolean {
    if (this.memory.has(key)) return false;
    this.memory.set(key, { taskId, task });
    return true;
  }
}

export function createIdempotencyKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function getExistingTask(entry: IdempotencyEntry): Promise<Task | undefined> {
  if (entry.task) return Promise.resolve(entry.task);
  return getTask(entry.taskId);
}
