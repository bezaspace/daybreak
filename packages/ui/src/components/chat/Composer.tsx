import { Send, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "../base/Button.js";
import { Input } from "../base/Input.js";
import { Label } from "../base/Label.js";
import { Select } from "../base/Select.js";

interface ComposerProps {
  repo: string;
  branch: string;
  prompt: string;
  mode: "plan" | "interactive" | "autopilot";
  isRunning: boolean;
  taskSelected?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onRepoChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onModeChange: (value: "plan" | "interactive" | "autopilot") => void;
  onSubmit: () => void;
}

const modeOptions = [
  { value: "plan", label: "Plan" },
  { value: "interactive", label: "Interactive" },
  { value: "autopilot", label: "Autopilot" },
];

export function Composer({
  repo,
  branch,
  prompt,
  mode,
  isRunning,
  taskSelected,
  disabled,
  disabledReason,
  onRepoChange,
  onBranchChange,
  onPromptChange,
  onModeChange,
  onSubmit,
}: ComposerProps) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && prompt.trim() && (taskSelected || !isRunning)) {
        onSubmit();
      }
    }
  }

  return (
    <div className="border-t border-db-border bg-db-surface p-4">
      <div className="mx-auto max-w-3xl space-y-3">
        {!taskSelected && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
              <Label htmlFor="composer-repo" className="text-xs text-db-text-secondary">
                Repo
              </Label>
              <Input
                id="composer-repo"
                type="text"
                value={repo}
                onChange={(e) => onRepoChange(e.target.value)}
                placeholder="https://github.com/owner/repo"
                disabled={disabled || isRunning}
              />
            </div>
            <div className="flex w-32 flex-col gap-1.5">
              <Label htmlFor="composer-branch" className="text-xs text-db-text-secondary">
                Branch
              </Label>
              <Input
                id="composer-branch"
                type="text"
                value={branch}
                onChange={(e) => onBranchChange(e.target.value)}
                placeholder="main"
                disabled={disabled || isRunning}
              />
            </div>
          </div>
        )}

        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || (!taskSelected && isRunning)}
            rows={3}
            placeholder={
              disabled
                ? disabledReason || "Select or start a new session"
                : taskSelected
                  ? "Send a follow-up message..."
                  : "What do you want the agent to do?"
            }
            className={cn(
              "min-h-[88px] w-full resize-none rounded-md border bg-db-elevated px-3 py-2 text-sm text-db-text shadow-sm transition-colors",
              "placeholder:text-db-text-tertiary",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-db-accent focus-visible:border-db-border-strong",
              "disabled:cursor-not-allowed disabled:opacity-50",
              disabled ? "border-db-border" : "border-db-border",
            )}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          {!taskSelected && (
            <div className="w-40">
              <Select
                value={mode}
                onValueChange={(value) => onModeChange((value as "plan" | "interactive" | "autopilot") || "autopilot")}
                options={modeOptions}
                disabled={disabled || isRunning}
              />
            </div>
          )}
          {taskSelected && <div />}
          <Button
            type="button"
            onClick={onSubmit}
            disabled={
              disabled ||
              !prompt.trim() ||
              (taskSelected ? !isRunning : isRunning || !repo.trim())
            }
          >
            {taskSelected ? (
              <>
                <Send className="h-4 w-4" />
                Send
              </>
            ) : isRunning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Run
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
