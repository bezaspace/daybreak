import type { SupabaseClient } from "@supabase/supabase-js";
import type { DaybreakConfig } from "@daybreak/shared";
import { getSupabase } from "./db.js";

export interface CleanupResult {
  type: string;
  startedAt: number;
  completedAt: number;
  deletedCount: number;
  details: Record<string, unknown>;
}

interface GitHubBranch {
  name: string;
  lastCommitAt?: number;
}

interface TaskRow {
  id: string;
  repo: string;
  pr_branch: string;
  status: string;
  ended_at?: string | null;
  started_at?: string | null;
  sandbox_id?: string | null;
  keep_alive_until?: string | null;
}

export interface CleanupServiceOptions {
  config: DaybreakConfig;
  githubToken?: string;
  sandboxTerminator?: (sandboxId: string) => Promise<boolean>;
  supabase?: SupabaseClient;
  fetchImpl?: typeof fetch;
}

const TERMINAL_STATUSES = ["complete", "failed", "abandoned", "promoted", "cancelled"];

function parseRepo(repoUrl: string): { owner: string; repo: string } | undefined {
  try {
    const url = new URL(repoUrl);
    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  } catch {
    const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return undefined;
}

function toMs(date: string | null | undefined): number | undefined {
  if (!date) return undefined;
  const ms = new Date(date).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export class CleanupService {
  private config: DaybreakConfig;
  private githubToken: string | undefined;
  private sandboxTerminator: (sandboxId: string) => Promise<boolean>;
  private supabase: SupabaseClient | undefined;
  private fetch: typeof fetch;

  constructor(options: CleanupServiceOptions) {
    this.config = options.config;
    this.githubToken = options.githubToken || options.config.githubToken;
    this.sandboxTerminator = options.sandboxTerminator || (async () => false);
    this.supabase = options.supabase ?? getSupabase();
    this.fetch = options.fetchImpl ?? fetch;
  }

  async runAll(dryRun = false): Promise<CleanupResult[]> {
    return [
      await this.cleanupBranches(dryRun),
      await this.cleanupSandboxes(dryRun),
      await this.cleanupDataRetention(dryRun),
    ];
  }

  async cleanupBranches(dryRun = false): Promise<CleanupResult> {
    const startedAt = Date.now();
    const prefix = this.config.prBranchPrefix || "daybreak/";
    const ttlMs = this.config.branchTtlDays * 24 * 60 * 60 * 1000;
    const cutoff = startedAt - ttlMs;

    const tasks = await this.getBranchCleanupTasks(prefix, cutoff);
    const byRepo = this.groupByRepo(tasks);
    const deleted: Array<Record<string, unknown>> = [];
    let deletedCount = 0;

    for (const repo of Object.keys(byRepo)) {
      const parsed = parseRepo(repo);
      if (!parsed) continue;
      const { owner, repo: repoName } = parsed;

      const branches = await this.listGitHubBranches(owner, repoName, prefix);
      for (const branch of branches) {
        const task = tasks.find((t) => t.repo === repo && t.pr_branch === branch.name);
        let shouldDelete = false;
        let reason = "";

        if (task && TERMINAL_STATUSES.includes(task.status)) {
          const endedAt = toMs(task.ended_at);
          if (endedAt && endedAt < cutoff) {
            shouldDelete = true;
            reason = `task terminal (${task.status}) and ended ${new Date(endedAt).toISOString()}`;
          }
        } else if (!task) {
          if (branch.lastCommitAt && branch.lastCommitAt < cutoff) {
            shouldDelete = true;
            reason = `orphan branch, last commit ${new Date(branch.lastCommitAt).toISOString()}`;
          }
        }

        if (!shouldDelete) continue;

        if (dryRun) {
          deleted.push({ repo, branch: branch.name, reason, dryRun: true });
          deletedCount++;
          continue;
        }

        const removed = await this.deleteGitHubBranch(owner, repoName, branch.name);
        if (removed) {
          deletedCount++;
          deleted.push({ repo, branch: branch.name, reason, tagsDeleted: 0 });

          // Find the task id from the branch name if possible.
          const taskId = this.taskIdFromBranch(branch.name, prefix);
          if (taskId) {
            const tags = await this.deleteCheckpointTags(owner, repoName, taskId);
            deleted[deleted.length - 1].tagsDeleted = tags;
          }
        } else {
          deleted.push({ repo, branch: branch.name, reason, error: "delete failed" });
        }
      }
    }

    const result: CleanupResult = {
      type: "branches",
      startedAt,
      completedAt: Date.now(),
      deletedCount,
      details: { prefix, cutoff, deleted },
    };
    await this.recordCleanupRun(result, dryRun);
    return result;
  }

  async cleanupSandboxes(dryRun = false): Promise<CleanupResult> {
    const startedAt = Date.now();
    const tasks = await this.getSandboxCleanupTasks();
    const deleted: Array<Record<string, unknown>> = [];
    let deletedCount = 0;

    for (const task of tasks) {
      const sandboxId = task.sandbox_id;
      if (!sandboxId) continue;

      if (dryRun) {
        deleted.push({ taskId: task.id, sandboxId, reason: this.sandboxReason(task), dryRun: true });
        deletedCount++;
        continue;
      }

      const killed = await this.sandboxTerminator(sandboxId);
      if (killed) {
        await this.clearSandboxId(task.id);
      }
      deleted.push({ taskId: task.id, sandboxId, killed, reason: this.sandboxReason(task) });
      if (killed) deletedCount++;
    }

    const result: CleanupResult = {
      type: "sandboxes",
      startedAt,
      completedAt: Date.now(),
      deletedCount,
      details: { deleted },
    };
    await this.recordCleanupRun(result, dryRun);
    return result;
  }

  async cleanupDataRetention(dryRun = false): Promise<CleanupResult> {
    const startedAt = Date.now();
    const cutoff = startedAt - this.config.dataRetentionDays * 24 * 60 * 60 * 1000;
    const deleted: Array<Record<string, unknown>> = [];
    let deletedCount = 0;

    const snapshots = await this.getOldSessionSnapshots(cutoff);
    if (snapshots.length > 0) {
      if (!dryRun) {
        const ids = snapshots.map((s) => s.id);
        const { error, count } = await this.supabaseFrom("session_snapshots")
          .delete()
          .in("id", ids);
        if (error) {
          console.error("[cleanup] failed to delete session_snapshots:", error.message);
        } else {
          const removed = count ?? snapshots.length;
          deletedCount += removed;
          deleted.push({ type: "session_snapshots", count: removed });
        }
      } else {
        deletedCount += snapshots.length;
        deleted.push({ type: "session_snapshots", count: snapshots.length, dryRun: true });
      }
    }

    const oldCheckpoints = await this.getOldCheckpoints(cutoff);
    let abandonedCount = 0;
    if (!dryRun) {
      for (const cp of oldCheckpoints) {
        const { error } = await this.supabaseFrom("checkpoints").update({ status: "abandoned" }).eq("id", cp.id);
        if (error) {
          console.error(`[cleanup] failed to abandon checkpoint ${cp.id}:`, error.message);
        } else {
          abandonedCount++;
        }
      }
    } else {
      abandonedCount = oldCheckpoints.length;
    }

    if (abandonedCount > 0) {
      deleted.push({ type: "checkpoints_abandoned", count: abandonedCount });
    }

    const result: CleanupResult = {
      type: "data",
      startedAt,
      completedAt: Date.now(),
      deletedCount,
      details: { cutoff, deleted },
    };
    await this.recordCleanupRun(result, dryRun);
    return result;
  }

  private groupByRepo(tasks: TaskRow[]): Record<string, TaskRow[]> {
    const map: Record<string, TaskRow[]> = {};
    for (const task of tasks) {
      map[task.repo] = map[task.repo] || [];
      map[task.repo].push(task);
    }
    return map;
  }

  private async getBranchCleanupTasks(prefix: string, cutoff: number): Promise<TaskRow[]> {
    const iso = new Date(cutoff).toISOString();
    const { data, error } = await this.supabaseFrom("tasks")
      .select("id, repo, pr_branch, status, ended_at, started_at")
      .like("pr_branch", `${prefix}%`)
      .in("status", TERMINAL_STATUSES)
      .lt("ended_at", iso);
    if (error) {
      console.error("[cleanup] getBranchCleanupTasks error:", error.message);
      return [];
    }
    return (data || []) as TaskRow[];
  }

  private async getSandboxCleanupTasks(): Promise<TaskRow[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabaseFrom("tasks")
      .select("id, status, keep_alive_until, sandbox_id")
      .not("sandbox_id", "is", null)
      .or(`and(status.eq.running,keep_alive_until.lt.${nowIso}),status.in.(${TERMINAL_STATUSES.join(",")})`);
    if (error) {
      console.error("[cleanup] getSandboxCleanupTasks error:", error.message);
      return [];
    }
    return (data || []) as TaskRow[];
  }

  private sandboxReason(task: TaskRow): string {
    if (task.status === "running" && toMs(task.keep_alive_until) === undefined) return "running with no keep-alive";
    if (TERMINAL_STATUSES.includes(task.status)) return `terminal status ${task.status}`;
    return "keep-alive expired";
  }

  private async clearSandboxId(taskId: string): Promise<void> {
    await this.supabaseFrom("tasks").update({ sandbox_id: null, keep_alive_until: null }).eq("id", taskId);
  }

  private async getOldSessionSnapshots(cutoff: number): Promise<{ id: string }[]> {
    const iso = new Date(cutoff).toISOString();
    const { data, error } = await this.supabaseFrom("session_snapshots")
      .select("id")
      .lt("created_at", iso);
    if (error) {
      console.error("[cleanup] getOldSessionSnapshots error:", error.message);
      return [];
    }
    return (data || []) as { id: string }[];
  }

  private async getOldCheckpoints(cutoff: number): Promise<{ id: string }[]> {
    const iso = new Date(cutoff).toISOString();
    const { data, error } = await this.supabaseFrom("checkpoints")
      .select("id")
      .lt("timestamp", iso)
      .eq("status", "active");
    if (error) {
      console.error("[cleanup] getOldCheckpoints error:", error.message);
      return [];
    }
    return (data || []) as { id: string }[];
  }

  private taskIdFromBranch(branch: string, prefix: string): string | undefined {
    if (!branch.startsWith(prefix)) return undefined;
    const suffix = branch.slice(prefix.length);
    const match = suffix.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return match ? match[0] : undefined;
  }

  private async listGitHubBranches(owner: string, repo: string, prefix: string): Promise<GitHubBranch[]> {
    const results: GitHubBranch[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const res = await this.githubFetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`);
      if (!res.ok) {
        console.error(`[cleanup] listGitHubBranches failed: ${res.status}`);
        return results;
      }
      const branches = (await res.json()) as Array<{
        name: string;
        commit: { sha: string; commit?: { committer?: { date?: string } } };
      }>;
      for (const b of branches) {
        if (b.name.startsWith(prefix)) {
          const dateStr = b.commit?.commit?.committer?.date;
          results.push({
            name: b.name,
            lastCommitAt: dateStr ? new Date(dateStr).getTime() : undefined,
          });
        }
      }
      if (branches.length < perPage) break;
      page++;
    }
    return results;
  }

  private async deleteGitHubBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    const res = await this.githubFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
    if (res.ok || res.status === 404) return true;
    console.error(`[cleanup] deleteGitHubBranch failed: ${res.status}`);
    return false;
  }

  private async deleteCheckpointTags(owner: string, repo: string, taskId: string): Promise<number> {
    const prefix = `tags/daybreak/checkpoint/${taskId}/`;
    const res = await this.githubFetch(`https://api.github.com/repos/${owner}/${repo}/git/matching-refs/${prefix}`);
    if (!res.ok) return 0;
    const refs = (await res.json()) as Array<{ ref: string }>;
    let deleted = 0;
    for (const r of refs) {
      const deleteRes = await this.githubFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/${r.ref.replace(/^refs\//, "")}`, { method: "DELETE" });
      if (deleteRes.ok || deleteRes.status === 404) deleted++;
    }
    return deleted;
  }

  private async githubFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers as Record<string, string>),
    };
    if (this.githubToken) headers.Authorization = `Bearer ${this.githubToken}`;
    return this.fetch(url, { ...init, headers });
  }

  private async recordCleanupRun(result: CleanupResult, dryRun: boolean): Promise<void> {
    const supabase = this.supabase;
    if (!supabase) return;
    await this.supabaseFrom("cleanup_runs").insert({
      type: result.type,
      started_at: new Date(result.startedAt).toISOString(),
      completed_at: new Date(result.completedAt).toISOString(),
      details: { ...result.details, dryRun },
      deleted_count: result.deletedCount,
    });
  }

  private supabaseFrom(table: string) {
    if (!this.supabase) throw new Error(`Supabase not configured; cannot access ${table}`);
    return this.supabase.from(table);
  }
}
