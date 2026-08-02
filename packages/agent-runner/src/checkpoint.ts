import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Checkpoint, CheckpointStatus } from "@daybreak/shared";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";

export interface CheckpointStoreOptions {
  taskId: string;
  cwd: string;
  sessionStore: SessionStore;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
}

function runGit(cwd: string, args: string, env?: NodeJS.ProcessEnv): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export class CheckpointStore {
  private sessionStore: SessionStore;
  private pending: Promise<unknown>[] = [];
  private lastCheckpointId?: string;
  private localPath: string;

  constructor(private options: CheckpointStoreOptions) {
    this.sessionStore = options.sessionStore;
    this.localPath = join(options.cwd, ".daybreak", "checkpoints.jsonl");
    mkdirSync(join(options.cwd, ".daybreak"), { recursive: true });
  }

  /**
   * Capture a filesystem + session checkpoint at the end of a turn.
   * The promise resolves once the checkpoint is persisted locally and, if
   * Supabase is configured, uploaded to the `checkpoints` table.
   */
  async createCheckpoint({
    turn,
    sessionManager,
    parentCheckpointId,
    toolCallId,
    costUsd,
  }: {
    turn: number;
    sessionManager: SessionManager;
    parentCheckpointId?: string;
    toolCallId?: string;
    costUsd?: number;
  }): Promise<Checkpoint> {
    const gitCommit = this.commitAndTag(turn);
    const { sessionRef } = await this.sessionStore.save(turn, sessionManager);

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      taskId: this.options.taskId,
      turn,
      timestamp: Date.now(),
      gitCommit,
      sessionRef,
      parentCheckpointId: parentCheckpointId ?? this.lastCheckpointId,
      status: "active",
      toolCallId,
      costUsd,
    };

    this.appendLocal(checkpoint);
    const persistPromise = this.persistSupabase(checkpoint);
    this.pending.push(persistPromise);
    await persistPromise;
    this.lastCheckpointId = checkpoint.id;
    return checkpoint;
  }

  async getCheckpoint(id: string): Promise<Checkpoint | undefined> {
    const local = this.listLocal().find((c) => c.id === id);
    if (local) return local;
    const list = await this.listSupabase(`id=eq.${id}`);
    return list[0];
  }

  async listCheckpoints(taskId?: string): Promise<Checkpoint[]> {
    const locals = taskId ? this.listLocal().filter((c) => c.taskId === taskId) : this.listLocal();
    const remote = await this.listSupabase(taskId ? `task_id=eq.${taskId}` : undefined);
    const byId = new Map<string, Checkpoint>();
    for (const c of locals) byId.set(c.id, c);
    for (const c of remote) byId.set(c.id, c);
    return Array.from(byId.values()).sort((a, b) => a.turn - b.turn || a.timestamp - b.timestamp);
  }

  async getLatestCheckpoint(taskId?: string): Promise<Checkpoint | undefined> {
    const all = await this.listCheckpoints(taskId ?? this.options.taskId);
    return all[all.length - 1];
  }

  async setCheckpointStatus(id: string, status: CheckpointStatus): Promise<boolean> {
    const locals = this.listLocal();
    const local = locals.find((c) => c.id === id);
    if (local) {
      local.status = status;
      writeFileSync(this.localPath, locals.map((c) => JSON.stringify(c)).join("\n") + "\n");
    }
    return this.updateSupabase(id, { status });
  }

  setLastCheckpointId(id: string): void {
    this.lastCheckpointId = id;
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);
    this.pending = [];
  }

  private commitAndTag(turn: number): string {
    const { cwd, taskId } = this.options;
    const message = `daybreak-checkpoint:${taskId}:${turn}`;
    const tag = `daybreak/checkpoint/${taskId}/${turn}`;

    try {
      runGit(cwd, "add -A");
      runGit(cwd, `commit --allow-empty --no-verify -m "${message.replace(/"/g, '\\"')}"`);
      const commit = runGit(cwd, "rev-parse HEAD");
      runGit(cwd, `tag -f ${tag} ${commit}`);
      return commit;
    } catch (error) {
      console.error("[checkpoint] git commit failed:", error instanceof Error ? error.message : String(error));
      try {
        return runGit(cwd, "rev-parse HEAD");
      } catch {
        return "unknown";
      }
    }
  }

  private appendLocal(checkpoint: Checkpoint): void {
    appendFileSync(this.localPath, JSON.stringify(checkpoint) + "\n");
  }

  private listLocal(): Checkpoint[] {
    if (!existsSync(this.localPath)) return [];
    const text = readFileSync(this.localPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as Checkpoint);
  }

  private async persistSupabase(checkpoint: Checkpoint): Promise<void> {
    const { supabaseUrl, supabaseServiceKey } = this.options;
    if (!supabaseUrl || !supabaseServiceKey) return;
    if (!isUuid(checkpoint.taskId)) {
      console.warn(`[checkpoint] skipping Supabase insert for non-uuid taskId ${checkpoint.taskId}`);
      return;
    }

    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/checkpoints`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          id: checkpoint.id,
          task_id: checkpoint.taskId,
          turn: checkpoint.turn,
          timestamp: new Date(checkpoint.timestamp).toISOString(),
          git_commit: checkpoint.gitCommit,
          session_ref: checkpoint.sessionRef,
          parent_checkpoint_id: checkpoint.parentCheckpointId,
          branch_task_id: checkpoint.branchTaskId,
          status: checkpoint.status,
          tool_call_id: checkpoint.toolCallId,
          cost_usd: checkpoint.costUsd,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "unknown");
        console.error(`[checkpoint] Supabase insert failed: ${response.status} ${text}`);
        return;
      }

      await this.updateTaskHead(checkpoint);
    } catch (error) {
      console.error("[checkpoint] Supabase insert error:", error instanceof Error ? error.message : String(error));
    }
  }

  private async updateTaskHead(checkpoint: Checkpoint): Promise<void> {
    const { supabaseUrl, supabaseServiceKey } = this.options;
    if (!supabaseUrl || !supabaseServiceKey) return;

    try {
      const getResponse = await fetch(
        `${supabaseUrl}/rest/v1/tasks?id=eq.${checkpoint.taskId}&select=root_checkpoint_id`,
        {
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
        },
      );
      const rows = getResponse.ok ? ((await getResponse.json()) as Array<{ root_checkpoint_id?: string }>) : [];
      const rootId = rows[0]?.root_checkpoint_id;

      const patch: Record<string, unknown> = { head_checkpoint_id: checkpoint.id, updated_at: new Date().toISOString() };
      if (!rootId) patch.root_checkpoint_id = checkpoint.id;

      const response = await fetch(`${supabaseUrl}/rest/v1/tasks?id=eq.${checkpoint.taskId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "unknown");
        console.error(`[checkpoint] task head update failed: ${response.status} ${text}`);
      }
    } catch (error) {
      console.error("[checkpoint] task head update error:", error instanceof Error ? error.message : String(error));
    }
  }

  private async listSupabase(query?: string): Promise<Checkpoint[]> {
    const { supabaseUrl, supabaseServiceKey } = this.options;
    if (!supabaseUrl || !supabaseServiceKey) return [];
    try {
      const url = query ? `${supabaseUrl}/rest/v1/checkpoints?${query}` : `${supabaseUrl}/rest/v1/checkpoints`;
      const response = await fetch(url, {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "unknown");
        console.error(`[checkpoint] Supabase list failed: ${response.status} ${text}`);
        return [];
      }
      const rows = (await response.json()) as Array<{
        id: string;
        task_id: string;
        turn: number;
        timestamp: string;
        git_commit?: string;
        session_ref?: string;
        parent_checkpoint_id?: string;
        branch_task_id?: string;
        status: string;
        tool_call_id?: string;
        cost_usd?: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        turn: r.turn,
        timestamp: new Date(r.timestamp).getTime(),
        gitCommit: r.git_commit,
        sessionRef: r.session_ref,
        parentCheckpointId: r.parent_checkpoint_id,
        branchTaskId: r.branch_task_id,
        status: r.status as CheckpointStatus,
        toolCallId: r.tool_call_id,
        costUsd: r.cost_usd,
      }));
    } catch (error) {
      console.error("[checkpoint] Supabase list error:", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private async updateSupabase(id: string, patch: Record<string, unknown>): Promise<boolean> {
    const { supabaseUrl, supabaseServiceKey } = this.options;
    if (!supabaseUrl || !supabaseServiceKey) return false;
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/checkpoints?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      });
      return response.ok;
    } catch (error) {
      console.error("[checkpoint] Supabase update error:", error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}
