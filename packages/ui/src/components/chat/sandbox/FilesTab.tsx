import { Folder, File, ChevronLeft } from "lucide-react";
import { Placeholder } from "./Placeholder.js";
import type { FileEntry } from "./types.js";

interface FilesTabProps {
  files: FileEntry[];
  filesPath: string;
  loading: boolean;
  error: string | null;
  onChangePath: (path: string) => void;
}

export function FilesTab({ files, filesPath, loading, error, onChangePath }: FilesTabProps) {
  if (loading) return <Placeholder title="Files">Loading…</Placeholder>;
  if (error) return <Placeholder title="Files">{error}</Placeholder>;
  if (files.length === 0) return <Placeholder title="Files">No files listed.</Placeholder>;

  return (
    <div className="h-full overflow-y-auto p-3 scrollbar-thin">
      <div className="space-y-1">
        <div className="mb-2 flex items-center gap-2 text-xs text-db-text-secondary">
          <button type="button" onClick={() => onChangePath("/home/user/target")} className="hover:text-db-accent">
            target
          </button>
          <span className="text-db-text-tertiary">{filesPath.replace("/home/user/target", "")}</span>
        </div>
        {filesPath !== "/home/user/target" && (
          <button
            type="button"
            onClick={() => onChangePath(filesPath.split("/").slice(0, -1).join("/") || "/home/user/target")}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-db-text-secondary hover:bg-db-subtle"
          >
            <ChevronLeft className="h-4 w-4" /> Parent
          </button>
        )}
        {files
          .slice()
          .sort((a, b) => (a.type === "dir" ? -1 : 1) - (b.type === "dir" ? -1 : 1) || a.name.localeCompare(b.name))
          .map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => entry.type === "dir" && onChangePath(entry.path)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-db-subtle"
            >
              {entry.type === "dir" ? (
                <Folder className="h-4 w-4 text-db-warning" />
              ) : (
                <File className="h-4 w-4 text-db-accent" />
              )}
              <span className={entry.type === "dir" ? "text-db-text" : "text-db-text-secondary"}>{entry.name}</span>
              {typeof entry.size === "number" && entry.size > 0 && (
                <span className="ml-auto text-xs text-db-text-tertiary">{entry.size}B</span>
              )}
            </button>
          ))}
      </div>
    </div>
  );
}
