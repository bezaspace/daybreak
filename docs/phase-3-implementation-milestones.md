# Phase 3 Implementation Milestones (PAT-only)

**Sub-document of:** [../roadmap.md](../roadmap.md)  
**Phase name:** GitHub-Native Triggers & Review Loop  
**Goal:** Daybreak is triggerable from a GitHub Issue or a PR review comment via manually configured repo webhooks, uses a PAT for API and git access, and listens for reviewer comments to iterate.

> **Auth note:** This phase intentionally does **not** use a GitHub App. GitHub App registration, JWT signing, 1-hour installation tokens, and per-installation multi-tenancy are deferred to Phase 7 (Cloudflare deployment). A Personal Access Token (PAT) with `contents:write` and `pull_requests:write` is used instead. See [../decisions.md](../decisions.md) for the trade-offs and deferred work.

---

## Exit criteria for the whole phase

> From [../roadmap.md](../roadmap.md): Comment `@daybreak-bot fix the flaky test` on an issue → Daybreak opens a PR. A reviewer comments `@daybreak-bot also handle the null case` → Daybreak pushes a follow-up commit to the same PR. All token/cost guardrails remain active.

---

## Milestones

### M1 — Webhook ingress, signature verification, and repo scoping

**What it ships:** The control plane accepts and verifies GitHub repo webhooks and refuses to run on untrusted repos.

- [x] Add `POST /api/webhooks/github` in `packages/control-plane/src/server.ts`.
- [x] Verify `X-Hub-Signature-256` using `GITHUB_WEBHOOK_SECRET` with HMAC-SHA256 over the raw request body. Use Hono's `bodyLimit` middleware (e.g. `1 MB`).
- [x] Validate `repository.full_name` against `GITHUB_WEBHOOK_REPO_ALLOWLIST` (comma-separated `owner/repo` or `owner/*` patterns) to prevent abuse of public/untrusted repos.
- [x] Route by `X-GitHub-Event`:
  - `issue_comment` (on a plain issue) with an `@daybreak-bot` mention → create a new task.
  - `pull_request_review_comment` with an `@daybreak-bot` mention → create a review-iteration task.
  - `pull_request_review` with an `@daybreak-bot` body mention → create a review-iteration task.
  - `check_run` → return `200` (deferred to Phase 5; subscribing now avoids reconfiguring webhooks later).
  - `ping` → return `200`.
- [x] Parse payload fields: `repository.clone_url`, `repository.full_name`, `repository.default_branch`, `pull_request.head.ref`, `pull_request.base.ref`, `pull_request.number`, `issue.title`, `issue.body`, `comment.body`, `sender.login`, and `X-GitHub-Delivery`.
- [x] Add `GITHUB_WEBHOOK_SECRET` and `GITHUB_WEBHOOK_REPO_ALLOWLIST` to `DaybreakConfig` / `.env.example`.
- [x] Add idempotency: record `X-GitHub-Delivery` in Redis with a 24-hour TTL so retries do not duplicate tasks.
- [x] Add `triggerSource` (`"dashboard" | "issue_comment" | "review_comment"`), `githubSender`, `prNumber`, and `prompt` to `Task` / `PersistedTask` and `db.ts`.
- [x] Add the corresponding columns to the Supabase `tasks` table (`supabase/migrations/20260802_add_phase3_task_fields.sql`).

**Acceptance:**
- `cloudflared tunnel --url http://localhost:8787` exposes the local control plane and a real `issue_comment` webhook is accepted.
- A comment on an allowed repo creates a running task visible at `GET /api/tasks`.
- A webhook from a repo not in the allowlist is rejected with `403`.
- A review comment without an `@daybreak-bot` mention is ignored.
- Duplicate `X-GitHub-Delivery` values do not spawn duplicate tasks.

---

### M2 — PAT-based auth validation and task creation

**What it ships:** Webhook-triggered tasks use the existing PAT path and the control plane creates tasks with the right repo/branch/prompt.

- Verify the configured `GITHUB_TOKEN` has the required permissions on the target repo (e.g. `GET /repos/{owner}/{repo}` and check `permissions.contents` / `permissions.pull_requests`). Fail fast with a clear error if not.
- Strip the `@daybreak-bot` mention and build the agent prompt.
- For an issue: base branch is `repository.default_branch`; prompt includes issue title/body.
- For a review comment: existing PR branch is `pull_request.head.ref`; prompt includes the review comment and optional PR context.
- Extend `POST /api/tasks` to also accept `triggerSource`, `prNumber`, and `githubSender` so webhooks can reuse the same task-creation path.
- Add per-repo and per-sender task-rate limits (count tasks in the last hour). Return `429` when exceeded.

**Acceptance:**
- `pnpm lint && pnpm typecheck && pnpm test` pass.
- A synthetic `issue_comment` payload creates a task whose `repo`, `branch`, `prBranch`, and `triggerSource` are correct.
- A synthetic `pull_request_review_comment` payload creates a review-iteration task tied to the correct PR branch.
- Rate limits reject excess tasks from the same repo/sender.

---

### M3 — Review-loop and sandbox keep-alive

**What it ships:** When a PR review comment asks for changes, Daybreak reconnects to the same sandbox (or a fresh one) and pushes a follow-up commit to the PR branch using the PAT.

- [x] Extend `packages/agent-runner/src/sandbox.ts`:
  - [x] Add `--connect=<sandboxId>` and `--review` flags.
  - [x] When `--connect` is supplied, call `Sandbox.connect(sandboxId)` and skip Node/Chromium installation.
  - [x] When `KEEP_SANDBOX_ALIVE=true`, do not `sandbox.kill()` after the initial run; call `sandbox.setTimeout(keepAliveMs)` (and optionally `sandbox.pause()`) and emit a `sandbox_created` event containing `sandboxId`.
- [x] Extend `packages/agent-runner/src/run-task.ts` to support `REVIEW_MODE=true`:
  - [x] Do not `rm -rf` and re-clone the repo.
  - [x] Run `git checkout ${PR_BRANCH_NAME} && git pull origin ${PR_BRANCH_NAME}`.
  - [x] Use `TASK_PROMPT` (the review comment) and apply the requested change.
  - [x] Stage, commit, and push to the same branch.
  - [x] Do not open a new PR.
- [x] In the control plane, when a review webhook arrives:
  - [x] Look up the original task by `prBranch` or by `repo + prNumber`.
  - [x] If a `sandboxId` exists and the sandbox is still alive, connect to it and run the review bundle with a fresh `GITHUB_TOKEN` env.
  - [x] If the sandbox is gone, spawn a new sandbox, clone the PR branch, and run the review.
- [x] Add `REVIEW_KEEP_ALIVE_MS` config (default ~15 minutes; cap under the E2B Hobby max lifetime of 1 hour).
- [x] Add `sandbox_id` and `keep_alive_until` columns to `tasks` (`supabase/migrations/2026080201_add_sandbox_keepalive_fields.sql`).
- [x] Publish events: `review_task_start`, `sandbox_resumed`, `commit_pushed`, `review_complete`.
- [x] Update the dashboard to render review events.

**Acceptance:**
- An issue-comment task opens a PR.
- Within the keep-alive window, a PR review comment containing `@daybreak-bot` triggers a follow-up commit on the same PR branch.
- The new commit is visible on the PR and CI re-runs.
- If the sandbox has expired, a new sandbox is created and the review still completes.

---

### M4 — Multi-tenancy stub (PAT version)

**What it ships:** Basic tenant isolation and rate limits without per-installation data.

- Add a Supabase `workspaces` (or `github_senders`) stub table:
  - `id`, `type` (`"repo"` or `"sender"`), `value` (`owner/repo` or `login`), `tasks_per_hour`, `created_at`, `updated_at`.
- Add `tasks.sender_login` and `tasks.repo` and update `PersistedTask` / `Task` / `db.ts`.
- Enforce per-repo and per-sender task-rate limits.
- Document that per-installation multi-tenancy and the `installations` table are deferred to Phase 7 with the GitHub App migration.

**Acceptance:**
- Supabase schema matches the new types.
- Two tasks from the same repo within the rate limit succeed; a third is rejected.
- Dashboard/manual tasks work with `null` `sender_login`.

---

### M5 — Evals, docs, and phase sign-off

**What it ships:** Phase 3 is documented, tested, and marked complete.

- Add unit tests for webhook signature verification and payload parsing.
- Add an integration test that POSTs a synthetic `issue_comment` payload to the control plane and asserts a task is created.
- Update `docs/SECRETS.md` with PAT requirements, webhook secret, repo allowlist, and `cloudflared` tunnel instructions.
- Update `docs/COST_BUDGET.md` with the cost impact of E2B keep-alive.
- Update `.env.example` with Phase 3 variables.
- Update `roadmap.md` Phase 3 checklist to reflect the PAT-only path.
- Update `decisions.md` with the PAT-only decision and deferred GitHub App work.
- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter ui build`.

**Acceptance:**
- All CI checks pass.
- A manual end-to-end demo succeeds: issue comment → PR → review comment → follow-up commit.
- `roadmap.md` shows Phase 3 as complete.

---

## Recommended order

1. **M1** — Webhook ingress and repo scoping are prerequisites.
2. **M2** — PAT validation and task creation; can be merged with M1 in one PR.
3. **M3** — Review loop; the riskiest milestone; do it as its own PR.
4. **M4** — Multi-tenancy stub; can be done in parallel with M2/M3.
5. **M5** — Docs/evals/sign-off; last.

M1 and M2 can ship together; M3 should be separate.

---

## Major risks and mitigations

| Risk | Mitigation |
|------|------------|
| PAT is long-lived and broad in scope | Keep it in `.env` only; never log it; validate `GITHUB_WEBHOOK_REPO_ALLOWLIST` before running on any repo. |
| Webhooks must be configured manually per repo | Document the repo/org webhook setup in `docs/SECRETS.md`; the GitHub App migration in Phase 7 will automate this. |
| `X-Hub-Signature-256` verification with Hono | Read raw body with `c.req.arrayBuffer()`, verify HMAC-SHA256, then `JSON.parse`. Use `bodyLimit` middleware. |
| PAT may not have permission on a repo | Fail fast with a permission check before creating a task; surface a clear error in the stream. |
| E2B keep-alive cost / Hobby 1-hour max lifetime | Default `REVIEW_KEEP_ALIVE_MS` to 15 minutes; cap it under 1 hour on Hobby; monitor E2B credits. |
| Review loop re-clones vs. state loss | Keep the sandbox alive with `setTimeout()` / `pause()`; if it expires, fall back to cloning the PR branch. Git history is the source of truth. |
| Pi session state is lost between review runs | Acceptable for Phase 3; re-run from the PR branch with the review prompt. True session forking is Phase 4. |
| Duplicate webhook deliveries | Deduplicate with `X-GitHub-Delivery` stored in Redis with a 24-hour TTL. |

---

## Verification commands

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter agent-runner build:bundle
pnpm --filter ui build

# Local webhook tunnel (pick one)
cloudflared tunnel --url http://localhost:8787
# or
ngrok http 8787

# Manual end-to-end eval
pnpm --filter evals eval:e2e
```

---

## Notes

- A GitHub App is **not** used in Phase 3. The following are deferred to Phase 7:
  - GitHub App registration and per-installation webhooks.
  - JWT signing and 1-hour installation-token exchange.
  - Replacing the PAT with installation tokens.
  - Per-installation multi-tenancy and rate limits.
- The PAT must have `contents:write` and `pull_requests:write` on every repo you want Daybreak to touch.
- The `@daybreak-bot` mention is a string check in the comment body; the actual commit/PR author is the PAT owner account.
