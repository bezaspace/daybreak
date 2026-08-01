# Time-travel state branching feasibility

Daybreak's headline time-travel feature has two parts: **rewinding the filesystem** and **rewinding the agent conversation state**. This document records what is known about each primitive, the implementation options, and what still needs proof before Phase 4.

## 1. Filesystem rewind

### Daytona snapshots (preferred)

Daytona supports persistent, point-in-time snapshots of a sandbox:

- `Sandbox.createSnapshot(name, timeout)` captures the sandbox filesystem.
- New sandboxes can start from a snapshot via `Daytona.create({ snapshot: "name" })`.
- Container sandboxes produce **cold snapshots** (filesystem only) when stopped.
- VM sandboxes can produce **hot snapshots** (`includeMemory: true`) while running.

Feasibility for per-turn rewind:

- Latency: unknown; needs measurement. A full snapshot per turn is likely too expensive for routine branching.
- Cost: snapshots consume storage and snapshotting time; the free $200 credit would be consumed quickly if every turn is snapshotted.
- Granularity: snapshots are whole-sandbox, not per-file. That is correct for reproducible rewinds but heavy.

### Git fallback

If Daytona snapshots are too slow or expensive, the fallback is a git-heavy approach:

- After every tool call that mutates files, `git add` + `git commit` with a stable message containing the turn number.
- Rewind by checking out the commit hash and resetting the working tree.
- Branching by checking out the commit and creating a new branch.

Trade-offs:

- No snapshot of installed dependencies or running processes.
- Faster and cheaper than full sandbox snapshots.
- Requires the target directory to be a git repo, which is true for most coding tasks.

## 2. Agent state rewind

The `pi-coding-agent` / `pi-agent-core` SDK already has session-tree primitives:

- `SessionManager.inMemory()` and disk-backed session managers persist conversation entries.
- `AgentSession` emits `entry_appended` events with `SessionEntry` objects.
- `serializeConversation` can turn a session branch into a portable transcript.
- Branch summarization (`generateBranchSummary`) and compaction (`compact`) are exported from `pi-coding-agent`.

What is feasible now:

- The conversation transcript can be captured from `session.agent.state.messages`.
- A custom `SessionStore` could serialize every turn to a JSONL file or Redis.
- Restoring a prior turn means loading that JSONL slice into a fresh `AgentSession` with the same system prompt and tools.

Open questions:

- Tool-call IDs and model internal state may not be fully reconstructible from the public transcript alone.
- Forking (parallel attempts) requires spawning a second `AgentSession` from the same message slice; this is conceptually straightforward but needs testing.
- Pi's own `SessionManager.forkFrom` exists; its exact semantics and serialization format need a dedicated spike.

## 3. Recommended Phase 4 path

1. Implement **git-based filesystem rewind** first — cheap, deterministic, and sufficient for most coding tasks.
2. Add **JSONL session-store persistence** to capture per-turn agent state.
3. Measure Daytona cold-snapshot latency and cost before relying on it for per-turn branching.
4. Use Daytona snapshots only for coarse checkpoints (task start/end, expensive setup) and git for per-turn rewind.

## 4. Phase 0 deliverable

Phase 0 does not require a working time-travel implementation. The `agent-runner` package already exposes `TaskRunner` and `MetricsCollector`, and the session transcript can be accessed through the public API. The next step is to add a `CheckpointStore` behind the runner that writes (turn, gitCommit, sessionJsonl) tuples and can restore them. This feasibility report is the input to that work.
