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
