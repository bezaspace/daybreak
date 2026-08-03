import { useMemo, useState } from "react";
import {
  Plus,
  PanelLeft,
  MessageSquare,
  Play,
  List,
  GitBranch,
  History,
  DollarSign,
  HeartPulse,
  XCircle,
  Trash2,
  Search,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "../base/Button.js";
import { Badge } from "../base/Badge.js";
import { Input } from "../base/Input.js";
import { statusBadgeVariant } from "../../lib/format.js";
import type { Task } from "../../lib/types.js";
import type { ViewId } from "../Sidebar.js";

interface ConversationSidebarProps {
  tasks: Task[];
  activeTaskId: string | null;
  activeView: "chat" | ViewId;
  onNewSession: () => void;
  onSelectTask: (taskId: string) => void;
  onNavigate: (view: "chat" | ViewId) => void;
}

type LucideIcon = React.ComponentType<{ className?: string }>;

interface LegacyItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

const legacyItems: LegacyItem[] = [
  { id: "run", label: "Legacy Run", icon: Play },
  { id: "tasks", label: "Tasks", icon: List },
  { id: "trace", label: "Trace", icon: GitBranch },
  { id: "time-travel", label: "Time Travel", icon: History },
  { id: "costs", label: "Costs", icon: DollarSign },
  { id: "ci-heal", label: "CI Heal", icon: HeartPulse },
  { id: "dead-letter", label: "Dead Letter", icon: XCircle },
  { id: "cleanup", label: "Cleanup", icon: Trash2 },
];

function repoName(repo: string): string {
  try {
    const url = new URL(repo);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  } catch {
    return repo.length > 32 ? `${repo.slice(0, 32)}…` : repo;
  }
}

function dateGroupLabel(startedAt: number | undefined): string {
  if (!startedAt) return "Older";
  const day = new Date(startedAt);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return "Older";
}

export function ConversationSidebar({
  tasks,
  activeTaskId,
  activeView,
  onNewSession,
  onSelectTask,
  onNavigate,
}: ConversationSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");

  const filteredTasks = useMemo(() => {
    const term = search.trim().toLowerCase();
    const sorted = [...tasks].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (!term) return sorted;
    return sorted.filter(
      (t) =>
        t.repo.toLowerCase().includes(term) ||
        t.branch.toLowerCase().includes(term) ||
        t.status.toLowerCase().includes(term) ||
        (t.prompt && t.prompt.toLowerCase().includes(term)),
    );
  }, [tasks, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of filteredTasks) {
      const label = dateGroupLabel(task.startedAt);
      const list = map.get(label) || [];
      list.push(task);
      map.set(label, list);
    }
    const order = ["Today", "Yesterday", "Older"];
    return order
      .map((label) => ({ label, tasks: map.get(label) || [] }))
      .filter((g) => g.tasks.length > 0);
  }, [filteredTasks]);

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-db-border bg-db-surface transition-all duration-200",
        collapsed ? "w-16 items-center" : "w-64",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-db-border px-3",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {!collapsed && <span className="text-lg font-bold tracking-tight text-db-text">Daybreak</span>}
        <Button
          type="button"
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <PanelLeft className={cn("h-4 w-4", collapsed && "rotate-180")} />
        </Button>
      </div>

      <div className={cn("p-3", collapsed && "px-2")}>
        <Button
          type="button"
          variant="default"
          size={collapsed ? "icon" : "md"}
          className={cn("w-full", collapsed && "w-8")}
          onClick={onNewSession}
          title="New session"
        >
          <Plus className="h-4 w-4" />
          {!collapsed && <span className="ml-2">New session</span>}
        </Button>
      </div>

      <nav className="flex flex-col gap-1 px-2 pb-2">
        <button
          type="button"
          onClick={() => onNavigate("chat")}
          title="Chat"
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            activeView === "chat" ? "bg-db-accent/10 text-db-accent" : "text-db-text-secondary hover:bg-db-subtle",
            collapsed && "justify-center px-2",
          )}
        >
          <MessageSquare className="h-4 w-4 shrink-0" />
          {!collapsed && "Chat"}
        </button>
      </nav>

      {!collapsed && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-db-text-tertiary" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions…"
              className="pl-8"
            />
          </div>
        </div>
      )}

      <div className={cn("flex-1 overflow-y-auto px-2", collapsed && "hidden")}>
        {grouped.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-db-text-tertiary">
            No sessions yet.
            <br />
            Start a new chat to begin.
          </div>
        ) : (
          <div className="space-y-4 pb-4">
            {grouped.map((group) => (
              <div key={group.label}>
                <h3 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-db-text-tertiary">
                  {group.label}
                </h3>
                <div className="space-y-1">
                  {group.tasks.map((task) => {
                    const active = activeTaskId === task.id && activeView === "chat";
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onSelectTask(task.id)}
                        className={cn(
                          "w-full rounded-md border px-2 py-2 text-left transition-colors",
                          active
                            ? "border-db-accent/20 bg-db-accent/10"
                            : "border-transparent hover:bg-db-subtle",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant={statusBadgeVariant(task.status)} className="shrink-0 text-[10px]">
                            {task.status}
                          </Badge>
                          <span className="truncate text-sm text-db-text">{repoName(task.repo)}</span>
                          <span className="shrink-0 text-xs text-db-text-tertiary">@{task.branch}</span>
                        </div>
                        {task.prompt && (
                          <div className="mt-1 truncate pl-1 text-xs text-db-text-secondary">{task.prompt}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-db-border p-2">
        <div className={cn("space-y-1", collapsed && "flex flex-col items-center gap-2")}>
          {!collapsed && (
            <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-db-text-tertiary">
              Legacy
            </div>
          )}
          {legacyItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                title={item.label}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-db-accent/10 text-db-accent" : "text-db-text-secondary hover:bg-db-subtle",
                  collapsed && "justify-center px-2",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
