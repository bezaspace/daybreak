import { cn } from "../../../lib/utils.js";
import { Placeholder } from "./Placeholder.js";
import type { DiffFile } from "./types.js";

interface Diff {
  files: DiffFile[];
  aheadBy?: number;
  behindBy?: number;
}

interface DiffTabProps {
  diff: Diff | null;
  loading: boolean;
}

export function DiffTab({ diff, loading }: DiffTabProps) {
  if (loading) return <Placeholder title="Diff">Loading…</Placeholder>;
  if (!diff || diff.files.length === 0) return <Placeholder title="Diff">No diff available.</Placeholder>;

  return (
    <div className="h-full overflow-y-auto p-3 scrollbar-thin">
      <div className="space-y-3 text-sm">
        <div className="text-xs text-db-text-secondary">
          {diff.aheadBy ?? 0} ahead, {diff.behindBy ?? 0} behind
        </div>
        {diff.files.map((file) => (
          <div key={file.filename} className="rounded border border-db-border bg-db-elevated">
            <div className="flex items-center justify-between border-b border-db-border px-2 py-1 text-xs">
              <span className="truncate font-medium text-db-text" title={file.filename}>
                {file.filename}
              </span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] uppercase",
                  file.status === "added" && "bg-green-500/10 text-green-400",
                  file.status === "removed" && "bg-red-500/10 text-red-400",
                  file.status === "modified" && "bg-blue-500/10 text-blue-400",
                  file.status === "renamed" && "bg-purple-500/10 text-purple-400",
                )}
              >
                {file.status}
              </span>
            </div>
            <div className="flex gap-3 px-2 py-1 text-xs text-db-text-secondary">
              <span className="text-green-400">+{file.additions}</span>
              <span className="text-red-400">-{file.deletions}</span>
            </div>
            {file.patch && (
              <pre className="max-h-48 overflow-auto border-t border-db-border bg-black/50 p-2 text-xs text-db-text-secondary scrollbar-thin">
                {file.patch}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
