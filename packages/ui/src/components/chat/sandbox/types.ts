export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | string;
  size?: number;
}

export interface CheckpointItem {
  id: string;
  turn: number;
  timestamp: number;
  gitCommit?: string;
  costUsd?: number;
  status: string;
  toolCallId?: string;
}

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
