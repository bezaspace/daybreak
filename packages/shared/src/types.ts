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
