import type { StreamEvent, TaskMetrics } from "./types.js";

export function formatEvent(event: StreamEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  if (event.type === "task_start") {
    const data = event.data as { repo?: string; branch?: string };
    return `[${time}] task_start: ${data.repo} @ ${data.branch}`;
  }
  if (event.type === "task_pending") {
    const data = event.data as { repo?: string; branch?: string };
    return `[${time}] task_pending: ${data.repo} @ ${data.branch}`;
  }
  if (event.type === "task_cancelled") {
    return `[${time}] task_cancelled`;
  }
  if (event.type === "message_update") {
    const data = event.data as { kind?: string; delta?: string };
    if (data.delta) return data.delta;
    return `[${time}] message_update: ${data.kind || ""}`;
  }
  if (event.type === "tool_execution_start") {
    const data = event.data as { toolName?: string; args?: unknown };
    return `[${time}] ▶ ${data.toolName} ${data.args ? JSON.stringify(data.args) : ""}`;
  }
  if (event.type === "tool_execution_end") {
    const data = event.data as { toolName?: string; isError?: boolean; result?: unknown };
    const prefix = data.isError ? "✗" : "✓";
    return `[${time}] ${prefix} ${data.toolName} ${data.result ? JSON.stringify(data.result).slice(0, 240) : ""}`;
  }
  if (event.type === "browser_screenshot") {
    const data = event.data as { url?: string };
    return `[${time}] browser_screenshot: ${data.url || ""}`;
  }
  if (event.type === "compaction_start") {
    const data = event.data as { reason?: string };
    return `[${time}] compaction_start: ${data.reason || ""}`;
  }
  if (event.type === "compaction_advised") {
    const data = event.data as { tokens?: number; contextWindow?: number; reserveTokens?: number };
    return `[${time}] compaction_advised: ${data.tokens ?? "-"} / ${data.contextWindow ?? "-"} tokens (reserve ${data.reserveTokens ?? "-"})`;
  }
  if (event.type === "compaction_end") {
    const data = event.data as { aborted?: boolean; tokensBefore?: number; firstKeptEntryId?: string };
    return `[${time}] compaction_end: ${data.aborted ? "aborted" : `tokensBefore=${data.tokensBefore}, firstKept=${data.firstKeptEntryId}`}`;
  }
  if (event.type === "file_too_large") {
    const data = event.data as { path?: string; size?: number; maxBytes?: number; maxLines?: number; reason?: string };
    return `[${time}] file_too_large: ${data.path ?? "-"} ${data.reason ?? ""} (max ${data.maxBytes ?? "-"}B / ${data.maxLines ?? "-"} lines)`;
  }
  if (event.type === "provider_switched" || event.type === "fallback_applied") {
    const data = event.data as { from?: string; to?: string; reason?: string; modelId?: string };
    return `[${time}] ${event.type}: ${data.from} → ${data.to} (${data.reason}) model=${data.modelId || "-"}`;
  }
  if (event.type === "task_complete" || event.type === "task_failed") {
    const data = event.data as { success?: boolean; error?: string; provider?: string; metrics?: { estimatedCostUsd?: number } };
    const cost = typeof data.metrics?.estimatedCostUsd === "number" ? ` cost=$${data.metrics.estimatedCostUsd.toFixed(4)}` : "";
    const provider = data.provider ? ` provider=${data.provider}` : "";
    return `[${time}] ${event.type}${provider}${cost}${data.error ? ": " + data.error : ""}`;
  }
  if (event.type === "sandbox_created" || event.type === "sandbox_resumed" || event.type === "sandbox_keep_alive") {
    const data = event.data as { sandboxId?: string; keepAliveUntil?: number; isReview?: boolean; isHeal?: boolean };
    const until = data.keepAliveUntil ? ` until ${new Date(data.keepAliveUntil).toLocaleTimeString()}` : "";
    return `[${time}] ${event.type}: sandbox=${data.sandboxId || "-"}${until}${data.isReview ? " review" : ""}${data.isHeal ? " heal" : ""}`;
  }
  if (event.type === "review_task_start") {
    const data = event.data as { sandboxId?: string; prBranch?: string };
    return `[${time}] review_task_start: prBranch=${data.prBranch || "-"} sandbox=${data.sandboxId || "-"}`;
  }
  if (event.type === "review_complete" || event.type === "review_failed") {
    const data = event.data as { success?: boolean; summary?: string; error?: string };
    return `[${time}] ${event.type}: ${data.success ? "success" : "failed"}${data.summary ? " " + data.summary.slice(0, 120) : ""}${data.error ? ": " + data.error : ""}`;
  }
  if (event.type === "ci_failure_received") {
    const data = event.data as { checkName?: string; headBranch?: string; headSha?: string; prNumber?: number; repo?: string; repoUrl?: string; healAttempt?: number };
    return `[${time}] ci_failure_received: '${data.checkName || "-"}' failed on PR #${data.prNumber ?? "-"} (${data.headBranch || "-"}, ${(data.headSha ?? "").slice(0, 7)})${data.healAttempt ? ` attempt ${data.healAttempt}` : ""}`;
  }
  if (event.type === "ci_logs_fetched") {
    const data = event.data as { annotationsCount?: number; logBytes?: number; errorContextLength?: number; checkRunId?: string };
    return `[${time}] ci_logs_fetched: annotations=${data.annotationsCount ?? 0} logBytes=${data.logBytes ?? 0} errorContext=${data.errorContextLength ?? 0}B`;
  }
  if (event.type === "heal_task_start") {
    const data = event.data as { sandboxId?: string; prBranch?: string; taskId?: string };
    return `[${time}] heal_task_start: prBranch=${data.prBranch || "-"} sandbox=${data.sandboxId || "-"} task=${data.taskId ?? event.taskId}`;
  }
  if (event.type === "heal_complete" || event.type === "heal_failed" || event.type === "heal_skipped") {
    const data = event.data as { success?: boolean; error?: string; reason?: string };
    return `[${time}] ${event.type}: ${data.reason ?? (data.success ? "success" : data.error ?? "failed")}`;
  }
  if (event.type === "checkpoint_created") {
    const data = event.data as { turn?: number; checkpointId?: string; gitCommit?: string; costUsd?: number };
    const cost = typeof data.costUsd === "number" ? ` cost=$${data.costUsd.toFixed(4)}` : "";
    return `[${time}] checkpoint_created: turn=${data.turn ?? "-"} commit=${(data.gitCommit ?? "").slice(0, 7)} checkpoint=${data.checkpointId ?? "-"}${cost}`;
  }
  if (event.type === "checkpoint_restored") {
    const data = event.data as { turn?: number; checkpointId?: string; gitCommit?: string; sessionRef?: string };
    return `[${time}] checkpoint_restored: turn=${data.turn ?? "-"} commit=${(data.gitCommit ?? "").slice(0, 7)} checkpoint=${data.checkpointId ?? "-"}`;
  }
  if (event.type === "task_rewind") {
    const data = event.data as { checkpointId?: string; prompt?: string };
    return `[${time}] task_rewind: checkpoint=${data.checkpointId ?? "-"} prompt=${(data.prompt ?? "").slice(0, 80)}`;
  }
  if (event.type === "branch_forked") {
    const data = event.data as { checkpointId?: string; prompt?: string; parentTaskId?: string; childTaskId?: string };
    return `[${time}] branch_forked: parent=${data.parentTaskId ?? "-"} checkpoint=${data.checkpointId ?? "-"} child=${data.childTaskId?.slice(0, 8) ?? "-"} prompt=${(data.prompt ?? "").slice(0, 80)}`;
  }
  if (event.type === "sandbox_killed") {
    const data = event.data as { sandboxId?: string; killed?: boolean };
    return `[${time}] sandbox_killed: sandbox=${data.sandboxId ?? "-"} killed=${data.killed ?? "-"}`;
  }
  if (event.type === "branch_promoted") {
    const data = event.data as { childTaskId?: string; prUrl?: string };
    return `[${time}] branch_promoted: child=${data.childTaskId?.slice(0, 8) ?? "-"} pr=${data.prUrl || "-"}`;
  }
  if (event.type === "branch_abandoned") {
    const data = event.data as { childTaskId?: string };
    return `[${time}] branch_abandoned: child=${data.childTaskId?.slice(0, 8) ?? "-"}`;
  }
  if (event.type === "budget_exceeded" || event.type === "rate_limited" || event.type === "budget_deferred") {
    const data = event.data as { reason?: string };
    return `[${time}] ${event.type}: ${data.reason || ""}`;
  }
  if (event.type === "circuit_breaker_triggered") {
    const data = event.data as { reason?: string; limit?: number; current?: number };
    return `[${time}] circuit_breaker: ${data.reason || ""} (limit ${data.limit ?? "-"}, current ${data.current ?? "-"})`;
  }
  if (event.type === "cost_alert") {
    const data = event.data as { current: number; limit: number; threshold: number };
    return `[${time}] cost_alert: ${data.current ? `$${data.current.toFixed(4)}` : "-"} / $${data.limit} (threshold ${data.threshold})`;
  }
  if (event.type === "commit_pushed") {
    const data = event.data as { prBranch?: string };
    return `[${time}] commit_pushed: ${data.prBranch || "-"}`;
  }
  if (event.type === "pr_created") {
    const data = event.data as { prUrl?: string; prNumber?: number; prBranch?: string };
    return `[${time}] pr_created: #${data.prNumber ?? "-"} ${data.prBranch || "-"} → ${data.prUrl || "-"}`;
  }
  return `[${time}] ${event.type}: ${JSON.stringify(event.data).slice(0, 200)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCost(cost: number | undefined): string {
  if (typeof cost !== "number") return "-";
  return `$${cost.toFixed(4)}`;
}

export function statusBadgeVariant(status: string): "default" | "success" | "warning" | "danger" | "info" | "secondary" {
  if (status === "complete" || status === "promoted") return "success";
  if (status === "running" || status === "starting") return "warning";
  if (status === "failed") return "danger";
  if (status === "pending") return "info";
  return "secondary";
}
