import { useEffect, useRef, useState } from "react";
import { PanelRight, Terminal, Image as ImageIcon, FolderTree, History, GitBranch, DollarSign, FileDiff } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { formatEvent } from "../../lib/format.js";
import type { Screenshot, StreamEvent, Task, TaskMetrics } from "../../lib/types.js";

interface SandboxPanelProps {
  events: StreamEvent[];
  screenshots: Screenshot[];
  task: Task | null;
  metrics: TaskMetrics | null;
  activeProvider: string | null;
  costAlert: { current: number; limit: number; threshold: number } | null;
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
      {children || <p>Coming in a later phase.</p>}
    </div>
  );
}

export function SandboxPanel({ events, screenshots, task, metrics, activeProvider, costAlert }: SandboxPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("terminal");
  const [collapsed, setCollapsed] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-l border-db-border bg-db-surface transition-all duration-200",
        collapsed ? "w-14 items-center" : "w-96",
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
          <pre
            ref={terminalRef}
            className="h-full overflow-auto whitespace-pre-wrap bg-black p-3 font-mono text-xs leading-relaxed text-green-400 scrollbar-thin"
          >
            {events.map((ev) => formatEvent(ev)).join("\n")}
          </pre>
        ) : activeTab === "browser" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            {screenshots.length === 0 ? (
              <Placeholder title="Browser">No screenshots yet.</Placeholder>
            ) : (
              <div className="space-y-3">
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
          <Placeholder title="Files">Sandbox file tree will appear here.</Placeholder>
        ) : activeTab === "checkpoints" ? (
          <Placeholder title="Checkpoints">Checkpoint timeline with rewind/fork will appear here.</Placeholder>
        ) : activeTab === "trace" ? (
          <Placeholder title="Trace">
            {task?.traceId ? (
              <p>
                Trace ID: <code className="text-db-text">{task.traceId}</code>
              </p>
            ) : (
              <p>No trace for this session.</p>
            )}
          </Placeholder>
        ) : activeTab === "costs" ? (
          <div className="h-full overflow-y-auto p-3 scrollbar-thin">
            <div className="space-y-2 text-sm text-db-text-secondary">
              {costAlert && (
                <div className="rounded border border-db-warning/30 bg-db-warning/5 p-2 text-xs">
                  Cost alert: ${costAlert.current.toFixed(4)} / ${costAlert.limit} (threshold {costAlert.threshold})
                </div>
              )}
              {metrics && (
                <div className="space-y-1 text-xs">
                  <div>Turns: {metrics.turns ?? "-"}</div>
                  <div>Tool calls: {metrics.toolCalls ?? "-"}</div>
                  <div>Blocked: {metrics.blockedToolCalls ?? "-"}</div>
                  <div>Tokens: {metrics.totalTokens ?? "-"}</div>
                  <div>Cost: {typeof metrics.estimatedCostUsd === "number" ? `$${metrics.estimatedCostUsd.toFixed(4)}` : "-"}</div>
                  <div>Provider: {activeProvider ?? task?.provider ?? "-"}</div>
                </div>
              )}
              {!costAlert && !metrics && <Placeholder title="Costs">No cost data for this session.</Placeholder>}
            </div>
          </div>
        ) : (
          <Placeholder title="Diff">Changed files will appear here.</Placeholder>
        )}
      </div>
    </aside>
  );
}
