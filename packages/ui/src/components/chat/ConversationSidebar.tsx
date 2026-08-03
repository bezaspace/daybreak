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
  Archive,
  ArchiveRestore,
  CalendarDays,
  FolderGit,
  LayoutList,
  MoreVertical,
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
  onTaskAction?: (taskId: string, action: "archive" | "unarchive" | "delete") => void;
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

function statusGroup(status: string): "running" | "idle" | "completed" | "dead-letter" {
  if (["running", "starting"].includes(status)) return "running";
  if (["pending", "paused", "waiting", "idle"].includes(status)) return "idle";
  if (["complete", "promoted", "success"].includes(status)) return "completed";
  return "dead-letter";
}

type GroupBy = "date" | "repo" | "status";

interface TaskGroup {
  label: string;
  tasks: Task[];
}

export function ConversationSidebar({
  tasks,
  activeTaskId,
  activeView,
  onNewSession,
  onSelectTask,
  onNavigate,
  onTaskAction,
}: ConversationSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [showArchived, setShowArchived] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    const term = search.trim().toLowerCase();
    let visible = tasks.filter((t) => showArchived || !t.archived).filter((t) => !t.deletedAt);
    visible.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (!term) return visible;
    return visible.filter(
      (t) =>
        t.repo.toLowerCase().includes(term) ||
        t.branch.toLowerCase().includes(term) ||
        t.status.toLowerCase().includes(term) ||
        (t.prompt && t.prompt.toLowerCase().includes(term)) ||
        (t.id && t.id.toLowerCase().includes(term)),
    );
  }, [tasks, search, showArchived]);

  const grouped = useMemo<TaskGroup[]>(() => {
    if (groupBy === "date") {
      const map = new Map<string, Task[]>();
      for (const task of filteredTasks) {
        const label = dateGroupLabel(task.startedAt);
        const list = map.get(label) || [];
        list.push(task);
        map.set(label, list);
      }
      const order = ["Today", "Yesterday", "Older"];
      return order.map((label) => ({ label, tasks: map.get(label) || [] })).filter((g) => g.tasks.length > 0);
    }

    if (groupBy === "repo") {
      const map = new Map<string, Task[]>();
      for (const task of filteredTasks) {
        const label = repoName(task.repo);
        const list = map.get(label) || [];
        list.push(task);
        map.set(label, list);
      }
      return Array.from(map.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, tasks]) => ({ label, tasks }));
    }

    const order: Record<string, number> = { running: 0, idle: 1, completed: 2, "dead-letter": 3 };
    const map = new Map<string, Task[]>();
    for (const task of filteredTasks) {
      const label = statusGroup(task.status);
      const list = map.get(label) || [];
      list.push(task);
      map.set(label, list);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (order[a] ?? 99) - (order[b] ?? 99))
      .map(([label, tasks]) => ({ label: label.replace("-", " "), tasks }));
  }, [filteredTasks, groupBy]);

  const runningCount = useMemo(() => tasks.filter((t) => ["running", "starting"].includes(t.status) && !t.deletedAt).length, [tasks]);

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
          {!collapsed && (
            <span className="flex flex-1 items-center justify-between">
              Chat
              {runningCount > 0 && <span className="h-2 w-2 rounded-full bg-db-warning" />}
            </span>
          )}
        </button>
      </nav>

      {!collapsed && (
        <div className="space-y-2 px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-db-text-tertiary" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions…"
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center rounded-md border border-db-border bg-db-elevated p-0.5">
              {([
                { id: "status", icon: LayoutList, label: "Status" },
                { id: "repo", icon: FolderGit, label: "Repo" },
                { id: "date", icon: CalendarDays, label: "Date" },
              ] as { id: GroupBy; icon: LucideIcon; label: string }[]).map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setGroupBy(opt.id)}
                    title={opt.label}
                    className={cn(
                      "flex flex-1 items-center justify-center rounded py-1 text-xs font-medium transition-colors",
                      groupBy === opt.id ? "bg-db-accent/10 text-db-accent" : "text-db-text-secondary hover:text-db-text",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              title={showArchived ? "Hide archived" : "Show archived"}
              className={cn(
                "rounded border px-2 py-1 text-xs font-medium transition-colors",
                showArchived
                  ? "border-db-accent/20 bg-db-accent/10 text-db-accent"
                  : "border-db-border bg-db-elevated text-db-text-secondary hover:text-db-text",
              )}
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
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
                    const isRunning = ["running", "starting"].includes(task.status);
                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "group relative w-full rounded-md border px-2 py-2 text-left transition-colors",
                          active
                            ? "border-db-accent/20 bg-db-accent/10"
                            : "border-transparent hover:bg-db-subtle",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectTask(task.id)}
                          className="w-full text-left"
                        >
                          <div className="flex items-center gap-2">
                            <Badge variant={statusBadgeVariant(task.status)} className="shrink-0 text-[10px]">
                              {task.status}
                            </Badge>
                            <span className="truncate text-sm text-db-text">{repoName(task.repo)}</span>
                            <span className="shrink-0 text-xs text-db-text-tertiary">@{task.branch}</span>
                            {isRunning && <span className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-db-warning" />}
                            {task.archived && <Archive className="ml-auto h-3 w-3 shrink-0 text-db-text-tertiary" />}
                          </div>
                          {task.prompt && (
                            <div className="mt-1 truncate pl-1 text-xs text-db-text-secondary">{task.prompt}</div>
                          )}
                        </button>

                        {onTaskAction && (
                          <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                            <button
                              type="button"
                              onClick={() => setOpenMenuId(openMenuId === task.id ? null : task.id)}
                              className="rounded p-1 text-db-text-secondary hover:bg-db-elevated hover:text-db-text"
                              aria-label="Task actions"
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </button>
                            {openMenuId === task.id && (
                              <div className="absolute right-0 top-full z-10 w-32 rounded-md border border-db-border bg-db-surface shadow-lg">
                                {task.archived ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onTaskAction(task.id, "unarchive");
                                      setOpenMenuId(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-db-text hover:bg-db-elevated"
                                  >
                                    <ArchiveRestore className="h-3.5 w-3.5" />
                                    Unarchive
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onTaskAction(task.id, "archive");
                                      setOpenMenuId(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-db-text hover:bg-db-elevated"
                                  >
                                    <Archive className="h-3.5 w-3.5" />
                                    Archive
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    onTaskAction(task.id, "delete");
                                    setOpenMenuId(null);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-db-danger hover:bg-db-danger/10"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
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
