# Phase 4 Implementation Milestones

**Sub-document of:** [../roadmap.md](../roadmap.md)  
**Phase name:** Time-Travel State Branching *(Headline Feature)*  
**Goal:** Rewind the agent's execution tree to any step, edit the context or prompt, and spawn a parallel attempt branch in a separate sandbox.

> **Dependency note:** Phase 4 builds on the Phase 0 feasibility report in [`docs/TIME_TRAVEL.md`](TIME_TRAVEL.md). That report recommended a **git-based per-turn filesystem checkpoint** first, a **JSONL session-store** for Pi state, and an **E2B-snapshot measurement spike** before committing to snapshot-based forking. This plan follows that recommendation.

This document breaks the Phase 4 exit criteria into small, independently-demoable milestones. Each milestone ships a visible capability and can be reviewed on its own.

---

## Exit criteria for the whole phase

> From [../roadmap.md](../roadmap.md): Run a task to completion. Rewind to step 3. Edit the prompt. Click "Branch". Watch a second, parallel sandbox execute a different path. Promote the second branch to a new PR.

---

## Milestones

### M1 — Pi session serialization feasibility hardening

**What it ships:** A definitive, working strategy for capturing and restoring the `pi-coding-agent` / `pi-agent-core` `AgentSession` state at a turn boundary.

Phase 0 proved the *concept* of Pi session serialization was accessible through public APIs (`SessionManager.inMemory()`, `serializeConversation`, `session.agent.state.messages`). Phase 4 needs to prove a concrete restore/fork works in the actual `TaskRunner` environment before the rest of the phase is built on it.

- [ ] Audit the installed `pi-coding-agent` / `pi-agent-core` version for state-export/import APIs:
  - `SessionManager.forkFrom`
  - `AgentSession` constructor inputs
  - `session.agent.state.messages`, `systemPrompt`, `tools`, `settings`
  - `serializeConversation` output format and round-trip behavior
- [ ] Write a standalone spike script in `packages/agent-runner/src/spikes/session-fork.ts` that:
  - Creates an `AgentSession` with the same tools/model as `TaskRunner`
  - Runs 2–3 turns
  - Saves a snapshot of the conversation state at turn 2
  - Loads it into a *fresh* `AgentSession`
  - Continues with a *different* user prompt and produces a different result
- [ ] Document the chosen serialization format (likely a JSONL of `SessionEntry` objects + system prompt + tool registry + settings) and its limitations in `docs/TIME_TRAVEL.md`.
- [ ] Define shared types in `packages/shared/src/types.ts`:
  - `Checkpoint`, `PersistedCheckpoint`, `AgentStateSnapshot`
- [ ] Add the Supabase `checkpoints` table migration (`supabase/migrations/2026080301_add_checkpoints.sql`) with columns:
  - `id uuid primary key`
  - `task_id uuid references tasks(id)`
  - `turn integer not null`
  - `timestamp timestamptz default now()`
  - `git_commit text`
  - `session_ref text` (URL/path to the stored JSONL state blob)
  - `parent_checkpoint_id uuid references checkpoints(id)`
  - `branch_task_id uuid references tasks(id)`
  - `status text` (`"active" | "rewound" | "branched" | "promoted" | "abandoned"`)
  - `tool_call_id text` (the tool call that produced this checkpoint, if any)
  - `cost_usd numeric`
- [ ] If Pi does **not** support a clean restore, decide on a mitigation (e.g., transcript replay with a synthetic "continue" prompt, wrapping `AgentSession`, or accepting mid-turn restore limitations) and update the milestones below before proceeding.

**Acceptance:**
- The spike script can fork a session to a new process and the new process continues coherently from turn *N*.
- `docs/TIME_TRAVEL.md` is updated with the working restore strategy and known limitations.
- Shared types and the `checkpoints` migration are merged.

---

### M2 — Per-turn git checkpointing and checkpoint store

**What it ships:** The agent runner records a deterministic filesystem checkpoint after each tool turn by committing the target repo to git, and persists checkpoint metadata to Supabase.

This is the cheap, deterministic filesystem rewind strategy recommended by `TIME_TRAVEL.md`. It avoids expensive per-turn E2B snapshots while still allowing rewind within the same sandbox and, with a small amount of extra work, branching to a fresh sandbox.

- [x] Add `packages/agent-runner/src/checkpoint.ts` with a `CheckpointStore` class:
  - `createCheckpoint(turn, gitCommit, sessionRef, parentCheckpointId, toolCallId, costUsd?)`
  - `getCheckpoint(id)`
  - `listCheckpoints(taskId)`
  - `getLatestCheckpoint(taskId)`
  - `setCheckpointStatus(id, status)`
- [x] Implement a JSONL session-store writer in `packages/agent-runner/src/session-store.ts`:
  - Serialize `AgentSession` state after each `turn_start` or `agent_end` boundary
  - Write to `${WORK_DIR}/.daybreak/sessions/<taskId>/<turn>.jsonl` inside the sandbox
  - Upload to a durable location (Supabase storage or a `session_snapshots` table) so it survives sandbox death and can be restored in a fork
- [x] Modify `packages/agent-runner/src/run-task.ts`:
  - After each `tool_execution_end` (and optionally at `turn_start`/`agent_end` for non-mutating turns), create a checkpoint commit with message `daybreak-checkpoint:<taskId>:<turn>`
  - Tag the commit with `daybreak/checkpoint/<taskId>/<turn>` so it is reachable even if the branch moves
  - Push checkpoint tags to origin only when needed for cross-sandbox fork (configurable; default off until M4)
  - Call `CheckpointStore.createCheckpoint(...)` and emit a `checkpoint_created` stream event
- [x] Modify `packages/agent-runner/src/session.ts` `TaskRunner`:
  - Wire `checkpoint_created` events into the event subscriber
  - Serialize session state at the end of each turn and pass it to `CheckpointStore`
  - Record checkpoint `costUsd` from the running `MetricsCollector`
- [x] Add `GET /api/tasks/:id/checkpoints` to the control plane and update `packages/control-plane/src/db.ts` with checkpoint persistence/query helpers.
- [x] Update `packages/control-plane/src/server.ts` `Task`/`PersistedTask` to track `headCheckpointId` and `rootCheckpointId`.
- [x] Add checkpoint stream events to `packages/ui/src/App.tsx` `formatEvent`.

**Acceptance:**
- [x] Run a task; the `checkpoints` table contains one row per turn with a non-null `git_commit`.
- [x] `git tag -l 'daybreak/checkpoint/*'` inside the sandbox shows tags.
- [x] The dashboard stream renders `checkpoint_created` events with turn number and cost.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

---

### M3 — Same-sandbox rewind

**What it ships:** A running task can be rewound to any previous checkpoint and continue from that filesystem + session state.

This is the first demoable time-travel slice: rewind within the same sandbox before tackling the harder cross-sandbox fork.

- [x] Add `--rewind-to-checkpoint=<checkpointId>` and `--parent-task-id=<taskId>` flags to `packages/agent-runner/src/run-task.ts`.
- [x] In `run-task.ts`, when `--rewind-to-checkpoint` is set:
  - Do **not** `rm -rf` the target directory
  - Fetch the checkpoint from `CheckpointStore`
  - Run `git checkout <git_commit>` and clean the working tree (`git reset --hard && git clean -fd`)
  - Restore the Pi session from the checkpoint's `sessionRef` JSONL
  - Set `TASK_PROMPT` to the user's edited prompt
  - Continue the `TaskRunner` loop from that turn
- [x] Add `POST /api/tasks/:id/rewind` to the control plane:
  - Body: `{ checkpointId, prompt }`
  - If the sandbox is still alive, signal it to rewind (for the local MVP this can be a new sandbox spawn that re-uses the same E2B sandbox; true in-process rewind is deferred to a control-channel later phase)
  - For the local MVP, the simplest reliable path is: spawn a new `run-task` bundle in the **same** connected sandbox with `--rewind-to-checkpoint` and `--parent-task-id`
- [x] Emit `checkpoint_restored` and `task_rewind` stream events.
- [x] Update `packages/ui/src/App.tsx` to surface rewind events.
- [x] Add unit/integration tests for `CheckpointStore` and rewind checkout logic.

**Acceptance:**
- Start a task, let it run for 4 turns, then call `POST /api/tasks/:id/rewind` with the turn-2 checkpoint and a new prompt.
- The task continues from turn 2, the filesystem matches the turn-2 state, and the stream shows `checkpoint_restored`.
- Metrics reset or continue coherently (document the choice).

---

### M4 — Cross-sandbox fork and E2B snapshot measurement

**What it ships:** A new, parallel sandbox can be spawned from a checkpoint with an edited prompt. The implementation strategy (E2B snapshot vs. git checkout + dependency re-install) is chosen after measuring E2B cold-snapshot latency and cost.

- [x] Add a measurement spike in `packages/agent-runner/src/spikes/snapshot-benchmark.ts`:
  - Create an E2B sandbox, install Node/Chromium, clone a small repo, run a test
  - Call `sandbox.createSnapshot()`
  - Measure wall-clock time, snapshot size, and credit impact
  - Spawn a new sandbox from the snapshot and verify it resumes
- [x] Update `docs/TIME_TRAVEL.md` and `docs/COST_BUDGET.md` with the measurement results and the chosen default strategy.
- [x] Add `POST /api/checkpoints/:checkpointId/fork` to the control plane:
  - Looks up the checkpoint and its parent task
  - Creates a new task record (`parentTaskId`, `parentCheckpointId`, new `prBranch`)
  - Spawns a new sandbox using the chosen strategy:
    - **Strategy A (E2B snapshot):** if snapshot benchmark shows acceptable latency/cost, create a snapshot from the parent sandbox at the checkpoint and spawn the new sandbox from it.
    - **Strategy B (git + re-install):** spawn a fresh sandbox from the `daybreak-browser` template, clone the repo, checkout the checkpoint commit, detect package manager (`package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `requirements.txt` → `pip install`, etc.) and re-run install, then restore the session JSONL.
  - Injects the restored session state and the edited prompt into the new `run-task` bundle
- [x] Add `--fork-from-checkpoint=<checkpointId>` and `--fork-prompt=<prompt>` to `run-task.ts`.
- [x] Add `--e2b-snapshot-id=<snapshotId>` to `sandbox.ts` so `Sandbox.create({ template: snapshotId })` can be used when Strategy A is selected.
- [x] Emit `branch_forked`, `checkpoint_restored`, `sandbox_created`, and `task_start` events for the new branch.
- [x] Link the new task to its parent in Supabase (`parent_task_id`, `parent_checkpoint_id`).

**Acceptance:**
- Call `POST /api/checkpoints/:checkpointId/fork` with a new prompt.
- A new task appears in `GET /api/tasks`, running in its own sandbox, starting from the checkpoint filesystem and session state.
- The original task continues unaffected.
- The new task has its own `traceId`, `prBranch`, and cost accounting.
- `docs/COST_BUDGET.md` documents the chosen fork strategy and its cost.

---

### M5 — Time-travel dashboard UI

**What it ships:** The React dashboard visualizes the checkpoint tree, lets the user inspect context at each checkpoint, edit the prompt, and spawn a rewind or a branch.

- [x] Add `packages/ui/src/TimeTravelView.tsx` (or extend `TraceView.tsx` if the trace and checkpoint trees are merged).
  - Fetch checkpoints from `GET /api/tasks/:id/checkpoints`
  - Render a tree by `parent_checkpoint_id`
  - Each node shows turn number, timestamp, tool name, cost, and status
  - Color-code nodes: active path (green), branched (blue), rewound (orange), abandoned (gray)
- [x] Add a checkpoint detail panel:
  - Show the system prompt and the last few messages at that checkpoint
  - Allow editing the user prompt in a text area
  - Show the `git_commit` and `session_ref` (read-only debug metadata)
- [x] Add action buttons:
  - **Rewind here** → calls `POST /api/tasks/:id/rewind` (only enabled if the parent task is still running/pausable)
  - **Branch from here** → calls `POST /api/checkpoints/:checkpointId/fork` with the edited prompt
- [x] Update `App.tsx`:
  - Add a "Time Travel" tab next to "Run", "Trace", "Costs"
  - Surface branch tasks in the "Recent tasks" list with a `branch of <taskId>` label
- [x] Add `formatEvent` support for `branch_forked`, `checkpoint_restored`, `branch_promoted`, `branch_abandoned`.

**Acceptance:**
- The dashboard shows a checkpoint tree for a completed or running task.
- Clicking a checkpoint opens the detail panel with editable prompt.
- "Branch from here" spawns a new task visible in the recent list.
- "Rewind here" restarts the parent task from the selected checkpoint.

---

### M6 — Branch convergence and PR promotion

**What it ships:** A user can promote a branch so its result becomes the primary PR, and abandoned branches are paused/killed to save cost.

- [ ] Add `POST /api/tasks/:id/promote` to the control plane:
  - Marks the branch task as `promoted`
  - Marks sibling branches as `abandoned`
  - Opens a PR from the branch's `prBranch` (or updates an existing PR head if GitHub allows it; GitHub PRs have fixed head branches, so the cleanest approach is to open a new PR and optionally close the old one)
  - Updates the original parent task's `prUrl` and `prNumber` to point to the promoted PR
- [ ] Add branch-kill logic:
  - When a branch is abandoned, kill its E2B sandbox if still alive to avoid paying for idle parallel sandboxes
  - Emit `branch_abandoned` and `sandbox_killed` events
- [ ] Add `POST /api/tasks/:id/abandon` for manual abandonment.
- [ ] Update the UI:
  - Show "Promote" and "Abandon" buttons on branch tasks
  - Show the primary PR link on the parent task after promotion
  - Gray out abandoned branches
- [ ] Add safety guard: promotion cannot override `main`/`master`; it always operates on the feature branch.

**Acceptance:**
- After a fork completes and the user likes the result, clicking "Promote" makes the branch's PR the primary deliverable.
- Abandoned branches stop consuming E2B resources.
- `pnpm lint && pnpm typecheck && pnpm test` pass.

---

### M7 — Evals, cost budget update, and phase sign-off

**What it ships:** Phase 4 is repeatable, budgeted, and marked complete.

- [ ] Extend `packages/evals/src/index.ts` and `e2e.ts`:
  - Add a `time-travel` fixture (or extend `failing-sum`) that:
    - Runs the task for a few turns
    - Calls the rewind or fork API
    - Asserts the checkpoint/branch task is created and completes
    - Asserts the promoted PR passes CI (or that the branch succeeds within the local eval)
  - Verify `traceId`, `costUsd`, and `parentCheckpointId` are present on branched tasks
- [ ] Add unit tests for:
  - `CheckpointStore` create/list/get
  - git checkpoint commit/tag creation
  - session store JSONL round-trip
  - control-plane fork/rewind endpoint validation
- [ ] Update `docs/COST_BUDGET.md`:
  - Per-checkpoint git commit cost (negligible)
  - Per-turn session JSONL storage cost in Supabase
  - E2B snapshot cost (if Strategy A) or re-install cost (if Strategy B)
  - Impact of parallel branches on `MAX_COST_USD` and `MAX_TURNS` (branches get their own budgets)
- [ ] Update `.env.example` with Phase 4 variables:
  - `DAYBREAK_CHECKPOINT_INTERVAL` (`"turn" | "tool"`, default `"tool"`)
  - `DAYBREAK_SESSION_STORE_BACKEND` (`"file" | "supabase"`, default `"supabase"`)
  - `DAYBREAK_FORK_STRATEGY` (`"auto" | "snapshot" | "git-reinstall"`, default `"auto"`)
  - `DAYBREAK_MAX_CHECKPOINTS_PER_TASK` (default 100)
- [ ] Update `decisions.md` with the final checkpoint/fork strategy and any Pi serialization limitations.
- [ ] Update `roadmap.md` Phase 4 checklist to mark items complete.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter agent-runner build:bundle && pnpm --filter ui build`.

**Acceptance:**
- `pnpm eval` includes a time-travel test.
- `pnpm eval:e2e` (or a manual end-to-end demo) shows: run → rewind → branch → promote.
- All CI checks pass.
- `roadmap.md` shows Phase 4 as complete.

---

## Recommended order

1. **M1** first — Pi session serialization is the highest-risk unknown and gates M3/M4.
2. **M2** in parallel with M1 — filesystem checkpointing is mostly independent, but both must land before M3.
3. **M3** — same-sandbox rewind; proves filesystem + state restore works end-to-end.
4. **M4** — cross-sandbox fork; depends on M3 and the E2B snapshot measurement.
5. **M5** — dashboard UI; depends on M4 API.
6. **M6** — branch convergence; depends on M5 and forked branches existing.
7. **M7** — evals, docs, budget, sign-off; always last.

M1 and M2 can ship in one PR. M3 should be its own PR because it changes the running task loop. M4 is another PR due to control-plane and sandbox complexity. M5 and M6 are UI/UX PRs and can be separate or combined.

---

## Major risks and mitigations

| Risk | Mitigation |
|------|------------|
| Pi `AgentSession` cannot be cleanly restored from public state | Investigate in M1; fall back to transcript replay with a synthetic "continue" prompt; document limitations. |
| E2B snapshots are too slow/expensive for per-turn fork | Default to git checkout + dependency re-install in fresh sandboxes; measure first in M4; use snapshots only for coarse checkpoints if at all. |
| Checkpoint commits/tags pollute the target repo remote | Keep tags local by default; push to `daybreak/checkpoint/<taskId>/<turn>` remote tags only when a cross-sandbox fork is requested; clean up tags after branch promotion. |
| Dependency state lost on fork because `node_modules` are not committed | Strategy B re-runs lockfile-based install after checkout; document in `COST_BUDGET.md`. |
| Running multiple parallel branches blows `MAX_COST_USD` or E2B credits | Each branch gets its own task and its own budget; dashboard shows cumulative branch spend; abandon/pause branches aggressively. |
| Rewind races with in-flight tool calls | Only create checkpoints at `tool_execution_end` or `agent_end` boundaries; reject rewind while a tool is in progress. |
| Supabase row growth from checkpoints and session snapshots | Add `DAYBREAK_MAX_CHECKPOINTS_PER_TASK`; compress/trim session JSONL; retain only the active path and explicit branches. |
| UI complexity makes the feature hard to demo | Build a minimal tree first; defer rich diff/visualization to Phase 6/7 polish. |

---

## Verification commands

```bash
# Lint/typecheck/test
pnpm lint && pnpm typecheck && pnpm test

# Agent bundle and UI build
pnpm --filter agent-runner build:bundle
pnpm --filter ui build

# Session serialization spike (M1)
pnpm --filter agent-runner tsx src/spikes/session-fork.ts

# Snapshot benchmark (M4)
pnpm --filter agent-runner tsx src/spikes/snapshot-benchmark.ts

# Local eval
pnpm --filter evals eval

# End-to-end through control plane
pnpm --filter evals eval:e2e
```

---

## Notes

- **Auth path remains PAT-only.** Phase 4 does not introduce a GitHub App; the PAT from Phase 3 continues to be used for git push and PR creation. Installation-token support is still deferred to Phase 7.
- **Branch PR semantics.** GitHub PRs are tied to a fixed head branch. The cleanest promotion flow is to open a new PR from the branch and update the parent task's `prUrl`/`prNumber` to point to it. Closing the old PR is optional and can be handled later.
- **Session snapshot storage.** For the local MVP, storing the JSONL in a Supabase `session_snapshots` table (or Supabase Storage) is simplest. In Phase 7 (Cloudflare deployment), this may move to R2/S3-compatible storage.
- **Checkpoint granularity.** The default is to checkpoint after every mutating tool call (`write`, `edit`, `bash` that changes files). Non-mutating turns can also be checkpointed for a richer tree, but this is configurable via `DAYBREAK_CHECKPOINT_INTERVAL` to save storage.
- **This milestone document should be updated as Phase 4 is built.** Mark each checkbox when the acceptance criteria are verified, and revise the fork strategy in M4 once the E2B snapshot benchmark is complete.
