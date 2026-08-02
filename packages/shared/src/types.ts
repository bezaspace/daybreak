export interface ToolCallRecord {
  id: string;
  toolName: string;
  args: unknown;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  blockedReason?: string;
}

export interface TaskMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  turns: number;
  toolCalls: number;
  blockedToolCalls: number;
  wallClockMs: number;
  startTime: number;
  endTime?: number;
}

export interface TaskResult {
  success: boolean;
  prUrl?: string;
  branch?: string;
  summary: string;
  metrics: TaskMetrics;
  error?: string;
  traceId?: string;
  provider?: string;
}

export interface AgentConfig {
  provider: "openai" | "custom" | "groq" | "openrouter";
  baseUrl: string;
  apiKey: string;
  modelId: string;
  inputPricePer1MTokens?: number;
  outputPricePer1MTokens?: number;
  fallback?: AgentConfig;
}

export type LlmPricingMap = Record<string, { input: number; output: number }>;

export type CheckpointStatus = "active" | "rewound" | "branched" | "promoted" | "abandoned";

export interface Checkpoint {
  id: string;
  taskId: string;
  turn: number;
  timestamp: number;
  gitCommit?: string;
  sessionRef?: string;
  parentCheckpointId?: string;
  branchTaskId?: string;
  status: CheckpointStatus;
  toolCallId?: string;
  costUsd?: number;
}

export interface PersistedCheckpoint {
  id: string;
  task_id: string;
  turn: number;
  timestamp: string;
  git_commit?: string | null;
  session_ref?: string | null;
  parent_checkpoint_id?: string | null;
  branch_task_id?: string | null;
  status: string;
  tool_call_id?: string | null;
  cost_usd?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface AgentStateSnapshot {
  taskId: string;
  turn: number;
  sessionFile?: string;
  sessionJsonl?: string;
}
