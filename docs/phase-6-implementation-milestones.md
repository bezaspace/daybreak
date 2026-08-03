# Phase 6 Implementation Milestones

**Sub-document of:** [../roadmap.md](../roadmap.md)  
**Phase name:** Resilience, Scale & Polish  
**Goal:** Make Daybreak safe, resilient, multi-tenant, and cost-aware: add a durable task queue, idempotency, retry/dead-letter handling, tenant quotas, security hardening, branch/sandbox cleanup, and compaction tuning for long and large repositories.

> **Scope note:** Phase 6 deliberately does **not** build the GitHub App / Cloudflare deployment (Phase 7). It does add the tenant/quota data model and queue infrastructure that the GitHub App will plug into, and it hardens the existing PAT-only local control plane.

---

## Exit criteria for the whole phase

> From [../roadmap.md](../roadmap.md): Attempt to make the agent read `.env` → blocked. Run a task in a loop that never passes tests → hits the 40-turn cap and stops. Simulate a webhook flood → queue absorbs it without duplicate tasks or quota exhaustion.

In addition, Phase 6 should demonstrate:

- A failed E2B sandbox spawn is retried and, if retries are exhausted, lands in a dead-letter queue with a clear reason.
- A tenant that exceeds its hourly task rate or daily cost budget is rejected with a `429`/`403` and a `budget_exceeded` stream event.
- A stale `daybreak/<uuid>` branch whose task finished days ago is cleaned up automatically.
- A command like `cat .env` or `read` of `../.env` is blocked before it reaches the filesystem.
- The dashboard shows queue depth, running count, dead-letter tasks, and cleanup reports.

---

> **Status:** M1–M7 complete; M8–M9 still pending.

## Milestones

### M1 — Durable task queue and concurrency control

**What it ships:** All task requests (dashboard, webhooks, review, heal, fork) are enqueued in Supabase and processed by a control-plane worker with a configurable max-concurrency limit. Webhook handlers return `202` immediately instead of waiting for a sandbox.

The current control plane spawns an E2B sandbox synchronously inside the request handler. Under a webhook flood this blocks the HTTP server, loses tasks on restart, and can exhaust E2B/Upstash quotas. A durable queue fixes this without requiring Cloudflare Queues yet.

- [x] Add `supabase/migrations/2026080601_add_task_queue.sql`:
  - Ensure `tasks.status` includes `"pending"` and `"retry_scheduled"`.
  - Add `worker_id`, `claimed_at`, `started_at` columns to `tasks` for claim tracking.
  - Add a Postgres function `claim_next_pending_task(max_concurrent integer)` that atomically selects the oldest `pending` or due `retry_scheduled` task, sets `status='running'`, increments `claimed_at`, and returns the row using `FOR UPDATE SKIP LOCKED` semantics.
- [x] Add `packages/control-plane/src/queue.ts` with a `TaskQueue` class:
  - `enqueue(spec)` inserts a `pending` task into Supabase.
  - `claimNext()` calls the `claim_next_pending_task` RPC and respects `DAYBREAK_MAX_CONCURRENT_TASKS`.
  - `getStatus()` returns pending/running/completed counts.
- [x] Refactor `packages/control-plane/src/server.ts`:
  - `POST /api/tasks`, webhook handlers, review/heal/fork routes call `queue.enqueue(...)` and return `202` with `{ taskId, status: "pending" }`.
  - Extract the existing sandbox-spawning logic into a `processTask(task)` method invoked by the worker.
  - Start a worker loop when the server boots (configurable; can also be run as a separate `pnpm --filter control-plane worker` command).
- [x] Add `packages/control-plane/src/queue.test.ts`:
  - Test that `claim_next_pending_task` is safe under concurrent callers.
  - Test that enqueue + claim sets the correct status and that concurrency limits are respected.
- [x] Add config to `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_MAX_CONCURRENT_TASKS` (default `2`)
  - `DAYBREAK_QUEUE_WORKER_POLL_MS` (default `1000`)
  - `DAYBREAK_QUEUE_WORKER_ENABLED` (default `true`)
- [x] Update `packages/ui/src/App.tsx`:
  - Add a queue status box: pending count, running count, completed/failed count.
  - Allow cancelling a `pending` task (set status `cancelled`).

**Acceptance:**
- Send 20 rapid `POST /api/tasks` requests. At most `DAYBREAK_MAX_CONCURRENT_TASKS` are `running` at once; the rest are `pending` and are processed in order.
- A `check_run` webhook returns `202` immediately; the task appears in the queue and is processed by the worker.
- Restarting the control plane while tasks are `pending` does not lose them; the worker resumes processing.
- `pnpm lint && pnpm typecheck && pnpm test` pass.

---

### M2 — Idempotency and delivery deduplication

**What it ships:** Every task-creating path supports an idempotency key. Replaying the same dashboard request or GitHub webhook delivery does not create duplicate tasks or sandboxes.

Phase 3 already deduplicates webhooks via `X-GitHub-Delivery` stored in Redis for 24 hours. Phase 6 generalizes this into a durable, cross-cutting idempotency layer that also covers the dashboard, heals, reviews, and forks.

- [x] Add `supabase/migrations/2026080602_add_idempotency_keys.sql`:
  - `idempotency_keys` table: `key text primary key`, `task_id uuid references tasks(id)`, `created_at timestamptz default now()`.
  - Add `tasks.idempotency_key` column.
- [x] Add `packages/control-plane/src/idempotency.ts` with an `IdempotencyStore`:
  - `tryCreate(key, taskId)` attempts a `SET NX` in Redis with 24-hour TTL and, on success, inserts into `idempotency_keys`.
  - `getTaskId(key)` returns the existing task id from Redis or Supabase.
- [x] Update `packages/control-plane/src/server.ts`:
  - `POST /api/tasks` reads an `Idempotency-Key` header (or generates one from `repo` + `branch` + hash of prompt) and returns the existing task if already seen.
  - Webhook handlers use `X-GitHub-Delivery` as the idempotency key.
  - `runReview` uses a deterministic key like `review:<repo>:<prNumber>:<commentId>`.
  - `runHeal` uses `heal:<repo>:<checkRunId>:<attempt>`.
  - `POST /api/checkpoints/:checkpointId/fork` uses `fork:<checkpointId>:<promptHash>`.
- [x] Add `packages/control-plane/src/idempotency.test.ts` with Redis mocked.
- [x] Update `packages/control-plane/src/server.test.ts`:
  - A duplicate `X-GitHub-Delivery` returns `202` with the original task id.
  - A duplicate `Idempotency-Key` on `POST /api/tasks` returns the original task id.

**Acceptance:**
- Replay the same `issue_comment` webhook 5 times with the same `X-GitHub-Delivery` → only one task is created.
- Replay the same dashboard `POST /api/tasks` with the same `Idempotency-Key` 5 times → only one task is created.
- A flood of identical `check_run` events for the same failed job creates exactly one heal task.

---

### M3 — Retry engine and dead-letter handling

**What it ships:** Tasks that fail for transient reasons are retried with exponential backoff; permanently failed or exhausted tasks are stored in a dead-letter table for manual inspection and re-queueing.

Currently a failed sandbox spawn or a transient network error immediately marks the task `failed`. Phase 6 makes the platform self-healing at the orchestration layer, not just at the CI layer.

- [x] Add `supabase/migrations/2026080603_add_retries_and_dead_letter.sql`:
  - Add to `tasks`: `retry_count integer default 0`, `max_retries integer default 2`, `next_retry_at timestamptz`, `last_error text`.
  - Add `dead_letter_tasks` table: `id uuid primary key`, `task_id uuid`, `repo text`, `branch text`, `pr_branch text`, `error text`, `retry_count integer`, `created_at timestamptz default now()`, `resolved_at timestamptz`, `resolution text`.
- [x] Add `packages/control-plane/src/retry.ts`:
  - `RetryClassifier.isRetryable(error, triggerSource, context)` returns true for transient failures:
    - E2B sandbox creation/connection errors
    - Git clone network failures/timeouts
    - LLM provider 5xx/429 errors
    - Upstash/Supabase transient errors
    - Bundle upload failures
  - Returns false for safety blocks, branch-protection blocks, max turns/cost, invalid repo, auth 403, test failures, and heal-attempt caps.
  - `RetryScheduler.nextRetryAt(retryCount)` implements exponential backoff (e.g., 30s, 2m, 5m).
- [x] Update `packages/control-plane/src/queue.ts` worker:
  - After `processTask` exits with failure, call `RetryClassifier`.
  - If retryable and `retry_count < max_retries`, update task to `retry_scheduled` with `next_retry_at`.
  - If not retryable or retries exhausted, insert into `dead_letter_tasks` and emit `dead_letter` event.
- [x] Add `packages/control-plane/src/server.ts` endpoints:
  - `GET /api/dead-letter` lists dead-letter tasks.
  - `POST /api/dead-letter/:taskId/retry` moves a dead-letter task back to `pending`.
- [x] Add `packages/ui/src/DeadLetterView.tsx` and wire it into `App.tsx`.
- [x] Add `packages/control-plane/src/retry.test.ts` for classifier cases.

**Acceptance:**
- Configure an invalid `E2B_API_KEY`; enqueue a task. The task is retried up to `max_retries` times with increasing backoff, then appears in the dead-letter queue.
- A task blocked by reading `.env` goes straight to the dead-letter table with reason `safety_block` and `retry_count=0`.
- A dead-letter task can be manually retried via the dashboard and returns to the queue.

---

### M4 — Tenant isolation and per-tenant quotas

**What it ships:** Tasks are bound to a tenant. Each tenant has per-hour task rate limits, a daily cost budget, a max-concurrency limit, and role-based action checks. The data model is compatible with the future GitHub App installation flow.

Phase 3 introduced a `workspaces` stub with `repo`/`sender`-level rate limits. Phase 6 generalizes this into a `tenants` model that will become the GitHub App `installation` in Phase 7 without a schema rewrite.

- [x] Add `supabase/migrations/2026080604_add_tenants.sql`:
  - `tenants` table: `id uuid primary key`, `type text` (`pat`, `github_installation`), `value text` (owner for PAT, installation id for app), `config jsonb` (rate limits, daily cost budget, max concurrency), `created_at`, `updated_at`.
  - `tenant_memberships` table: `tenant_id`, `user_id text`, `role text` (`admin`, `operator`, `viewer`), `created_at`.
  - Add `tasks.tenant_id` foreign key and a `workspaces.tenant_id` column to migrate existing workspaces.
- [x] Add `packages/control-plane/src/tenants.ts` with `TenantService`:
  - `getOrCreateTenantForRequest(req)` derives tenant from `X-Daybreak-Tenant-Id`, `repository.owner.login`, or `installation.id`.
  - `assertCanCreateTask(tenant, userId, role, costEstimate)` checks rate, budget, concurrency, and role.
  - `recordTaskCost(tenantId, costUsd)` updates daily spend (computed from `tasks` table).
- [x] Update `packages/control-plane/src/server.ts`:
  - `assertCanSpawn` is replaced by `tenant.assertCanCreateTask`.
  - `POST /api/tasks` and webhook handlers attach `tenant_id` to the task spec.
  - `GET /api/tasks` scopes by tenant when `X-Daybreak-Tenant-Id`/`X-Daybreak-Role` is present.
- [x] Update `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_DEFAULT_TENANT_DAILY_COST_USD` (default `0.50`)
  - `DAYBREAK_DEFAULT_TENANT_TASKS_PER_HOUR` (default `10`)
  - `DAYBREAK_DEFAULT_TENANT_MAX_CONCURRENT` (default `2`)
- [x] Update `packages/ui/src/App.tsx`:
  - Add tenant selector or headers section for local testing.
  - Show `budget_exceeded` / `rate_limited` events.

**Acceptance:**
- A tenant with `tasks_per_hour=2` is rejected on the third task within an hour with `429`.
- A tenant with `daily_cost_usd=0.01` is rejected after tasks exceed the budget.
- A request from a user with `viewer` role cannot trigger a new task.
- Existing `workspaces` rows continue to work because they are linked to the new `tenants` table.

> **Note:** GitHub App registration, JWT signing, 1-hour installation tokens, and per-installation webhooks are still Phase 7. Phase 6 prepares the tenant model; Phase 7 will populate it from GitHub App installations.

---

### M5 — Cost and global resource circuit breakers

**What it ships:** The per-task `MAX_COST_USD`, `MAX_TURNS`, and `MAX_WALL_CLOCK` limits are finalized and emit explicit `circuit_breaker_triggered` events. The control plane enforces tenant and global daily budgets and caps total concurrent sandboxes.

Phase 0/1 already added the `TaskRunner` abort paths. Phase 6 surfaces them as first-class observability events and protects the platform from runaway spend across tenants.

- [x] Update `packages/agent-runner/src/session.ts`:
  - When `abort` is called for `max_turns`, `max_cost_usd`, or `max_wall_clock`, emit a `circuit_breaker_triggered` stream event with `reason`, `limit`, and `current` values.
  - Ensure the root span is ended with `ERROR` status and the trace is flushed.
- [x] Add `packages/control-plane/src/budgets.ts`:
  - `getTenantDailySpend(tenantId, since)` aggregates `cost_usd` from `tasks` for the tenant in the last 24h.
  - `getGlobalConcurrentRunning()` counts `status='running'` tasks.
  - `isWithinBudget(tenant, estimatedCost)` checks tenant daily and global limits before claiming a task.
- [x] Update `packages/control-plane/src/queue.ts`:
  - Before claiming a task, call `budgets.isWithinBudget`. If not, defer the task and emit a `budget_deferred` event.
  - Enforce `DAYBREAK_MAX_CONCURRENT_TASKS` globally as well as per tenant.
- [x] Add config to `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_GLOBAL_MAX_CONCURRENT_SANDBOXES` (default `5`)
  - `DAYBREAK_COST_ALERT_THRESHOLD` (default `0.8`, fraction of `MAX_COST_USD` at which to emit `cost_alert`)
- [x] Update `packages/ui/src/App.tsx`:
  - Render `circuit_breaker_triggered` and `cost_alert` events in the terminal.
  - Show a cost-alert banner when a task crosses the threshold.
- [x] Add `packages/control-plane/src/budgets.test.ts`.

**Acceptance:**
- Run a task with `maxTurns=3` that loops forever. It stops at turn 3, emits `circuit_breaker_triggered: max_turns`, and the trace is visible in Langfuse.
- Set a tenant's daily cost budget to a low value, run tasks until it is exceeded, and observe `budget_exceeded` with the next task rejected.
- The worker never starts more than `DAYBREAK_MAX_CONCURRENT_TASKS` + `DAYBREAK_GLOBAL_MAX_CONCURRENT_SANDBOXES` sandboxes.

---

### M6 — Security hardening and output redaction

**What it ships:** A concrete security layer blocks path traversal, expands the sensitive-file denylist, redacts secrets from stream events and logs, and hardens branch-protection and bash guards.

The current `SafetyMiddleware` blocks the known `.env` and secret patterns but does not prevent `read ../.env`, `bash cat /etc/passwd`, or the accidental leakage of a secret into the Redis stream or control-plane logs. Phase 6 closes those gaps.

- [x] Add `packages/shared/src/security.ts`:
  - `sanitizePath(cwd, requestedPath)` resolves an absolute or relative path and rejects any result outside `cwd` or containing `..` escape sequences.
  - `isSensitivePath` already exists; extend it to also reject absolute paths outside `cwd`.
  - `redactSecrets(text)` scans strings for credential patterns (`token=...`, `api_key=...`, `Authorization: Bearer ...`, `-----BEGIN ...-----`, AWS keys, URL credentials) and replaces values with `[REDACTED]`.
- [x] Update `packages/shared/src/safety.ts`:
  - In `beforeToolCall`, for `read`/`write`/`edit` tools, call `sanitizePath` on any `path`, `file_path`, `target_path`, `new_path`, `old_path` argument.
  - For `bash`, tokenize the command and reject any token that resolves outside `cwd` (e.g., absolute `/etc/passwd`, `../.env`) and any sensitive path.
  - Extend `isGitCommandOnProtectedBranch` to also catch `git switch`, `git merge`, and refspec deletions like `git push origin :main`.
- [x] Expand `DEFAULT_DENYLIST_PATTERNS` in `packages/shared/src/config.ts`:
  - Add `.aws/credentials`, `.docker/config.json`, `.netrc`, `.pgpass`, `.my.cnf`, `id_rsa`, `id_ed25519`, `*.p8`, `*.mobileprovision`, `.bash_history`, `.zsh_history`.
- [x] Update `packages/agent-runner/src/stream.ts`:
  - Call `redactSecrets` on the event payload before `rpush` to Redis.
- [x] Update `packages/control-plane/src/server.ts`:
  - Call `redactSecrets` in `appendLog` and `publishEvent` before persisting to disk/Supabase.
- [x] Update `packages/control-plane/src/ci-logs.ts`:
  - Reuse the shared `redactSecrets` function instead of a local implementation.
- [x] Add `packages/shared/src/security.test.ts` with path-traversal, secret-redaction, and bash-command test cases.
- [x] Add `docs/SECURITY_AUDIT.md` capturing the audit findings and mitigations.

**Acceptance:**
- Agent calls `read` with `path: "../.env"` → blocked with `Path resolves outside workspace`.
- Agent calls `bash` with `command: "cat /etc/passwd"` → blocked for path traversal.
- Agent calls `bash` with `command: "echo GITHUB_TOKEN=ghp_xxx"` → the event in the UI shows `GITHUB_TOKEN=[REDACTED]`.
- `git push origin main` and `git push origin --force` are blocked by branch-protection logic.

---

### M7 — Branch cleanup and idle sandbox termination

**What it ships:** A cleanup service removes stale `daybreak/<uuid>` branches from target repos, kills sandboxes whose keep-alive expired or whose task is terminal, and prunes old checkpoint/session data to stay within free-tier limits.

Over time the target repos accumulate abandoned Daybreak branches and E2B sandboxes stay alive longer than needed. Phase 6 automates cleanup while respecting active tasks.

- [x] Add `supabase/migrations/2026080605_add_cleanup.sql`:
  - `cleanup_runs` table: `id uuid primary key`, `type text`, `started_at`, `completed_at`, `details jsonb`, `deleted_count integer`.
  - Add index on `tasks(pr_branch, status, ended_at)`.
- [x] Add `packages/control-plane/src/cleanup.ts` with:
  - `cleanupBranches(options)`:
    - Query GitHub API for branches matching `DAYBREAK_PR_BRANCH_PREFIX`.
    - For each branch, look up its task. Delete the branch if the task is terminal (`complete`/`failed`/`abandoned`/`promoted`) and `ended_at` is older than `DAYBREAK_BRANCH_TTL_DAYS`, or if there is no associated task.
    - Also delete remote checkpoint tags `daybreak/checkpoint/<taskId>/*` when a branch is deleted.
    - Support `dryRun`.
  - `cleanupSandboxes()`:
    - For every `running` task where `keepAliveUntil < now()` or status is terminal, call `Sandbox.connect(sandboxId).kill()` (or the E2B API if available).
    - If `sandboxId` is unknown, skip and log.
  - `cleanupDataRetention()`:
    - Mark checkpoints older than `DAYBREAK_DATA_RETENTION_DAYS` as `abandoned`.
    - Delete old `session_snapshots` rows to save Supabase storage.
- [x] Update `packages/control-plane/src/server.ts`:
  - Add `POST /api/cleanup?type=branches|sandboxes|all&dryRun=true|false`.
  - Optionally run cleanup on server start and on a `setInterval` in local mode; document that Phase 7 will use Cloudflare scheduled Workers for true cron.
- [x] Update `packages/ui/src/App.tsx`:
  - Add a "Cleanup" panel with dry-run and run buttons.
  - Show last cleanup run summary.
- [x] Add `packages/control-plane/src/cleanup.test.ts` with mocked GitHub and E2B calls.
- [x] Add config to `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_BRANCH_TTL_DAYS` (default `7`)
  - `DAYBREAK_SANDBOX_IDLE_TTL_MINUTES` (default `15`)
  - `DAYBREAK_DATA_RETENTION_DAYS` (default `30`)
  - `DAYBREAK_CLEANUP_ENABLED` (default `true`)

**Acceptance:**
- A `daybreak/<uuid>` branch whose task is `complete` and older than `DAYBREAK_BRANCH_TTL_DAYS` is deleted by cleanup (or shown in dry-run).
- A sandbox with `keepAliveUntil` in the past is killed by cleanup.
- A checkpoint older than `DAYBREAK_DATA_RETENTION_DAYS` is marked `abandoned` and its session snapshot is removed.

---

### M8 — Compaction tuning and large-repo resilience

**What it ships:** Pi context compaction is configurable per task, file reads are bounded, and repo clones can be shallow. Circuit-breaker events are explicit and traceable.

Long tasks on non-trivial repos can exceed context windows or pull multi-gigabyte files into the LLM context. Phase 6 adds the final guardrails and tuning knobs.

- [x] Add `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_MAX_FILE_READ_BYTES` (default `200000`)
  - `DAYBREAK_MAX_FILE_READ_LINES` (default `5000`)
  - `DAYBREAK_MAX_REPO_CLONE_DEPTH` (default `0`, `0` means full clone)
  - `DAYBREAK_COMPACTION_RESERVE_TOKENS` and `DAYBREAK_COMPACTION_KEEP_RECENT_TOKENS` are already config; also accept per-task overrides from `POST /api/tasks`.
- [x] Update `packages/agent-runner/src/run-task.ts`:
  - If `DAYBREAK_MAX_REPO_CLONE_DEPTH > 0`, pass `--depth <n>` to `git clone`.
- [x] Update `packages/shared/src/safety.ts`:
  - In `beforeToolCall`, for `read`/`write`/`edit`, check the target file size and line count; block or truncate if it exceeds `MAX_FILE_READ_BYTES`/`MAX_FILE_READ_LINES`.
- [x] Update `packages/agent-runner/src/session.ts`:
  - On `turn_start`, if the token count of the current conversation exceeds a threshold, force a compaction round (if Pi exposes the API) or emit a `compaction_advised` event.
  - Ensure `circuit_breaker_triggered` events are emitted for `max_cost_usd` and `max_wall_clock` as well.
- [x] Update `packages/agent-runner/src/llm.ts`:
  - Track provider health: consecutive 5xx/429 errors from a provider increment a failure counter; after a threshold, fail-fast to the fallback provider immediately instead of waiting for each call to time out.
- [x] Add `packages/agent-runner/src/limits.test.ts` for file-size and circuit-breaker behavior.
- [x] Update `packages/ui/src/App.tsx` `formatEvent` to render `compaction_advised` and `circuit_breaker_triggered`.

**Acceptance:**
- A task with `maxTurns=3` that cannot fix the failing test stops at turn 3 and the dashboard shows `circuit_breaker_triggered: max_turns`.
- An agent attempt to `read` a 10 MB file is blocked with a `file_too_large` event.
- A repo clone with `DAYBREAK_MAX_REPO_CLONE_DEPTH=1` produces a shallow clone and the task still passes the eval fixture.

---

### M9 — Evals, cost budget update, docs, and phase sign-off

**What it ships:** Phase 6 is repeatable, budgeted, tested, and marked complete in the roadmap.

- [x] Extend `packages/evals/src/index.ts` and add `packages/evals/src/resilience.ts`:
  - Queue flood: rapid task creation, assert concurrency and no duplicates.
  - Idempotency: replay same request, assert single task.
  - Retry/dead-letter: force a transient E2B failure, assert retry then dead-letter.
  - Tenant rate limit: exceed hourly quota, assert `429`.
  - Security: attempt `read`/`bash` on `.env` and `../.env`, assert blocked.
  - Circuit breaker: `MAX_TURNS=3` loop, assert stop.
  - Branch cleanup: dry-run deletion of a stale branch.
- [x] Add unit/integration tests for `queue.ts`, `idempotency.ts`, `retry.ts`, `tenants.ts`, `budgets.ts`, `security.ts`, `cleanup.ts`.
- [x] Update `docs/COST_BUDGET.md`:
  - Queue/concurrency savings under webhook floods.
  - Retry/dead-letter cost (extra E2B sandboxes for retries).
  - Tenant budget impact on daily spend.
  - Cleanup savings on Supabase storage and E2B runtime.
- [x] Update `docs/SECRETS.md` with tenant headers and new env vars.
- [x] Update `decisions.md` with queue strategy, tenant model, retry policy, security hardening, cleanup policy.
- [x] Update `roadmap.md` Phase 6 checklist and add a link to this document.
- [x] Update `.env.example` with all Phase 6 variables.
- [x] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter agent-runner build:bundle && pnpm --filter ui build`.

**Acceptance:**
- `pnpm eval` includes resilience fixtures and passes.
- `pnpm eval:e2e` still passes for the `failing-sum` fixture.
- All CI checks pass and `roadmap.md` shows Phase 6 as complete.

---

## Recommended order

1. **M1** — The queue is foundational; M3/M4/M5 build on it.
2. **M2** — Idempotency can be merged with M1 in one PR or follow immediately.
3. **M3** — Retry engine; depends on the queue and worker lifecycle.
4. **M4** — Tenant isolation; depends on task creation path.
5. **M5** — Cost/global circuit breakers; depends on tenant model but can be drafted in parallel with M4.
6. **M6** — Security hardening; can be parallel to M1–M5.
7. **M7** — Cleanup; can be parallel to M1–M6, but should land after M1 so it can kill queued/running tasks safely.
8. **M8** — Compaction and large-repo resilience; can be parallel.
9. **M9** — Evals, docs, budget, sign-off; always last.

Likely PR split:
- PR 1: M1 + M2 (queue + idempotency).
- PR 2: M3 (retry + dead-letter).
- PR 3: M4 + M5 (tenant quotas + budgets).
- PR 4: M6 (security hardening).
- PR 5: M7 + M8 (cleanup + large-repo resilience).
- PR 6: M9 (evals, docs, sign-off).

---

## Major risks and mitigations

| Risk | Mitigation |
|------|------------|
| Supabase `claim_next_pending_task` RPC has race conditions | Use `FOR UPDATE SKIP LOCKED` inside a single Postgres function; test with concurrent callers. |
| Worker crashes while a task is `running` | `running` tasks are still in `tasks` table; a new worker process can resume by claiming any stale `running` tasks whose `claimed_at` is older than a heartbeat timeout. |
| Retry loops on non-transient failures | `RetryClassifier` explicitly excludes safety blocks, branch protection, max turns/cost, and test failures. |
| Tenant model conflicts with Phase 7 GitHub App | Use a generic `tenants` table with `type` and `value`; Phase 7 adds `installations` rows and maps them to tenants. |
| Cost overruns before circuit breaker trips | Check tenant daily budget in the worker before claiming; emit `cost_alert` at 80% of per-task budget. |
| Secret redaction mangles legitimate code | `redactSecrets` only replaces values after known credential prefixes and headers, leaving surrounding code intact. |
| Path traversal via `bash` is hard to parse | Combine `sanitizePath` on absolute/relative tokens with the existing denylist; legitimate repo-relative commands still work. |
| Cleanup deletes an active branch | Only delete branches whose task is terminal and older than `DAYBREAK_BRANCH_TTL_DAYS`; support dry-run. |
| Shallow clones break some tests | `DAYBREAK_MAX_REPO_CLONE_DEPTH=0` disables shallow clone by default; opt-in for known repos. |
| E2B sandbox list/kill API unavailable | Use `Sandbox.connect(sandboxId).kill()` from the control plane; fallback to `tasks.sandbox_id` records and keep-alive timeouts. |
| Phase 6 scope grows beyond the roadmap | Reject anything that belongs in Phase 7 (GitHub App, Cloudflare Workers, Durable Objects) and document it as deferred. |

---

## Verification commands

```bash
# Lint/typecheck/test
pnpm lint && pnpm typecheck && pnpm test

# Agent bundle and UI build
pnpm --filter agent-runner build:bundle
pnpm --filter ui build

# Control-plane queue/worker tests
pnpm --filter control-plane test

# Resilience evals
pnpm --filter evals eval --resilience

# End-to-end through control plane
pnpm --filter evals eval:e2e

# Manual resilience demos
# 1. Queue flood: run `pnpm --filter evals eval:queue-flood` or POST 20 tasks quickly.
# 2. Idempotency: replay a webhook with the same X-GitHub-Delivery.
# 3. Retry: set E2B_API_KEY=invalid and enqueue a task.
# 4. Security: ask the agent to `read .env` or `bash cat /etc/passwd`.
# 5. Cleanup: POST /api/cleanup?type=branches&dryRun=true.
```

---

## Notes

- **Auth remains PAT-only.** Phase 6 adds the tenant data model but does not implement GitHub App JWT, installation-token exchange, or auto-subscribed webhooks. Those are Phase 7.
- **Queue implementation is local-first.** The Supabase-backed queue with a worker loop works for the local control plane and can be migrated to Cloudflare Queues in Phase 7 by replacing `TaskQueue.claimNext` with a Queue consumer binding.
- **Multi-tenancy is opt-in for local development.** If no `X-Daybreak-Tenant-Id` header is sent, the control plane auto-creates a default tenant so existing demos continue to work.
- **Cleanup is manual-by-default in local mode.** A `POST /api/cleanup` endpoint and a dashboard button are provided; Phase 7 will add a Cloudflare scheduled trigger.
- **This milestone document should be updated as Phase 6 is built.** Mark each checkbox when the acceptance criteria are verified, and revise the tenant/quota defaults once real usage data is collected.
