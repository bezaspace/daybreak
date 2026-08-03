import { useEffect, useMemo, useState } from "react";
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

  function loadTasks() {
    fetch("/api/tasks", { headers: tenantHeaders() })
      .then((r) => r.json())
      .then((data) => setTasks(Array.isArray(data) ? data : []))
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

  async function loadTaskAndMessages(taskId: string) {
    try {
      const [taskRes, eventsRes, messagesRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/events`),
        fetch(`/api/tasks/${taskId}/messages`),
      ]);
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

  const selectedTask = useMemo(() => tasks.find((t) => t.id === activeTaskId), [tasks, activeTaskId]);

  useEffect(() => {
    if (!activeTaskId) return;
    setEvents([]);
    setMessages([]);
    setScreenshots([]);
    setMetrics(null);
    setCostAlert(null);
    setStatus("running");
    setPrUrl(null);
    setPrBranch(null);
    loadTaskAndMessages(activeTaskId);

    const es = new EventSource(`/api/tasks/${activeTaskId}/stream`);
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
            es.close();
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

    es.onerror = () => {
      // EventSource will auto-reconnect
    };

    return () => {
      es.close();
    };
  }, [activeTaskId]);

  useEffect(() => {
    updateUrl(activeView, activeTaskId);
  }, [activeView, activeTaskId]);

  async function startTask(startRepo: string, startBranch: string, startPrompt: string) {
    setStatus("starting");
    const body: Record<string, unknown> = { repo: startRepo, branch: startBranch };
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

  function handleComposerSubmit() {
    if (!composerPrompt.trim() || !repo.trim()) return;
    startTask(repo, branch, composerPrompt);
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
        <ChatThread messages={messages} isStreaming={isRunning} task={selectedTask || null} />
        <Composer
          repo={repo}
          branch={branch}
          prompt={composerPrompt}
          mode={mode}
          isRunning={isRunning}
          disabled={!!selectedTask}
          disabledReason="Open a new session to send another request"
          onRepoChange={setRepo}
          onBranchChange={setBranch}
          onPromptChange={setComposerPrompt}
          onModeChange={setMode}
          onSubmit={handleComposerSubmit}
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
    <ChatLayout
      left={
        <ConversationSidebar
          tasks={tasks}
          activeTaskId={activeTaskId}
          activeView={activeView}
          onNewSession={handleNewSession}
          onSelectTask={handleSelectTask}
          onNavigate={handleNavigate}
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
          />
        ) : undefined
      }
    />
  );
}
