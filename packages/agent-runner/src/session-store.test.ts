import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionStore } from "./session-store.js";

describe("SessionStore", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "daybreak-ss-"));
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("saves and restores a local JSONL session snapshot round-trip", async () => {
    const store = new SessionStore({ taskId: "t1", cwd });
    const sessionDir = join(cwd, ".daybreak", "session");
    const sessionManager = SessionManager.create(cwd, sessionDir);

    const { sessionRef, localPath } = await store.save(1, sessionManager);
    expect(sessionRef).toMatch(/^local:/);
    expect(localPath).toContain(`${join(cwd, ".daybreak", "sessions", "t1", "1.jsonl")}`);
    expect(existsSync(localPath)).toBe(true);

    const restoreDir = join(cwd, ".daybreak", "restored");
    const restoredPath = await store.restore(sessionRef, restoreDir);
    expect(restoredPath.startsWith(restoreDir)).toBe(true);
    expect(readFileSync(restoredPath, "utf8")).toBe(readFileSync(localPath, "utf8"));
  });

  it("saves multiple turns independently", async () => {
    const store = new SessionStore({ taskId: "t1", cwd });
    const sessionDir = join(cwd, ".daybreak", "session");
    const sessionManager = SessionManager.create(cwd, sessionDir);

    const r1 = await store.save(1, sessionManager);
    const r2 = await store.save(2, sessionManager);
    expect(r1.localPath).not.toBe(r2.localPath);
    expect(existsSync(r1.localPath)).toBe(true);
    expect(existsSync(r2.localPath)).toBe(true);
  });
});
