import { Play, List, GitBranch, History, DollarSign, HeartPulse, XCircle, Trash2 } from "lucide-react";
import { cn } from "../lib/utils.js";

export type ViewId =
  | "run"
  | "tasks"
  | "trace"
  | "time-travel"
  | "costs"
  | "ci-heal"
  | "dead-letter"
  | "cleanup";

interface SidebarProps {
  active: ViewId;
  onNavigate: (view: ViewId) => void;
  taskId?: string | null;
}

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  needsTask?: boolean;
}

const items: NavItem[] = [
  { id: "run", label: "Run", icon: Play },
  { id: "tasks", label: "Tasks", icon: List },
  { id: "trace", label: "Trace", icon: GitBranch, needsTask: true },
  { id: "time-travel", label: "Time Travel", icon: History, needsTask: true },
  { id: "costs", label: "Costs", icon: DollarSign },
  { id: "ci-heal", label: "CI Heal", icon: HeartPulse },
  { id: "dead-letter", label: "Dead Letter", icon: XCircle },
  { id: "cleanup", label: "Cleanup", icon: Trash2 },
];

export function Sidebar({ active, onNavigate, taskId }: SidebarProps) {
  return (
    <aside className="fixed left-0 top-0 z-40 flex h-full w-60 flex-col border-r border-db-border bg-db-surface">
      <div className="flex h-14 items-center border-b border-db-border px-4">
        <span className="text-lg font-bold tracking-tight text-db-text">Daybreak</span>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {items.map((item) => {
          const Icon = item.icon;
          const disabled = item.needsTask && !taskId;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors",
                "hover:bg-db-subtle",
                active === item.id ? "bg-db-subtle text-db-accent" : "text-db-text-secondary",
                disabled && "pointer-events-none opacity-40",
              )}
            >
              <Icon className={cn("h-4 w-4", active === item.id ? "text-db-accent" : "text-db-text-tertiary")} />
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
