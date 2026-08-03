import type { ChatMessage, StreamEvent, TaskMetrics } from "./types.js";
import { generateId } from "./utils.js";
import { formatEvent } from "./format.js";

export function createUserMessage(content: string, taskId?: string): ChatMessage {
  return {
    id: generateId(),
    taskId,
    role: "user",
    type: "text",
    content,
    createdAt: Date.now(),
    status: "complete",
  };
}

function updateRunningAssistantStatus(
  prev: ChatMessage[],
  status: "complete" | "error",
): ChatMessage[] {
  return prev.map((m) =>
    m.role === "assistant" && m.status === "running" ? { ...m, status } : m,
  );
}

export function appendEvent(prev: ChatMessage[], event: StreamEvent): ChatMessage[] {
  const timestamp = event.timestamp || Date.now();

  if (event.type === "user_message") {
    const data = event.data as { messageId?: string; content?: string; role?: string } | undefined;
    const messageId = data?.messageId || generateId();
    if (prev.some((m) => m.id === messageId)) return prev;
    return [
      ...prev,
      {
        id: messageId,
        role: (data?.role as "user") || "user",
        type: "text",
        content: data?.content || "",
        createdAt: timestamp,
        status: "complete" as const,
      },
    ];
  }

  if (event.type === "message_update") {
    const data = event.data as { kind?: string; delta?: string };
    if (data.kind === "complete" || data.kind === "done") {
      return updateRunningAssistantStatus(prev, "complete");
    }
    const delta = data.delta?.trimEnd() ?? "";
    if (!delta) {
      if (data.kind) {
        return [
          ...prev,
          {
            id: generateId(),
            role: "assistant",
            type: "text",
            content: data.kind,
            createdAt: timestamp,
            status: "running" as const,
          },
        ];
      }
      return prev;
    }
    const last = prev[prev.length - 1];
    if (last && last.role === "assistant" && last.type === "text") {
      const updated: ChatMessage = {
        ...last,
        content: `${last.content as string}${delta}`,
        status: "running" as const,
      };
      return [...prev.slice(0, -1), updated];
    }
    return [
      ...prev,
      {
        id: generateId(),
        role: "assistant",
        type: "text",
        content: delta,
        createdAt: timestamp,
        status: "running" as const,
      },
    ];
  }

  if (event.type === "tool_execution_start") {
    const data = event.data as { toolName?: string; args?: unknown };
    return [
      ...prev,
      {
        id: generateId(),
        role: "tool",
        type: "tool_call",
        content: { toolName: data.toolName, args: data.args, status: "pending" },
        createdAt: timestamp,
        status: "pending" as const,
      },
    ];
  }

  if (event.type === "tool_execution_end") {
    const data = event.data as { toolName?: string; isError?: boolean; result?: unknown };
    return [
      ...prev,
      {
        id: generateId(),
        role: "tool",
        type: "tool_result",
        content: {
          toolName: data.toolName,
          isError: data.isError,
          result: data.result,
          status: data.isError ? "error" : "complete",
        },
        createdAt: timestamp,
        status: data.isError ? ("error" as const) : ("complete" as const),
      },
    ];
  }

  if (event.type === "browser_screenshot") {
    const data = event.data as { screenshot?: string; url?: string; mimeType?: string };
    if (!data.screenshot) return prev;
    const mimeType = data.mimeType || "image/png";
    return [
      ...prev,
      {
        id: generateId(),
        role: "artifact",
        type: "text",
        content: {
          dataUrl: `data:${mimeType};base64,${data.screenshot}`,
          url: data.url,
        },
        createdAt: timestamp,
      },
    ];
  }

  if (event.type === "checkpoint_created") {
    const data = event.data as { turn?: number; checkpointId?: string; gitCommit?: string; costUsd?: number };
    return [
      ...prev,
      {
        id: generateId(),
        role: "system",
        type: "checkpoint",
        content: data,
        createdAt: timestamp,
      },
    ];
  }

  if (event.type === "cost_alert") {
    const data = event.data as { current: number; limit: number; threshold: number };
    return [
      ...prev,
      {
        id: generateId(),
        role: "system",
        type: "cost_alert",
        content: data,
        createdAt: timestamp,
      },
    ];
  }

  if (event.type === "task_complete" || event.type === "task_failed") {
    const data = event.data as {
      success?: boolean;
      error?: string;
      provider?: string;
      metrics?: TaskMetrics;
    };
    const newStatus = event.type === "task_complete" ? ("complete" as const) : ("error" as const);
    return [
      ...updateRunningAssistantStatus(prev, newStatus),
      {
        id: generateId(),
        role: "system",
        type: "status",
        content: { event: event.type, ...data },
        createdAt: timestamp,
        status: newStatus,
      },
    ];
  }

  if (event.type === "task_start" || event.type === "task_pending") {
    const data = event.data as { repo?: string; branch?: string };
    return [
      ...prev,
      {
        id: generateId(),
        role: "system",
        type: "status",
        content: formatEvent(event),
        createdAt: timestamp,
      },
    ];
  }

  return [
    ...prev,
    {
      id: generateId(),
      role: "system",
      type: "status",
      content: formatEvent(event),
      createdAt: timestamp,
    },
  ];
}

export function buildMessagesFromEvents(events: StreamEvent[], userPrompt?: string): ChatMessage[] {
  let messages: ChatMessage[] = [];
  if (userPrompt) {
    messages = [createUserMessage(userPrompt)];
  }
  for (const event of events) {
    messages = appendEvent(messages, event);
  }
  return messages;
}
