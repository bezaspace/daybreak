# Time-travel state branching feasibility

Daybreak's headline time-travel feature has two parts: **rewinding the filesystem** and **rewinding the agent conversation state**. This document records what is known about each primitive, the implementation options, and what still needs proof before Phase 4.

## 1. Filesystem rewind

### E2B snapshots

E2B supports persistent, point-in-time snapshots of a sandbox:

- `sandbox.createSnapshot()` captures the sandbox filesystem and, by default, memory state.
- New sandboxes can start from a snapshot via `Sandbox.create({ snapshotId: "<snapshot-id>" })`.
- Snapshots can be listed with `Sandbox.listSnapshots()` and deleted with `Sandbox.deleteSnapshot()`.
- Filesystem-only snapshots are available and are cheaper/faster because they skip the memory diff (e.g. `keepMemory: false` or `WithFilesystemSnapshot()`).

Feasibility for per-turn rewind:

- Latency: E2B docs note ~4 s per 1 GiB RAM for pausing and ~1 s for resuming a paused sandbox. Creating a full memory snapshot is proportionally slower than filesystem-only.
- Cost: snapshots consume storage and snapshotting time. E2B storage is billed (Hobby includes 10 GiB, Pro 20 GiB). Memory snapshots are the expensive part; filesystem-only snapshots are the escape hatch when memory snapshots are too large or slow.
- A full snapshot per turn is likely too expensive and slow for routine branching. Measure before relying on it.
- Granularity: snapshots are whole-sandbox, not per-file. That is correct for reproducible rewinds but heavy.

### Git fallback (preferred for per-turn)

If E2B snapshots are too slow or expensive, the fallback is a git-heavy approach:

- After every tool call that mutates files, `git add` + `git commit` with a stable message containing the turn number.
- Rewind by checking out the commit hash and resetting the working tree.
- Branching by checking out the commit and creating a new branch.

Trade-offs:

- No snapshot of installed dependencies or running processes.
- Faster and cheaper than full sandbox snapshots.
- Requires the target directory to be a git repo, which is true for most coding tasks.

## 2. Agent state rewind

The `pi-coding-agent` / `pi-agent-core` SDK has mature session-tree primitives:

- `SessionManager` stores sessions as append-only JSONL trees with `id`/`parentId` links.
- `SessionManager.create(cwd, sessionDir)` writes a persisted `.jsonl` session file.
- `SessionManager.open(path, sessionDir, cwdOverride)` loads a persisted session file into a new manager.
- `SessionManager.branch(targetId)` moves the leaf pointer to an earlier entry without deleting history.
- `SessionManager.createBranchedSession(leafId)` extracts a single branch into a new session file.
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir)` copies a session file into a different project directory.
- `AgentSession.navigateTree(targetId)` rewrites `agent.state.messages` from the session tree in place.
- `AgentSession.exportToJsonl()` and `AgentSessionRuntime.importFromJsonl()` copy a branch into a portable JSONL file and load it back into a new runtime.
- `AgentSessionRuntime.fork(entryId, { position: "before" | "at" })` creates a branched session and switches the active runtime.

`packages/agent-runner/src/spikes/session-fork.ts` demonstrates feasibility end-to-end:

- A parent process creates an `AgentSession` backed by `SessionManager.create`, runs two prompts, and records the leaf entry id.
- A child process opens the same `.jsonl` file with `SessionManager.open`, creates a fresh `AgentSession`, and continues from that leaf with a different prompt.
- The child coherently executes the new prompt against the restored filesystem and conversation context.

What is feasible now:

- Disk-backed Pi sessions are portable across Node processes. The JSONL file plus the same `ModelRuntime`/`tools`/`cwd` are sufficient to resume.
- Same-process rewind can be done by branching the session manager and rewriting `session.agent.state.messages` before the next prompt.
- A custom `CheckpointStore` can persist `(turn, gitCommit, sessionFile, leafId, sessionJsonl)` tuples and restore them.

Open questions / limitations:

- `SessionManager` stores messages and tool-call entries, but the restored `Agent` does not resume mid-tool-call. Restores are only safe at an idle leaf (between turns).
- The `Agent` object itself cannot be serialized; a fresh `AgentSession` must be created and its `state.messages` seeded from the session tree. This works, but it means we cannot restore transient in-flight state.
- Branch summarization is an LLM call; it should be optional for time-travel checkpoints to keep restores fast and cheap.
- Model internal state (e.g. provider cache keys) is tied to `ModelRuntime` configuration, not the session file. Restored sessions must use the same `ModelRuntime` and model id.

## 3. M1 deliverable

The `packages/agent-runner/src/spikes/session-fork.ts` script proves that `pi-coding-agent` sessions are serializable across Node processes:

- Parent runs a disk-backed `AgentSession` for two turns.
- Child opens the same `.jsonl` with `SessionManager.open`, creates a fresh `AgentSession`, and continues from the recorded leaf with a different prompt.
- The restored session coherently executes the new prompt and writes files into the same working directory.

The remaining Phase 4 work is to wire this into `TaskRunner` as a `CheckpointStore` that writes `(turn, gitCommit, sessionRef, leafId, sessionJsonl)` tuples, and then to add per-turn git commits and E2B snapshot benchmarks.

## 5. Recommended Phase 4 path

1. Implement **git-based filesystem rewind** first — cheap, deterministic, and sufficient for most coding tasks.
2. Add **JSONL session-store persistence** to `TaskRunner` so each turn produces a portable session snapshot.
3. Measure E2B cold-snapshot latency and cost before relying on it for cross-sandbox forks.
4. Use E2B snapshots only for coarse checkpoints (task start/end, expensive setup) and filesystem-only snapshots where memory state is not required.
