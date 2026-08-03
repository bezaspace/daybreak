import { useEffect, useRef } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { MessageBubble } from "./MessageBubble.js";
import type { ChatMessage, Task } from "../../lib/types.js";

interface ChatThreadProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  task: Task | null;
}

export function ChatThread({ messages, isStreaming, task }: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 py-6 scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {isStreaming && (
            <div className="flex items-center gap-2 px-4 text-sm text-db-text-tertiary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Agent is working…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
