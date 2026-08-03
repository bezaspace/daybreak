import { useEffect, useState } from "react";
import { Button } from "./components/base/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./components/base/Card.js";
import { Loader2 } from "lucide-react";
import type { Config } from "./lib/types.js";

interface CleanupResult {
  type: string;
  startedAt: number;
  completedAt: number;
  deletedCount: number;
  details: Record<string, unknown>;
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
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-db-text">Cleanup</h2>
      {config && (
        <p className="text-sm text-db-text-secondary">
          Branch TTL: {config.branchTtlDays} days · Sandbox idle TTL: {config.sandboxIdleTtlMinutes} min · Data retention: {config.dataRetentionDays} days ·{" "}
          {config.cleanupEnabled ? "enabled" : "disabled"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={loading} onClick={() => run("branches", true)}>
          {loading && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          Dry-run branches
        </Button>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => run("branches", false)}>
          Clean branches
        </Button>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => run("sandboxes", true)}>
          Dry-run sandboxes
        </Button>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => run("sandboxes", false)}>
          Clean sandboxes
        </Button>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => run("data", true)}>
          Dry-run data retention
        </Button>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => run("data", false)}>
          Clean data retention
        </Button>
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => run("all", true)}>
          Dry-run all
        </Button>
        <Button variant="danger" size="sm" disabled={loading} onClick={() => run("all", false)}>
          Run all cleanup
        </Button>
      </div>
      {lastSummary && (
        <Card>
          <CardHeader>
            <CardTitle>Last cleanup summary</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc text-sm text-db-text-secondary">
              {lastSummary.map((r, i) => (
                <li key={i}>
                  {r.type}: {r.deletedCount} deleted ({formatDuration(r.completedAt - r.startedAt)})
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {results && (
        <pre className="h-[25rem] overflow-auto whitespace-pre-wrap rounded-lg border border-db-border bg-black p-4 font-mono text-sm leading-relaxed text-green-400 scrollbar-thin">
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
