import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionStoreOptions {
  taskId: string;
  cwd: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

export class SessionStore {
  private sessionsDir: string;

  constructor(private options: SessionStoreOptions) {
    this.sessionsDir = join(options.cwd, ".daybreak", "sessions", options.taskId);
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  localPath(turn: number): string {
    return join(this.sessionsDir, `${turn}.jsonl`);
  }

  /**
   * Persist the current Pi session to a turn-specific JSONL file.
   * If Supabase credentials are configured, also upload the JSONL to the
   * `session_snapshots` table and return a `snapshot:<id>` ref; otherwise the
   * ref is `local:<path>`.
   */
  async save(turn: number, sessionManager: SessionManager): Promise<{ sessionRef: string; localPath: string; snapshotId?: string }> {
    const targetPath = this.localPath(turn);
    ensureDir(targetPath);

    const sessionFile = sessionManager.getSessionFile();
    if (sessionFile && existsSync(sessionFile as string)) {
      copyFileSync(sessionFile, targetPath);
    } else {
      const header = sessionManager.getHeader();
      const entries = sessionManager.getEntries();
      const lines: string[] = [];
      if (header) lines.push(JSON.stringify(header));
      for (const entry of entries) {
        lines.push(JSON.stringify(entry));
      }
      writeFileSync(targetPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    }

    const jsonl = readFileSync(targetPath, "utf8");
    const snapshotId = await this.uploadSnapshot(turn, jsonl);
    const sessionRef = snapshotId ? `snapshot:${snapshotId}` : `local:${targetPath}`;
    return { sessionRef, localPath: targetPath, snapshotId };
  }

  /**
   * Resolve a sessionRef back into a local JSONL file path that can be opened by
   * `SessionManager.open`. The path is copied into `sessionDir` so the restored
   * session can be mutated without corrupting the original snapshot.
   */
  async restore(sessionRef: string, sessionDir: string): Promise<string> {
    mkdirSync(sessionDir, { recursive: true });
    const targetPath = join(sessionDir, "restored.jsonl");

    if (sessionRef.startsWith("local:")) {
      const sourcePath = sessionRef.slice("local:".length);
      copyFileSync(sourcePath, targetPath);
      return targetPath;
    }

    if (sessionRef.startsWith("snapshot:")) {
      const snapshotId = sessionRef.slice("snapshot:".length);
      const jsonl = await this.downloadSnapshot(snapshotId);
      writeFileSync(targetPath, jsonl);
      return targetPath;
    }

    throw new Error(`Unsupported sessionRef: ${sessionRef}`);
  }

  private async downloadSnapshot(snapshotId: string): Promise<string> {
    const { supabaseUrl, supabaseServiceKey } = this.options;
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase credentials are required to restore snapshot sessions");
    }
    const response = await fetch(`${supabaseUrl}/rest/v1/session_snapshots?id=eq.${snapshotId}`, {
      headers: {
        apikey: supabaseServiceKey,
        Authorization: `Bearer ${supabaseServiceKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to download snapshot: ${response.status}`);
    }
    const rows = (await response.json()) as Array<{ jsonl: string }>;
    if (!rows[0]) throw new Error(`Snapshot ${snapshotId} not found`);
    return rows[0].jsonl;
  }

  private async uploadSnapshot(turn: number, jsonl: string): Promise<string | undefined> {
    const { supabaseUrl, supabaseServiceKey } = this.options;
    if (!supabaseUrl || !supabaseServiceKey) return undefined;

    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/session_snapshots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          id: randomUUID(),
          task_id: this.options.taskId,
          turn,
          jsonl,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "unknown");
        console.error(`[session-store] snapshot upload failed: ${response.status} ${text}`);
        return undefined;
      }
      const data = (await response.json()) as Array<{ id: string }>;
      return data[0]?.id;
    } catch (error) {
      console.error("[session-store] snapshot upload error:", error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }
}
