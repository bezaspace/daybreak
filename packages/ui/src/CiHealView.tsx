import { Badge } from "./components/base/Badge.js";
import type { Task } from "./lib/types.js";

interface CiHealViewProps {
  tasks: Task[];
}

function getPrHref(repo: string, prNumber: number | undefined): string | undefined {
  if (prNumber === undefined) return undefined;
  try {
    const base = repo.replace(/\.git$/, "");
    const url = new URL(base);
    return `${url.origin}${url.pathname}/pull/${prNumber}`;
  } catch {
    return undefined;
  }
}

function statusVariant(status: string) {
  if (status === "complete") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "running") return "warning" as const;
  return "secondary" as const;
}

export function CiHealView({ tasks }: CiHealViewProps) {
  const heals = tasks
    .filter((t) => t.triggerSource === "check_run")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-db-text">CI self-heal attempts</h2>
      {heals.length === 0 ? (
        <p className="text-sm text-db-text-secondary">No heal attempts yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-db-border">
          <table className="w-full text-sm">
            <thead className="bg-db-elevated text-db-text-secondary">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">PR</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Commit</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {heals.map((t) => {
                const prHref = getPrHref(t.repo, t.prNumber);
                return (
                  <tr key={t.id} className="border-t border-db-border">
                    <td className="px-3 py-2 text-db-text">
                      {prHref ? (
                        <a href={prHref} target="_blank" rel="noopener noreferrer" className="text-db-accent hover:text-db-accent-hover underline">
                          #{t.prNumber}
                        </a>
                      ) : (
                        typeof t.prNumber === "number" && `#${t.prNumber}`
                      )}{" "}
                      {t.prBranch ? <span className="text-db-text-tertiary">({t.prBranch})</span> : "-"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-db-text-secondary">
                      <code className="rounded bg-db-elevated px-1 py-0.5 text-xs">{t.headSha ? t.headSha.slice(0, 7) : "-"}</code>
                    </td>
                    <td className="px-3 py-2 text-db-text-secondary">
                      {typeof t.costUsd === "number" ? `$${t.costUsd.toFixed(4)}` : "-"}
                    </td>
                    <td className="px-3 py-2 text-db-text-secondary">
                      {t.startedAt ? new Date(t.startedAt).toLocaleString() : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
