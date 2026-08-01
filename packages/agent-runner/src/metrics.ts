import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { TaskMetrics, ToolCallRecord } from "@daybreak/shared";

export class MetricsCollector {
  private metrics: TaskMetrics;
  private toolCalls: ToolCallRecord[] = [];
  private startTime = Date.now();

  constructor() {
    this.metrics = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      turns: 0,
      toolCalls: 0,
      blockedToolCalls: 0,
      wallClockMs: 0,
      startTime: this.startTime,
    };
  }

  recordTurn(): void {
    this.metrics.turns++;
  }

  startToolCall(record: ToolCallRecord): void {
    this.toolCalls.push(record);
  }

  endToolCall(id: string, isError?: boolean): void {
    const record = this.toolCalls.find((t) => t.id === id);
    if (!record || record.endedAt) return;
    record.endedAt = Date.now();
    record.isError = isError;
    if (record.blockedReason) {
      this.metrics.blockedToolCalls++;
    } else {
      this.metrics.toolCalls++;
    }
  }

  blockToolCall(id: string, reason: string): void {
    const record = this.toolCalls.find((t) => t.id === id);
    if (!record) return;
    record.blockedReason = reason;
    this.metrics.blockedToolCalls++;
  }

  recordMessage(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    const usage = assistant.usage;
    if (!usage) return;

    this.metrics.promptTokens += usage.input || 0;
    this.metrics.completionTokens += usage.output || 0;
    this.metrics.totalTokens += usage.totalTokens || 0;
    this.metrics.estimatedCostUsd += usage.cost?.total || 0;
  }

  finalize(): TaskMetrics {
    this.metrics.endTime = Date.now();
    this.metrics.wallClockMs = this.metrics.endTime - this.startTime;
    return { ...this.metrics };
  }

  current(): TaskMetrics {
    return { ...this.metrics, wallClockMs: Date.now() - this.startTime };
  }

  getToolCalls(): ToolCallRecord[] {
    return [...this.toolCalls];
  }
}
