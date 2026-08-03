import { useState } from "react";
import { Shield, Check, X } from "lucide-react";
import { cn } from "../../lib/utils.js";

interface ApprovalGateProps {
  taskId?: string;
  toolCallId?: string;
  toolName?: string;
  reason?: string;
  kind?: string;
  decision?: string | null;
  onAction?: (action: "approved" | "rejected" | "approveAlways", toolCallId: string) => void;
}

export function ApprovalGate({ taskId, toolCallId, toolName, reason, kind, decision, onAction }: ApprovalGateProps) {
  const [pending, setPending] = useState(false);
  const isPlan = kind === "plan";
  const resolved = decision != null;

  const handle = (action: "approved" | "rejected" | "approveAlways") => {
    if (!toolCallId || !onAction) return;
    setPending(true);
    onAction(action, toolCallId);
  };

  if (resolved) {
    return (
      <div className="flex max-w-md flex-col gap-2 rounded-xl border border-db-border bg-db-surface p-4 text-sm">
        <div className="flex items-center gap-2 text-db-text-secondary">
          <Shield className="h-4 w-4" />
          <span>{isPlan ? "Plan" : toolName ? `${toolName}()` : "Action"} {decision === "rejected" ? "rejected" : "approved"}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex max-w-md flex-col gap-3 rounded-xl border p-4 text-sm", pending ? "border-db-warning/30 bg-db-warning/5" : "border-db-accent/30 bg-db-accent/5")}>
      <div className="flex items-start gap-2">
        <Shield className={cn("mt-0.5 h-4 w-4 shrink-0", pending ? "text-db-warning" : "text-db-accent")} />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-db-text">
            {isPlan ? "Plan ready for review" : `Approve ${toolName ? `${toolName}()` : "action"}?`}
          </div>
          {reason && <div className="mt-1 text-db-text-secondary">{reason}</div>}
          {taskId && <div className="mt-1 text-xs text-db-text-tertiary">Task {taskId.slice(0, 8)}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => handle("approved")}
          className="inline-flex items-center gap-1.5 rounded-lg bg-db-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-db-accent/90 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {isPlan ? "Proceed" : "Approve"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => handle("approveAlways")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-db-border bg-db-surface px-3 py-1.5 text-xs font-medium text-db-text hover:bg-db-elevated disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {isPlan ? "Proceed always" : "Approve always"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => handle("rejected")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-db-border bg-db-surface px-3 py-1.5 text-xs font-medium text-db-text hover:bg-db-elevated disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          {isPlan ? "Cancel" : "Reject"}
        </button>
      </div>
    </div>
  );
}
