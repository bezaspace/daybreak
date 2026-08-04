import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  PanelRight,
  Terminal,
  Image as ImageIcon,
  FolderTree,
  History,
  GitBranch,
  DollarSign,
  FileDiff,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { ansiToHtml } from "../../lib/ansi.js";
import { Placeholder } from "./sandbox/Placeholder.js";
import type { Screenshot, StreamEvent, Task, TaskMetrics } from "../../lib/types.js";
import type { FileEntry, CheckpointItem, DiffFile } from "./sandbox/types.js";

interface SandboxPanelProps {
  events: StreamEvent[];
  screenshots: Screenshot[];
  task: Task | null;
  metrics: TaskMetrics | null;
  activeProvider: string | null;
  costAlert: { current: number; limit: number; threshold: number } | null;
  onRewind?: (checkpointId: string, prompt: string) => void;
  onFork?: (checkpointId: string, prompt: string) => void;
}

type TabId = "terminal" | "browser" | "files" | "checkpoints" | "trace" | "costs" | "diff";

interface TabItem {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const tabs: TabItem[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "browser", label: "Browser", icon: ImageIcon },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "checkpoints", label: "Checkpoints", icon: History },
  { id: "trace", label: "Trace", icon: GitBranch },
  { id: "costs", label: "Costs", icon: DollarSign },
  { id: "diff", label: "Diff", icon: FileDiff },
];

const TerminalTab = lazy(() => import("./sandbox/TerminalTab.js").then((m) => ({ default: m.TerminalTab })));
const BrowserTab = lazy(() => import("./sandbox/BrowserTab.js").then((m) => ({ default: m.BrowserTab })));
const FilesTab = lazy(() => import("./sandbox/FilesTab.js").then((m) => ({ default: m.FilesTab })));
const CheckpointsTab = lazy(() => import("./sandbox/CheckpointsTab.js").then((m) => ({ default: m.CheckpointsTab })));
const TraceTab = lazy(() => import("./sandbox/TraceTab.js").then((m) => ({ default: m.TraceTab })));
const CostsTab = lazy(() => import("./sandbox/CostsTab.js").then((m) => ({ default: m.CostsTab })));
const DiffTab = lazy(() => import("./sandbox/DiffTab.js").then((m) => ({ default: m.DiffTab })));

function buildTerminalHtml(events: StreamEvent[]): string {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type === "bash_execution_update") {
      const data = ev.data as { delta?: string } | undefined;
      if (data?.delta) out.push(data.delta);
    } else if (ev.type === "tool_execution_start") {
      const data = ev.data as { toolName?: string; args?: unknown } | undefined;
      const args = typeof data?.args === "string" ? data.args : JSON.stringify(data?.args);
      out.push(`\n$ ${data?.toolName ?? "tool"} ${args}\n`);
    } else if (ev.type === "tool_execution_end") {
      const data = ev.data as { toolName?: string; result?: unknown } | undefined;
      if (data?.toolName === "bash" && data?.result && typeof data.result === "object") {
        const r = data.result as { stdout?: string; stderr?: string };
        if (r.stdout) out.push(`${r.stdout}\n`);
        if (r.stderr) out.push(`${r.stderr}\n`);
      } else if (typeof data?.result === "string") {
        out.push(`${data.result}\n`);
      } else if (data?.result) {
        out.push(`${JSON.stringify(data.result, null, 2)}\n`);
      }
    } else if (ev.type === "task_complete" || ev.type === "task_failed") {
      const data = ev.data as { success?: boolean; summary?: string; error?: string } | undefined;
      const message = data?.error ?? data?.summary ?? "";
      out.push(`\n[${ev.type}] ${message}\n`);
    }
  }
  return ansiToHtml(out.join(""));
}

function useCostData(events: StreamEvent[], metrics: TaskMetrics | null) {
  return useMemo(() => {
    const points: { label: string; cost: number; turns: number }[] = [];
    let turns = 0;
    for (const ev of events) {
      if (ev.type === "checkpoint_created") {
        const data = ev.data as { turn?: number; costUsd?: number } | undefined;
        turns = data?.turn ?? turns;
        if (typeof data?.costUsd === "number") {
          points.push({ label: new Date(ev.timestamp).toLocaleTimeString(), cost: data.costUsd, turns });
        }
      } else if (ev.type === "cost_alert") {
        const data = ev.data as { current: number } | undefined;
        points.push({ label: new Date(ev.timestamp).toLocaleTimeString(), cost: data?.current ?? 0, turns });
      }
    }
    if (metrics && typeof metrics.estimatedCostUsd === "number") {
      points.push({
        label: new Date().toLocaleTimeString(),
        cost: metrics.estimatedCostUsd,
        turns: metrics.turns ?? turns,
      });
    }
    return points;
  }, [events, metrics]);
}

export function SandboxPanel({
  events,
  screenshots,
  task,
  metrics,
  activeProvider,
  costAlert,
  onRewind,
  onFork,
}: SandboxPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("terminal");
  const [collapsed, setCollapsed] = useState(false);

  const [filesPath, setFilesPath] = useState("/home/user/target");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [checkpoints, setCheckpoints] = useState<CheckpointItem[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);

  const [diff, setDiff] = useState<{ files: DiffFile[]; aheadBy?: number; behindBy?: number } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [trace, setTrace] = useState<{ traceUrl: string; trace?: Record<string, unknown> } | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const terminalHtml = useMemo(() => buildTerminalHtml(events), [events]);
  const costData = useCostData(events, metrics);

  useEffect(() => {
    if (!task?.id) return;
    if (activeTab === "files") {
      setFilesLoading(true);
      fetch(`/api/tasks/${task.id}/files?path=${encodeURIComponent(filesPath)}`)
        .then((r) => r.json())
        .then((data) => {
          setFiles(Array.isArray(data.entries) ? data.entries : []);
          setFilesError(data.error ?? null);
        })
        .catch((err) => setFilesError(String(err)))
        .finally(() => setFilesLoading(false));
    }
    if (activeTab === "checkpoints") {
      setCheckpointsLoading(true);
      fetch(`/api/tasks/${task.id}/checkpoints`)
        .then((r) => r.json())
        .then((data) => setCheckpoints(Array.isArray(data) ? data : []))
        .finally(() => setCheckpointsLoading(false));
    }
    if (activeTab === "diff") {
      setDiffLoading(true);
      fetch(`/api/tasks/${task.id}/diff`)
        .then((r) => r.json())
        .then((data) => setDiff(data))
        .finally(() => setDiffLoading(false));
    }
    if (activeTab === "trace") {
      setTraceLoading(true);
      fetch(`/api/tasks/${task.id}/trace`)
        .then((r) => {
          if (!r.ok) throw new Error(`trace fetch failed: ${r.status}`);
          return r.json();
        })
        .then((data) => setTrace(data as { traceUrl: string; trace?: Record<string, unknown> }))
        .catch(() => setTrace(null))
        .finally(() => setTraceLoading(false));
    }
  }, [activeTab, task?.id, filesPath]);

  function handleFork(checkpointId: string) {
    const prompt = window.prompt("Prompt for the forked branch:");
    if (!prompt) return;
    onFork?.(checkpointId, prompt);
  }

  function handleRewind(checkpointId: string) {
    const prompt = window.prompt("Prompt for the rewinded turn:");
    if (!prompt) return;
    onRewind?.(checkpointId, prompt);
  }

  const latestScreenshot = screenshots[screenshots.length - 1];

  const activeTabLabel = tabs.find((t) => t.id === activeTab)?.label ?? activeTab;

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-l border-db-border bg-db-surface transition-all duration-200",
        collapsed ? "w-14 items-center" : "w-full md:w-96",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center justify-between border-b border-db-border px-3",
          collapsed && "justify-center",
        )}
      >
        {!collapsed && <span className="text-sm font-semibold text-db-text">{activeTabLabel}</span>}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand panel" : "Collapse panel"}
          className="rounded p-1 text-db-text-secondary transition-colors hover:bg-db-subtle"
        >
          <PanelRight className={cn("h-4 w-4", collapsed && "rotate-180")} />
        </button>
      </div>

      {!collapsed && (
        <div className="flex gap-1 overflow-x-auto border-b border-db-border px-2 py-2 scrollbar-thin">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  activeTab === tab.id
                    ? "bg-db-accent/10 text-db-accent"
                    : "text-db-text-secondary hover:bg-db-subtle",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {collapsed ? (
          <div className="flex h-full flex-col items-center gap-4 py-4">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.id);
                    setCollapsed(false);
                  }}
                  title={tab.label}
                  className={cn(
                    "rounded p-2 transition-colors",
                    activeTab === tab.id ? "text-db-accent" : "text-db-text-secondary hover:bg-db-subtle",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        ) : (
          <Suspense fallback={<Placeholder title={activeTabLabel}>Loading…</Placeholder>}>
            {activeTab === "terminal" && <TerminalTab html={terminalHtml} />}
            {activeTab === "browser" && <BrowserTab screenshots={screenshots} latestScreenshot={latestScreenshot} />}
            {activeTab === "files" && (
              <FilesTab
                files={files}
                filesPath={filesPath}
                loading={filesLoading}
                error={filesError}
                onChangePath={setFilesPath}
              />
            )}
            {activeTab === "checkpoints" && (
              <CheckpointsTab
                checkpoints={checkpoints}
                loading={checkpointsLoading}
                onRewind={handleRewind}
                onFork={handleFork}
              />
            )}
            {activeTab === "trace" && <TraceTab trace={trace} loading={traceLoading} />}
            {activeTab === "costs" && <CostsTab costAlert={costAlert} metrics={metrics} costData={costData} />}
            {activeTab === "diff" && <DiffTab diff={diff} loading={diffLoading} />}
          </Suspense>
        )}
      </div>
    </aside>
  );
}
