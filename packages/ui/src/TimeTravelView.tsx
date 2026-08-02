import { useEffect, useState, type ReactNode } from "react";

interface Checkpoint {
  id: string;
  taskId: string;
  turn: number;
  timestamp: number;
  gitCommit?: string;
  sessionRef?: string;
  parentCheckpointId?: string;
  branchTaskId?: string;
  status: "active" | "rewound" | "branched" | "promoted" | "abandoned";
  toolCallId?: string;
  costUsd?: number;
}

interface StreamEvent {
  id: string;
  type: string;
  timestamp: number;
  taskId: string;
  data: unknown;
}

function statusColor(status: Checkpoint["status"]): string {
  switch (status) {
    case "active":
      return "#2e7d32";
    case "branched":
      return "#1565c0";
    case "rewound":
      return "#ef6c00";
    case "abandoned":
      return "#757575";
    case "promoted":
      return "#6a1b9a";
    default:
      return "#333";
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function buildTree(checkpoints: Checkpoint[]): Checkpoint[] {
  return checkpoints.filter((c) => !c.parentCheckpointId);
}

function childrenOf(checkpoints: Checkpoint[], parentId: string): Checkpoint[] {
  return checkpoints.filter((c) => c.parentCheckpointId === parentId).sort((a, b) => a.turn - b.turn || a.timestamp - b.timestamp);
}

function formatEventPreview(ev: StreamEvent): string {
  const time = new Date(ev.timestamp).toLocaleTimeString();
  if (ev.type === "tool_execution_start") {
    const data = ev.data as { toolName?: string };
    return `[${time}] ▶ ${data.toolName || ev.type}`;
  }
  if (ev.type === "tool_execution_end") {
    const data = ev.data as { toolName?: string; isError?: boolean };
    return `[${time}] ${data.isError ? "✗" : "✓"} ${data.toolName || ev.type}`;
  }
  if (ev.type === "message_update") {
    const data = ev.data as { delta?: string };
    return `[${time}] ${(data.delta || "").slice(0, 80)}`;
  }
  if (ev.type === "checkpoint_created") {
    const data = ev.data as { turn?: number };
    return `[${time}] checkpoint turn ${data.turn ?? "-"}`;
  }
  return `[${time}] ${ev.type}`;
}

function CheckpointDetails({ checkpoint, events }: { checkpoint: Checkpoint; events: StreamEvent[] }) {
  const contextEvents = events
    .filter((ev) => ev.timestamp <= checkpoint.timestamp)
    .filter((ev) => ["message_update", "tool_execution_start", "tool_execution_end", "checkpoint_created", "task_rewind", "branch_forked"].includes(ev.type))
    .slice(-10);

  return (
    <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "#fff", border: "1px solid #ddd", borderRadius: 4, fontSize: 13 }}>
      <div style={{ color: "#555", marginBottom: "0.25rem" }}>
        <strong>Checkpoint details</strong>
      </div>
      <div>git commit: <code>{checkpoint.gitCommit || "-"}</code></div>
      <div>session ref: <code>{checkpoint.sessionRef || "-"}</code></div>
      {checkpoint.branchTaskId && <div>branch task: <code>{checkpoint.branchTaskId}</code></div>}
      <div style={{ marginTop: "0.5rem" }}>
        <strong>Recent context ({contextEvents.length} events):</strong>
        <pre style={{ margin: "0.25rem 0 0 0", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>
          {contextEvents.map((ev) => formatEventPreview(ev)).join("\n") || "No context events available."}
        </pre>
      </div>
    </div>
  );
}

export function TimeTravelView({ taskId }: { taskId: string }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/tasks/${taskId}/checkpoints`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/tasks/${taskId}/events`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([cpData, evData]) => {
        setCheckpoints(Array.isArray(cpData) ? (cpData as Checkpoint[]) : []);
        setEvents(Array.isArray(evData) ? (evData as StreamEvent[]) : []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, [taskId]);

  const toolNameByCallId = events.reduce<Record<string, string>>((map, ev) => {
    if (ev.type === "tool_execution_start") {
      const data = ev.data as { toolCallId?: string; toolName?: string };
      if (data.toolCallId && data.toolName) {
        map[data.toolCallId] = data.toolName;
      }
    }
    return map;
  }, {});

  async function handleFork(checkpoint: Checkpoint) {
    const prompt = prompts[checkpoint.id]?.trim();
    if (!prompt) {
      setMessages((m) => ({ ...m, [checkpoint.id]: "Enter a prompt to fork." }));
      return;
    }
    setMessages((m) => ({ ...m, [checkpoint.id]: "Forking..." }));
    try {
      const res = await fetch(`/api/checkpoints/${checkpoint.id}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, strategy: "git-reinstall" }),
      });
      const data = (await res.json()) as { taskId?: string; error?: string; prBranch?: string };
      if (!res.ok) throw new Error(data.error || "fork failed");
      setMessages((m) => ({ ...m, [checkpoint.id]: `Forked → ${data.taskId?.slice(0, 8)} branch ${data.prBranch}` }));
    } catch (err) {
      setMessages((m) => ({ ...m, [checkpoint.id]: `Fork error: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  async function handleRewind(checkpoint: Checkpoint) {
    const prompt = prompts[checkpoint.id]?.trim();
    if (!prompt) {
      setMessages((m) => ({ ...m, [checkpoint.id]: "Enter a prompt to rewind." }));
      return;
    }
    setMessages((m) => ({ ...m, [checkpoint.id]: "Rewinding..." }));
    try {
      const res = await fetch(`/api/tasks/${checkpoint.taskId}/rewind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId: checkpoint.id, prompt }),
      });
      const data = (await res.json()) as { taskId?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "rewind failed");
      setMessages((m) => ({ ...m, [checkpoint.id]: `Rewind accepted` }));
    } catch (err) {
      setMessages((m) => ({ ...m, [checkpoint.id]: `Rewind error: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  function renderNode(checkpoint: Checkpoint, depth: number): ReactNode {
    const toolName = checkpoint.toolCallId ? toolNameByCallId[checkpoint.toolCallId] : undefined;
    const branchChildren = childrenOf(checkpoints, checkpoint.id);

    return (
      <li key={checkpoint.id} style={{ marginBottom: "0.75rem" }}>
        <div
          style={{
            borderLeft: `4px solid ${statusColor(checkpoint.status)}`,
            paddingLeft: "0.75rem",
            background: "#fafafa",
            borderRadius: 4,
            padding: "0.5rem 0.75rem",
          }}
        >
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center", fontSize: 14, marginBottom: "0.25rem" }}>
            <strong style={{ color: statusColor(checkpoint.status) }}>{checkpoint.status.toUpperCase()}</strong>
            <span>turn {checkpoint.turn}</span>
            <span style={{ color: "#666" }}>{formatTimestamp(checkpoint.timestamp)}</span>
            {toolName && <span>tool: {toolName}</span>}
            {typeof checkpoint.costUsd === "number" && <span>cost ${checkpoint.costUsd.toFixed(4)}</span>}
            <code style={{ fontSize: 12 }}>{checkpoint.gitCommit?.slice(0, 7) || "-"}</code>
          </div>
          <textarea
            value={prompts[checkpoint.id] ?? ""}
            onChange={(e) => setPrompts((p) => ({ ...p, [checkpoint.id]: e.target.value }))}
            placeholder="New prompt for rewind or fork..."
            rows={2}
            style={{ width: "100%", padding: "0.5rem", fontFamily: "inherit", marginBottom: "0.5rem" }}
          />
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button type="button" onClick={() => handleFork(checkpoint)} style={{ padding: "0.25rem 0.75rem" }}>
              Fork from here
            </button>
            <button type="button" onClick={() => handleRewind(checkpoint)} style={{ padding: "0.25rem 0.75rem" }}>
              Rewind to here
            </button>
            {messages[checkpoint.id] && <span style={{ fontSize: 13, color: "#555" }}>{messages[checkpoint.id]}</span>}
            <button type="button" onClick={() => setSelectedId((id) => (id === checkpoint.id ? null : checkpoint.id))} style={{ padding: "0.25rem 0.75rem", marginLeft: "auto" }}>
              {selectedId === checkpoint.id ? "Hide details" : "Details"}
            </button>
          </div>
          {selectedId === checkpoint.id && <CheckpointDetails checkpoint={checkpoint} events={events} />}
        </div>
        {branchChildren.length > 0 && (
          <ul style={{ marginTop: "0.5rem", marginLeft: `${depth * 16 + 16}px`, paddingLeft: 0, listStyle: "none" }}>
            {branchChildren.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  if (loading) return <p>Loading checkpoints...</p>;
  if (error) return <p style={{ color: "red" }}>Error: {error}</p>;

  const roots = buildTree(checkpoints);
  if (roots.length === 0) return <p>No checkpoints for this task yet.</p>;

  return (
    <div style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Time Travel</h2>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
      <ul style={{ listStyle: "none", padding: 0 }}>{roots.map((r) => renderNode(r, 0))}</ul>
    </div>
  );
}
