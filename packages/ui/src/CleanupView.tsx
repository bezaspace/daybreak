import { useEffect, useState } from "react";

interface CleanupResult {
  type: string;
  startedAt: number;
  completedAt: number;
  deletedCount: number;
  details: Record<string, unknown>;
}

interface Config {
  branchTtlDays?: number;
  sandboxIdleTtlMinutes?: number;
  dataRetentionDays?: number;
  cleanupEnabled?: boolean;
}

export function CleanupView() {
  const [config, setConfig] = useState<Config | null>(null);
  const [results, setResults] = useState<CleanupResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastSummary, setLastSummary] = useState<CleanupResult[] | null>(null);

  function loadConfig() {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setConfig(data as Config))
      .catch(() => {});
  }

  useEffect(() => {
    loadConfig();
  }, []);

  async function run(type: string, dryRun: boolean) {
    setLoading(true);
    try {
      const res = await fetch(`/api/cleanup?type=${type}&dryRun=${dryRun}`, { method: "POST" });
      const data = (await res.json()) as { results: CleanupResult[]; totalDeleted: number };
      setResults(data.results);
      setLastSummary(data.results);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2>Cleanup</h2>
      {config && (
        <div style={{ color: "#666", fontSize: 14, marginBottom: "1rem" }}>
          Branch TTL: {config.branchTtlDays} days · Sandbox idle TTL: {config.sandboxIdleTtlMinutes} min · Data retention: {config.dataRetentionDays} days ·{" "}
          {config.cleanupEnabled ? "enabled" : "disabled"}
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <button type="button" disabled={loading} onClick={() => run("branches", true)}>
          Dry-run branches
        </button>
        <button type="button" disabled={loading} onClick={() => run("branches", false)}>
          Clean branches
        </button>
        <button type="button" disabled={loading} onClick={() => run("sandboxes", true)}>
          Dry-run sandboxes
        </button>
        <button type="button" disabled={loading} onClick={() => run("sandboxes", false)}>
          Clean sandboxes
        </button>
        <button type="button" disabled={loading} onClick={() => run("data", true)}>
          Dry-run data retention
        </button>
        <button type="button" disabled={loading} onClick={() => run("data", false)}>
          Clean data retention
        </button>
        <button type="button" disabled={loading} onClick={() => run("all", true)}>
          Dry-run all
        </button>
        <button type="button" disabled={loading} onClick={() => run("all", false)}>
          Run all cleanup
        </button>
      </div>
      {lastSummary && (
        <div style={{ background: "#f6f6f6", padding: "1rem", borderRadius: 8, marginBottom: "1rem" }}>
          <strong>Last cleanup summary</strong>
          <ul>
            {lastSummary.map((r, i) => (
              <li key={i}>
                {r.type}: {r.deletedCount} deleted ({formatDuration(r.completedAt - r.startedAt)})
              </li>
            ))}
          </ul>
        </div>
      )}
      {results && (
        <pre
          style={{
            background: "#111",
            color: "#0f0",
            padding: "1rem",
            borderRadius: 8,
            maxHeight: 400,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
            fontSize: 14,
          }}
        >
          {JSON.stringify(results, null, 2)}
        </pre>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
