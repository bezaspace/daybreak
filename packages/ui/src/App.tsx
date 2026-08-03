import { useEffect, useRef, useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { Button } from "./components/base/Button.js";
import { Input } from "./components/base/Input.js";
import { Label } from "./components/base/Label.js";
import { Select } from "./components/base/Select.js";
import { Badge } from "./components/base/Badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./components/base/Card.js";
import { Sidebar, type ViewId } from "./components/Sidebar.js";
import { CostDashboard } from "./CostDashboard.js";
import { TraceView } from "./TraceView.js";
import { TimeTravelView } from "./TimeTravelView.js";
import { CiHealView } from "./CiHealView.js";
import { DeadLetterView } from "./DeadLetterView.js";
import { CleanupView } from "./CleanupView.js";
import type { Config, QueueStatus, Screenshot, StreamEvent, Task, TaskMetrics } from "./lib/types.js";

function formatEvent(event: StreamEvent): string {
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

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getInitialTaskId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("taskId");
}

function getInitialView(): ViewId {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const valid: ViewId[] = ["run", "tasks", "trace", "time-travel", "costs", "ci-heal", "dead-letter", "cleanup"];
  return valid.includes(view as ViewId) ? (view as ViewId) : "run";
}

function updateUrl(view: ViewId, taskId: string | null) {
  const params = new URLSearchParams();
  if (view !== "run") params.set("view", view);
  if (taskId) params.set("taskId", taskId);
  const qs = params.toString();
  window.history.replaceState({}, "", qs ? `?${qs}` : window.location.pathname);
}

function statusBadgeVariant(status: string): "default" | "success" | "warning" | "danger" | "info" | "secondary" {
  if (status === "complete" || status === "promoted") return "success";
  if (status === "running" || status === "starting") return "warning";
  if (status === "failed") return "danger";
  if (status === "pending") return "info";
  return "secondary";
}

export function App() {
  const [repo, setRepo] = useState("https://github.com/bezaspace/daybreak-target");
  const [branch, setBranch] = useState("main");
  const [taskId, setTaskId] = useState<string | null>(getInitialTaskId());
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prBranch, setPrBranch] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [metrics, setMetrics] = useState<TaskMetrics | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [costAlert, setCostAlert] = useState<{ current: number; limit: number; threshold: number } | null>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<ViewId>(getInitialView());
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState("operator");
  const [userId, setUserId] = useState("");

  function tenantHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (tenantId) headers["X-Daybreak-Tenant-Id"] = tenantId;
    if (role) headers["X-Daybreak-Role"] = role;
    if (userId) headers["X-Daybreak-User-Id"] = userId;
    return headers;
  }

  function loadTasks() {
    fetch("/api/tasks", { headers: tenantHeaders() })
      .then((r) => r.json())
      .then((data) => setTasks(Array.isArray(data) ? data : []))
      .catch(() => {});
  }

  function loadConfig() {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setConfig(data as Config))
      .catch(() => {});
  }

  function loadQueueStatus() {
    fetch("/api/queue/status")
      .then((r) => r.json())
      .then((data) => setQueueStatus(data as QueueStatus))
      .catch(() => {});
  }

  useEffect(() => {
    loadTasks();
    loadConfig();
    loadQueueStatus();
    const interval = setInterval(() => {
      loadTasks();
      loadQueueStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const selectedTask = taskId ? tasks.find((t) => t.id === taskId) : undefined;

  useEffect(() => {
    if (!taskId) return;
    setEvents([]);
    setStatus("running");
    setPrUrl(null);
    setPrBranch(null);
    setScreenshots([]);
    setMetrics(null);
    setCostAlert(null);

    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.onmessage = (message) => {
      if (!message.data) return;
      try {
        const event = JSON.parse(message.data) as StreamEvent;
        setEvents((prev) => [...prev, event]);
        if (event.type === "browser_screenshot") {
          const data = event.data as { screenshot?: string; url?: string; mimeType?: string };
          if (data.screenshot) {
            const mimeType = data.mimeType || "image/png";
            setScreenshots((prev) => [
              ...prev,
              { dataUrl: `data:${mimeType};base64,${data.screenshot}`, url: data.url, timestamp: event.timestamp },
            ]);
          }
        }
        if (event.type === "pr_created") {
          const data = event.data as { prUrl?: string; prBranch?: string };
          if (data.prUrl) {
            setPrUrl(data.prUrl);
            setPrBranch(data.prBranch || null);
            loadTasks();
            es.close();
          }
        }
        if (event.type === "task_complete") {
          setStatus("complete");
          const data = event.data as { metrics?: TaskMetrics; provider?: string; traceId?: string };
          if (data.metrics) setMetrics(data.metrics);
          if (data.provider) setActiveProvider(data.provider);
          if (data.traceId) loadTasks();
        }
        if (event.type === "task_failed") {
          setStatus("failed");
          const data = event.data as { metrics?: TaskMetrics; error?: string; provider?: string };
          if (data.metrics) setMetrics(data.metrics);
          if (data.provider) setActiveProvider(data.provider);
        }
        if (event.type === "cost_alert") {
          const data = event.data as { current: number; limit: number; threshold: number };
          setCostAlert(data);
        }
      } catch {
        // ignore heartbeat or malformed
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect; terminal improvements are in Milestone 2
    };

    return () => {
      es.close();
    };
  }, [taskId]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    updateUrl(view, taskId);
  }, [view, taskId]);

  async function startTask(options?: { maxTurns?: number; maxCostUsd?: number; maxWallClockMinutes?: number }) {
    setStatus("starting");
    const body: Record<string, unknown> = { repo, branch };
    if (options?.maxTurns !== undefined) body.maxTurns = options.maxTurns;
    if (options?.maxCostUsd !== undefined) body.maxCostUsd = options.maxCostUsd;
    if (options?.maxWallClockMinutes !== undefined) body.maxWallClockMinutes = options.maxWallClockMinutes;
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenantHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.taskId) {
      setTaskId(data.taskId);
      setView("run");
    } else {
      setStatus("error: " + (data.error || "unknown"));
    }
  }

  async function cancelTask(id: string) {
    await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
    loadTasks();
    loadQueueStatus();
  }

  function startFailingSumDemo() {
    setRepo("https://github.com/bezaspace/daybreak-target");
    setBranch("main");
    setTimeout(() => startTask(), 0);
  }

  function startMaxTurnsDemo() {
    setRepo("https://github.com/bezaspace/daybreak-target");
    setBranch("main");
    setTimeout(() => startTask({ maxTurns: 3 }), 0);
  }

  function navigate(next: ViewId) {
    setView(next);
    if (next === "run" && !taskId) {
      // keep taskId null
    }
  }

  const isRunning = status === "starting" || status === "running";

  return (
    <div className="flex h-full bg-db-page">
      <Sidebar active={view} onNavigate={navigate} taskId={taskId} />
      <main className="flex-1 overflow-y-auto pl-60">
        <div className="mx-auto max-w-6xl p-6">
          {config && (
            <div className="mb-4 text-xs text-db-text-secondary">
              Circuit breakers: {config.maxTurns} turns · {config.maxWallClockMinutes} min · ${config.maxCostUsd} ·
              compaction {config.compactionEnabled ? "on" : "off"}
              {config.e2bTemplate ? ` · template ${config.e2bTemplate}` : ""} · max concurrency {config.maxConcurrentTasks}
              · cleanup {config.cleanupEnabled ? "on" : "off"} ({config.branchTtlDays}d / {config.sandboxIdleTtlMinutes}m / {config.dataRetentionDays}d)
            </div>
          )}
          {queueStatus && (
            <div className="mb-4 text-xs text-db-text-secondary">
              Queue: {queueStatus.pending} pending · {queueStatus.running} running · limit {queueStatus.maxConcurrent} · worker{" "}
              {queueStatus.workerEnabled ? "on" : "off"}
            </div>
          )}

          {view === "run" && (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                <Button onClick={startFailingSumDemo} disabled={isRunning} variant="secondary">
                  <Play className="h-4 w-4" />
                  Fix failing-sum test
                </Button>
                <Button onClick={startMaxTurnsDemo} disabled={isRunning} variant="outline">
                  Demo MAX_TURNS=3 (should fail)
                </Button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  startTask();
                }}
                className="mb-4 flex flex-wrap items-end gap-2"
              >
                <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
                  <Label htmlFor="repo">Repo URL</Label>
                  <Input id="repo" type="text" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Repo URL" />
                </div>
                <div className="flex w-32 flex-col gap-1.5">
                  <Label htmlFor="branch">Branch</Label>
                  <Input id="branch" type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch" />
                </div>
                <Button type="submit" disabled={isRunning}>
                  {isRunning ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Starting…
                    </>
                  ) : (
                    "Run task"
                  )}
                </Button>
              </form>

              <div className="mb-4 flex flex-wrap items-end gap-2">
                <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
                  <Label htmlFor="tenantId">Tenant ID (optional)</Label>
                  <Input
                    id="tenantId"
                    type="text"
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    placeholder="Tenant ID (optional)"
                  />
                </div>
                <div className="flex w-40 flex-col gap-1.5">
                  <Label>Role</Label>
                  <Select
                    value={role}
                    onValueChange={(value) => setRole(value ?? "operator")}
                    options={[
                      { value: "operator", label: "operator" },
                      { value: "viewer", label: "viewer" },
                      { value: "admin", label: "admin" },
                    ]}
                  />
                </div>
                <div className="flex min-w-[10rem] flex-1 flex-col gap-1.5">
                  <Label htmlFor="userId">User ID (optional)</Label>
                  <Input id="userId" type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="User ID (optional)" />
                </div>
              </div>

              {taskId && (
                <div className="mb-4 flex items-center gap-2 text-sm text-db-text-secondary">
                  <span>Task:</span>
                  <code className="rounded bg-db-elevated px-1.5 py-0.5 text-xs text-db-text">{taskId}</code>
                  <span>· Status:</span>
                  <Badge variant={statusBadgeVariant(status)}>{status}</Badge>
                  {prBranch && <span>· branch: {prBranch}</span>}
                  {prUrl && (
                    <span>
                      ·{" "}
                      <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-db-accent hover:text-db-accent-hover underline">
                        View PR
                      </a>
                    </span>
                  )}
                </div>
              )}

              {metrics && (
                <Card className="mb-4">
                  <CardHeader>
                    <CardTitle>Metrics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    turns {metrics.turns ?? "-"} · tool calls {metrics.toolCalls ?? "-"}
                    {metrics.blockedToolCalls ? ` · blocked ${metrics.blockedToolCalls}` : ""} · tokens {metrics.totalTokens ?? "-"} · cost{" "}
                    {typeof metrics.estimatedCostUsd === "number" ? `$${metrics.estimatedCostUsd.toFixed(4)}` : "-"} · wall-clock{" "}
                    {formatDuration(metrics.wallClockMs)}
                    {activeProvider ? ` · provider: ${activeProvider}` : ""}
                    {config?.provider && activeProvider && config.provider !== activeProvider ? " (fallback)" : ""}
                  </CardContent>
                </Card>
              )}

              {costAlert && (
                <Card className="mb-4 border-db-warning/30 bg-db-warning/5">
                  <CardContent>
                    <span className="font-semibold text-db-warning">Cost alert</span>: ${costAlert.current.toFixed(4)} / ${costAlert.limit} (threshold{" "}
                    {costAlert.threshold})
                  </CardContent>
                </Card>
              )}

              {screenshots.length > 0 && (
                <div className="mb-4 space-y-4">
                  {screenshots.map((s, i) => (
                    <div key={i}>
                      <img
                        src={s.dataUrl}
                        alt={`Screenshot ${i + 1}${s.url ? ` of ${s.url}` : ""}`}
                        className="max-w-full rounded border border-db-border"
                      />
                      <div className="mt-1 text-xs text-db-text-secondary">{s.url || "Browser screenshot"}</div>
                    </div>
                  ))}
                </div>
              )}

              <pre
                ref={terminalRef}
                className="mb-6 h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg border border-db-border bg-black p-4 font-mono text-sm leading-relaxed text-green-400 scrollbar-thin"
              >
                {events.map((ev) => formatEvent(ev)).join("\n")}
              </pre>

              <h2 className="mb-3 text-lg font-semibold text-db-text">Recent tasks</h2>
              <ul className="space-y-2">
                {tasks.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-md border border-db-border bg-db-surface p-3 text-sm text-db-text-secondary transition-colors hover:bg-db-subtle"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-db-elevated px-1.5 py-0.5 text-xs text-db-text">{t.id}</code>
                      <span>
                        {t.repo} @ {t.branch}
                      </span>
                      <Badge variant={statusBadgeVariant(t.status)}>{t.status}</Badge>
                      {t.triggerSource ? <span>· {t.triggerSource}</span> : null}
                      {t.triggerSource === "check_run"
                        ? ` · heal of ${t.prBranch || "-"}${typeof t.prNumber === "number" ? ` #${t.prNumber}` : ""}${t.headSha ? ` · ${t.headSha.slice(0, 7)}` : ""}`
                        : t.parentTaskId
                          ? ` · branch of ${t.parentTaskId.slice(0, 8)}`
                          : t.prBranch
                            ? ` · ${t.prBranch}`
                            : ""}
                      {t.healAttempt ? ` · attempt ${t.healAttempt}` : ""}
                      {t.provider ? ` · ${t.provider}` : ""}
                      {typeof t.costUsd === "number" ? ` · $${t.costUsd.toFixed(4)}` : ""}
                      {t.prUrl && (
                        <span>
                          ·{" "}
                          <a href={t.prUrl} target="_blank" rel="noopener noreferrer" className="text-db-accent hover:text-db-accent-hover underline">
                            PR
                          </a>
                        </span>
                      )}
                      {t.status === "pending" && (
                        <Button size="sm" variant="ghost" onClick={() => cancelTask(t.id)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {view === "tasks" && (
            <Card>
              <CardHeader>
                <CardTitle>Tasks</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-db-text-secondary">Full task list with search, filters, and detail view is planned in Milestone 1.</p>
                <p className="mt-2 text-db-text-tertiary">Use the Recent tasks list on the Run page as a temporary workaround.</p>
              </CardContent>
            </Card>
          )}

          {view === "trace" && taskId && selectedTask?.traceId && (
            <TraceView
              taskId={taskId}
              traceId={selectedTask.traceId}
              provider={selectedTask.provider}
              costUsd={selectedTask.costUsd}
            />
          )}
          {view === "trace" && taskId && !selectedTask?.traceId && (
            <Card><CardContent>No trace available for this task.</CardContent></Card>
          )}
          {view === "trace" && !taskId && (
            <Card><CardContent>Select a task on the Run page to view its trace.</CardContent></Card>
          )}

          {view === "time-travel" && taskId && <TimeTravelView taskId={taskId} />}
          {view === "time-travel" && !taskId && (
            <Card><CardContent>Select a task on the Run page to explore checkpoints.</CardContent></Card>
          )}

          {view === "costs" && <CostDashboard />}

          {view === "ci-heal" && <CiHealView tasks={tasks} />}

          {view === "dead-letter" && <DeadLetterView />}

          {view === "cleanup" && <CleanupView />}
        </div>
      </main>
    </div>
  );
}
