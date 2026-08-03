import type { Task } from "./App.js";

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

export function CiHealView({ tasks }: CiHealViewProps) {
  const heals = tasks
    .filter((t) => t.triggerSource === "check_run")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  return (
    <div>
      <h3>CI self-heal attempts</h3>
      {heals.length === 0 ? (
        <p>No heal attempts yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc" }}>
              <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>PR</th>
              <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Status</th>
              <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Commit</th>
              <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Cost</th>
              <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Started</th>
            </tr>
          </thead>
          <tbody>
            {heals.map((t) => {
              const prHref = getPrHref(t.repo, t.prNumber);
              return (
                <tr key={t.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.25rem 0.5rem" }}>
                    {prHref ? (
                      <a href={prHref} target="_blank" rel="noopener noreferrer">
                        #{t.prNumber}
                      </a>
                    ) : (
                      typeof t.prNumber === "number" && `#${t.prNumber}`
                    )}{" "}
                    {t.prBranch ? <span style={{ color: "#666" }}>({t.prBranch})</span> : "-"}
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>{t.status}</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>
                    <code>{t.headSha ? t.headSha.slice(0, 7) : "-"}</code>
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>
                    {typeof t.costUsd === "number" ? `$${t.costUsd.toFixed(4)}` : "-"}
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>
                    {t.startedAt ? new Date(t.startedAt).toLocaleString() : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
