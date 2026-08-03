import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanelRight,
  Terminal,
  Image as ImageIcon,
  FolderTree,
  History,
  GitBranch,
  DollarSign,
  FileDiff,
  Folder,
  File,
  ChevronLeft,
  ExternalLink,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "../../lib/utils.js";
import { formatCost } from "../../lib/format.js";
import { ansiToHtml } from "../../lib/ansi.js";
import type { Screenshot, StreamEvent, Task, TaskMetrics } from "../../lib/types.js";

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

function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-db-text-secondary">
      <h3 className="mb-1 font-medium text-db-text">{title}</h3>
      {children || <p>Not available.</p>}
    </div>
  );
}

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | string;
  size?: number;
}

interface CheckpointItem {
  id: string;
  turn: number;
  timestamp: number;
  gitCommit?: string;
  costUsd?: number;
  status: string;
  toolCallId?: string;
}

interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

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
  const terminalRef = useRef<HTMLDivElement>(null);

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
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalHtml]);

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

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-l border-db-border bg-db-surface transition-all duration-200",
        collapsed ? "w-14 items-center" : "w-full md:w-96",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-db-border px-3",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {!collapsed && <span className="text-sm font-semibold text-db-text">Sandbox</span>}
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
                title={tab.label}
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
                    setCollapsed(false);
                    setActiveTab(tab.id);
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
        ) : activeTab === "terminal" ? (
          <div
            ref={terminalRef}
            className="h-full overflow-auto bg-black p-3 font-mono text-xs leading-relaxed text-green-400 scrollbar-thin"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: terminalHtml || '<span class="opacity-50">No terminal output yet.</span>' }}
          />
        ) : activeTab === "browser" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {screenshots.length === 0 ? (
              <Placeholder title="Browser">No screenshots yet.</Placeholder>
            ) : (
              <div className="space-y-3">
                {latestScreenshot?.url && (
                  <div className="text-xs text-db-text-tertiary">
                    URL: <a href={latestScreenshot.url} target="_blank" rel="noreferrer" className="text-db-accent hover:underline">{latestScreenshot.url}</a>
                  </div>
                )}
                {screenshots.map((s, i) => (
                  <div key={i}>
                    <img
                      src={s.dataUrl}
                      alt={s.url ? `Screenshot ${i + 1} of ${s.url}` : `Screenshot ${i + 1}`}
                      className="w-full rounded border border-db-border"
                    />
                    <div className="mt-1 text-xs text-db-text-tertiary">{s.url || "Browser screenshot"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === "files" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {filesLoading ? (
              <Placeholder title="Files">Loading…</Placeholder>
            ) : filesError ? (
              <Placeholder title="Files">{filesError}</Placeholder>
            ) : files.length === 0 ? (
              <Placeholder title="Files">No files listed.</Placeholder>
            ) : (
              <div className="space-y-1">
                <div className="mb-2 flex items-center gap-2 text-xs text-db-text-secondary">
                  <button
                    type="button"
                    onClick={() => setFilesPath("/home/user/target")}
                    className="hover:text-db-accent"
                  >
                    target
                  </button>
                  <span className="text-db-text-tertiary">{filesPath.replace("/home/user/target", "")}</span>
                </div>
                {filesPath !== "/home/user/target" && (
                  <button
                    type="button"
                    onClick={() => setFilesPath(filesPath.split("/").slice(0, -1).join("/") || "/home/user/target")}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-db-text-secondary hover:bg-db-subtle"
                  >
                    <ChevronLeft className="h-4 w-4" /> Parent
                  </button>
                )}
                {files
                  .slice()
                  .sort((a, b) => (a.type === "dir" ? -1 : 1) - (b.type === "dir" ? -1 : 1) || a.name.localeCompare(b.name))
                  .map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => entry.type === "dir" && setFilesPath(entry.path)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
                        entry.type === "dir"
                          ? "text-db-text hover:bg-db-subtle"
                          : "text-db-text-secondary hover:bg-db-subtle",
                      )}
                    >
                      {entry.type === "dir" ? <Folder className="h-4 w-4 text-db-warning" /> : <File className="h-4 w-4 text-db-accent" />}
                      <span className="truncate">{entry.name}</span>
                      {typeof entry.size === "number" && entry.size > 0 && (
                        <span className="ml-auto text-xs text-db-text-tertiary">{entry.size}B</span>
                      )}
                    </button>
                  ))}
              </div>
            )}
          </div>
        ) : activeTab === "checkpoints" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {checkpointsLoading ? (
              <Placeholder title="Checkpoints">Loading…</Placeholder>
            ) : checkpoints.length === 0 ? (
              <Placeholder title="Checkpoints">No checkpoints yet.</Placeholder>
            ) : (
              <div className="space-y-2">
                {checkpoints.map((cp) => (
                  <div
                    key={cp.id}
                    className="rounded border border-db-border bg-db-elevated p-2 text-xs"
                  >
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
                        onClick={() => handleRewind(cp.id)}
                        className="rounded bg-db-accent/10 px-2 py-1 text-db-accent hover:bg-db-accent/20"
                      >
                        Rewind
                      </button>
                      <button
                        type="button"
                        onClick={() => handleFork(cp.id)}
                        className="rounded bg-db-subtle px-2 py-1 text-db-text hover:bg-db-border"
                      >
                        Fork
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === "trace" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {traceLoading ? (
              <Placeholder title="Trace">Loading…</Placeholder>
            ) : !trace?.traceUrl ? (
              <Placeholder title="Trace">No trace for this session.</Placeholder>
            ) : (
              <div className="space-y-2 text-sm">
                <a
                  href={trace.traceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-db-accent hover:underline"
                >
                  Open in Langfuse <ExternalLink className="h-3 w-3" />
                </a>
                {trace.trace && (
                  <pre className="max-h-96 overflow-auto rounded border border-db-border bg-db-elevated p-2 text-xs text-db-text-secondary scrollbar-thin">
                    {JSON.stringify(trace.trace, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        ) : activeTab === "costs" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {costAlert && (
              <div className="mb-3 rounded border border-db-warning/30 bg-db-warning/5 p-2 text-xs text-db-warning">
                Cost alert: {formatCost(costAlert.current)} / {formatCost(costAlert.limit)} (threshold {costAlert.threshold})
              </div>
            )}
            {metrics && (
              <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-db-text-secondary">
                <div className="rounded border border-db-border bg-db-elevated p-2">
                  <div className="text-db-text-tertiary">Turns</div>
                  <div className="text-lg font-medium text-db-text">{metrics.turns ?? "-"}</div>
                </div>
                <div className="rounded border border-db-border bg-db-elevated p-2">
                  <div className="text-db-text-tertiary">Cost</div>
                  <div className="text-lg font-medium text-db-text">{formatCost(metrics.estimatedCostUsd)}</div>
                </div>
                <div className="rounded border border-db-border bg-db-elevated p-2">
                  <div className="text-db-text-tertiary">Tool calls</div>
                  <div className="text-lg font-medium text-db-text">{metrics.toolCalls ?? "-"}</div>
                </div>
                <div className="rounded border border-db-border bg-db-elevated p-2">
                  <div className="text-db-text-tertiary">Tokens</div>
                  <div className="text-lg font-medium text-db-text">{metrics.totalTokens ?? "-"}</div>
                </div>
              </div>
            )}
            {costData.length > 0 ? (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={costData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="label" tick={{ fill: "#9ca3af", fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis yAxisId="left" tick={{ fill: "#9ca3af", fontSize: 10 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fill: "#9ca3af", fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#1f2937", borderColor: "#374151" }}
                      itemStyle={{ color: "#e5e7eb" }}
                    />
                    <Legend wrapperStyle={{ color: "#9ca3af" }} />
                    <Line yAxisId="left" type="monotone" dataKey="cost" name="Cost (USD)" stroke="#22c55e" dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="turns" name="Turns" stroke="#3b82f6" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Placeholder title="Costs">No cost data for this session.</Placeholder>
            )}
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {diffLoading ? (
              <Placeholder title="Diff">Loading…</Placeholder>
            ) : !diff || diff.files.length === 0 ? (
              <Placeholder title="Diff">No diff available.</Placeholder>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="text-xs text-db-text-secondary">
                  {diff.aheadBy ?? 0} ahead, {diff.behindBy ?? 0} behind
                </div>
                {diff.files.map((file) => (
                  <div key={file.filename} className="rounded border border-db-border bg-db-elevated">
                    <div className="flex items-center justify-between border-b border-db-border px-2 py-1 text-xs">
                      <span className="font-medium text-db-text truncate" title={file.filename}>{file.filename}</span>
                      <span className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] uppercase",
                        file.status === "added" && "bg-green-500/10 text-green-400",
                        file.status === "removed" && "bg-red-500/10 text-red-400",
                        file.status === "modified" && "bg-blue-500/10 text-blue-400",
                        file.status === "renamed" && "bg-purple-500/10 text-purple-400",
                      )}>
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
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
