export interface StreamEvent {
  id: string;
  type: string;
  timestamp: number;
  taskId: string;
  data: unknown;
}

export interface Task {
  id: string;
  repo: string;
  branch: string;
  prBranch?: string;
  status: string;
  prUrl?: string;
  traceId?: string;
  provider?: string;
  costUsd?: number;
  startedAt?: number;
  endedAt?: number;
  triggerSource?: string;
  prNumber?: number;
  sandboxId?: string;
  keepAliveUntil?: number;
  headCheckpointId?: string;
  rootCheckpointId?: string;
  parentTaskId?: string;
  parentCheckpointId?: string;
  headSha?: string;
  checkRunId?: string;
  healAttempt?: number;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  taskId?: string;
  role: "user" | "assistant" | "tool" | "system" | "artifact";
  type: "text" | "tool_call" | "tool_result" | "approval_request" | "checkpoint" | "cost_alert" | "status" | "error";
  content: unknown;
  createdAt: number;
  status?: "pending" | "running" | "complete" | "error";
}

export interface Screenshot {
  dataUrl: string;
  url?: string;
  timestamp: number;
}

export interface Config {
  maxTurns: number;
  maxWallClockMinutes: number;
  maxCostUsd: number;
  compactionEnabled: boolean;
  e2bTemplate?: string;
  provider?: string;
  maxConcurrentTasks: number;
  queueWorkerEnabled: boolean;
  branchTtlDays?: number;
  sandboxIdleTtlMinutes?: number;
  dataRetentionDays?: number;
  cleanupEnabled?: boolean;
}

export interface QueueStatus {
  pending: number;
  running: number;
  maxConcurrent: number;
  workerEnabled: boolean;
  workerPollMs: number;
  workerPending: number;
  workerRunning: number;
}

export interface TaskMetrics {
  turns?: number;
  toolCalls?: number;
  blockedToolCalls?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  wallClockMs?: number;
}
