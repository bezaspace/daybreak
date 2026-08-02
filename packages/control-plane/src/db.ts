import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "@daybreak/shared";

export interface PersistedTask {
  id: string;
  repo: string;
  branch: string;
  pr_branch: string;
  status: string;
  started_at: string;
  ended_at?: string | null;
  exit_code?: number | null;
  pr_url?: string | null;
  trace_id?: string | null;
  provider?: string | null;
  cost_usd?: number | null;
  trigger_source?: string | null;
  github_sender?: string | null;
  pr_number?: number | null;
  prompt?: string | null;
  sandbox_id?: string | null;
  keep_alive_until?: string | null;
  workspace_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PersistedEvent {
  id: number;
  task_id: string;
  type: string;
  data: unknown;
  timestamp: number;
  event_id?: string | null;
  created_at?: string;
}

export interface Task {
  id: string;
  repo: string;
  branch: string;
  prBranch: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  prUrl?: string;
  traceId?: string;
  provider?: string;
  costUsd?: number;
  triggerSource?: string;
  githubSender?: string;
  prNumber?: number;
  prompt?: string;
  sandboxId?: string;
  keepAliveUntil?: number;
  workspaceId?: string;
}

export interface PersistedWorkspace {
  id: string;
  type: string;
  value: string;
  tasks_per_hour: number;
  created_at?: string;
  updated_at?: string;
}

export interface Workspace {
  id: string;
  type: "repo" | "sender";
  value: string;
  tasksPerHour: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface StreamEvent {
  id: string;
  taskId: string;
  type: string;
  timestamp: number;
  data: unknown;
}

function getSupabase(): SupabaseClient | undefined {
  const config = loadConfig();
  if (!config.supabaseUrl || !config.supabaseServiceKey) return undefined;
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function toTask(row: PersistedTask): Task {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    prBranch: row.pr_branch,
    status: row.status as Task["status"],
    startedAt: row.started_at ? new Date(row.started_at).getTime() : Date.now(),
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : undefined,
    exitCode: row.exit_code ?? undefined,
    prUrl: row.pr_url ?? undefined,
    traceId: row.trace_id ?? undefined,
    provider: row.provider ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    triggerSource: row.trigger_source ?? undefined,
    githubSender: row.github_sender ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prompt: row.prompt ?? undefined,
    sandboxId: row.sandbox_id ?? undefined,
    keepAliveUntil: row.keep_alive_until ? new Date(row.keep_alive_until).getTime() : undefined,
    workspaceId: row.workspace_id ?? undefined,
  };
}

export async function persistTask(task: Task): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("tasks").upsert({
    id: task.id,
    repo: task.repo,
    branch: task.branch,
    pr_branch: task.prBranch,
    status: task.status,
    started_at: new Date(task.startedAt).toISOString(),
    ended_at: task.endedAt ? new Date(task.endedAt).toISOString() : null,
    exit_code: task.exitCode ?? null,
    pr_url: task.prUrl ?? null,
    trace_id: task.traceId ?? null,
    provider: task.provider ?? null,
    cost_usd: task.costUsd ?? null,
    trigger_source: task.triggerSource ?? null,
    github_sender: task.githubSender ?? null,
    pr_number: task.prNumber ?? null,
    prompt: task.prompt ?? null,
    sandbox_id: task.sandboxId ?? null,
    keep_alive_until: task.keepAliveUntil ? new Date(task.keepAliveUntil).toISOString() : null,
    workspace_id: task.workspaceId ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[db] persistTask error:", error.message);
    return false;
  }
  return true;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.endedAt !== undefined) payload.ended_at = updates.endedAt ? new Date(updates.endedAt).toISOString() : null;
  if (updates.exitCode !== undefined) payload.exit_code = updates.exitCode ?? null;
  if (updates.prUrl !== undefined) payload.pr_url = updates.prUrl ?? null;
  if (updates.traceId !== undefined) payload.trace_id = updates.traceId ?? null;
  if (updates.provider !== undefined) payload.provider = updates.provider ?? null;
  if (updates.costUsd !== undefined) payload.cost_usd = updates.costUsd ?? null;
  if (updates.workspaceId !== undefined) payload.workspace_id = updates.workspaceId ?? null;
  const { error } = await supabase.from("tasks").update(payload).eq("id", id);
  if (error) {
    console.error("[db] updateTask error:", error.message);
    return false;
  }
  return true;
}

export async function getTasks(): Promise<Task[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<PersistedTask[]>();
  if (error) {
    console.error("[db] getTasks error:", error.message);
    return [];
  }
  return (data || []).map(toTask);
}

export async function getTask(id: string): Promise<Task | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle<PersistedTask>();
  if (error || !data) {
    if (error) console.error("[db] getTask error:", error.message);
    return undefined;
  }
  return toTask(data);
}

function toWorkspace(row: PersistedWorkspace): Workspace {
  return {
    id: row.id,
    type: row.type as Workspace["type"],
    value: row.value,
    tasksPerHour: row.tasks_per_hour,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : undefined,
  };
}

export async function getWorkspace(type: Workspace["type"], value: string): Promise<Workspace | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("type", type)
    .eq("value", value)
    .maybeSingle<PersistedWorkspace>();
  if (error || !data) {
    if (error) console.error("[db] getWorkspace error:", error.message);
    return undefined;
  }
  return toWorkspace(data);
}

export async function ensureWorkspace(type: Workspace["type"], value: string, defaultTasksPerHour: number): Promise<Workspace | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const existing = await getWorkspace(type, value);
  if (existing) return existing;
  const { data, error } = await supabase
    .from("workspaces")
    .insert({ type, value, tasks_per_hour: defaultTasksPerHour })
    .select("*")
    .single<PersistedWorkspace>();
  if (error || !data) {
    if (error) console.error("[db] ensureWorkspace error:", error.message);
    return undefined;
  }
  return toWorkspace(data);
}

export async function countTasksByWorkspace(workspaceId: string, since: number): Promise<number> {
  const supabase = getSupabase();
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("started_at", new Date(since).toISOString());
  if (error) {
    console.error("[db] countTasksByWorkspace error:", error.message);
    return 0;
  }
  return count ?? 0;
}

export async function persistEvent(taskId: string, event: StreamEvent): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("events").upsert(
    {
      task_id: taskId,
      event_id: event.id,
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    },
    { onConflict: "task_id,event_id" },
  );
  if (error) {
    console.error("[db] persistEvent error:", error.message);
    return false;
  }
  return true;
}

export async function getEvents(taskId: string, after = 0): Promise<StreamEvent[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("task_id", taskId)
    .gt("id", after)
    .order("id", { ascending: true })
    .returns<PersistedEvent[]>();
  if (error) {
    console.error("[db] getEvents error:", error.message);
    return [];
  }
  return (data || []).map((row) => ({
    id: row.event_id || String(row.id),
    taskId: row.task_id,
    type: row.type,
    timestamp: row.timestamp,
    data: row.data,
  }));
}
