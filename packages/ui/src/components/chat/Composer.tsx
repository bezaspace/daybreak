import { useEffect, useRef, useState, useCallback } from "react";
import { Send, Loader2, FileText, GitBranch, Hash, Command, ImageIcon } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "../base/Button.js";
import { Input } from "../base/Input.js";
import { Label } from "../base/Label.js";
import { Select } from "../base/Select.js";
import type { Task } from "../../lib/types.js";

interface ComposerProps {
  repo: string;
  branch: string;
  prompt: string;
  mode: "plan" | "interactive" | "autopilot";
  isRunning: boolean;
  taskSelected?: boolean;
  task?: Task;
  disabled?: boolean;
  disabledReason?: string;
  onRepoChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onModeChange: (value: "plan" | "interactive" | "autopilot") => void;
  onSubmit: () => void;
  onCommand?: (command: string) => void;
}

interface SuggestionItem {
  id: string;
  label: string;
  value: string;
  subLabel?: string;
  icon?: "repo" | "file" | "issue" | "pr" | "command";
}

interface SuggestionsState {
  open: boolean;
  type: "repo" | "file" | "issue" | "command" | null;
  query: string;
  start: number;
  end: number;
  items: SuggestionItem[];
  loading: boolean;
  selectedIndex: number;
}

const modeOptions = [
  { value: "plan", label: "Plan" },
  { value: "interactive", label: "Interactive" },
  { value: "autopilot", label: "Autopilot" },
];

const slashCommands: SuggestionItem[] = [
  { id: "/plan", label: "/plan", value: "/plan", subLabel: "Switch to plan mode", icon: "command" },
  { id: "/auto", label: "/auto", value: "/auto", subLabel: "Switch to autopilot mode", icon: "command" },
  { id: "/interactive", label: "/interactive", value: "/interactive", subLabel: "Switch to interactive mode", icon: "command" },
  { id: "/costs", label: "/costs", value: "/costs", subLabel: "Open costs view", icon: "command" },
  { id: "/cancel", label: "/cancel", value: "/cancel", subLabel: "Cancel running task", icon: "command" },
  { id: "/help", label: "/help", value: "/help", subLabel: "Show composer shortcuts", icon: "command" },
];

function parseRepoFromUrl(repo: string): { owner: string; repo: string } | undefined {
  try {
    const url = new URL(repo);
    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  } catch {
    const match = repo.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return undefined;
}

function getTriggerInfo(text: string, cursor: number): { type: "repo" | "file" | "issue" | "command"; start: number; query: string } | null {
  if (cursor === 0) return null;
  // Slash commands only at the very beginning
  if (text[0] === "/") {
    const prev = text.slice(0, cursor);
    if (!prev.includes(" ")) {
      return { type: "command", start: 0, query: prev.slice(1) };
    }
  }
  // Find the last @ or # before cursor
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@" || ch === "#") {
      const prevChar = text[i - 1];
      if (prevChar === undefined || /\s/.test(prevChar) || /[\(\[\{<"']/.test(prevChar)) {
        const query = text.slice(i + 1, cursor);
        return { type: ch === "@" ? "file" : "issue", start: i, query };
      }
      return null;
    }
    if (/\s/.test(ch)) break;
    i--;
  }
  return null;
}

export function Composer({
  repo,
  branch,
  prompt,
  mode,
  isRunning,
  taskSelected,
  task,
  disabled,
  disabledReason,
  onRepoChange,
  onBranchChange,
  onPromptChange,
  onModeChange,
  onSubmit,
  onCommand,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(prompt.length);
  const [suggestions, setSuggestions] = useState<SuggestionsState>({
    open: false,
    type: null,
    query: "",
    start: 0,
    end: 0,
    items: [],
    loading: false,
    selectedIndex: 0,
  });
  const [previews, setPreviews] = useState<{ name: string; dataUrl: string }[]>([]);

  const updateCursor = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCursor(el.selectionStart ?? prompt.length);
  }, [prompt.length]);

  const activeRepo = task?.repo || repo;

  const refreshSuggestions = useCallback(
    async (text: string, pos: number) => {
      const info = getTriggerInfo(text, pos);
      if (!info) {
        setSuggestions((s) => ({ ...s, open: false, type: null }));
        return;
      }
      const { type, start, query } = info;
      setSuggestions({
        open: true,
        type,
        query,
        start,
        end: pos,
        items: [],
        loading: true,
        selectedIndex: 0,
      });

      try {
        if (type === "command") {
          const q = query.toLowerCase();
          const items = slashCommands.filter(
            (c) => c.value.toLowerCase().startsWith(q) || c.subLabel?.toLowerCase().includes(q),
          );
          setSuggestions((s) => ({ ...s, items, loading: false }));
          return;
        }

        if (type === "repo") {
          const res = await fetch("/api/repos");
          const data = (await res.json()) as { repos?: Array<{ fullName: string; url: string }> };
          const q = query.toLowerCase();
          const repos = (data.repos || []).filter(
            (r) =>
              r.fullName.toLowerCase().startsWith(q) ||
              r.fullName.toLowerCase().includes(q) ||
              (r.url && r.url.toLowerCase().includes(q)),
          );
          const items: SuggestionItem[] = repos.map((r) => ({
            id: r.fullName,
            label: r.fullName,
            value: `@${r.fullName}`,
            subLabel: r.url,
            icon: "repo",
          }));
          setSuggestions((s) => ({ ...s, items, loading: false }));
          return;
        }

        if (type === "file") {
          if (!task?.id) {
            setSuggestions((s) => ({ ...s, items: [], loading: false }));
            return;
          }
          const basePath = "/home/user/target";
          const lastSlash = query.lastIndexOf("/");
          const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash) : "";
          const search = lastSlash >= 0 ? query.slice(lastSlash + 1) : query;
          const path = dirPart ? `${basePath}/${dirPart}` : basePath;
          const res = await fetch(`/api/tasks/${task.id}/files?path=${encodeURIComponent(path)}`);
          const data = (await res.json()) as { entries?: Array<{ name: string; type?: string; path?: string }> };
          const entries = (data.entries || []).filter((e) =>
            search ? e.name.toLowerCase().startsWith(search.toLowerCase()) : true,
          );
          const prefix = dirPart ? `${dirPart}/` : "";
          const items: SuggestionItem[] = entries.map((e) => ({
            id: `${prefix}${e.name}`,
            label: e.name,
            value: `@${prefix}${e.name}${e.type === "dir" ? "/" : ""}`,
            subLabel: e.type === "dir" ? "directory" : "file",
            icon: "file",
          }));
          setSuggestions((s) => ({ ...s, items, loading: false }));
          return;
        }

        if (type === "issue") {
          const parsed = parseRepoFromUrl(activeRepo);
          if (!parsed) {
            setSuggestions((s) => ({ ...s, items: [], loading: false }));
            return;
          }
          const res = await fetch(`/api/repos/${parsed.owner}/${parsed.repo}/issues-prs`);
          const data = (await res.json()) as { items?: Array<{ number: number; title: string; type: "issue" | "pr" }> };
          const q = query.toLowerCase();
          const items: SuggestionItem[] = (data.items || [])
            .filter(
              (item) =>
                String(item.number).includes(q) || item.title.toLowerCase().includes(q),
            )
            .slice(0, 8)
            .map((item) => ({
              id: `${item.type}-${item.number}`,
              label: `#${item.number} ${item.title}`,
              value: `#${item.number}`,
              subLabel: item.type,
              icon: item.type,
            }));
          setSuggestions((s) => ({ ...s, items, loading: false }));
        }
      } catch {
        setSuggestions((s) => ({ ...s, loading: false }));
      }
    },
    [activeRepo, task?.id],
  );

  const applySuggestion = useCallback(
    (item: SuggestionItem) => {
      const before = prompt.slice(0, suggestions.start);
      const after = prompt.slice(suggestions.end);
      let newPrompt = `${before}${item.value} `;
      const newCursor = newPrompt.length;
      newPrompt += after;
      onPromptChange(newPrompt);
      setSuggestions((s) => ({ ...s, open: false, type: null }));
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCursor, newCursor);
          updateCursor();
        }
      }, 0);

      if (suggestions.type === "command") {
        const command = item.value;
        if (command === "/plan") onModeChange("plan");
        if (command === "/auto") onModeChange("autopilot");
        if (command === "/interactive") onModeChange("interactive");
        if (command === "/plan" || command === "/auto" || command === "/interactive") {
          onPromptChange("");
        }
        if (onCommand && (command === "/costs" || command === "/cancel" || command === "/help")) {
          onCommand(command.slice(1));
          onPromptChange("");
        }
      }
    },
    [onCommand, onModeChange, onPromptChange, prompt, suggestions.end, suggestions.start, suggestions.type, updateCursor],
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onPromptChange(e.target.value);
    updateCursor();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (suggestions.open && suggestions.items.length > 0) {
        e.preventDefault();
        applySuggestion(suggestions.items[suggestions.selectedIndex]);
        return;
      }
      if (!disabled && prompt.trim() && (taskSelected || !isRunning)) {
        e.preventDefault();
        onSubmit();
      }
      return;
    }
    if (suggestions.open && suggestions.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestions((s) => ({
          ...s,
          selectedIndex: (s.selectedIndex + 1) % s.items.length,
        }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestions((s) => ({
          ...s,
          selectedIndex: (s.selectedIndex - 1 + s.items.length) % s.items.length,
        }));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestions((s) => ({ ...s, open: false }));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applySuggestion(suggestions.items[suggestions.selectedIndex]);
        return;
      }
    }
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
    const el = e.currentTarget;
    setCursor(el.selectionStart ?? prompt.length);
    refreshSuggestions(el.value, el.selectionStart ?? el.value.length);
  }

  function handleClick() {
    updateCursor();
    if (textareaRef.current) {
      refreshSuggestions(textareaRef.current.value, textareaRef.current.selectionStart ?? textareaRef.current.value.length);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files || []);
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) {
      e.preventDefault();
      for (const file of images) addImage(file);
    }
  }

  function addImage(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPreviews((p) => [...p, { name: file.name, dataUrl }]);
      const markdown = `![${file.name}](${dataUrl})`;
      const el = textareaRef.current;
      const start = el?.selectionStart ?? prompt.length;
      const newPrompt = `${prompt.slice(0, start)}${markdown}\n${prompt.slice(start)}`;
      onPromptChange(newPrompt);
      setTimeout(() => {
        if (el) {
          const newCursor = start + markdown.length + 1;
          el.setSelectionRange(newCursor, newCursor);
          updateCursor();
        }
      }, 0);
    };
    reader.readAsDataURL(file);
  }

  function removePreview(index: number) {
    const removed = previews[index];
    setPreviews((p) => p.filter((_, i) => i !== index));
    onPromptChange(prompt.replace(`![${removed.name}](${removed.dataUrl})\n`, "").replace(`![${removed.name}](${removed.dataUrl})`, ""));
  }

  useEffect(() => {
    if (suggestions.open && textareaRef.current) {
      refreshSuggestions(prompt, cursor);
    }
  }, [prompt, cursor, activeRepo, task?.id, suggestions.open, refreshSuggestions]);

  const canSubmit = !disabled && prompt.trim() && (taskSelected ? isRunning : !isRunning && !!repo.trim());

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
          {previews.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {previews.map((p, i) => (
                <div key={`${p.name}-${i}`} className="group relative inline-block rounded border border-db-border bg-db-elevated p-1">
                  <img src={p.dataUrl} alt={p.name} className="h-16 w-16 rounded object-cover" />
                  <button
                    type="button"
                    onClick={() => removePreview(i)}
                    className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-db-danger text-xs text-white group-hover:flex"
                    aria-label="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onClick={handleClick}
            onPaste={handlePaste}
            disabled={disabled || (!taskSelected && isRunning)}
            rows={3}
            placeholder={
              disabled
                ? disabledReason || "Select or start a new session"
                : taskSelected
                  ? "Send a follow-up message..."
                  : "What do you want the agent to do? Try @repo, @file, #issue, or /help"
            }
            className={cn(
              "min-h-[88px] w-full resize-none rounded-md border bg-db-elevated px-3 py-2 text-sm text-db-text shadow-sm transition-colors",
              "placeholder:text-db-text-tertiary",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-db-accent focus-visible:border-db-border-strong",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          {suggestions.open && (
            <div className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-lg rounded-lg border border-db-border bg-db-surface shadow-lg">
              {suggestions.loading && (
                <div className="px-3 py-2 text-xs text-db-text-secondary">Loading…</div>
              )}
              {!suggestions.loading && suggestions.items.length === 0 && (
                <div className="px-3 py-2 text-xs text-db-text-secondary">No matches</div>
              )}
              {!suggestions.loading && suggestions.items.length > 0 && (
                <div className="max-h-56 overflow-y-auto py-1">
                  {suggestions.items.map((item, idx) => {
                    const Icon =
                      item.icon === "repo"
                        ? GitBranch
                        : item.icon === "issue"
                          ? Hash
                          : item.icon === "pr"
                            ? GitBranch
                            : item.icon === "command"
                              ? Command
                              : FileText;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => applySuggestion(item)}
                        onMouseEnter={() => setSuggestions((s) => ({ ...s, selectedIndex: idx }))}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                          idx === suggestions.selectedIndex ? "bg-db-accent/10 text-db-text" : "text-db-text-secondary hover:bg-db-elevated",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0 text-db-text-tertiary" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{item.label}</div>
                          {item.subLabel && <div className="truncate text-xs text-db-text-tertiary">{item.subLabel}</div>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
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
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-db-border bg-db-elevated px-3 text-xs font-medium text-db-text hover:bg-db-surface disabled:opacity-50"
              title="Attach image"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              Attach
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                for (const file of Array.from(e.target.files || [])) addImage(file);
                if (e.target) e.target.value = "";
              }}
            />
          </div>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
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
