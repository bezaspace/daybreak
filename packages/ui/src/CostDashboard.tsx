import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./components/base/Card.js";
import { Badge } from "./components/base/Badge.js";
import type { Task } from "./lib/types.js";

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
      .then((data) => setTasks(Array.isArray(data) ? data : []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-db-text-secondary">Loading cost dashboard...</div>;
  if (error) return <div className="text-db-danger">Dashboard error: {error}</div>;

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
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-db-text">Cost dashboard</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Total completed tasks</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold text-db-text">{totalTasks}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total spend</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold text-db-text">${totalCost.toFixed(4)}</CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-2 text-base font-medium text-db-text">Provider breakdown</h3>
        {providerBreakdown.length === 0 ? (
          <p className="text-sm text-db-text-secondary">No completed tasks with cost data.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-db-border">
            <table className="w-full text-sm">
              <thead className="bg-db-elevated text-db-text-secondary">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Tasks</th>
                  <th className="px-3 py-2 font-medium">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {providerBreakdown.map((row) => (
                  <tr key={row.provider} className="border-t border-db-border">
                    <td className="px-3 py-2 text-db-text">{row.provider}</td>
                    <td className="px-3 py-2 text-db-text-secondary">{row.tasks}</td>
                    <td className="px-3 py-2 text-db-text-secondary">${row.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-base font-medium text-db-text">Daily spend</h3>
        {dailySpend.length === 0 ? (
          <p className="text-sm text-db-text-secondary">No daily data.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-db-border">
            <table className="w-full text-sm">
              <thead className="bg-db-elevated text-db-text-secondary">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Tasks</th>
                  <th className="px-3 py-2 font-medium">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {dailySpend.map((row) => (
                  <tr key={row.date} className="border-t border-db-border">
                    <td className="px-3 py-2 text-db-text">{row.date}</td>
                    <td className="px-3 py-2 text-db-text-secondary">{row.tasks}</td>
                    <td className="px-3 py-2 text-db-text-secondary">${row.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-base font-medium text-db-text">Recent tasks</h3>
        <ul className="space-y-2">
          {tasks.slice(0, 20).map((t) => (
            <li key={t.id} className="rounded-md border border-db-border bg-db-surface p-3 text-sm text-db-text-secondary">
              <code className="rounded bg-db-elevated px-1.5 py-0.5 text-xs text-db-text">{t.id}</code>
              <span className="mx-1">—</span>
              {t.repo} @ {t.branch}
              <Badge className="ml-2" variant={t.status === "complete" ? "success" : t.status === "failed" ? "danger" : "secondary"}>
                {t.status}
              </Badge>
              {t.provider ? <span className="ml-2">{t.provider}</span> : ""}
              {typeof t.costUsd === "number" ? <span className="ml-2">${t.costUsd.toFixed(4)}</span> : ""}
              {t.traceId ? <span className="ml-2 text-db-text-tertiary">trace: {t.traceId}</span> : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
