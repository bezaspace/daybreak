import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { DaybreakConfig, TaskMetrics, TaskResult, ToolCallRecord } from "@daybreak/shared";
import { SafetyMiddleware } from "@daybreak/shared";
import pc from "picocolors";
import { createModelRuntime, getFallbackModel } from "./llm.js";
import { MetricsCollector } from "./metrics.js";

export interface RunOptions {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  autoApprove?: boolean;
  onStream?: (text: string) => void;
}

export class TaskRunner {
  private config: DaybreakConfig;
  private safety: SafetyMiddleware;
  private metrics: MetricsCollector;
  private session?: AgentSession;
  private abortedReason?: string;
  private wallClockTimer?: NodeJS.Timeout;

  constructor(config: DaybreakConfig) {
    this.config = config;
    this.safety = new SafetyMiddleware(config);
    this.metrics = new MetricsCollector();
  }

  async run(options: RunOptions): Promise<TaskResult> {
    const { prompt, cwd, systemPrompt, autoApprove, onStream } = options;

    const { modelRuntime, model } = await createModelRuntime(this.config.llm, this.config.llmFallback);

    const { session } = await createAgentSession({
      modelRuntime,
      model,
      tools: ["read", "bash", "edit", "write"],
      sessionManager: SessionManager.inMemory(cwd),
      cwd,
    });

    this.session = session;

    if (systemPrompt) {
      this.session.agent.state.systemPrompt = systemPrompt;
    }

    if (autoApprove) {
      this.safety.approveAll();
    }

    this.wireSafety();
    this.wireMetrics();
    this.wireStreaming(onStream);
    this.startWallClockTimer();

    try {
      await this.session.prompt(prompt);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.abortedReason) {
        console.error(pc.yellow(`\n[run aborted] ${this.abortedReason}`));
      } else {
        console.error(pc.red(`\n[run error] ${errorMessage}`));
      }
    } finally {
      this.stopWallClockTimer();
      this.session.dispose();
    }

    return {
      success: !this.abortedReason,
      summary: "See log for details",
      metrics: this.metrics.finalize(),
      error: this.abortedReason,
    };
  }

  private wireSafety(): void {
    if (!this.session) return;

    this.session.agent.beforeToolCall = async ({ toolCall, args }) => {
      const check = this.safety.beforeToolCall(toolCall.name, args);
      if (!check.allowed) {
        console.error(pc.red(`\n[safety block] ${toolCall.name}: ${check.reason}`));
        this.metrics.blockToolCall(toolCall.id, check.reason ?? "safety");
        return { block: true, reason: check.reason };
      }
      return {};
    };
  }

  private wireMetrics(): void {
    if (!this.session) return;

    const pendingToolCalls = new Map<string, ToolCallRecord>();

    this.session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "turn_start": {
          this.metrics.recordTurn();
          const current = this.metrics.current();
          if (current.turns >= this.config.maxTurns) {
            this.abort(`Max turns (${this.config.maxTurns}) reached`);
          }
          if (current.estimatedCostUsd >= this.config.maxCostUsd) {
            this.abort(`Max cost $${this.config.maxCostUsd.toFixed(2)} reached`);
          }
          break;
        }
        case "message_end": {
          this.metrics.recordMessage(event.message);
          break;
        }
        case "tool_execution_start": {
          const record: ToolCallRecord = {
            id: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            startedAt: Date.now(),
          };
          pendingToolCalls.set(event.toolCallId, record);
          this.metrics.startToolCall(record);
          console.log(pc.cyan(`[tool start] ${event.toolName}`), JSON.stringify(event.args).slice(0, 200));
          break;
        }
        case "tool_execution_end": {
          const record = pendingToolCalls.get(event.toolCallId);
          if (record) {
            pendingToolCalls.delete(event.toolCallId);
            this.metrics.endToolCall(event.toolCallId, event.isError);
            console.log(
              pc.cyan(`[tool end] ${record.toolName}`),
              event.isError ? pc.red("ERROR") : pc.green("ok"),
              JSON.stringify(event.result).slice(0, 200),
            );
          }
          break;
        }
      }
    });
  }

  private wireStreaming(onStream?: (text: string) => void): void {
    if (!this.session) return;

    this.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        process.stdout.write(delta);
        onStream?.(delta);
      }
    });
  }

  private startWallClockTimer(): void {
    const maxMs = this.config.maxWallClockMinutes * 60 * 1000;
    this.wallClockTimer = setTimeout(() => {
      this.abort(`Max wall-clock time (${this.config.maxWallClockMinutes}m) reached`);
    }, maxMs);
  }

  private stopWallClockTimer(): void {
    if (this.wallClockTimer) {
      clearTimeout(this.wallClockTimer);
      this.wallClockTimer = undefined;
    }
  }

  private abort(reason: string): void {
    if (this.abortedReason) return;
    this.abortedReason = reason;
    this.session?.abort().catch(() => {});
  }
}
