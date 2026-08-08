import { useEffect, useMemo, useRef, useState } from "react";
import { Wifi, WifiOff, X } from "lucide-react";
import { cn } from "./lib/utils.js";
import { ChatLayout } from "./components/chat/ChatLayout.js";
import { ConversationSidebar } from "./components/chat/ConversationSidebar.js";
import { ChatHeader } from "./components/chat/ChatHeader.js";
import { ChatThread } from "./components/chat/ChatThread.js";
import { Composer } from "./components/chat/Composer.js";
import { SandboxPanel } from "./components/chat/SandboxPanel.js";
import { LegacyRunView } from "./components/chat/LegacyRunView.js";
import { Button } from "./components/base/Button.js";
import { Card, CardContent } from "./components/base/Card.js";
import { CostDashboard } from "./CostDashboard.js";
import { TraceView } from "./TraceView.js";
import { TimeTravelView } from "./TimeTravelView.js";
import { CiHealView } from "./CiHealView.js";
import { DeadLetterView } from "./DeadLetterView.js";
import { CleanupView } from "./CleanupView.js";
import { Dialog } from "./components/base/Dialog.js";
import type { Config, QueueStatus, Screenshot, StreamEvent, Task, TaskMetrics, ChatMessage } from "./lib/types.js";
import { formatDuration, statusBadgeVariant } from "./lib/format.js";
import { createUserMessage, appendEvent, buildMessagesFromEvents } from "./lib/messages.js";
import type { ViewId } from "./components/Sidebar.js";

function getInitialTaskId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("taskId");
}

function getInitialView(): "chat" | ViewId {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "chat") return "chat";
  const valid: ViewId[] = ["run", "tasks", "trace", "time-travel", "costs", "ci-heal", "dead-letter", "cleanup"];
  return valid.includes(view as ViewId) ? (view as ViewId) : "chat";
}

function updateUrl(view: "chat" | ViewId, taskId: string | null) {
  const params = new URLSearchParams();
  if (view !== "chat") params.set("view", view);
  if (taskId) params.set("taskId", taskId);
  const qs = params.toString();
  window.history.replaceState({}, "", qs ? `?${qs}` : window.location.pathname);
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

export function App() {
  const [activeView, setActiveView] = useState<"chat" | ViewId>(getInitialView);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(getInitialTaskId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prBranch, setPrBranch] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<TaskMetrics | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [costAlert, setCostAlert] = useState<{ current: number; limit: number; threshold: number } | null>(null);

  const [repo, setRepo] = useState("https://github.com/bezaspace/daybreak-target");
  const [branch, setBranch] = useState("main");
  const [composerPrompt, setComposerPrompt] = useState("");
  const [mode, setMode] = useState<"plan" | "interactive" | "autopilot">("autopilot");
  const [helpOpen, setHelpOpen] = useState(false);

  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [streamConnected, setStreamConnected] = useState(false);
  interface Toast {
    id: string;
    message: string;
    type: "info" | "success" | "error";
  }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const previousTasksRef = useRef<Task[]>([]);

  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState("operator");
  const [userId, setUserId] = useState("");

  function tenantHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (tenantId) headers["X-Daybreak-Tenant-Id"] = tenantId;
    if (role) headers["X-Daybreak-Role"] = role;
    if (userId) headers["X-Daybreak-User-Id"] = userId;
    return headers;
  }

  function addToast(message: string, type: Toast["type"] = "info") {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }

  function detectToasts(next: Task[], prev: Task[]) {
    const prevMap = new Map(prev.map((t) => [t.id, t.status]));
    for (const task of next) {
      const previousStatus = prevMap.get(task.id);
      if (previousStatus && previousStatus !== task.status) {
        const label = `${repoName(task.repo)} @ ${task.branch}`;
        if (["complete", "promoted"].includes(task.status)) {
          addToast(`Task complete: ${label}`, "success");
        } else if (["failed", "abandoned", "cancelled"].includes(task.status)) {
          addToast(`Task ${task.status}: ${label}`, "error");
        }
      }
    }
  }

  function loadTasks() {
    fetch("/api/tasks", { headers: tenantHeaders() })
      .then((r) => r.json())
      .then((data) => {
        const next = Array.isArray(data) ? (data as Task[]) : [];
        detectToasts(next, previousTasksRef.current);
        previousTasksRef.current = next;
        setTasks(next);
      })
      .catch(() => {});
  }

  function loadConfig() {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setConfig(data as Config))
      .catch(() => {});
  }

  function loadQueueStatus() {
    fetch("/api/queue/status")
      .then((r) => r.json())
      .then((data) => setQueueStatus(data as QueueStatus))
      .catch(() => {});
  }

  async function loadTaskAndMessages(taskId: string): Promise<Task | undefined> {
    try {
      const [taskRes, eventsRes, messagesRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/events`),
        fetch(`/api/tasks/${taskId}/messages`),
      ]);
      if (taskRes.status === 404) {
        setStatus("idle");
        setActiveTaskId(null);
        return undefined;
      }
      const task = (await taskRes.json()) as Task | undefined;
      const history = (await eventsRes.json()) as StreamEvent[] | undefined;
      const serverMessages = (await messagesRes.json()) as ChatMessage[] | undefined;
      if (task) {
        setStatus(task.status);
        if (task.provider) setActiveProvider(task.provider);
        if (typeof task.costUsd === "number") setMetrics((m) => ({ ...m, estimatedCostUsd: task.costUsd }));
        if (task.prUrl) setPrUrl(task.prUrl);
        if (task.prBranch) setPrBranch(task.prBranch);
      }
      setEvents(Array.isArray(history) ? history : []);
      setMessages(
        Array.isArray(serverMessages) && serverMessages.length > 0
          ? serverMessages
          : buildMessagesFromEvents(history || [], task?.prompt),
      );
      setScreenshots(extractScreenshots(history || []));
      return task;
    } catch {
      // ignore
    }
  }

  function extractScreenshots(history: StreamEvent[]): Screenshot[] {
    const out: Screenshot[] = [];
    for (const event of history) {
      if (event.type === "browser_screenshot") {
        const data = event.data as { screenshot?: string; url?: string; mimeType?: string };
        if (data.screenshot) {
          const mimeType = data.mimeType || "image/png";
          out.push({
            dataUrl: `data:${mimeType};base64,${data.screenshot}`,
            url: data.url,
            timestamp: event.timestamp,
          });
        }
      }
    }
    return out;
  }

  useEffect(() => {
    loadTasks();
    loadConfig();
    loadQueueStatus();
    const interval = setInterval(() => {
      loadTasks();
      loadQueueStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const online = () => {
      setIsOnline(true);
      addToast("Connection restored", "success");
      loadTasks();
    };
    const offline = () => {
      setIsOnline(false);
      addToast("You are offline", "error");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  const selectedTask = useMemo(() => tasks.find((t) => t.id === activeTaskId), [tasks, activeTaskId]);

  useEffect(() => {
    if (selectedTask) {
      setRepo(selectedTask.repo);
      setBranch(selectedTask.branch);
      const taskMode = selectedTask.metadata?.mode as string | undefined;
      if (taskMode === "plan" || taskMode === "interactive" || taskMode === "autopilot") {
        setMode(taskMode);
      }
    }
  }, [selectedTask]);

  useEffect(() => {
    if (!activeTaskId) return;
    setEvents([]);
    setMessages([]);
    setScreenshots([]);
    setMetrics(null);
    setCostAlert(null);
    setStatus("loading");
    setPrUrl(null);
    setPrBranch(null);

    let es: EventSource | null = null;

    loadTaskAndMessages(activeTaskId).then((task) => {
      // Only open the SSE stream for actually-running tasks
      if (!task || task.status !== "running") return;

      es = new EventSource(`/api/tasks/${activeTaskId}/stream`);
      es.onmessage = (message) => {
        if (!message.data) return;
        try {
          const event = JSON.parse(message.data) as StreamEvent;
          setEvents((prev) => [...prev, event]);
          setMessages((prev) => appendEvent(prev, event));
          if (event.type === "browser_screenshot") {
            const data = event.data as { screenshot?: string; url?: string; mimeType?: string };
            if (data.screenshot) {
              const mimeType = data.mimeType || "image/png";
              setScreenshots((prev) => [
                ...prev,
                { dataUrl: `data:${mimeType};base64,${data.screenshot}`, url: data.url, timestamp: event.timestamp },
              ]);
            }
          }
          if (event.type === "pr_created") {
            const data = event.data as { prUrl?: string; prBranch?: string };
            if (data.prUrl) {
              setPrUrl(data.prUrl);
              setPrBranch(data.prBranch || null);
              loadTasks();
              es?.close();
            }
          }
          if (event.type === "task_complete") {
            setStatus("complete");
            const data = event.data as { metrics?: TaskMetrics; provider?: string; traceId?: string };
            if (data.metrics) setMetrics(data.metrics);
            if (data.provider) setActiveProvider(data.provider);
            if (data.traceId) loadTasks();
          }
          if (event.type === "task_failed") {
            setStatus("failed");
            const data = event.data as { metrics?: TaskMetrics; error?: string; provider?: string };
            if (data.metrics) setMetrics(data.metrics);
            if (data.provider) setActiveProvider(data.provider);
          }
          if (event.type === "cost_alert") {
            const data = event.data as { current: number; limit: number; threshold: number };
            setCostAlert(data);
          }
        } catch {
          // ignore heartbeat or malformed
        }
      };

      es.onopen = () => setStreamConnected(true);
      es.onerror = () => {
        setStreamConnected(false);
      };
    });

    return () => {
      setStreamConnected(false);
      es?.close();
    };
  }, [activeTaskId]);

  useEffect(() => {
    updateUrl(activeView, activeTaskId);
  }, [activeView, activeTaskId]);

  async function startTask(startRepo: string, startBranch: string, startPrompt: string) {
    setStatus("starting");
    const body: Record<string, unknown> = { repo: startRepo, branch: startBranch, mode };
    if (startPrompt.trim()) body.prompt = startPrompt.trim();
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenantHeaders() },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { taskId?: string; error?: string };
    if (data.taskId) {
      setActiveTaskId(data.taskId);
      setActiveView("chat");
      setMessages(startPrompt.trim() ? [createUserMessage(startPrompt.trim(), data.taskId)] : []);
      setEvents([]);
      setScreenshots([]);
      setMetrics(null);
      setCostAlert(null);
      setStatus("running");
      setComposerPrompt("");
    } else {
      setStatus("error: " + (data.error || "unknown"));
    }
  }

  async function cancelTask(id: string) {
    await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
    loadTasks();
    loadQueueStatus();
  }

  async function sendFollowUp(taskId: string, content: string) {
    const method = mode === "interactive" ? "steer" : "followUp";
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tenantHeaders() },
        body: JSON.stringify({ content, method }),
      });
      if (!res.ok) return;
      const message = (await res.json()) as ChatMessage;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      setComposerPrompt("");
    } catch {
      // ignore
    }
  }

  function handleComposerSubmit() {
    if (!composerPrompt.trim() || (!activeTaskId && !repo.trim())) return;
    if (activeTaskId && isRunning) {
      sendFollowUp(activeTaskId, composerPrompt.trim());
    } else {
      startTask(repo, branch, composerPrompt);
    }
  }

  async function handleFork(checkpointId: string, prompt: string) {
    const res = await fetch(`/api/checkpoints/${checkpointId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenantHeaders() },
      body: JSON.stringify({ prompt }),
    });
    const data = (await res.json()) as { taskId?: string; error?: string };
    if (data.taskId) {
      setActiveTaskId(data.taskId);
      setActiveView("chat");
    } else {
      setStatus(data.error ?? "fork failed");
    }
  }

  async function handleRewind(checkpointId: string, prompt: string) {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/rewind`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenantHeaders() },
      body: JSON.stringify({ checkpointId, prompt }),
    });
  }

  async function handleApprovalAction(action: "approved" | "rejected" | "approveAlways", toolCallId: string) {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolCallId, action }),
    });
  }

  function handleComposerCommand(command: string) {
    if (command === "costs") setActiveView("costs");
    if (command === "cancel" && activeTaskId) cancelTask(activeTaskId);
    if (command === "help") setHelpOpen(true);
  }

  async function handleTaskAction(taskId: string, action: "archive" | "unarchive" | "delete") {
    try {
      if (action === "delete") {
        await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
        if (activeTaskId === taskId) handleNewSession();
      } else {
        await fetch(`/api/tasks/${taskId}/${action}`, { method: "POST" });
      }
      await loadTasks();
    } catch {
      // ignore
    }
  }

  function handleNewSession() {
    setActiveView("chat");
    setActiveTaskId(null);
    setComposerPrompt("");
    setEvents([]);
    setMessages([]);
    setScreenshots([]);
    setMetrics(null);
    setCostAlert(null);
    setStatus("idle");
    setPrUrl(null);
    setPrBranch(null);
  }

  function handleSelectTask(taskId: string) {
    setActiveView("chat");
    setActiveTaskId(taskId);
  }

  function handleNavigate(view: "chat" | ViewId) {
    setActiveView(view);
  }

  const isRunning = status === "starting" || status === "running";

  const center =
    activeView === "chat" ? (
      <>
        {selectedTask && <ChatHeader task={selectedTask} status={status} isRunning={isRunning} onCancel={() => activeTaskId && cancelTask(activeTaskId)} />}
        <ChatThread messages={messages} isStreaming={isRunning} task={selectedTask || null} onApprovalAction={handleApprovalAction} />
        <Composer
          repo={repo}
          branch={branch}
          prompt={composerPrompt}
          mode={mode}
          isRunning={isRunning}
          taskSelected={!!selectedTask}
          task={selectedTask}
          disabled={!!selectedTask && !isRunning}
          disabledReason={selectedTask ? "Task is not running" : undefined}
          onRepoChange={setRepo}
          onBranchChange={setBranch}
          onPromptChange={setComposerPrompt}
          onModeChange={setMode}
          onSubmit={handleComposerSubmit}
          onCommand={handleComposerCommand}
        />
      </>
    ) : (
      <div className="h-full overflow-y-auto p-6">
        {activeView === "run" && <LegacyRunView isRunning={isRunning} onStart={startTask} />}
        {activeView === "tasks" && (
          <Card>
            <CardContent className="py-8 text-center text-db-text-secondary">
              Full task list and filters are planned for Phase 7.
              <br />
              Use the sessions list in the left sidebar for now.
            </CardContent>
          </Card>
        )}
        {activeView === "trace" && selectedTask?.traceId ? (
          <TraceView
            taskId={selectedTask.id}
            traceId={selectedTask.traceId}
            provider={selectedTask.provider}
            costUsd={selectedTask.costUsd}
          />
        ) : activeView === "trace" ? (
          <Card><CardContent>Select a session with a trace.</CardContent></Card>
        ) : null}
        {activeView === "time-travel" && activeTaskId ? (
          <TimeTravelView taskId={activeTaskId} />
        ) : activeView === "time-travel" ? (
          <Card><CardContent>Select a session to explore checkpoints.</CardContent></Card>
        ) : null}
        {activeView === "costs" && <CostDashboard />}
        {activeView === "ci-heal" && <CiHealView tasks={tasks} />}
        {activeView === "dead-letter" && <DeadLetterView />}
        {activeView === "cleanup" && <CleanupView />}

        {config && activeView !== "run" && (
          <div className="mt-4 text-xs text-db-text-secondary">
            Circuit breakers: {config.maxTurns} turns · {config.maxWallClockMinutes} min · ${config.maxCostUsd} ·
            compaction {config.compactionEnabled ? "on" : "off"}
            {config.e2bTemplate ? ` · template ${config.e2bTemplate}` : ""} · max concurrency {config.maxConcurrentTasks}
            · cleanup {config.cleanupEnabled ? "on" : "off"} ({config.branchTtlDays}d / {config.sandboxIdleTtlMinutes}m / {config.dataRetentionDays}d)
          </div>
        )}
        {queueStatus && activeView !== "run" && (
          <div className="mt-1 text-xs text-db-text-secondary">
            Queue: {queueStatus.pending} pending · {queueStatus.running} running · limit {queueStatus.maxConcurrent} · worker{" "}
            {queueStatus.workerEnabled ? "on" : "off"}
          </div>
        )}
      </div>
    );

  return (
    <>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen} title="Composer shortcuts">
        <div className="space-y-2 text-sm text-db-text-secondary">
          <p><code className="rounded bg-db-elevated px-1 text-db-text">@repo</code> autocomplete allowed repos</p>
          <p><code className="rounded bg-db-elevated px-1 text-db-text">@file</code> autocomplete files in the checked-out repo</p>
          <p><code className="rounded bg-db-elevated px-1 text-db-text">#123</code> autocomplete issues and PRs</p>
          <p><code className="rounded bg-db-elevated px-1 text-db-text">/plan</code>, <code className="rounded bg-db-elevated px-1 text-db-text">/interactive</code>, <code className="rounded bg-db-elevated px-1 text-db-text">/auto</code> switch mode</p>
          <p><code className="rounded bg-db-elevated px-1 text-db-text">/costs</code>, <code className="rounded bg-db-elevated px-1 text-db-text">/cancel</code>, <code className="rounded bg-db-elevated px-1 text-db-text">/help</code> open views or actions</p>
          <p>Paste or attach images to include them as markdown in your message.</p>
        </div>
      </Dialog>
      <ChatLayout
      left={
        <ConversationSidebar
          tasks={tasks}
          activeTaskId={activeTaskId}
          activeView={activeView}
          onNewSession={handleNewSession}
          onSelectTask={handleSelectTask}
          onNavigate={handleNavigate}
          onTaskAction={handleTaskAction}
        />
      }
      center={center}
      right={
        activeView === "chat" ? (
          <SandboxPanel
            events={events}
            screenshots={screenshots}
            task={selectedTask || null}
            metrics={metrics}
            activeProvider={activeProvider}
            costAlert={costAlert}
            onRewind={handleRewind}
            onFork={handleFork}
          />
        ) : undefined
      }
    />

      {!isOnline && (
        <div className="fixed left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-db-border bg-db-surface px-3 py-1.5 text-xs font-medium text-db-text shadow-lg">
          <WifiOff className="h-3.5 w-3.5 text-db-danger" />
          Offline — changes will queue
        </div>
      )}
      {isOnline && activeTaskId && !streamConnected && (
        <div className="fixed left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-db-border bg-db-surface px-3 py-1.5 text-xs font-medium text-db-text shadow-lg">
          <Wifi className="h-3.5 w-3.5 animate-pulse text-db-warning" />
          Reconnecting…
        </div>
      )}

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                "flex items-center justify-between rounded-md border px-3 py-2 text-xs font-medium shadow-lg",
                toast.type === "success" && "border-db-success/20 bg-db-success/10 text-db-success",
                toast.type === "error" && "border-db-danger/20 bg-db-danger/10 text-db-danger",
                toast.type === "info" && "border-db-border bg-db-surface text-db-text",
              )}
            >
              <span className="line-clamp-2">{toast.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                className="ml-2 rounded p-1 hover:bg-black/10"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
