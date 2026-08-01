import { useEffect, useRef, useState } from "react";

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
}

interface Screenshot {
  dataUrl: string;
  url?: string;
  timestamp: number;
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
  if (event.type === "task_complete" || event.type === "task_failed") {
    const data = event.data as { success?: boolean; error?: string };
    return `[${time}] ${event.type}${data.error ? ": " + data.error : ""}`;
  }
  return `[${time}] ${event.type}: ${JSON.stringify(event.data).slice(0, 200)}`;
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
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const terminalRef = useRef<HTMLPreElement>(null);
  const [tasks, setTasks] = useState<Task[]>([]);

  function loadTasks() {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((data) => setTasks(Array.isArray(data) ? data : []))
      .catch(() => {});
  }

  useEffect(() => {
    loadTasks();
  }, []);

  useEffect(() => {
    if (!taskId) return;
    setEvents([]);
    setStatus("running");
    setPrUrl(null);
    setScreenshots([]);

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
          const data = event.data as { prUrl?: string };
          if (data.prUrl) {
            setPrUrl(data.prUrl);
            loadTasks();
            es.close();
          }
        }
        if (event.type === "task_complete") {
          setStatus("complete");
        }
        if (event.type === "task_failed") {
          setStatus("failed");
          es.close();
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

  async function startTask(e: React.FormEvent) {
    e.preventDefault();
    setStatus("starting");
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, branch }),
    });
    const data = await res.json();
    if (data.taskId) {
      setTaskId(data.taskId);
      window.history.replaceState({}, "", `?taskId=${data.taskId}`);
    } else {
      setStatus("error: " + (data.error || "unknown"));
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 960, margin: "0 auto" }}>
      <h1>Daybreak</h1>
      <form onSubmit={startTask} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
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

      {screenshots.length > 0 && (
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

      <h2>Recent tasks</h2>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <code>{t.id}</code> — {t.repo} @ {t.branch} · {t.status}
            {t.prBranch && ` · ${t.prBranch}`}
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
