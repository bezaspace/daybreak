import { useEffect, useRef, useState, useCallback } from "react";
import { Search, GitBranch, Loader2, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Label } from "../base/Label.js";

interface RepoOption {
  fullName: string;
  url: string;
  owner?: string;
  name?: string;
  defaultBranch?: string;
  private?: boolean;
}

interface RepoSelectProps {
  value: string;
  onChange: (value: string) => void;
  onBranchChange?: (branch: string) => void;
  branch?: string;
  disabled?: boolean;
}

export function RepoSelect({ value, onChange, onBranchChange, branch, disabled }: RepoSelectProps) {
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchRepos() {
      try {
        const res = await fetch("/api/repos");
        const data = (await res.json()) as { repos?: RepoOption[] };
        if (!cancelled && data.repos) {
          setRepos(data.repos);
        }
      } catch {
        // silently fall back to manual entry
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchRepos();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = repos.filter((r) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return r.fullName.toLowerCase().includes(q) || (r.url || "").toLowerCase().includes(q);
  });

  const selectedRepo = repos.find((r) => r.url === value || r.fullName === value);

  function selectRepo(repo: RepoOption) {
    onChange(repo.url);
    if (onBranchChange && repo.defaultBranch && (!branch || branch === "main")) {
      onBranchChange(repo.defaultBranch);
    }
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && filtered[highlightIndex]) {
      e.preventDefault();
      selectRepo(filtered[highlightIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [handleClickOutside]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  return (
    <div ref={containerRef} className="relative flex min-w-[12rem] flex-1 flex-col gap-1.5">
      <Label htmlFor="composer-repo" className="text-xs text-db-text-secondary">
        Repo
      </Label>

      {/* Search input / display */}
      <div className="relative">
        {open ? (
          <div className="flex h-9 items-center rounded-md border border-db-border bg-db-elevated px-3 shadow-sm focus-within:ring-1 focus-within:ring-db-accent">
            <Search className="mr-2 h-4 w-4 shrink-0 text-db-text-tertiary" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => setOpen(true)}
              placeholder="Search repositories…"
              className="w-full bg-transparent text-sm text-db-text outline-none placeholder:text-db-text-tertiary"
              disabled={disabled}
              autoFocus
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            disabled={disabled}
            className={cn(
              "flex h-9 w-full items-center justify-between rounded-md border border-db-border bg-db-elevated px-3 py-2 text-sm text-db-text shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-db-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span className={cn("truncate", !selectedRepo && !value && "text-db-text-tertiary")}>
              {selectedRepo ? selectedRepo.fullName : value || "Select a repository…"}
            </span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-db-text-tertiary" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-db-border bg-db-surface py-1 shadow-lg">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-db-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading repositories…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-db-text-secondary">
              {repos.length === 0
                ? "No repositories found. You can still type a URL manually."
                : "No matches found."}
            </div>
          ) : (
            <>
              {filtered.map((repo, i) => (
                <button
                  key={repo.fullName}
                  type="button"
                  onClick={() => selectRepo(repo)}
                  onMouseEnter={() => setHighlightIndex(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none",
                    i === highlightIndex ? "bg-db-subtle" : "",
                    repo.url === value || repo.fullName === value ? "text-db-accent" : "text-db-text",
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-db-text-tertiary" />
                  <span className="truncate">{repo.fullName}</span>
                  {repo.private && (
                    <span className="ml-auto shrink-0 rounded bg-db-subtle px-1.5 py-0.5 text-xs text-db-text-tertiary">
                      private
                    </span>
                  )}
                </button>
              ))}
              <div className="border-t border-db-border px-3 py-1.5 text-xs text-db-text-tertiary">
                Or paste a URL directly in the field below
              </div>
            </>
          )}
        </div>
      )}

      {/* Manual URL fallback — always available below the dropdown trigger */}
      {!open && !selectedRepo && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="…or paste a GitHub URL"
          disabled={disabled}
          className="h-7 w-full rounded border border-db-border bg-db-elevated px-2 text-xs text-db-text outline-none focus-visible:ring-1 focus-visible:ring-db-accent disabled:opacity-50"
        />
      )}
    </div>
  );
}
