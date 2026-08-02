import { useEffect, useRef, useState } from "react";
import { CostDashboard } from "./CostDashboard.js";
import { TraceView } from "./TraceView.js";

interface StreamEvent {
  id: string;
  type: string;
  timestamp: number;
  taskId: string;
  data: unknown;
}

interface Task {
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
}

interface Screenshot {
  dataUrl: string;
  url?: string;
  timestamp: number;
}

interface Config {
  maxTurns: number;
  maxWallClockMinutes: number;
  maxCostUsd: number;
  compactionEnabled: boolean;
  e2bTemplate?: string;
  provider?: string;
}

interface TaskMetrics {
  turns?: number;
  toolCalls?: number;
  blockedToolCalls?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  wallClockMs?: number;
}

function formatEvent(event: StreamEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  if (event.type === "task_start") {
    const data = event.data as { repo?: string; branch?: string };
    return `[${time}] task_start: ${data.repo} @ ${data.branch}`;
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
  if (event.type === "compaction_end") {
    const data = event.data as { aborted?: boolean; tokensBefore?: number; firstKeptEntryId?: string };
    return `[${time}] compaction_end: ${data.aborted ? "aborted" : `tokensBefore=${data.tokensBefore}, firstKept=${data.firstKeptEntryId}`}`;
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
    const data = event.data as { sandboxId?: string; keepAliveUntil?: number; isReview?: boolean };
    const until = data.keepAliveUntil ? ` until ${new Date(data.keepAliveUntil).toLocaleTimeString()}` : "";
    return `[${time}] ${event.type}: sandbox=${data.sandboxId || "-"}${until}${data.isReview ? " review" : ""}`;
  }
  if (event.type === "review_task_start") {
    const data = event.data as { sandboxId?: string; prBranch?: string };
    return `[${time}] review_task_start: prBranch=${data.prBranch || "-"} sandbox=${data.sandboxId || "-"}`;
  }
  if (event.type === "review_complete" || event.type === "review_failed") {
    const data = event.data as { success?: boolean; summary?: string; error?: string };
    return `[${time}] ${event.type}: ${data.success ? "success" : "failed"}${data.summary ? " " + data.summary.slice(0, 120) : ""}${data.error ? ": " + data.error : ""}`;
  }
  if (event.type === "checkpoint_created") {
    const data = event.data as { turn?: number; checkpointId?: string; gitCommit?: string; costUsd?: number };
    const cost = typeof data.costUsd === "number" ? ` cost=$${data.costUsd.toFixed(4)}` : "";
    return `[${time}] checkpoint_created: turn=${data.turn ?? "-"} commit=${(data.gitCommit ?? "").slice(0, 7)} checkpoint=${data.checkpointId ?? "-"}${cost}`;
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
  const terminalRef = useRef<HTMLPreElement>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<"run" | "trace" | "costs">("run");

  function loadTasks() {
    fetch("/api/tasks")
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

  useEffect(() => {
    loadTasks();
    loadConfig();
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
              {
                dataUrl: `data:${mimeType};base64,${data.screenshot}`,
                url: data.url,
                timestamp: event.timestamp,
              },
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
      } catch {
        // ignore heartbeat or malformed
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect; if terminal, close after a delay
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

  async function startTask(options?: { maxTurns?: number; maxCostUsd?: number; maxWallClockMinutes?: number }) {
    setStatus("starting");
    const body: Record<string, unknown> = { repo, branch };
    if (options?.maxTurns !== undefined) body.maxTurns = options.maxTurns;
    if (options?.maxCostUsd !== undefined) body.maxCostUsd = options.maxCostUsd;
    if (options?.maxWallClockMinutes !== undefined) body.maxWallClockMinutes = options.maxWallClockMinutes;
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.taskId) {
      setTaskId(data.taskId);
      window.history.replaceState({}, "", `?taskId=${data.taskId}`);
    } else {
      setStatus("error: " + (data.error || "unknown"));
    }
  }

  function startFailingSumDemo() {
    setRepo("https://github.com/bezaspace/daybreak-target");
    setBranch("main");
    // Use a microtask so state updates before the fetch
    setTimeout(() => startTask(), 0);
  }

  function startMaxTurnsDemo() {
    setRepo("https://github.com/bezaspace/daybreak-target");
    setBranch("main");
    setTimeout(() => startTask({ maxTurns: 3 }), 0);
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 960, margin: "0 auto" }}>
      <h1>Daybreak</h1>

      {config && (
        <div style={{ color: "#666", fontSize: 14, marginBottom: "1rem" }}>
          Circuit breakers: {config.maxTurns} turns · {config.maxWallClockMinutes} min · ${config.maxCostUsd} ·
          compaction {config.compactionEnabled ? "on" : "off"}
          {config.e2bTemplate ? ` · template ${config.e2bTemplate}` : ""}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <button type="button" onClick={startFailingSumDemo} disabled={status === "starting" || status === "running"} style={{ padding: "0.5rem 1rem" }}>
          Fix failing-sum test
        </button>
        <button type="button" onClick={startMaxTurnsDemo} disabled={status === "starting" || status === "running"} style={{ padding: "0.5rem 1rem" }}>
          Demo MAX_TURNS=3 (should fail)
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTask();
        }}
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}
      >
        <input
          type="text"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="Repo URL"
          style={{ flex: 1, minWidth: 300, padding: "0.5rem" }}
        />
        <input
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Branch"
          style={{ width: 120, padding: "0.5rem" }}
        />
        <button type="submit" disabled={status === "starting" || status === "running"} style={{ padding: "0.5rem 1rem" }}>
          {status === "starting" ? "Starting..." : "Run task"}
        </button>
      </form>

      {taskId && (
        <p style={{ color: "#666" }}>
          Task: <code>{taskId}</code> · Status: <strong>{status}</strong>
          {prBranch && ` · branch: ${prBranch}`}
          {prUrl && (
            <span>
              {" · "}
              <a href={prUrl} target="_blank" rel="noopener noreferrer">
                View PR
              </a>
            </span>
          )}
        </p>
      )}

      {metrics && (
        <div style={{ background: "#f6f6f6", padding: "1rem", borderRadius: 8, marginBottom: "1rem" }}>
          <strong>Metrics</strong>: turns {metrics.turns ?? "-"} · tool calls {metrics.toolCalls ?? "-"}
          {metrics.blockedToolCalls ? ` · blocked ${metrics.blockedToolCalls}` : ""} · tokens {metrics.totalTokens ?? "-"} · cost{" "}
          {typeof metrics.estimatedCostUsd === "number" ? `$${metrics.estimatedCostUsd.toFixed(4)}` : "-"} · wall-clock {formatDuration(metrics.wallClockMs)}
          {activeProvider ? ` · provider: ${activeProvider}` : ""}
          {config?.provider && activeProvider && config.provider !== activeProvider ? " (fallback)" : ""}
        </div>
      )}

      {taskId && (
        <div style={{ marginBottom: "1rem" }}>
          <button type="button" disabled={view === "run"} onClick={() => setView("run")} style={{ marginRight: 8 }}>
            Run
          </button>
          <button type="button" disabled={view === "trace"} onClick={() => setView("trace")} style={{ marginRight: 8 }}>
            Trace
          </button>
          <button type="button" disabled={view === "costs"} onClick={() => setView("costs")}>
            Costs
          </button>
        </div>
      )}

      {view === "trace" && taskId && selectedTask?.traceId && (
        <TraceView
          taskId={taskId}
          traceId={selectedTask.traceId}
          provider={selectedTask.provider}
          costUsd={selectedTask.costUsd}
        />
      )}
      {view === "trace" && taskId && !selectedTask?.traceId && <p>No trace available for this task.</p>}

      {view === "costs" && <CostDashboard />}

      {view !== "run" ? null : screenshots.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          {screenshots.map((s, i) => (
            <div key={i} style={{ marginBottom: "1rem" }}>
              <img
                src={s.dataUrl}
                alt={`Screenshot ${i + 1}${s.url ? ` of ${s.url}` : ""}`}
                style={{ maxWidth: "100%", border: "1px solid #ccc", borderRadius: 8 }}
              />
              <div style={{ color: "#666", fontSize: 12 }}>{s.url || "Browser screenshot"}</div>
            </div>
          ))}
        </div>
      )}

      {view === "run" && (
        <pre
          ref={terminalRef}
          style={{
            background: "#111",
            color: "#0f0",
            padding: "1rem",
            borderRadius: 8,
            height: 480,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
            fontSize: 14,
          }}
        >
          {events.map((ev) => formatEvent(ev)).join("\n")}
        </pre>
      )}

      <h2>Recent tasks</h2>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <code>{t.id}</code> — {t.repo} @ {t.branch} · {t.status}
            {t.prBranch && ` · ${t.prBranch}`}
            {t.provider ? ` · ${t.provider}` : ""}
            {typeof t.costUsd === "number" ? ` · $${t.costUsd.toFixed(4)}` : ""}
            {t.prUrl && (
              <span>
                {" · "}
                <a href={t.prUrl} target="_blank" rel="noopener noreferrer">
                  PR
                </a>
              </span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
