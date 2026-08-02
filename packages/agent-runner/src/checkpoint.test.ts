import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CheckpointStore } from "./checkpoint.js";
import { SessionStore } from "./session-store.js";

function initRepo(cwd: string) {
  execSync("git init -q", { cwd });
  execSync('git config user.name "Test" && git config user.email "test@example.com"', { cwd });
}

function checkoutCheckpoint(cwd: string, commit: string, branch = "daybreak/test") {
  execSync("git reset --hard", { cwd });
  execSync(`git checkout -B ${branch} ${commit}`, { cwd });
  execSync("git reset --hard", { cwd });
  execSync("git clean -fd", { cwd });
}

describe("CheckpointStore", () => {
  let cwd: string;
  let sessionStore: SessionStore;
  let checkpointStore: CheckpointStore;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "daybreak-cp-"));
    initRepo(cwd);
    sessionStore = new SessionStore({ taskId: "t1", cwd });
    checkpointStore = new CheckpointStore({ taskId: "t1", cwd, sessionStore });
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates per-turn checkpoints, commits and tags", async () => {
    const sessionManager = SessionManager.create(cwd, join(cwd, ".daybreak", "session"));
    writeFileSync(join(cwd, "a.txt"), "turn1");

    const cp1 = await checkpointStore.createCheckpoint({ turn: 1, sessionManager });
    expect(cp1.gitCommit).toBeTruthy();
    expect(cp1.sessionRef).toBeTruthy();
    const sessionRef = cp1.sessionRef!;
    expect(sessionRef.startsWith("local:") || sessionRef.startsWith("snapshot:")).toBe(true);

    const tagName = `daybreak/checkpoint/t1/1`;
    const tags = execSync("git tag", { cwd }).toString();
    expect(tags).toContain(tagName);
    const tagCommit = execSync(`git rev-list -n1 ${tagName}`, { cwd }).toString().trim();
    expect(tagCommit).toBe(cp1.gitCommit);

    writeFileSync(join(cwd, "a.txt"), "turn2");
    const cp2 = await checkpointStore.createCheckpoint({ turn: 2, sessionManager });
    expect(cp2.parentCheckpointId).toBe(cp1.id);

    const list = await checkpointStore.listCheckpoints("t1");
    expect(list.map((c) => c.turn)).toEqual([1, 2]);

    const byId = await checkpointStore.getCheckpoint(cp1.id);
    expect(byId?.gitCommit).toBe(cp1.gitCommit);
    if (!cp1.sessionRef) throw new Error("sessionRef missing");
  });

  it("chains parentCheckpointId and stores status", async () => {
    const sessionManager = SessionManager.create(cwd, join(cwd, ".daybreak", "session"));
    writeFileSync(join(cwd, "a.txt"), "1");
    const cp1 = await checkpointStore.createCheckpoint({ turn: 1, sessionManager });
    const cp2 = await checkpointStore.createCheckpoint({ turn: 2, sessionManager });
    expect(cp2.parentCheckpointId).toBe(cp1.id);
    expect(cp1.status).toBe("active");
  });

  it("rewind restores the filesystem from the checkpoint commit", async () => {
    const sessionManager = SessionManager.create(cwd, join(cwd, ".daybreak", "session"));
    writeFileSync(join(cwd, "a.txt"), "1");
    const cp1 = await checkpointStore.createCheckpoint({ turn: 1, sessionManager });

    writeFileSync(join(cwd, "a.txt"), "2");
    writeFileSync(join(cwd, "b.txt"), "extra");
    await checkpointStore.createCheckpoint({ turn: 2, sessionManager });

    if (!cp1.gitCommit) throw new Error("gitCommit missing");
    checkoutCheckpoint(cwd, cp1.gitCommit);

    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("1");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
  });

  it("SessionStore.restore copies a checkpoint session snapshot to a new session file", async () => {
    const sessionDir = join(cwd, ".daybreak", "session");
    const sessionManager = SessionManager.create(cwd, sessionDir);
    writeFileSync(join(cwd, "a.txt"), "1");
    const cp1 = await checkpointStore.createCheckpoint({ turn: 1, sessionManager });

    if (!cp1.sessionRef) throw new Error("sessionRef missing");
    const restoreDir = join(cwd, ".daybreak", "session-restored");
    const restoredPath = await sessionStore.restore(cp1.sessionRef, restoreDir);

    expect(restoredPath.startsWith(restoreDir)).toBe(true);
    expect(existsSync(restoredPath)).toBe(true);
    const restoredManager = SessionManager.open(restoredPath, restoreDir, cwd);
    expect(restoredManager.getSessionFile()).toBe(restoredPath);
  });
});
