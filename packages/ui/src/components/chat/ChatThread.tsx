import { useEffect, useRef } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { MessageBubble } from "./MessageBubble.js";
import type { ChatMessage, Task } from "../../lib/types.js";

interface ChatThreadProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  task: Task | null;
  onApprovalAction?: (action: "approved" | "rejected" | "approveAlways", toolCallId: string) => void;
}

export function ChatThread({ messages, isStreaming, task, onApprovalAction }: ChatThreadProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  useEffect(() => {
    if (messages.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth", align: "end" });
    }
  }, [messages.length]);

  if (!task && messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-db-elevated">
          <MessageSquare className="h-6 w-6 text-db-text-secondary" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-db-text">Start a session</h2>
        <p className="mt-1 max-w-sm text-sm text-db-text-secondary">
          Describe what you want to build or fix. The agent will clone the repo, plan, and start working.
        </p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-sm text-db-text-secondary">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Virtuoso
        ref={(r) => {
          virtuosoRef.current = r;
        }}
        data={messages}
        followOutput="smooth"
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        components={{
          Footer: () =>
            isStreaming ? (
              <div className="mx-auto max-w-3xl px-4 py-3 text-sm text-db-text-tertiary">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Agent is working…
                </div>
              </div>
            ) : (
              <div className="h-4" />
            ),
        }}
        itemContent={(_index, message) => (
          <div className="px-4 py-2">
            <div className="mx-auto max-w-3xl">
              <MessageBubble
                message={message}
                taskId={task?.id}
                onApprovalAction={onApprovalAction}
              />
            </div>
          </div>
        )}
        style={{ height: "100%" }}
        className="flex-1"
      />
    </div>
  );
}
