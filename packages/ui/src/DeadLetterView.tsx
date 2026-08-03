import { useEffect, useState } from "react";

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
    <div style={{ marginBottom: "1rem" }}>
      <h2>Dead Letter</h2>
      {items.length === 0 ? (
        <p>No dead-letter tasks.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <code>{item.taskId}</code> — {item.repo} @ {item.branch} · {item.error?.slice(0, 120)}
              {item.resolvedAt ? ` · resolved: ${item.resolution}` : ""}
              {!item.resolvedAt && (
                <button type="button" onClick={() => retry(item.taskId)} disabled={loading} style={{ marginLeft: 8 }}>
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
