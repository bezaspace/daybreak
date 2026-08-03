import { useState } from "react";
import { Bot, User, Wrench, AlertTriangle, Image, CheckCircle, Info } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { formatCost } from "../../lib/format.js";
import type { ChatMessage } from "../../lib/types.js";

interface MessageBubbleProps {
  message: ChatMessage;
}

function SystemStatus({ content }: { content: unknown }) {
  if (typeof content === "string") {
    return <span className="text-xs whitespace-pre-wrap">{content}</span>;
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (c.event === "task_complete") {
      const metrics = c.metrics as { estimatedCostUsd?: number; turns?: number; totalTokens?: number } | undefined;
      return (
        <span className="text-xs">
          Task complete{metrics ? ` · ${metrics.turns ?? "-"} turns · ${formatCost(metrics.estimatedCostUsd)}` : ""}
        </span>
      );
    }
    if (c.event === "task_failed") {
      return <span className="text-xs">Task failed: {String(c.error || "unknown")}</span>;
    }
    return <span className="text-xs">{JSON.stringify(content).slice(0, 200)}</span>;
  }
  return <span className="text-xs">{String(content)}</span>;
}

function CostAlert({ content }: { content: unknown }) {
  const c = content as { current: number; limit: number; threshold: number };
  return (
    <span className="text-xs">
      Cost alert: {formatCost(c.current)} / {formatCost(c.limit)} (threshold {c.threshold})
    </span>
  );
}

function Checkpoint({ content }: { content: unknown }) {
  const c = content as { turn?: number; checkpointId?: string; gitCommit?: string; costUsd?: number };
  return (
    <span className="text-xs">
      Checkpoint turn {c.turn ?? "-"} · {c.gitCommit ? c.gitCommit.slice(0, 7) : "-"} · {c.checkpointId?.slice(0, 8) ?? "-"}
      {typeof c.costUsd === "number" ? ` · ${formatCost(c.costUsd)}` : ""}
    </span>
  );
}

function Artifact({ content }: { content: unknown }) {
  const c = content as { dataUrl?: string; url?: string };
  if (!c.dataUrl) return null;
  return (
    <div className="max-w-lg">
      <img
        src={c.dataUrl}
        alt={c.url ? `Screenshot of ${c.url}` : "Artifact"}
        className="max-h-96 rounded-lg border border-db-border object-contain"
      />
      {c.url && <div className="mt-1 text-xs text-db-text-tertiary">{c.url}</div>}
    </div>
  );
}

function ToolResult({ content }: { content: unknown }) {
  const c = content as {
    toolName?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
    status?: string;
  };
  const [open, setOpen] = useState(false);
  const status = c.isError ? "error" : c.status === "pending" ? "pending" : "complete";
  return (
    <div
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-lg border bg-db-surface",
        status === "error" ? "border-db-danger/30" : "border-db-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
      >
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-db-text-tertiary" />
          <span className="font-medium text-db-text">{c.toolName || "tool"}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              status === "error" && "bg-db-danger/10 text-db-danger",
              status === "pending" && "bg-db-warning/10 text-db-warning",
              status === "complete" && "bg-db-success/10 text-db-success",
            )}
          >
            {status}
          </span>
        </div>
        <span className="text-xs text-db-text-tertiary">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-db-border px-3 py-2 text-xs">
          {c.args !== undefined && (
            <div className="mb-2">
              <div className="mb-1 text-db-text-tertiary">Args</div>
              <pre className="max-h-32 overflow-auto rounded bg-db-elevated p-2 text-db-text-secondary">
                {JSON.stringify(c.args, null, 2)}
              </pre>
            </div>
          )}
          {c.result !== undefined && (
            <div>
              <div className="mb-1 text-db-text-tertiary">Result</div>
              <pre className="max-h-48 overflow-auto rounded bg-db-elevated p-2 text-db-text-secondary">
                {JSON.stringify(c.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-start gap-2">
          <div className="rounded-2xl rounded-tr-sm bg-db-accent/10 px-4 py-2.5 text-sm text-db-text">
            <div className="whitespace-pre-wrap">{String(message.content)}</div>
          </div>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-db-accent/20">
            <User className="h-3.5 w-3.5 text-db-accent" />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="flex max-w-[85%] items-start gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-db-elevated">
            <Bot className="h-3.5 w-3.5 text-db-text-secondary" />
          </div>
          <div
            className={cn(
              "rounded-2xl rounded-tl-sm border px-4 py-2.5 text-sm text-db-text",
              message.status === "running" ? "border-db-accent/30 bg-db-surface" : "border-db-border bg-db-surface",
            )}
          >
            <div className="whitespace-pre-wrap">{String(message.content)}</div>
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "artifact") {
    return (
      <div className="flex justify-start">
        <div className="flex max-w-[85%] items-start gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-db-elevated">
            <Image className="h-3.5 w-3.5 text-db-text-secondary" />
          </div>
          <Artifact content={message.content} />
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="flex max-w-[90%] items-start gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-db-elevated">
            <Wrench className="h-3.5 w-3.5 text-db-text-secondary" />
          </div>
          <div className="min-w-0 flex-1">
            <ToolResult content={message.content} />
          </div>
        </div>
      </div>
    );
  }

  const icon =
    message.type === "cost_alert" ? (
      <AlertTriangle className="h-3.5 w-3.5 text-db-warning" />
    ) : message.type === "checkpoint" ? (
      <CheckCircle className="h-3.5 w-3.5 text-db-success" />
    ) : (
      <Info className="h-3.5 w-3.5 text-db-text-tertiary" />
    );

  return (
    <div className="flex justify-center px-4">
      <div className="flex max-w-[90%] items-center gap-2 rounded-md bg-db-elevated px-3 py-1.5 text-db-text-secondary">
        {icon}
        {message.type === "cost_alert" ? (
          <CostAlert content={message.content} />
        ) : message.type === "checkpoint" ? (
          <Checkpoint content={message.content} />
        ) : (
          <SystemStatus content={message.content} />
        )}
      </div>
    </div>
  );
}
