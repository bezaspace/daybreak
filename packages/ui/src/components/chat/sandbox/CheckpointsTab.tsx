import { Placeholder } from "./Placeholder.js";
import { formatCost } from "../../../lib/format.js";
import type { CheckpointItem } from "./types.js";

interface CheckpointsTabProps {
  checkpoints: CheckpointItem[];
  loading: boolean;
  onRewind: (checkpointId: string) => void;
  onFork: (checkpointId: string) => void;
}

export function CheckpointsTab({ checkpoints, loading, onRewind, onFork }: CheckpointsTabProps) {
  if (loading) return <Placeholder title="Checkpoints">Loading…</Placeholder>;
  if (checkpoints.length === 0) return <Placeholder title="Checkpoints">No checkpoints yet.</Placeholder>;

  return (
    <div className="h-full overflow-y-auto p-3 scrollbar-thin">
      <div className="space-y-2">
        {checkpoints.map((cp) => (
          <div key={cp.id} className="rounded border border-db-border bg-db-elevated p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-db-text">Turn {cp.turn}</span>
              <span className="text-db-text-tertiary">{new Date(cp.timestamp).toLocaleString()}</span>
            </div>
            <div className="mt-1 text-db-text-secondary">
              commit <code className="text-db-text">{(cp.gitCommit ?? "").slice(0, 7)}</code>
              {typeof cp.costUsd === "number" && <span className="ml-2">{formatCost(cp.costUsd)}</span>}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => onRewind(cp.id)}
                className="rounded bg-db-accent/10 px-2 py-1 text-db-accent hover:bg-db-accent/20"
              >
                Rewind
              </button>
              <button
                type="button"
                onClick={() => onFork(cp.id)}
                className="rounded bg-db-subtle px-2 py-1 text-db-text hover:bg-db-border"
              >
                Fork
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
