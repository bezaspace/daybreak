import { useEffect, useState } from "react";

interface Task {
  id: string;
  repo: string;
  branch: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  provider?: string;
  costUsd?: number;
  traceId?: string;
  prUrl?: string;
}

interface CostBreakdown {
  provider: string;
  tasks: number;
  costUsd: number;
}

interface DailySpend {
  date: string;
  tasks: number;
  costUsd: number;
}

export function CostDashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tasks")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<Task[]>;
      })
      .then((data) => {
        setTasks(Array.isArray(data) ? data : []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>Loading cost dashboard...</div>;
  if (error) return <div style={{ color: "red" }}>Dashboard error: {error}</div>;

  const completed = tasks.filter((t) => t.status === "complete" && typeof t.costUsd === "number");
  const totalCost = completed.reduce((sum, t) => sum + (t.costUsd || 0), 0);
  const totalTasks = completed.length;

  const providerMap = new Map<string, CostBreakdown>();
  const dailyMap = new Map<string, DailySpend>();

  for (const task of completed) {
    const provider = task.provider || "unknown";
    const existing = providerMap.get(provider) || { provider, tasks: 0, costUsd: 0 };
    existing.tasks += 1;
    existing.costUsd += task.costUsd || 0;
    providerMap.set(provider, existing);

    const date = task.startedAt ? new Date(task.startedAt).toISOString().split("T")[0] : "unknown";
    const day = dailyMap.get(date) || { date, tasks: 0, costUsd: 0 };
    day.tasks += 1;
    day.costUsd += task.costUsd || 0;
    dailyMap.set(date, day);
  }

  const providerBreakdown = Array.from(providerMap.values()).sort((a, b) => b.costUsd - a.costUsd);
  const dailySpend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div>
      <h2>Cost dashboard</h2>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <div style={{ background: "#f6f6f6", padding: "1rem", borderRadius: 8, flex: 1 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Total completed tasks</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{totalTasks}</div>
        </div>
        <div style={{ background: "#f6f6f6", padding: "1rem", borderRadius: 8, flex: 1 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Total spend</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>${totalCost.toFixed(4)}</div>
        </div>
      </div>

      <h3>Provider breakdown</h3>
      {providerBreakdown.length === 0 ? (
        <p>No completed tasks with cost data.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1rem" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Provider</th>
              <th>Tasks</th>
              <th>Cost (USD)</th>
            </tr>
          </thead>
          <tbody>
            {providerBreakdown.map((row) => (
              <tr key={row.provider}>
                <td>{row.provider}</td>
                <td>{row.tasks}</td>
                <td>${row.costUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Daily spend</h3>
      {dailySpend.length === 0 ? (
        <p>No daily data.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1rem" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Date</th>
              <th>Tasks</th>
              <th>Cost (USD)</th>
            </tr>
          </thead>
          <tbody>
            {dailySpend.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{row.tasks}</td>
                <td>${row.costUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Recent tasks</h3>
      <ul>
        {tasks.slice(0, 20).map((t) => (
          <li key={t.id}>
            <code>{t.id}</code> — {t.repo} @ {t.branch} · {t.status}
            {t.provider ? ` · ${t.provider}` : ""}
            {typeof t.costUsd === "number" ? ` · $${t.costUsd.toFixed(4)}` : ""}
            {t.traceId ? ` · trace: ${t.traceId}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
