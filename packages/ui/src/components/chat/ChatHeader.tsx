import { Square, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "../base/Button.js";
import { Badge } from "../base/Badge.js";
import { statusBadgeVariant } from "../../lib/format.js";
import type { Task } from "../../lib/types.js";

interface ChatHeaderProps {
  task: Task;
  status: string;
  isRunning: boolean;
  onCancel: () => void;
}

function repoName(repo: string): string {
  try {
    const url = new URL(repo);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  } catch {
    return repo.length > 32 ? `${repo.slice(0, 32)}…` : repo;
  }
}

export function ChatHeader({ task, status, isRunning, onCancel }: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-db-border bg-db-surface px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-db-text">
          <span className="truncate font-medium">{repoName(task.repo)}</span>
          <span className="text-db-text-tertiary">@</span>
          <span className="text-db-text-secondary">{task.branch}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-db-text-tertiary">
          <code className="rounded bg-db-elevated px-1 py-0.5">{task.id.slice(0, 8)}</code>
          {task.provider && <span>{task.provider}</span>}
          {typeof task.costUsd === "number" && <span>${task.costUsd.toFixed(4)}</span>}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noopener noreferrer" className="text-db-accent hover:text-db-accent-hover underline">
              PR
            </a>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={statusBadgeVariant(status)}>{status}</Badge>
        {isRunning && (
          <Button type="button" variant="danger" size="sm" onClick={onCancel}>
            <Square className={cn("h-3 w-3", status === "starting" && "hidden")} />
            {status === "starting" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Stop"}
          </Button>
        )}
      </div>
    </div>
  );
}
