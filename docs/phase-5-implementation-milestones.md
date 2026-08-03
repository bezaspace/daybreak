# Phase 5 Implementation Milestones

**Sub-document of:** [../roadmap.md](../roadmap.md)  
**Phase name:** CI Self-Healing *(Headline Feature)*  
**Goal:** Listen for failed GitHub Actions status checks on Daybreak's own PRs, fetch the failed job logs and annotations, and have the agent push a self-healing fix commit to the same PR branch.

> **Dependency note:** Phase 5 builds on Phase 3 (PAT-only webhooks, review-loop reconnect) and Phase 4 (checkpoint/branch task model). It reuses the existing `REVIEW_MODE` / branch-iteration path in `packages/agent-runner/src/run-task.ts` so the agent pushes a follow-up commit instead of opening a new PR.

This document breaks the Phase 5 exit criteria into small, independently-demoable milestones. Each milestone ships a visible capability and can be reviewed on its own.

---

## Exit criteria for the whole phase

> From [../roadmap.md](../roadmap.md): Merge a PR with a deliberately broken test. CI fails. Daybreak receives the webhook, analyzes the log, pushes a fix, and CI goes green.

---

## Milestones

### M1 — `check_run` webhook ingress and Daybreak-PR filtering

**What it ships:** The control plane accepts `check_run` webhooks, verifies them the same way as other GitHub events, and only acts on failed checks for branches that Daybreak created.

- [x] Extend `packages/control-plane/src/server.ts` `POST /api/webhooks/github`:
  - Add a `case "check_run"` handler.
  - Parse `action`, `check_run.conclusion`, `check_run.id`, `check_run.name`, `check_run.output`, `check_run.check_suite.id`, `check_run.check_suite.head_branch`, `check_run.check_suite.pull_requests`, and `check_run.pull_requests`.
  - Only process `action === "completed"` and `conclusion === "failure"`.
- [x] Filter to Daybreak PRs:
  - Look up an existing task by `repo` + `pr_branch` matching `head_branch`.
  - Fallback: allow branches matching `DAYBREAK_PR_BRANCH_PREFIX` (default `daybreak/`).
  - Reuse `GITHUB_WEBHOOK_REPO_ALLOWLIST` for repo trust.
- [x] Add `triggerSource: "check_run"` to `Task` / `PersistedTask`.
- [x] Add `headSha`, `checkRunId`, and `healAttempt` fields to `Task` / `PersistedTask` and to the Supabase `tasks` table (`supabase/migrations/2026080501_add_ci_heal_fields.sql`):
  - `head_sha text`
  - `check_run_id text`
  - `heal_attempt integer`
- [x] Add config to `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_CI_SELF_HEAL_ENABLED` (`true` | `false`, default `true`)
  - `DAYBREAK_PR_BRANCH_PREFIX` (default `daybreak/`)
  - `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` (default `2`)
- [x] Emit a `ci_failure_received` stream event with `checkRunId`, `checkSuiteId`, `checkName`, `headBranch`, `headSha`, `prNumber`, and `repo`.
- [x] Add unit/integration test in `packages/control-plane/src/server.test.ts`:
  - A synthetic `check_run` failure for a `daybreak/` branch returns `202` and creates a task with `triggerSource: "check_run"`.
  - A `check_run` for `main`, for `conclusion: success`, or for a repo outside the allowlist returns `200` and does **not** create a task.

**Acceptance:**
- `POST /api/webhooks/github` with a synthetic `check_run` `failure` for `daybreak/<uuid>` returns `202`.
- A `check_run` for `main` or with `conclusion: success` is acknowledged and ignored.
- `pnpm lint && pnpm typecheck && pnpm test` pass.

---

### M2 — Failed CI log and annotation fetcher

**What it ships:** A dedicated module downloads the failed job logs and annotations from the GitHub API and extracts a concise, token-budgeted error context for the agent prompt.

- [x] Add `packages/control-plane/src/ci-logs.ts` with a `CiLogFetcher` / `CiLogParser`:
  - `fetchAnnotations(owner, repo, checkRunId)`: `GET /repos/{owner}/{repo}/check-runs/{checkRunId}/annotations`; keep only `annotation_level === "failure"` entries with `path`, `start_line`, `message`, `title`.
  - `fetchJobLogs(owner, repo, jobId)`: `GET /repos/{owner}/{repo}/actions/jobs/{jobId}/logs` and follow the `Location` redirect. Limit download to `DAYBREAK_MAX_CI_LOG_BYTES` (default 512 KiB) and, if truncated, read from the end of the log where errors usually appear.
  - `parseErrorContext(logs, annotations, output)`: remove timestamps / ANSI control markers, find error patterns (`FAIL`, `Error:`, `error:`, `npm ERR!`, `Tests: ... failed`, `AssertionError`, etc.), and extract a configurable window of context lines (`DAYBREAK_CI_LOG_CONTEXT_LINES`, default 20) around the first few failure blocks.
  - `redactSecrets(text)`: strip obvious secret-like patterns (`token=...`, `api_key=...`, `SECRET=...`, URLs with embedded credentials) as defense-in-depth before the text reaches the LLM context.
- [x] Add `packages/control-plane/src/ci-logs.test.ts` with fixtures for:
  - A sample GitHub Actions plain-text log (timestamps, group markers, `npm test` failure).
  - A sample annotations list.
  - Assertions that the returned `errorContext` is under the token budget and contains the relevant failure lines.
- [x] Add config to `packages/shared/src/config.ts` and `.env.example`:
  - `DAYBREAK_MAX_CI_LOG_BYTES` (default 524288)
  - `DAYBREAK_CI_LOG_CONTEXT_LINES` (default 20)
- [x] Update `decisions.md` with the chosen log-fetch strategy:
  - `actions/jobs/{job_id}/logs` is the primary source because `check_run.id` equals the Actions job id.
  - Annotations are fetched first as a fast, structured fallback.
  - Raw logs are truncated and cleaned before being injected into the prompt.

**Acceptance:**
- `CiLogParser` extracts the failing test and error block from a mocked 100 KB log.
- `redactSecrets` removes a synthetic `API_KEY=abc123` without mangling the rest of the text.
- Unit tests pass.

---

### M3 — Heal task router and commit path

**What it ships:** A failed `check_run` spawns a new branch-iteration task that reuses an existing sandbox when possible, otherwise creates a fresh one, and pushes a fix commit to the same PR branch.

- [x] Add `runHeal` in `packages/control-plane/src/server.ts` (analogous to `runReview`):
  - Look up the original task by `prBranch` (or `prNumber` + `repo`) using `findOriginalTask`.
  - Build a `heal_prompt` with `buildCiHealPrompt(repo, prNumber, headBranch, headSha, checkName, errorContext)`:
    ```
    CI check '<checkName>' failed on PR #<prNumber> (branch <headBranch>, commit <headSha>):
    <errorContext>
    Investigate the repo, reproduce the failure, apply the minimal fix, run the failing test command, and push a follow-up commit to branch <headBranch>. Do not open a new PR.
    ```
  - Create a new `Task` with `triggerSource: "check_run"`, `parentTaskId` = original task id, `prNumber`, `prBranch` = `headBranch`, `headSha`, `checkRunId`, `healAttempt` = (count of prior `check_run` tasks for this PR + 1).
  - Reuse the original sandbox if `sandboxId` exists and `keepAliveUntil > now` (same reconnect logic as `runReview`).
  - Otherwise spawn a fresh E2B sandbox and have `run-task.ts` clone the PR branch.
- [x] Extend `packages/agent-runner/src/run-task.ts` to support `HEAL_MODE`:
  - Accept `HEAL_MODE=true` env and, when set, run in the same branch-iteration path as `REVIEW_MODE` (do not `rm -rf` / re-clone, pull the existing branch, push a new commit).
  - Emit `heal_task_start`, `heal_complete` / `heal_failed`, and `commit_pushed` events instead of `review_*` events when `HEAL_MODE` is true.
- [x] Extend `packages/control-plane/src/server.ts` to spawn heal tasks with `--review --heal` (or `--heal` if a new flag is added) and set `TASK_PROMPT`, `REVIEW_MODE=true`, and `HEAL_MODE=true`.
- [x] Update `packages/control-plane/src/db.ts` `toTask` / `persistTask` / `updateTask` to handle `headSha`, `checkRunId`, and `healAttempt`.
- [x] Emit `heal_task_start` and `ci_logs_fetched` stream events so the dashboard can show progress.

**Acceptance:**
- A synthetic `check_run` failure creates a heal task that appears in `GET /api/tasks` with `triggerSource: "check_run"`.
- The spawned agent runs in the PR branch and pushes a follow-up commit (verified in a real end-to-end demo).
- `pnpm lint && pnpm typecheck && pnpm test` pass.

---

### M4 — Circuit breakers, deduplication, and safety

**What it ships:** Daybreak cannot be looped into an infinite self-heal cycle, cannot heal the same failed run twice, and cannot act on protected or non-Daybreak branches.

- [x] Add per-PR heal attempt counter:
  - Before spawning a heal task, query `tasks` for `repo` + `prNumber` + `triggerSource = "check_run"` in the last 24 hours.
  - If count >= `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` (default `2`), emit `heal_skipped` with reason `max heal attempts reached` and return `200`.
- [x] Add in-flight guard:
  - If a `check_run` heal task for the same `prBranch` is already `running`, skip the new webhook with a `heal_skipped` event.
- [x] Add delivery / check-run deduplication:
  - Reuse existing `isDuplicateDelivery` (`X-GitHub-Delivery`) to ignore retries.
  - Also set a Redis key `daybreak:heal-checkrun:{checkRunId}` with 24-hour TTL to avoid duplicate heals if GitHub redelivers with a new delivery ID.
- [x] Add branch-safety guard:
  - Refuse to heal if `headBranch` matches `main`, `master`, or `protectedBranches`.
  - Refuse to heal if `headBranch` does not match `DAYBREAK_PR_BRANCH_PREFIX` and is not a known `pr_branch` in `tasks`.
- [x] Add `DAYBREAK_HEAL_COOLDOWN_SECONDS` (default `60`) to prevent rapid re-triggering on the same commit; skip if a heal for the same `headSha` was started within the cooldown window.
- [x] Update `packages/control-plane/src/server.test.ts`:
  - Test that the third heal attempt for the same PR is skipped.
  - Test that a `check_run` for a protected branch is ignored.

**Acceptance:**
- Three consecutive `check_run` failures for the same PR create at most two heal tasks.
- A duplicate `X-GitHub-Delivery` or duplicate `check_run.id` does not spawn a second heal task.
- A `check_run` for `main` is ignored.

---

### M5 — Dashboard and event stream UI

**What it ships:** The React dashboard surfaces CI failures, heal tasks, and their outcomes alongside the existing task list.

- [x] Update `packages/ui/src/App.tsx` `formatEvent` to render:
  - `ci_failure_received` — show check name, branch, conclusion.
  - `ci_logs_fetched` — show bytes / annotations count.
  - `heal_task_start` — show task id and branch.
  - `heal_complete` / `heal_failed` / `heal_skipped` — show status and reason.
- [x] Update the "Recent tasks" list to show `triggerSource` and, for `check_run` tasks, the `prNumber` / `headSha` (if available).
- [x] Add a small `CiHealView.tsx` tab or panel that lists recent `check_run` heal attempts with status, PR link, and cost. This reuses the existing `/api/tasks` data.
- [x] Ensure the UI distinguishes branch tasks (`branch of <taskId>`) from heal tasks (`heal of <prBranch>`).

**Acceptance:**
- A `check_run` failure appears in the dashboard terminal with the failed check name and branch.
- The heal task shows up in the recent tasks list with `triggerSource: check_run`.
- `pnpm --filter ui build` passes.

---

### M6 — Evals, cost budget, docs, and phase sign-off

**What it ships:** Phase 5 is repeatable, budgeted, tested, and marked complete.

- [x] Add end-to-end test harness for CI self-healing:
  - Added `packages/evals/src/ci-self-heal.ts`. In `--real` mode it can open a broken PR on `bezaspace/daybreak-target`, wait for a failed GitHub Actions `check_run`, send the webhook to the local control plane, and poll for the heal task, new commit, and green CI run.
  - The default fast mode runs the control-plane `check_run` integration tests, which mock the payload and assert the heal task is created with the right `prBranch` and `headSha`.
- [x] Add unit tests for `ci-logs.ts` (parser, redactor, annotation fetcher). Covered in `packages/control-plane/src/ci-logs.test.ts`.
- [x] Update `docs/COST_BUDGET.md` with Phase 5 cost drivers:
  - One extra E2B sandbox (or reconnect) per heal.
  - Extra LLM turns per heal (typically 3–8 turns).
  - GitHub API log download is free under REST quota.
  - `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` caps cost per PR.
- [x] Update `.env.example` with all Phase 5 variables.
- [x] Update `docs/SECRETS.md` to note that the PAT needs `actions:read` and `checks:read` (usually covered by `repo` scope) for fetching logs/annotations.
- [x] Update `roadmap.md` Phase 5 checklist to mark items complete.
- [x] Update `decisions.md` with final design choices (check_run vs check_suite, log parsing strategy, branch-prefix trust, max-attempt circuit breaker).
- [x] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter agent-runner build:bundle && pnpm --filter ui build`.

**Acceptance:**
- `pnpm eval` supports a `--ci-self-heal` path; `pnpm eval:ci-self-heal` runs the fast integration by default.
- A manual end-to-end demo succeeds: broken PR → CI fails → `check_run` webhook → heal commit pushed → CI green.
- All CI checks pass and `roadmap.md` shows Phase 5 as complete.

---

## Recommended order

1. **M1** — Webhook ingress and filtering are prerequisites for everything else.
2. **M2** — Log/annotation fetcher can be built in parallel with M1; it has no runtime dependency on M1.
3. **M3** — Heal task router and commit path; depends on M1 and M2 (needs failure payload + error context).
4. **M4** — Circuit breakers and dedup; can be done in parallel with M3 logic but should land in the same PR or immediately after.
5. **M5** — Dashboard UI; depends on M3 events.
6. **M6** — Evals, docs, budget, sign-off; always last.

M1 and M2 can ship together. M3 and M4 are tightly coupled and should land together. M5 is a separate UI PR. M6 is the final sign-off PR.

---

## Major risks and mitigations

| Risk | Mitigation |
|------|------------|
| `check_run` events fire per job, causing multiple heals for one suite | Use `checkRunId` dedup and per-PR attempt limit; treat the first failed check of a suite as the trigger and ignore subsequent failures on the same commit within the cooldown window. |
| GitHub Actions logs are large or unavailable | Truncate to `DAYBREAK_MAX_CI_LOG_BYTES` and read from the end; use annotations and `output.title/summary/text` as fallback. |
| PAT cannot fetch logs or push to the PR branch | Document required `repo` scope in `docs/SECRETS.md`; fail fast with a clear error if the log fetch returns 403/404. |
| Infinite self-heal loops on flaky CI | Hard cap of `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` (default 2); each heal is a separate task with its own `MAX_TURNS` and `MAX_COST_USD`; cooldown window prevents rapid re-trigger. |
| Heal task edits the wrong branch | Filter by branch prefix `daybreak/` or known `pr_branch`; block `main`/`master` and `protectedBranches` in the heal router. |
| Logs contain secrets that leak into the LLM context | Redact credential-like patterns; rely on GitHub's native secret redaction in Actions; keep `DAYBREAK_MAX_CI_LOG_BYTES` small. |
| Concurrent heals race on the same PR branch | In-flight guard: skip if a `check_run` heal task for the same `prBranch` is already `running`. |
| GitHub sends `check_run` for non-Actions checks | The `actions/jobs/{job_id}/logs` endpoint may not work for third-party checks; fallback to `output.text` and annotations; emit a warning event. |
| Cost of spawning a new sandbox per heal | Reconnect to the original sandbox when `keepAliveUntil` has not expired; use `git-reinstall` strategy from Phase 4 for fresh sandboxes. |

---

## Verification commands

```bash
# Lint/typecheck/test
pnpm lint && pnpm typecheck && pnpm test

# Agent bundle and UI build
pnpm --filter agent-runner build:bundle
pnpm --filter ui build

# Control-plane webhook integration tests
pnpm --filter control-plane test

# Local control-plane end-to-end through the real webhook path
pnpm --filter evals eval:e2e

# Manual CI self-heal end-to-end demo
# 1. Push a broken test to a daybreak/<uuid> branch on the target repo and open a PR.
# 2. Wait for GitHub Actions to fail.
# 3. Ensure the repo webhook is subscribed to check_run and points at the tunnel.
# 4. Verify the control plane receives the webhook, creates a heal task, and pushes a fix commit.
# 5. Verify the next CI run is green.
```

---

## Notes

- **Auth path remains PAT-only.** Phase 5 does not introduce a GitHub App. The `GITHUB_TOKEN` PAT must have `repo` scope (which includes `contents:write`, `pull_requests:write`, `actions:read`, and `checks:read`) to fetch logs, annotations, and push fix commits.
- **Webhooks are still manually configured per repo.** `check_run` must be enabled in the repo/org webhook settings, and the webhook must point at the local control plane via `cloudflared`/`ngrok`.
- **Branch prefix is the trust signal.** Because `check_run` payloads do not reliably identify the bot author, we treat `daybreak/<uuid>` branches (or branches already recorded in `tasks.pr_branch`) as Daybreak-owned. This is configurable via `DAYBREAK_PR_BRANCH_PREFIX`.
- **Heal tasks are branch iterations, not new PRs.** The agent reuses `REVIEW_MODE` logic: it pulls the existing PR branch, makes a fix, and pushes a commit. The control plane does not create a new PR for heals.
- **One `check_run` per failed job, one heal per PR attempt.** The first failed check run of a commit triggers the heal. Subsequent failed check runs for the same `checkRunId` are deduplicated, and the per-PR attempt cap prevents runaway loops.
- **This milestone document should be updated as Phase 5 is built.** Mark each checkbox when the acceptance criteria are verified, and adjust the log-parser heuristics in M2 if real CI logs reveal new failure patterns.
