import { useEffect, useState } from "react";
import { Button } from "./components/base/Button.js";
import { Badge } from "./components/base/Badge.js";

interface DeadLetterTask {
  id: string;
  taskId?: string;
  repo?: string;
  branch?: string;
  prBranch?: string;
  error?: string;
  retryCount?: number;
  createdAt?: number;
  resolvedAt?: number;
  resolution?: string;
}

export function DeadLetterView() {
  const [items, setItems] = useState<DeadLetterTask[]>([]);
  const [loading, setLoading] = useState(false);

  function load() {
    fetch("/api/dead-letter")
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(() => {});
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  async function retry(taskId: string | undefined) {
    if (!taskId) return;
    setLoading(true);
    await fetch(`/api/dead-letter/${taskId}/retry`, { method: "POST" });
    setLoading(false);
    load();
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-db-text">Dead Letter</h2>
      {items.length === 0 ? (
        <p className="text-sm text-db-text-secondary">No dead-letter tasks.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-md border border-db-border bg-db-surface p-3 text-sm text-db-text-secondary">
              <code className="rounded bg-db-elevated px-1.5 py-0.5 text-xs text-db-text">{item.taskId}</code>
              <span>
                {item.repo} @ {item.branch}
              </span>
              <span className="text-db-text-tertiary">{item.error?.slice(0, 120)}</span>
              {item.resolvedAt ? (
                <Badge variant="success">resolved: {item.resolution}</Badge>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => retry(item.taskId)} disabled={loading}>
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
