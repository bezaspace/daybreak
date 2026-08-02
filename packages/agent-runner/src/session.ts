import { createAgentSession, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { context, trace, SpanStatusCode, type Span, type Context, type Tracer } from "@opentelemetry/api";
import type { TracerProvider } from "@opentelemetry/sdk-trace";
import type { Checkpoint, DaybreakConfig, TaskResult, ToolCallRecord } from "@daybreak/shared";
import { SafetyMiddleware } from "@daybreak/shared";
import pc from "picocolors";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { browserTool, closeBrowser } from "./browser-tool.js";
import { CheckpointStore } from "./checkpoint.js";
import { createModelRuntime, type ProviderSwitchInfo } from "./llm.js";
import { MetricsCollector } from "./metrics.js";
import { SessionStore } from "./session-store.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";

type ProviderSwitchEvent = { type: "provider_switched" } & ProviderSwitchInfo;
type FallbackAppliedEvent = { type: "fallback_applied" } & ProviderSwitchInfo;
type CheckpointCreatedEvent = { type: "checkpoint_created"; checkpoint: Checkpoint };
type CheckpointRestoredEvent = { type: "checkpoint_restored"; checkpoint: Checkpoint };
type TaskRewindEvent = { type: "task_rewind"; checkpointId: string; prompt: string };
type BranchForkedEvent = { type: "branch_forked"; checkpointId: string; prompt: string; parentTaskId: string };
export type TaskEvent = AgentSessionEvent | ProviderSwitchEvent | FallbackAppliedEvent | CheckpointCreatedEvent | CheckpointRestoredEvent | TaskRewindEvent | BranchForkedEvent;

export interface RunOptions {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  autoApprove?: boolean;
  onStream?: (text: string) => void;
  onEvent?: (event: TaskEvent) => void;
  taskId?: string;
  checkpoint?: Checkpoint;
  isFork?: boolean;
}

export class TaskRunner {
  private config: DaybreakConfig;
  private safety: SafetyMiddleware;
  private metrics: MetricsCollector;
  private session?: AgentSession;
  private abortedReason?: string;
  private wallClockTimer?: NodeJS.Timeout;
  private onEvent?: (event: TaskEvent) => void;

  private provider?: TracerProvider;
  private tracer?: Tracer;
  private rootSpan?: Span;
  private rootContext?: Context;
  private turnSpan?: Span;
  private turnContext?: Context;
  private compactionSpan?: Span;
  private toolSpans = new Map<string, Span>();
  private taskId?: string;
  private traceId?: string;
  private activeProvider: string;
  private checkpointStore?: CheckpointStore;
  private pendingCheckpoints: Promise<void>[] = [];
  private lastToolCallId?: string;

  constructor(config: DaybreakConfig) {
    this.config = config;
    this.safety = new SafetyMiddleware(config);
    this.metrics = new MetricsCollector(config.llmPricing);
    this.activeProvider = config.llm.provider;
  }

  getTraceId(): string | undefined {
    return this.traceId;
  }

  async run(options: RunOptions): Promise<TaskResult> {
    const { prompt, cwd, systemPrompt, autoApprove, onStream, onEvent, taskId: explicitTaskId, checkpoint, isFork } = options;
    this.onEvent = onEvent;

    const telemetry = initTelemetry({
      taskId: explicitTaskId,
      publicKey: this.config.langfusePublicKey,
      secretKey: this.config.langfuseSecretKey,
      baseUrl: this.config.langfuseBaseUrl,
    });
    this.provider = telemetry.provider;
    this.tracer = telemetry.tracer;
    this.taskId = telemetry.taskId;
    this.traceId = telemetry.traceId;

    const { modelRuntime, model } = await createModelRuntime(
      this.config.llm,
      this.config.llmFallback,
      {
        onProviderSwitch: (info) => {
          this.activeProvider = info.to;
          this.onEvent?.({ type: "fallback_applied", ...info });
          this.onEvent?.({ type: "provider_switched", ...info });
        },
      },
      this.config.llmPricing,
    );

    const taskId = this.taskId ?? randomUUID();
    const useSupabase = this.config.sessionStoreBackend !== "file";
    const sessionStore = new SessionStore({
      taskId,
      cwd,
      supabaseUrl: useSupabase ? this.config.supabaseUrl : undefined,
      supabaseServiceKey: useSupabase ? this.config.supabaseServiceKey : undefined,
    });
    this.checkpointStore = new CheckpointStore({
      taskId,
      cwd,
      sessionStore,
      supabaseUrl: useSupabase ? this.config.supabaseUrl : undefined,
      supabaseServiceKey: useSupabase ? this.config.supabaseServiceKey : undefined,
    });

    const settingsManager = SettingsManager.inMemory(
      {
        compaction: {
          enabled: this.config.compactionEnabled,
          reserveTokens: this.config.compactionReserveTokens,
          keepRecentTokens: this.config.compactionKeepRecentTokens,
        },
        defaultProjectTrust: "always",
      },
      { projectTrusted: true },
    );

    const sessionDir = join(cwd, ".daybreak", "session");
    let sessionManager: SessionManager;
    if (checkpoint) {
      const restoredFile = await sessionStore.restore(checkpoint.sessionRef ?? "", sessionDir);
      sessionManager = SessionManager.open(restoredFile, sessionDir, cwd);
      sessionManager.buildSessionContext();
      this.metrics.setTurns(checkpoint.turn);
      this.metrics.setCostUsd(checkpoint.costUsd ?? 0);
      this.checkpointStore.setLastCheckpointId(checkpoint.id);
      this.onEvent?.({ type: "checkpoint_restored", checkpoint });
      if (isFork) {
        this.onEvent?.({ type: "branch_forked", checkpointId: checkpoint.id, prompt, parentTaskId: checkpoint.taskId });
      } else {
        this.onEvent?.({ type: "task_rewind", checkpointId: checkpoint.id, prompt });
      }
    } else {
      sessionManager = SessionManager.create(cwd, sessionDir);
    }

    const { session } = await createAgentSession({
      modelRuntime,
      model,
      tools: ["read", "bash", "edit", "write", "browser"],
      customTools: [browserTool],
      sessionManager,
      settingsManager,
      cwd,
    });

    if (checkpoint) {
      session.agent.state.messages = sessionManager.buildSessionContext().messages;
    }

    this.session = session;

    if (systemPrompt) {
      this.session.agent.state.systemPrompt = systemPrompt;
    }

    if (autoApprove) {
      this.safety.approveAll();
    }

    this.wireSafety();
    this.wireTelemetry(onEvent);
    this.wireStreaming(onStream);
    this.startWallClockTimer();

    this.rootSpan = this.tracer.startSpan("task");
    this.rootContext = trace.setSpan(context.active(), this.rootSpan);
    this.rootSpan.setAttribute("task.id", this.taskId ?? "unknown");
    this.rootSpan.setAttribute("task.cwd", cwd);

    try {
      await context.with(this.rootContext, async () => {
        await this.session!.prompt(prompt);
        if (!this.abortedReason && this.metrics.current().toolCalls === 0) {
          this.abort("Agent finished without taking any action");
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.abortedReason) {
        console.error(pc.yellow(`\n[run aborted] ${this.abortedReason}`));
      } else {
        this.abort(errorMessage);
        console.error(pc.red(`\n[run error] ${errorMessage}`));
      }
      this.rootSpan?.recordException(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.stopWallClockTimer();
      await this.flushCheckpoints();
      await this.session?.dispose();
      this.endTaskSpans();
    }

    return {
      success: !this.abortedReason,
      summary: "See log for details",
      metrics: this.metrics.finalize(),
      error: this.abortedReason,
      traceId: this.traceId,
      provider: this.activeProvider,
    };
  }

  async shutdown(): Promise<void> {
    await this.flushCheckpoints();
    await closeBrowser();
    await shutdownTelemetry(this.provider);
  }

  private async flushCheckpoints(): Promise<void> {
    await Promise.all(this.pendingCheckpoints);
    this.pendingCheckpoints = [];
    await this.checkpointStore?.flush();
  }

  private wireSafety(): void {
    if (!this.session) return;

    this.session.agent.beforeToolCall = async ({ toolCall, args }) => {
      const check = this.safety.beforeToolCall(toolCall.name, args);
      if (!check.allowed) {
        console.error(pc.red(`[safety block] ${toolCall.name}: ${check.reason}`));
        this.metrics.blockToolCall(toolCall.id, check.reason ?? "safety");
        return { block: true, reason: check.reason };
      }
      return {};
    };
  }

  private wireTelemetry(onEvent?: (event: TaskEvent) => void): void {
    if (!this.session || !this.tracer) return;

    const pendingToolCalls = new Map<string, ToolCallRecord>();

    this.session.subscribe((event: AgentSessionEvent) => {
      onEvent?.(event as TaskEvent);

      switch (event.type) {
        case "turn_start": {
          this.turnSpan?.end();
          this.turnSpan = undefined;
          this.turnContext = undefined;

          this.metrics.recordTurn();
          const current = this.metrics.current();
          if (current.turns >= this.config.maxTurns) {
            this.abort(`Max turns (${this.config.maxTurns}) reached`);
          }
          if (current.estimatedCostUsd >= this.config.maxCostUsd) {
            this.abort(`Max cost $${this.config.maxCostUsd.toFixed(2)} reached`);
          }

          this.lastToolCallId = undefined;

          if (this.rootContext) {
            this.turnSpan = this.tracer!.startSpan("turn", {}, this.rootContext);
            this.turnSpan.setAttribute("turn.number", current.turns);
            this.turnContext = trace.setSpan(this.rootContext, this.turnSpan);
          }
          break;
        }
        case "message_end": {
          this.metrics.recordMessage(event.message);
          this.recordLlmSpan(event.message);
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
          this.startToolSpan(event, record);
          console.log(pc.cyan(`[tool start] ${event.toolName}`), JSON.stringify(event.args).slice(0, 200));
          break;
        }
        case "tool_execution_end": {
          const record = pendingToolCalls.get(event.toolCallId);
          if (record) {
            pendingToolCalls.delete(event.toolCallId);
            this.metrics.endToolCall(event.toolCallId, event.isError);
            this.endToolSpan(event);
            this.lastToolCallId = event.toolCallId;
            console.log(
              pc.cyan(`[tool end] ${record.toolName}`),
              event.isError ? pc.red("ERROR") : pc.green("ok"),
              JSON.stringify(event.result).slice(0, 200),
            );
            if (!this.abortedReason && this.checkpointStore && this.config.checkpointInterval === "tool" && this.session?.sessionManager) {
              const turn = this.metrics.current().turns;
              const costUsd = this.metrics.current().estimatedCostUsd;
              const promise = this.checkpointStore
                .createCheckpoint({ turn, sessionManager: this.session.sessionManager, toolCallId: event.toolCallId, costUsd })
                .then((checkpoint: Checkpoint) => {
                  console.log(pc.blue(`[checkpoint] turn=${checkpoint.turn} tool=${event.toolCallId?.slice(0, 8)} commit=${checkpoint.gitCommit?.slice(0, 7)}`));
                  this.onEvent?.({ type: "checkpoint_created", checkpoint });
                })
                .catch((error: unknown) => {
                  console.error("[checkpoint] create failed:", error instanceof Error ? error.message : String(error));
                });
              this.pendingCheckpoints.push(promise);
            }
          }
          break;
        }
        case "auto_retry_start": {
          console.log(pc.yellow(`[retry start] attempt ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`));
          break;
        }
        case "auto_retry_end": {
          if (event.finalError) {
            console.log(pc.red(`[retry end] final error after ${event.attempt} attempts: ${event.finalError}`));
            this.abort(`Model retries exhausted: ${event.finalError}`);
          } else {
            console.log(pc.green(`[retry end] recovered after ${event.attempt} attempts`));
          }
          break;
        }
        case "agent_end": {
          console.log(pc.yellow(`[agent end] willRetry=${event.willRetry}`));
          this.turnSpan?.end();
          this.turnSpan = undefined;
          this.turnContext = undefined;

          if (!this.abortedReason && this.checkpointStore && this.config.checkpointInterval !== "tool" && this.session?.sessionManager) {
            const turn = this.metrics.current().turns;
            const costUsd = this.metrics.current().estimatedCostUsd;
            const toolCallId = this.lastToolCallId;
            const promise = this.checkpointStore
              .createCheckpoint({
                turn,
                sessionManager: this.session.sessionManager,
                toolCallId,
                costUsd,
              })
              .then((checkpoint: Checkpoint) => {
                console.log(pc.blue(`[checkpoint] turn=${checkpoint.turn} commit=${checkpoint.gitCommit?.slice(0, 7)}`));
                this.onEvent?.({ type: "checkpoint_created", checkpoint });
              })
              .catch((error: unknown) => {
                console.error("[checkpoint] create failed:", error instanceof Error ? error.message : String(error));
              });
            this.pendingCheckpoints.push(promise);
          }
          break;
        }
        case "compaction_start": {
          console.log(pc.yellow(`[compaction start] reason=${event.reason}`));
          if (this.rootContext) {
            this.compactionSpan = this.tracer!.startSpan("compaction", {}, this.rootContext);
          }
          break;
        }
        case "compaction_end": {
          if (this.compactionSpan) {
            if (event.aborted) {
              this.compactionSpan.setStatus({ code: SpanStatusCode.ERROR, message: "aborted" });
            }
            this.compactionSpan.end();
            this.compactionSpan = undefined;
          }
          if (event.aborted) {
            console.log(pc.red(`[compaction end] aborted`));
          } else if (event.result) {
            console.log(pc.green(`[compaction end] tokensBefore=${event.result.tokensBefore} firstKeptEntry=${event.result.firstKeptEntryId}`));
          } else {
            console.log(pc.yellow(`[compaction end] no compaction needed`));
          }
          break;
        }
      }
    });
  }

  private recordLlmSpan(message: AgentMessage): void {
    if (!this.tracer) return;
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    const usage = assistant.usage;
    const parent = this.turnContext ?? this.rootContext;
    if (!parent) return;

    const span = this.tracer.startSpan("llm", {}, parent);
    span.setAttribute("gen_ai.operation.name", "chat");
    span.setAttribute("gen_ai.provider.name", assistant.provider ?? this.config.llm.provider);
    span.setAttribute("gen_ai.system", assistant.provider ?? this.config.llm.provider);
    span.setAttribute("gen_ai.request.model", assistant.model ?? this.config.llm.modelId);
    span.setAttribute("gen_ai.response.model", assistant.model ?? this.config.llm.modelId);
    if (usage) {
      span.setAttribute("gen_ai.usage.input_tokens", usage.input ?? 0);
      span.setAttribute("gen_ai.usage.output_tokens", usage.output ?? 0);
      span.setAttribute("gen_ai.usage.total_tokens", usage.totalTokens ?? 0);
      if (usage.cost?.total !== undefined) {
        span.setAttribute("gen_ai.usage.cost", usage.cost.total);
      }
    }
    span.end();
  }

  private startToolSpan(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>, record: ToolCallRecord): void {
    if (!this.tracer) return;
    const parent = this.turnContext ?? this.rootContext;
    if (!parent) return;

    const span = this.tracer.startSpan(`tool:${event.toolName}`, {}, parent);
    span.setAttribute("tool.name", event.toolName);
    span.setAttribute("tool.call_id", event.toolCallId);
    try {
      span.setAttribute("tool.args", JSON.stringify(event.args).slice(0, 2000));
    } catch {
      span.setAttribute("tool.args", "<unserializable>");
    }
    span.setAttribute("tool.started_at", record.startedAt);
    this.toolSpans.set(event.toolCallId, span);
  }

  private endToolSpan(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
    const span = this.toolSpans.get(event.toolCallId);
    if (!span) return;
    this.toolSpans.delete(event.toolCallId);

    if (event.isError) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    try {
      span.setAttribute("tool.result", JSON.stringify(event.result).slice(0, 2000));
    } catch {
      span.setAttribute("tool.result", "<unserializable>");
    }
    span.end();
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

  private endTaskSpans(): void {
    this.turnSpan?.end();
    this.turnSpan = undefined;
    this.turnContext = undefined;

    this.compactionSpan?.end();
    this.compactionSpan = undefined;

    for (const span of this.toolSpans.values()) {
      span.end();
    }
    this.toolSpans.clear();

    if (this.rootSpan) {
      if (this.abortedReason) {
        this.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: this.abortedReason });
      }
      this.rootSpan.setAttribute("task.status", this.abortedReason ? "aborted" : "complete");
      this.rootSpan.end();
      this.rootSpan = undefined;
    }
  }

  private abort(reason: string): void {
    if (this.abortedReason) return;
    this.abortedReason = reason;
    this.session?.abort().catch(() => {});
  }
}
