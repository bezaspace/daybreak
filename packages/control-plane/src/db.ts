import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "@daybreak/shared";
import type { Checkpoint, PersistedCheckpoint } from "@daybreak/shared";

let memoryDeadLetterId = 0;
const memoryDeadLetterTasks: DeadLetterTask[] = [];

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
  tenant_id?: string | null;
  head_checkpoint_id?: string | null;
  root_checkpoint_id?: string | null;
  parent_task_id?: string | null;
  parent_checkpoint_id?: string | null;
  head_sha?: string | null;
  check_run_id?: string | null;
  heal_attempt?: number | null;
  claimed_at?: string | null;
  worker_id?: string | null;
  metadata?: unknown | null;
  idempotency_key?: string | null;
  retry_count?: number | null;
  max_retries?: number | null;
  next_retry_at?: string | null;
  last_error?: string | null;
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
  status: "pending" | "running" | "complete" | "failed" | "abandoned" | "promoted" | "cancelled" | "retry_scheduled";
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
  tenantId?: string;
  headCheckpointId?: string;
  rootCheckpointId?: string;
  parentTaskId?: string;
  parentCheckpointId?: string;
  headSha?: string;
  checkRunId?: string;
  healAttempt?: number;
  claimedAt?: number;
  workerId?: string;
  metadata?: Record<string, unknown>;
  maxTurns?: number;
  maxCostUsd?: number;
  maxWallClockMinutes?: number;
  idempotencyKey?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: number;
  lastError?: string;
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

export function getSupabase(): SupabaseClient | undefined {
  const config = loadConfig();
  if (!config.supabaseUrl || !config.supabaseServiceKey) return undefined;
  try {
    return createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (error) {
    console.warn("[db] Supabase client creation failed, running without persistence:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
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
    tenantId: row.tenant_id ?? undefined,
    headCheckpointId: row.head_checkpoint_id ?? undefined,
    rootCheckpointId: row.root_checkpoint_id ?? undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    parentCheckpointId: row.parent_checkpoint_id ?? undefined,
    headSha: row.head_sha ?? undefined,
    checkRunId: row.check_run_id ?? undefined,
    healAttempt: row.heal_attempt ?? undefined,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).getTime() : undefined,
    workerId: row.worker_id ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    retryCount: row.retry_count ?? undefined,
    maxRetries: row.max_retries ?? undefined,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).getTime() : undefined,
    lastError: row.last_error ?? undefined,
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
    tenant_id: task.tenantId ?? null,
    head_checkpoint_id: task.headCheckpointId ?? null,
    root_checkpoint_id: task.rootCheckpointId ?? null,
    parent_task_id: task.parentTaskId ?? null,
    parent_checkpoint_id: task.parentCheckpointId ?? null,
    head_sha: task.headSha ?? null,
    check_run_id: task.checkRunId ?? null,
    heal_attempt: task.healAttempt ?? null,
    claimed_at: task.claimedAt ? new Date(task.claimedAt).toISOString() : null,
    worker_id: task.workerId ?? null,
    metadata: task.metadata ?? null,
    idempotency_key: task.idempotencyKey ?? null,
    retry_count: task.retryCount ?? 0,
    max_retries: task.maxRetries ?? 2,
    next_retry_at: task.nextRetryAt ? new Date(task.nextRetryAt).toISOString() : null,
    last_error: task.lastError ?? null,
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
  if (updates.tenantId !== undefined) payload.tenant_id = updates.tenantId ?? null;
  if (updates.headCheckpointId !== undefined) payload.head_checkpoint_id = updates.headCheckpointId ?? null;
  if (updates.rootCheckpointId !== undefined) payload.root_checkpoint_id = updates.rootCheckpointId ?? null;
  if (updates.parentTaskId !== undefined) payload.parent_task_id = updates.parentTaskId ?? null;
  if (updates.parentCheckpointId !== undefined) payload.parent_checkpoint_id = updates.parentCheckpointId ?? null;
  if (updates.headSha !== undefined) payload.head_sha = updates.headSha ?? null;
  if (updates.checkRunId !== undefined) payload.check_run_id = updates.checkRunId ?? null;
  if (updates.healAttempt !== undefined) payload.heal_attempt = updates.healAttempt ?? null;
  if (updates.claimedAt !== undefined) payload.claimed_at = updates.claimedAt ? new Date(updates.claimedAt).toISOString() : null;
  if (updates.workerId !== undefined) payload.worker_id = updates.workerId ?? null;
  if (updates.metadata !== undefined) payload.metadata = updates.metadata ?? null;
  if (updates.idempotencyKey !== undefined) payload.idempotency_key = updates.idempotencyKey ?? null;
  if (updates.retryCount !== undefined) payload.retry_count = updates.retryCount ?? 0;
  if (updates.maxRetries !== undefined) payload.max_retries = updates.maxRetries ?? 2;
  if (updates.nextRetryAt !== undefined) payload.next_retry_at = updates.nextRetryAt ? new Date(updates.nextRetryAt).toISOString() : null;
  if (updates.lastError !== undefined) payload.last_error = updates.lastError ?? null;
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

export async function claimNextPendingTask(maxConcurrent: number, workerId?: string): Promise<Task | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase.rpc("claim_next_pending_task", { max_concurrent: maxConcurrent, worker_id: workerId ?? null });
  if (error) {
    console.error("[db] claimNextPendingTask error:", error.message);
    return undefined;
  }
  if (!data || !Array.isArray(data) || data.length === 0) return undefined;
  return toTask(data[0] as PersistedTask);
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

function toCheckpoint(row: PersistedCheckpoint): Checkpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    turn: row.turn,
    timestamp: new Date(row.timestamp).getTime(),
    gitCommit: row.git_commit ?? undefined,
    sessionRef: row.session_ref ?? undefined,
    parentCheckpointId: row.parent_checkpoint_id ?? undefined,
    branchTaskId: row.branch_task_id ?? undefined,
    status: row.status as Checkpoint["status"],
    toolCallId: row.tool_call_id ?? undefined,
    costUsd: row.cost_usd ?? undefined,
  };
}

export async function persistCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("checkpoints").upsert({
    id: checkpoint.id,
    task_id: checkpoint.taskId,
    turn: checkpoint.turn,
    timestamp: new Date(checkpoint.timestamp).toISOString(),
    git_commit: checkpoint.gitCommit ?? null,
    session_ref: checkpoint.sessionRef ?? null,
    parent_checkpoint_id: checkpoint.parentCheckpointId ?? null,
    branch_task_id: checkpoint.branchTaskId ?? null,
    status: checkpoint.status,
    tool_call_id: checkpoint.toolCallId ?? null,
    cost_usd: checkpoint.costUsd ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[db] persistCheckpoint error:", error.message);
    return false;
  }
  return true;
}

export async function getCheckpoint(id: string): Promise<Checkpoint | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase.from("checkpoints").select("*").eq("id", id).maybeSingle<PersistedCheckpoint>();
  if (error || !data) {
    if (error) console.error("[db] getCheckpoint error:", error.message);
    return undefined;
  }
  return toCheckpoint(data);
}

export async function listCheckpoints(taskId: string): Promise<Checkpoint[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("checkpoints")
    .select("*")
    .eq("task_id", taskId)
    .order("turn", { ascending: true })
    .order("timestamp", { ascending: true })
    .returns<PersistedCheckpoint[]>();
  if (error) {
    console.error("[db] listCheckpoints error:", error.message);
    return [];
  }
  return (data || []).map(toCheckpoint);
}

export async function getLatestCheckpoint(taskId: string): Promise<Checkpoint | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from("checkpoints")
    .select("*")
    .eq("task_id", taskId)
    .order("turn", { ascending: false })
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle<PersistedCheckpoint>();
  if (error || !data) {
    if (error) console.error("[db] getLatestCheckpoint error:", error.message);
    return undefined;
  }
  return toCheckpoint(data);
}

export async function updateCheckpointStatus(id: string, status: Checkpoint["status"]): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase
    .from("checkpoints")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.error("[db] updateCheckpointStatus error:", error.message);
    return false;
  }
  return true;
}

export interface PersistedDeadLetterTask {
  id: string;
  task_id?: string | null;
  repo?: string | null;
  branch?: string | null;
  pr_branch?: string | null;
  error?: string | null;
  retry_count?: number | null;
  created_at?: string;
  resolved_at?: string | null;
  resolution?: string | null;
}

export interface DeadLetterTask {
  id: string;
  taskId?: string;
  repo?: string;
  branch?: string;
  prBranch?: string;
  error?: string;
  retryCount?: number;
  createdAt?: number;
  resolvedAt?: number;
  resolution?: string;
}

function makeMemoryDeadLetterTask(task: Task, error: string): DeadLetterTask {
  memoryDeadLetterId += 1;
  return {
    id: `dl-mem-${memoryDeadLetterId}`,
    taskId: task.id,
    repo: task.repo,
    branch: task.branch,
    prBranch: task.prBranch,
    error,
    retryCount: task.retryCount ?? 0,
    createdAt: Date.now(),
  };
}

function toDeadLetterTask(row: PersistedDeadLetterTask): DeadLetterTask {
  return {
    id: row.id,
    taskId: row.task_id ?? undefined,
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    prBranch: row.pr_branch ?? undefined,
    error: row.error ?? undefined,
    retryCount: row.retry_count ?? undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : undefined,
    resolution: row.resolution ?? undefined,
  };
}

export async function insertDeadLetterTask(task: Task, error: string): Promise<DeadLetterTask | undefined> {
  const supabase = getSupabase();
  if (!supabase) {
    const dl = makeMemoryDeadLetterTask(task, error);
    memoryDeadLetterTasks.push(dl);
    return dl;
  }
  const { data, error: dbError } = await supabase
    .from("dead_letter_tasks")
    .insert({
      task_id: task.id,
      repo: task.repo,
      branch: task.branch,
      pr_branch: task.prBranch,
      error,
      retry_count: task.retryCount ?? 0,
    })
    .select()
    .single<PersistedDeadLetterTask>();
  if (dbError) {
    console.error("[db] insertDeadLetterTask error:", dbError.message);
    return undefined;
  }
  return data ? toDeadLetterTask(data) : undefined;
}

export async function listDeadLetterTasks(): Promise<DeadLetterTask[]> {
  const supabase = getSupabase();
  if (!supabase) return [...memoryDeadLetterTasks].reverse();
  const { data, error } = await supabase
    .from("dead_letter_tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<PersistedDeadLetterTask[]>();
  if (error) {
    console.error("[db] listDeadLetterTasks error:", error.message);
    return [];
  }
  return (data ?? []).map(toDeadLetterTask);
}

export async function getDeadLetterTaskByTaskId(taskId: string): Promise<DeadLetterTask | undefined> {
  const supabase = getSupabase();
  if (!supabase) return memoryDeadLetterTasks.find((t) => t.taskId === taskId && !t.resolution);
  const { data, error } = await supabase
    .from("dead_letter_tasks")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle<PersistedDeadLetterTask>();
  if (error) {
    console.error("[db] getDeadLetterTaskByTaskId error:", error.message);
    return undefined;
  }
  return data ? toDeadLetterTask(data) : undefined;
}

export async function resolveDeadLetterTask(id: string, resolution: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) {
    const dl = memoryDeadLetterTasks.find((t) => t.id === id);
    if (dl) {
      dl.resolvedAt = Date.now();
      dl.resolution = resolution;
    }
    return true;
  }
  const { error } = await supabase
    .from("dead_letter_tasks")
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq("id", id);
  if (error) {
    console.error("[db] resolveDeadLetterTask error:", error.message);
    return false;
  }
  return true;
}

export async function updateCheckpoint(id: string, updates: Partial<Pick<Checkpoint, "branchTaskId" | "status">>): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.branchTaskId !== undefined) payload.branch_task_id = updates.branchTaskId ?? null;
  if (updates.status !== undefined) payload.status = updates.status;
  const { error } = await supabase.from("checkpoints").update(payload).eq("id", id);
  if (error) {
    console.error("[db] updateCheckpoint error:", error.message);
    return false;
  }
  return true;
}
