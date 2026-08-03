import { describe, it, expect, vi } from "vitest";
import { loadConfig, type DaybreakConfig } from "@daybreak/shared";
import { CleanupService, type CleanupResult } from "./cleanup.js";

function buildConfig(overrides: Partial<DaybreakConfig> = {}): DaybreakConfig {
  return { ...loadConfig(), ...overrides };
}

type TableRows = Record<string, Array<Record<string, unknown>>>;

class FakeSupabaseBuilder {
  private table: string;
  private store: TableRows;
  private state: {
    operation?: string;
    payload?: unknown;
    filters: Array<Record<string, unknown>>;
  } = { filters: [] };

  constructor(table: string, store: TableRows) {
    this.table = table;
    this.store = store;
  }

  select(_cols?: string) {
    this.state.operation = "select";
    return this;
  }

  like(col: string, val: string) {
    this.state.filters.push({ type: "like", col, val });
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.state.filters.push({ type: "in", col, vals });
    return this;
  }

  lt(col: string, val: string) {
    this.state.filters.push({ type: "lt", col, val });
    return this;
  }

  not(col: string, op: string, val: unknown) {
    this.state.filters.push({ type: "not", col, op, val });
    return this;
  }

  or(_str: string) {
    this.state.filters.push({ type: "or", str: _str });
    return this;
  }

  eq(col: string, val: unknown) {
    this.state.filters.push({ type: "eq", col, val });
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.state.operation = "update";
    this.state.payload = payload;
    return this;
  }

  delete() {
    this.state.operation = "delete";
    return this;
  }

  insert(payload: unknown) {
    this.state.operation = "insert";
    this.state.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled as (value: unknown) => TResult1 | PromiseLike<TResult1>, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null,
  ): Promise<unknown | TResult> {
    return this.then(undefined, onrejected);
  }

  private execute() {
    const rows = this.store[this.table] || [];
    switch (this.state.operation) {
      case "select": {
        const matches = rows.filter((row) => this.matches(row));
        return { data: matches, error: null };
      }
      case "update": {
        let updated = 0;
        for (const row of rows) {
          if (this.matches(row)) {
            Object.assign(row, this.state.payload);
            updated++;
          }
        }
        return { data: updated > 0 ? [{}] : null, error: null };
      }
      case "delete": {
        const kept: typeof rows = [];
        let count = 0;
        for (const row of rows) {
          if (this.matches(row)) {
            count++;
          } else {
            kept.push(row);
          }
        }
        this.store[this.table] = kept;
        return { error: null, count };
      }
      case "insert": {
        const payload = (this.state.payload as unknown[]) || [];
        for (const item of payload) {
          if (typeof item === "object" && item !== null) {
            rows.push({ ...item });
          } else {
            rows.push(item as Record<string, unknown>);
          }
        }
        return { error: null };
      }
      default:
        return { data: null, error: new Error("unknown operation") };
    }
  }

  private matches(row: Record<string, unknown>): boolean {
    for (const f of this.state.filters) {
      switch (f.type) {
        case "like": {
          const val = String(f.val);
          const prefix = val.endsWith("%") ? val.slice(0, -1) : val;
          if (!String(row[f.col as string]).startsWith(prefix)) return false;
          break;
        }
        case "in": {
          const vals = f.vals as unknown[];
          if (!vals.includes(row[f.col as string])) return false;
          break;
        }
        case "lt": {
          const a = new Date(row[f.col as string] as string).getTime();
          const b = new Date(f.val as string).getTime();
          if (Number.isNaN(a) || Number.isNaN(b) || !(a < b)) return false;
          break;
        }
        case "not": {
          if (f.op === "is" && f.val === null) {
            if (row[f.col as string] == null) return false;
          } else {
            return false;
          }
          break;
        }
        case "eq": {
          if (row[f.col as string] !== f.val) return false;
          break;
        }
        case "or":
        default:
          break;
      }
    }
    return true;
  }
}

function createFakeSupabase(tables: TableRows) {
  return {
    from: (table: string) => new FakeSupabaseBuilder(table, tables),
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeGitHubFetch(branches: Array<{ name: string; lastCommitAt?: number }>, deleted: string[] = []) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/branches?")) {
      const body = branches.map((b) => ({
        name: b.name,
        commit: {
          sha: "abc",
          commit: b.lastCommitAt
            ? { committer: { date: new Date(b.lastCommitAt).toISOString() } }
            : undefined,
        },
      }));
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes("/git/refs/heads/")) {
      deleted.push(url.split("/git/refs/heads/").pop()!);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/git/matching-refs/")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}

describe("CleanupService", () => {
  it("dry-runs stale daybreak branches", async () => {
    const branchUuid = "11111111-1111-1111-1111-111111111111";
    const tables: TableRows = {
      tasks: [
        {
          id: branchUuid,
          repo: "https://github.com/bezaspace/daybreak-target",
          pr_branch: `daybreak/${branchUuid}`,
          status: "complete",
          ended_at: isoDaysAgo(10),
        },
      ],
      session_snapshots: [],
      checkpoints: [],
      cleanup_runs: [],
    };
    const githubFetch = makeGitHubFetch([
      { name: `daybreak/${branchUuid}`, lastCommitAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
    ]);
    const service = new CleanupService({
      config: buildConfig({ branchTtlDays: 7, prBranchPrefix: "daybreak/" }),
      githubToken: "ghp_test",
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
      fetchImpl: githubFetch as unknown as typeof fetch,
    });

    const result = await service.cleanupBranches(true);
    expect(result.deletedCount).toBe(1);
    const deletedBranches = result.details.deleted as Array<{ branch: string; dryRun?: boolean }>;
    expect(deletedBranches).toHaveLength(1);
    expect(deletedBranches[0]).toMatchObject({ branch: `daybreak/${branchUuid}`, dryRun: true });
  });

  it("deletes stale branches and checkpoint tags", async () => {
    const branchUuid = "22222222-2222-2222-2222-222222222222";
    const tables: TableRows = {
      tasks: [
        {
          id: branchUuid,
          repo: "https://github.com/bezaspace/daybreak-target",
          pr_branch: `daybreak/${branchUuid}`,
          status: "failed",
          ended_at: isoDaysAgo(10),
        },
      ],
      session_snapshots: [],
      checkpoints: [],
      cleanup_runs: [],
    };
    const deleted: string[] = [];
    const githubFetch = makeGitHubFetch(
      [{ name: `daybreak/${branchUuid}`, lastCommitAt: Date.now() - 10 * 24 * 60 * 60 * 1000 }],
      deleted,
    );
    const service = new CleanupService({
      config: buildConfig({ branchTtlDays: 7, prBranchPrefix: "daybreak/" }),
      githubToken: "ghp_test",
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
      fetchImpl: githubFetch as unknown as typeof fetch,
    });

    const result = await service.cleanupBranches(false);
    expect(result.deletedCount).toBe(1);
    expect(deleted).toContain(`daybreak/${branchUuid}`);
  });

  it("includes orphan branches in dry-run", async () => {
    const branchUuid = "33333333-3333-3333-3333-333333333333";
    const tables: TableRows = {
      tasks: [
        {
          id: branchUuid,
          repo: "https://github.com/bezaspace/daybreak-target",
          pr_branch: `daybreak/${branchUuid}`,
          status: "complete",
          ended_at: isoDaysAgo(10),
        },
      ],
      session_snapshots: [],
      checkpoints: [],
      cleanup_runs: [],
    };
    const githubFetch = makeGitHubFetch([
      { name: `daybreak/${branchUuid}`, lastCommitAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
      { name: "daybreak/orphan-branch", lastCommitAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
    ]);
    const service = new CleanupService({
      config: buildConfig({ branchTtlDays: 7, prBranchPrefix: "daybreak/" }),
      githubToken: "ghp_test",
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
      fetchImpl: githubFetch as unknown as typeof fetch,
    });

    const result = await service.cleanupBranches(true);
    expect(result.deletedCount).toBe(2);
    const branches = (result.details.deleted as Array<{ branch: string }>).map((d) => d.branch);
    expect(branches).toContain(`daybreak/${branchUuid}`);
    expect(branches).toContain("daybreak/orphan-branch");
  });

  it("kills expired sandboxes", async () => {
    const tables: TableRows = {
      tasks: [
        {
          id: "task-1",
          repo: "https://github.com/bezaspace/daybreak-target",
          status: "running",
          sandbox_id: "sbx-1",
          keep_alive_until: isoDaysAgo(1),
        },
      ],
      session_snapshots: [],
      checkpoints: [],
      cleanup_runs: [],
    };
    const terminator = vi.fn(async () => true);
    const service = new CleanupService({
      config: buildConfig({ sandboxIdleTtlMinutes: 15 }),
      sandboxTerminator: terminator,
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
    });

    const result = await service.cleanupSandboxes(false);
    expect(result.deletedCount).toBe(1);
    expect(terminator).toHaveBeenCalledWith("sbx-1");
    expect(tables.tasks[0].sandbox_id).toBeNull();
  });

  it("dry-runs sandbox cleanup", async () => {
    const tables: TableRows = {
      tasks: [
        {
          id: "task-2",
          status: "complete",
          sandbox_id: "sbx-2",
        },
      ],
      session_snapshots: [],
      checkpoints: [],
      cleanup_runs: [],
    };
    const service = new CleanupService({
      config: buildConfig({ sandboxIdleTtlMinutes: 15 }),
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
    });

    const result = await service.cleanupSandboxes(true);
    expect(result.deletedCount).toBe(1);
    expect(tables.tasks[0].sandbox_id).toBe("sbx-2");
  });

  it("deletes old session snapshots and abandons old checkpoints", async () => {
    const tables: TableRows = {
      tasks: [],
      session_snapshots: [{ id: "snap-1", created_at: isoDaysAgo(40) }],
      checkpoints: [
        { id: "cp-1", timestamp: isoDaysAgo(40), status: "active" },
        { id: "cp-2", timestamp: isoDaysAgo(40), status: "active" },
      ],
      cleanup_runs: [],
    };
    const service = new CleanupService({
      config: buildConfig({ dataRetentionDays: 30 }),
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
    });

    const result = await service.cleanupDataRetention(false);
    expect(result.deletedCount).toBe(1);
    expect(tables.session_snapshots).toHaveLength(0);
    expect(tables.checkpoints.every((cp) => cp.status === "abandoned")).toBe(true);
  });

  it("dry-runs data retention", async () => {
    const tables: TableRows = {
      tasks: [],
      session_snapshots: [{ id: "snap-2", created_at: isoDaysAgo(40) }],
      checkpoints: [{ id: "cp-3", timestamp: isoDaysAgo(40), status: "active" }],
      cleanup_runs: [],
    };
    const service = new CleanupService({
      config: buildConfig({ dataRetentionDays: 30 }),
      // @ts-expect-error fake supabase
      supabase: createFakeSupabase(tables),
    });

    const result = await service.cleanupDataRetention(true);
    expect(result.deletedCount).toBe(1);
    expect(tables.session_snapshots).toHaveLength(1);
    expect(tables.checkpoints[0].status).toBe("active");
  });
});
