# Roadmap — Daybreak

**Open-source, cloud-native, autonomous AI software engineer platform with time-travel state branching and full OpenTelemetry lineage.**

> **Status:** Phases 0–6 are complete and in `main`. Phase 7 (Cloudflare deployment & v1.0 release) is the remaining work.  
> **Started:** 2026-08-01

---

## 0. Vision & North Star

Daybreak is a learning/demonstration project that replicates the cloud coding-agent class of system (Devin, Cursor's cloud agent) and adds two features the closed-source originals do not expose: **full OpenTelemetry lineage** (every prompt, token count, tool call, and latency is traceable) and **time-travel state branching** (rewind the cloud sandbox filesystem and agent state to any step, edit the context, and spawn a parallel attempt in a separate sandbox). The entire platform is engineered to run on **$0 of free-tier infrastructure**.

The differentiator is the *combination* of features and the *transparency thesis*, not the concept itself. What is novel is the specific stack: **time-travel branching + full OTel lineage + $0 free-tier + open-source + GitHub-native CI self-healing**.

---

## 1. Guiding Principles

- [x] 1.1. **Safety before features.** Guardrails, branch protection, sensitive-file denylisting, and resource/cost circuit breakers are built in Phase 0 and are non-negotiable for any loop that can `write`, `bash`, `git push`, or open PRs.
- [x] 1.2. **Local-first development, cloud-ready architecture.** All code is written, tested, and demoed locally first. Control-plane code is constrained to Cloudflare Workers/Pages-compatible APIs from the start so cloud deployment is a configuration step, not a rewrite.
- [x] 1.3. **Vertical slice first, differentiators later.** The MVP (Phase 1) proves the end-to-end loop is demoable on its own before observability, GitHub triggers, time-travel, or CI self-healing.
- [x] 1.4. **Every milestone is demoable on its own.** No phase exists only to enable a later phase; each ships a visible capability.
- [x] 1.5. **Track cost, latency, token usage, and success rate from day one.** The $0 thesis is a continuously-verified invariant, not an afterthought.
- [x] 1.6. **Provider-agnostic intelligence with fallback.** The agent kernel talks to any OpenAI-compatible endpoint and degrades gracefully to a fallback provider if the primary is rate-limited or down.
- [x] 1.7. **Transparency by construction.** Observability is not bolted on — it is a first-class layer that every subsequent phase emits into.
- [x] 1.8. **Evaluations are a feature, not an afterthought.** A repeatable eval/benchmark harness is created in Phase 0 and runs in CI for every subsequent phase.
- [x] 1.9. **Fail safe, not fail fast.** Resource circuit breakers, sensitive-file denylists, human approval gates for destructive actions, and branch-protection locks are first-class.
- [x] 1.10. **AI-Agent Friendly Codebase.** Highly modular, strongly typed, and extensively documented to provide maximum context to the AI agents doing the building.

---

## 2. Phase Overview

Progress is measured by the completion of demoable vertical slices and objective eval metrics, not calendar estimates.

| Phase | Name | Ships | Status |
|-------|------|-------|--------|
| [x] 0 | Foundation, Safety Baseline & Feasibility Spikes | Agent loop + guardrails + eval harness + cost/quota budget model + time-travel feasibility proof | Done |
| [x] 1 | Safe Local MVP Vertical Slice | End-to-end dashboard → E2B sandbox → stream via Upstash + local control-plane + React UI + Supabase persistence + GitHub PRs + browser tool + eval harness integration. Exit-criteria demo completed. | Done |
| [x] 2 | Observability, Cost Control & Provider Resilience | OTel/Langfuse trace tree, cost dashboard, provider fallback, eval harness, updated cost budget | Done |
| [x] 3 | GitHub-Native Triggers & Review Loop (PAT-only) | PAT-based repo webhooks, issue/PR-comment triggers, review-loop listener; GitHub App deferred to Phase 7 | Done |
| [x] 4 | Time-Travel State Branching | Per-turn checkpoints, filesystem + Pi-state rewind, parallel attempt forking, promote/abandon UI | Done |
| [x] 5 | CI Self-Healing | `check_run` webhook → wake sandbox → fix commit | Done |
| [x] 6 | Resilience, Scale & Polish | Durable queue, idempotency, retry/dead-letter, tenant quotas, budgets, security hardening, branch/sandbox cleanup, compaction tuning, large-repo resilience, provider fail-fast, evals | Done |
| [ ] 7 | Cloudflare Deployment & v1.0 | Workers/Pages, Durable Objects/Queues, production webhooks, release docs | Not started |

---

## 3. Phase 0 — Foundation, Safety Baseline & Feasibility Spikes

**Goal:** Stand up the repo, prove the agent kernel runs end-to-end against a free OpenAI-compatible provider, establish safety guardrails, an eval harness, and a cost/quotabudget model **before** any cloud plumbing or UI is built. Also prove the two riskiest headline primitives (Pi session serialization and E2B snapshot rewind) before committing to them.

- [x] 3.1. Initialize `daybreak` monorepo with pnpm workspaces: `packages/control-plane`, `packages/agent-runner`, `packages/ui`, `packages/shared`.
- [x] 3.2. Create `roadmap.md` and `decisions.md`.
- [x] 3.3. Create `.env.example` documenting `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_MODEL`, E2B, Upstash, Supabase, Langfuse, and GitHub credentials.
- [x] 3.4. Pi SDK spike: standalone TypeScript script using `@earendil-works/pi-agent-core` that wires `read`/`write`/`edit`/`bash` and drives a multi-turn loop against an OpenAI-compatible provider.
- [x] 3.5. **Safety baseline (Phase 0, not Phase 6):**
  - [x] 3.5.1. Tool middleware denylist: block `read`/`write`/`edit` on `.env`, `*.pem`, `.ssh/*`, `.git/config`, `id_*`, `*secret*`, `*token*` unless explicitly approved.
  - [x] 3.5.2. Branch-protection lock: agent refuses to commit, push, or reset `main`/`master` or any protected branch; every task must use a feature branch.
  - [x] 3.5.3. Resource circuit breakers: default `MAX_TURNS=40`, `MAX_WALL_CLOCK_MINUTES=20`, `MAX_COST_USD=0.50` per task. Exceeding any limit stops the task gracefully with a final trace.
  - [x] 3.5.4. Human approval gate: pause before destructive actions (`git push`, `git push --force`, branch deletion, `rm -rf`, opening a PR, force-merging) and require UI/webhook approval.
- [x] 3.6. **Eval harness:** Define a `packages/evals` package with a small benchmark set. Each phase runs `pnpm eval` and reports pass/fail, token count, cost, and wall-clock time.
- [x] 3.7. **Cost and quota-budget model:** Produce a living budget model (now in the Cost & quota budget appendix) that models LLM tokens per turn, Upstash Redis free-tier command volume, Supabase limits, E2B snapshot frequency/latency/credit consumption, and Langfuse free trace tier.
- [x] 3.8. **Secrets management strategy:** No secrets in code. Local: `.env` plus a team-managed secret manager. Cloud: Cloudflare Worker secrets + Supabase Vault. GitHub App private key stored as a Cloudflare/Worker secret. Documented in `decisions.md`.
- [x] 3.9. **Time-travel feasibility spike (critical):**
  - [x] 3.9.1. Prove Pi session state can be serialized to a deterministic blob, reloaded into a fresh process, and optionally branched/forked. `SessionManager` JSONL files are portable across Node processes; `SessionManager.open` reloads the session and `SessionManager.branch` rewinds the leaf pointer.
  - [x] 3.9.2. Measure E2B `Sandbox.createSnapshot()` latency and cost on a small workspace; determine if per-turn snapshots are viable or if a per-turn `git commit` + dependency-cache strategy is required. Conclusion: full snapshots are too slow/expensive for per-turn use; git commits + Pi JSONL snapshots are the default, with E2B snapshots available as an optional fork strategy.
  - [x] 3.9.3. Document the chosen checkpoint strategy before Phase 4 begins. See Phase 4 and `decisions.md` D37.
- [x] 3.10. Set up CI: `pnpm install`, lint, typecheck, unit tests, and the eval harness on every push.
- [x] 3.11. Confirm `pi-agent-core` (v0.83.0+) installs cleanly and its tool-registration and context-compaction APIs are understood.
- [x] 3.12. Spike each tool in isolation (`read`, `edit`, `bash npm test`) and record baseline `tokens/turn`, `p50 latency/turn`, and `cost/task` on the toy repo.
- [x] 3.13. Document the chosen free LLM provider, its quota shape, and fallback providers.
- [x] 3.14. **Exit criteria:**
  - `pnpm spike` clones a toy repo, runs its tests, applies a one-line fix, re-runs tests until green, and prints a token/latency/cost summary table.
  - Attempting to read `.env` is blocked by the denylist.
  - `MAX_TURNS` is enforced.
  - A feasibility report for time-travel serialization and E2B snapshots is written and reviewed.

---

## 4. Phase 1 — Safe Local MVP Vertical Slice

**Goal:** The full Daybreak loop, demoable end-to-end locally, with safety, evals, and cost tracking already in place. The UI is a chat-first, three-pane workspace (collapsible left sidebar, center chat thread, right sandbox/canvas panel).

- [x] 4.1. **Control plane (local MVP):** Local Hono server (`packages/control-plane`) exposes `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/events`, `GET /api/tasks/:id/stream`, `GET /api/tasks/:id/messages`, `POST /api/tasks/:id/messages`, `POST /api/tasks/:id/approve`, `GET /api/tasks/:id/checkpoints`, and checkpoint fork/rewind endpoints. It spawns the E2B-based agent runner and reads from Upstash Redis. Supabase persistence, auth, and Cloudflare Worker migration are deferred.
- [x] 4.2. **Agent runner:** Runs inside the E2B sandbox. Wraps Pi SDK, clones the target repo, configures bot committer, iterates (`read`/`bash`/`edit`/`browser`), then creates a feature branch `daybreak/<task-id>`, commits, and pushes it.
- [x] 4.3. **Sandbox provisioning:** E2B TypeScript SDK `Sandbox.create()` from the `base` template; runtime prep installs git and Node 22. A pre-built `daybreak-browser` E2B template with Node 22, Chromium, and `playwright-core` is supported for the browser tool (build with `pnpm --filter agent-runner build:template`).
- [x] 4.4. **Real-time stream:** Sandbox publishes lifecycle and tool events to an Upstash Redis list (`daybreak:stream:<taskId>`) using batched `rpush` + `ltrim`, keeping the last 1000 events per task. The control plane serves them via SSE (`/api/tasks/:id/stream`) and replays persisted events on demand.
- [x] 4.5. **UI (chat-first):** React + Vite dashboard (`packages/ui`) with a three-pane shell: collapsible left sidebar (conversation/session list), center chat thread, and right sandbox/canvas panel. The composer supports mode selection (`plan`/`interactive`/`autopilot`), `@repo`, `@file`, `#issue`, and slash-command autocomplete (`/plan`, `/auto`, `/interactive`, `/costs`, `/cancel`, `/help`).
- [x] 4.6. **Persistence:** Supabase Postgres. `tasks`, `events`, `messages`, `checkpoints`, `session_snapshots`, and tenant tables. The control plane persists tasks, events, and messages; the UI and REST endpoints read from Postgres.
- [x] 4.7. **Event schema:** `task_start`, `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `tool_execution_update`, `browser_screenshot`, `compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end`, `agent_end`, `bash_execution_update`, `task_complete`, `task_failed`, `approval_request`, `approval_resolved`, `user_message`, `checkpoint_created`, `cost_alert`.
- [x] 4.8. **Context compaction:** Integrate Pi's compaction settings and the hard `MAX_TURNS` cap from Phase 0. Configurable via `COMPACTION_ENABLED`, `COMPACTION_RESERVE_TOKENS`, and `COMPACTION_KEEP_RECENT_TOKENS`.
- [x] 4.9. **Browser/Playwright tool:** Integrate headless Chromium inside the sandbox so the agent can visually verify running web apps and interact with DOM elements; stream screenshots to the UI.
- [x] 4.10. **PR delivery path:** Agent pushes to a `daybreak/<task-id>` feature branch; the control plane opens a PR via GitHub API (`POST /repos/{owner}/{repo}/pulls`) using `GITHUB_TOKEN`.
- [x] 4.11. **Control channel:** The control plane receives user messages via `POST /api/tasks/:id/messages` and queues them in Redis (`daybreak:messages:<taskId>`). The agent runner consumes the queue and calls `sendUserMessage`, `steer`, or `followUp` on the active `AgentSession`. Cancellations, approvals, rewind/fork requests are also wired.
- [x] 4.12. **UI streaming:** Browser connects to the Hono SSE endpoint `/api/tasks/:id/stream` and renders events live. Completed tasks load persisted events from `/api/tasks/:id/events` so the terminal/chat is never empty.
- [x] 4.13. Run the Phase 0 eval harness against this local MVP and record wall-clock time, token count, and $-cost per task.
- [x] 4.14. **Exit criteria:** From the dashboard, start a task → watch live terminal, browser, and chat → a PR appears on GitHub. The PR contains a real fix that passes CI, no `.env` was read, the branch is not `main`, and `MAX_TURNS`/`MAX_COST` are enforced.

---

## 5. Phase 2 — Observability, Cost Control & Provider Resilience

**Goal:** Every prompt, token count, tool call, and latency is emitted as OpenTelemetry spans to Langfuse, the dashboard renders the reasoning tree, and the system survives primary LLM provider outages.

- [x] 5.1. **OTel instrumentation:** In the agent runner. A root `task` span with child spans per LLM call (model, prompt/completion token counts, latency) and per tool call (tool name, args, result size, latency).
- [x] 5.2. **Langfuse ingestion:** Spans exported via the OTel HTTP exporter to the Langfuse OTel endpoint.
- [x] 5.3. **DAG trace visualizer:** In the UI. Query Langfuse API for a task's trace; render reasoning tree with per-node cost and latency; color-code tool types; surface token totals.
- [x] 5.4. **Cost dashboard:** Aggregate $-spend per task, per provider, per day, sourced from span token counts × provider pricing.
- [x] 5.5. Map the Phase 1 event schema 1:1 to OTel span attributes.
- [x] 5.6. Wrap Pi SDK's LLM-call and tool-execution hooks with span start/end.
- [x] 5.7. **Provider fallback:** When the primary `LLM_BASE_URL` returns 429/5xx or a configurable retry budget is exhausted, switch to `LLM_FALLBACK_*`. Record provider usage in traces. Threshold configured by `DAYBREAK_PROVIDER_FAILURE_THRESHOLD`.
- [x] 5.8. Build the Langfuse query client for the visualizer.
- [x] 5.9. Render the DAG with a recursive tree view; make node metadata expandable to show full details.
- [x] 5.10. Validate the $0 invariant: confirmed in the Cost & quota budget appendix with observed unit usage and projected monthly Langfuse burn at expected eval volumes.
- [x] 5.11. **Exit criteria:** The agent emits full OTel traces to Langfuse, the dashboard renders the reasoning tree with per-step cost and latency, total task cost is displayed, and a primary-provider failure switches to fallback with a visible trace event.

---

## 6. Phase 3 — GitHub-Native Triggers & Review Loop (PAT-only)

**Goal:** Daybreak is triggerable from a GitHub Issue or a PR review comment via repo webhooks, uses a PAT for API and git access, and listens for reviewer comments to iterate. GitHub App registration, JWT signing, and installation tokens are deferred to Phase 7.

- [x] 6.1. **Repo webhooks and local tunneling:** Document and configure repo/org webhooks pointing at the local control plane (via `cloudflared` or `ngrok`). Subscribe to `issue_comment`, `pull_request_review_comment`, `pull_request_review`, `check_run`.
- [x] 6.2. **Webhook handler:** In the control plane. Verify `X-Hub-Signature-256`, validate the repo against `GITHUB_WEBHOOK_REPO_ALLOWLIST`, parse the event, and create a task.
- [x] 6.3. **PAT-based auth path:** Use `GITHUB_TOKEN` (PAT with `contents:write` and `pull_requests:write`) for PR creation and git push inside the sandbox. Validate token permissions on the target repo before running (`validatePat`).
- [x] 6.4. **Issue/PR-comment parsing:** Extract the instruction, target repo/branch, and context; strip the `@daybreak-bot` mention; map to a task spec.
- [x] 6.5. **Review-loop listener:** On a new `pull_request_review_comment` with `@daybreak-bot`, reconnect to the kept-alive sandbox (or create a fresh one) and push a follow-up commit to the existing PR branch.
- [x] 6.6. **Multi-tenancy (PAT version):** Map repo/sender to a tenant (`TenantService`) and enforce per-repo/per-sender task-rate limits and daily cost budgets. Per-installation limits are deferred.
- [ ] 6.7. **GitHub App:** Generate the GitHub App private key; store as a Cloudflare/Worker secret; implement JWT signing + installation-token exchange. *Deferred to Phase 7.*
- [ ] 6.8. **Installation tokens:** Replace the MVP PAT path with installation tokens everywhere. *Deferred to Phase 7.*
- [x] 6.9. **Comment-trigger routing:** Distinguish "new task" (issue) vs. "iterate on existing PR" (review comment).
- [x] 6.10. **Sandbox standby/keep-alive:** A PR-opened task keeps its sandbox alive (idle/paused) for a configurable window (`REVIEW_KEEP_ALIVE_MS`, default 15 minutes) to absorb review feedback, subject to cost/turn caps.
- [x] 6.11. **Exit criteria:** Comment `@daybreak-bot fix the flaky test` on an issue → Daybreak opens a PR. A reviewer comments `@daybreak-bot also handle the null case` → Daybreak pushes a follow-up commit to the same PR. All token/cost guardrails remain active.

---

## 7. Phase 4 — Time-Travel State Branching *(Headline Feature)*

**Goal:** Rewind the agent's execution tree to any step, edit the context or prompt, and spawn a parallel attempt branch in a separate sandbox.

**Chosen strategy (see `decisions.md` D37):**
- Filesystem checkpoints are per-turn `git commit`s with lightweight tags (`daybreak/checkpoint/<taskId>/<turn>`) plus a JSONL snapshot of the Pi session. This is faster and cheaper than per-turn E2B snapshots.
- Cross-sandbox forks default to **git + re-install**: a fresh E2B sandbox from the configured template clones the repo, checks out the checkpoint commit, re-installs dependencies from the lockfile, and restores the JSONL session snapshot. `DAYBREAK_FORK_STRATEGY` defaults to `auto`, which currently resolves to `git-reinstall`.
- E2B snapshots are supported as an optional fork strategy (`DAYBREAK_FORK_STRATEGY=snapshot` or passing `snapshotId` to `POST /api/checkpoints/:checkpointId/fork`) when the benchmark justifies the cost.
- Rewind reconnects to the same sandbox, resets the working tree to the checkpoint commit, restores the JSONL snapshot, and resumes `TaskRunner` from that turn.

- [x] 7.1. **Checkpoint model:** A checkpoint is `{ id, taskId, turn, timestamp, gitCommit, sessionRef, parentCheckpointId, branchTaskId, status, toolCallId }` stored in Supabase. One checkpoint per turn (or per tool call when `DAYBREAK_CHECKPOINT_INTERVAL=tool`).
- [x] 7.2. **Filesystem rewind:** Git commit + tag per checkpoint; rewind checks out the commit and resets the working tree.
- [x] 7.3. **Agent-state rewind:** Serialize Pi session at each checkpoint to a JSONL snapshot (`sessionStore.save`) and reload/fork from `sessionRef` via `SessionManager.open` and `SessionManager.branch`.
- [x] 7.4. **Parallel attempt branching:** Fork the sandbox and fork the Pi session from checkpoint `N` into a new task (`branchTaskId`).
- [x] 7.5. **Branch UI:** In the dashboard. A **Checkpoints** tab shows a timeline; users click a checkpoint and choose **Rewind here** or **Fork from here**, edit the prompt, and spawn a new branch.
- [x] 7.6. **Checkpoint manager:** `CheckpointStore` in the agent runner commits the repo, saves the Pi JSONL snapshot, and persists the checkpoint tuple to Supabase after each turn/tool call.
- [x] 7.7. **Fork endpoint in control plane:** `POST /api/checkpoints/:checkpointId/fork` creates a new task from the checkpoint with a chosen strategy (`git-reinstall` or `snapshot`).
- [x] 7.8. **Rewind endpoint in control plane:** `POST /api/tasks/:id/rewind` reconnects to the original sandbox and restores the checkpoint.
- [x] 7.9. **Branch convergence:** Users can abandon a branch (`POST /api/tasks/:id/abandon`) or promote a completed branch to become the primary PR (`POST /api/tasks/:id/promote`), which creates/updates the PR and abandons sibling branches.
- [x] 7.10. **Exit criteria:** Run a task to completion. Rewind to step 3. Edit the prompt. Click "Branch". Watch a second, parallel sandbox execute a different path. Promote the second branch to a new PR.

---

## 8. Phase 5 — CI Self-Healing

**Goal:** Listen for failed GitHub Actions status checks on Daybreak's own PRs, intercept error logs, and push self-healing fix commits automatically.

- [x] 8.1. **Webhook listener:** For `check_run` events with `conclusion: failure`.
- [x] 8.2. **Log fetcher:** Uses GitHub API (`CiLogFetcher`) to pull `check-runs/{id}/annotations` and `actions/jobs/{job_id}/logs`, following the 302 redirect and truncating to `DAYBREAK_MAX_CI_LOG_BYTES`.
- [x] 8.3. **Heal task router:** Creates a new task (`triggerSource: check_run`) in an existing kept-alive sandbox or a forked sandbox, injecting the CI failure logs as context.
- [x] 8.4. **Commit path:** Agent applies fix and pushes a new commit to the existing PR branch. CI re-runs automatically.
- [x] 8.5. **Scope filter:** `check_run` webhooks are only healed for Daybreak PRs (`daybreak/` prefix or a matching `prBranch` in `tasks`); `main`/`master`/protected branches are refused.
- [x] 8.6. **Log parsing:** `CiLogParser` strips ANSI codes/timestamps/GitHub group markers and extracts a configurable window of context around failure blocks (`FAIL`, `Error:`, `npm ERR!`, `Tests: ... failed`, `AssertionError`).
- [x] 8.7. **Targeted prompt:** The heal prompt includes the cleaned error context and instructs the agent to fix, test, and push a follow-up commit without opening a new PR.
- [x] 8.8. **Circuit breakers:** Max 2 self-heal attempts per PR (`DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR`) and a same-commit cooldown (`DAYBREAK_HEAL_COOLDOWN_SECONDS`) prevent infinite CI loops; still subject to `MAX_TURNS` and `MAX_COST`.
- [x] 8.9. **Exit criteria:** Merge a PR with a deliberately broken test. CI fails. Daybreak receives the webhook, analyzes the log, pushes a fix, and CI goes green.

---

## 9. Phase 6 — Resilience, Scale & Polish

**Goal:** Make the platform safe, resilient, and multi-user without blowing context windows, quotas, or budgets.

- [x] 9.1. **Context compaction:** Tune Pi's compaction settings for long tasks and large repositories; per-task overrides via `POST /api/tasks` (`compactionReserveTokens`, `compactionKeepRecentTokens`).
- [x] 9.2. **Resource circuit breakers:** Finalize wall-clock (20 min), turn (40), and cost ($0.50) per task with graceful failure and full trace.
- [x] 9.3. **Sensitive-file denylist:** Finalize and expand path patterns; add runtime log redaction so LLM/tool outputs cannot leak secrets.
- [x] 9.4. **Branch-protection locks:** Agent refuses to commit directly to `main`/`master`; always uses feature branches.
- [x] 9.5. **Cost circuit breaker:** Abort task if total $-cost exceeds threshold; emit `cost_alert` at the configured threshold fraction.
- [x] 9.6. **Task queue / worker:** Durable Supabase-backed queue (`claim_next_pending_task` PL/pgSQL function) plus an in-memory queue fallback. Multiple webhooks and UI triggers are processed without data loss or duplication.
- [x] 9.7. **Idempotency and deduplication:** Webhook events and tasks carry idempotency keys; duplicate triggers are collapsed.
- [x] 9.8. **Retry and dead-letter handling:** Failed tasks retry with exponential backoff; permanently failed tasks land in a dead-letter row in Supabase and can be retried via `POST /api/dead-letter/:taskId/retry`.
- [x] 9.9. **Multi-tenancy and auth:** Per-repo/sender tenant isolation, per-user/per-org task quotas (`DAYBREAK_DEFAULT_TENANT_*`), role-based actions (`admin`/`operator`/`viewer`), and global concurrent caps (`DAYBREAK_GLOBAL_MAX_CONCURRENT_SANDBOXES`).
- [x] 9.10. **Security hardening:** See the Security audit findings appendix for path-traversal mitigation, secret redaction, protected-branch bypass coverage, and denylist expansion.
- [x] 9.11. **Branch cleanup:** Delete or archive stale feature branches (`DAYBREAK_BRANCH_TTL_DAYS`) and terminate idle sandboxes (`DAYBREAK_SANDBOX_IDLE_TTL_MINUTES`) automatically.
- [x] 9.12. **Large-repo resilience:** Cap file reads by bytes/lines (`DAYBREAK_MAX_FILE_READ_BYTES`/`DAYBREAK_MAX_FILE_READ_LINES`), allow shallow clones (`DAYBREAK_MAX_REPO_CLONE_DEPTH`), and provider fail-fast (`DAYBREAK_PROVIDER_FAILURE_THRESHOLD`).
- [x] 9.13. **Resilience eval fixtures:** `packages/evals/src/resilience.ts` exercises queue, idempotency, retry, tenant rate limits, security blocks, circuit-breaker metrics, and cleanup in a single in-memory run with no external credentials.
- [x] 9.14. **Exit criteria:** Attempt to make the agent read `.env` → blocked. Run a task in a loop that never passes tests → hits the 40-turn cap and stops. Simulate a webhook flood → queue absorbs it without duplicate tasks or quota exhaustion. `pnpm lint`/`typecheck`/`test` and `pnpm --filter ui build` pass.

---

## 10. Phase 7 — Cloudflare Deployment & v1.0 Release

**Goal:** Take the fully functional, locally-tested codebase and deploy it to the $0 free-tier cloud infrastructure (Cloudflare Workers/Pages, Upstash, Supabase, Langfuse, E2B).

- [ ] 10.1. **Control Plane Migration:** Adapt the local Node.js control plane to run natively on Cloudflare Workers. Move long-lived WebSocket/queue handling to Durable Objects or Cloudflare Queues; replace Node-only APIs (`child_process` spawn) with durable queue + E2B orchestration.
- [ ] 10.2. **Architecture audit:** Confirm no long-running agent work executes inside a Worker invocation. Agent orchestration is enqueue + signal; E2B containers do the heavy work.
- [ ] 10.3. **UI Deployment:** Deploy React + Vite app to Cloudflare Pages. Ensure Edge compatibility for any API routes.
- [ ] 10.4. **Environment Configuration:** Move all local `.env` secrets to Cloudflare Worker secrets and Upstash/Supabase dashboards.
- [ ] 10.5. **Production Webhooks:** Point GitHub App webhook URL to the deployed Cloudflare Worker URL.
- [ ] 10.6. **Documentation:** `DEPLOYMENT.md` guide, architecture diagrams, operator runbook, and v1.0 release notes.
- [ ] 10.7. Set up Durable Objects for the WebSocket/SSE bridge between Upstash Redis and the browser.
- [ ] 10.8. Configure `wrangler.toml` with all bindings (Supabase URL, Upstash REST URL, GitHub App ID, Langfuse keys, E2B config).
- [ ] 10.9. Run end-to-end production test: trigger via GitHub Issue → Cloudflare Worker → E2B → PR.
- [ ] 10.10. **Exit criteria:** The entire Daybreak platform is accessible via a public URL. A GitHub issue triggers the cloud-hosted agent, which opens a PR, with live logs streaming to the deployed dashboard. Total monthly operating cost = $0 under the modeled free-tier quotas.

---

## 11. Non-Goals for v1.0

- Public multi-tenant SaaS with billing and user sign-up (single-user/single-org GitHub App install only).
- Running untrusted public repos without an explicit approval gate.
- Order execution, real-time trading, or any non-research use.
- Native mobile or desktop apps.
- On-prem or self-hosted Kubernetes deployment.
- A custom vector/RAG memory system (use existing tools if needed).

---

## 12. Open Questions & Risks

- [ ] Which free-tier OpenAI-compatible provider gives the best success-rate/availability for coding tasks, and what are its exact rate limits?
- [ ] Can Cloudflare Workers free tier handle webhook fan-in and Durable Object usage without hitting limits?
- [ ] How do we sanitize tool output so an adversarial repo cannot exfiltrate secrets even if the denylist is bypassed?
- [ ] What is the real latency/credit cost of per-turn E2B snapshots for large repos? (The `git-reinstall` strategy is the default; snapshots are optional and benchmarked on demand.)

---

## 13. Reference

- Pi SDK: https://github.com/earendil-works/pi (`@earendil-works/pi-agent-core`, MIT, by Mario Zechner)
- E2B: https://e2b.dev
- OpenTelemetry: https://opentelemetry.io/
- Langfuse: https://langfuse.com/

---

# Appendix A — Cost & Quota Budget

Daybreak is designed to live on free-tier infrastructure. The tables below summarize the free quotas, expected burn rates, and guardrails. For the full cost-driver details, see the source-of-truth in `packages/shared/src/config.ts` and `.env.example`.

## Free-tier quotas

| Service | Free tier |
|---------|-----------|
| **Upstash Redis** | 256 MB data, 500K commands/month, 10 GB bandwidth, 10K max commands/sec |
| **Supabase** | 500 MB DB, 5 GB egress, 1 GB file storage, 50K MAU, 2 projects, 500K Edge Function invocations/month |
| **Langfuse** | 50K units/month on Hobby plan |
| **E2B** | Hobby: $100 in one-time credits; paid vCPU/RAM/storage only after credits consumed |
| **Groq** | 30 RPM, 6K TPM, 1K RPD for most models |
| **OpenRouter free** | 50 requests/day, 20 RPM |

## Circuit breakers

| Limit | Default | Config env |
|-------|---------|------------|
| Max turns | 40 | `MAX_TURNS` |
| Max wall-clock time | 20 minutes | `MAX_WALL_CLOCK_MINUTES` |
| Max cost per task | $0.50 USD | `MAX_COST_USD` |

## Model cost assumptions

Free providers are used wherever possible. For paid fallbacks, the target model is a small, cheap model such as `gpt-4o-mini` or `inclusionai/Ling-3.0-flash:free`:

- Typical agent turn: ~2K input tokens + ~1K output tokens.
- At OpenAI `gpt-4o-mini` rates: ~$0.0005 per prompt + $0.0006 per completion = **~$0.0011 per turn**.
- A 40-turn task therefore costs roughly **$0.044**, well under the default `MAX_COST_USD=0.50`.
- Context compaction triggers a summarization LLM call. On a 32K-token summary this may add ~8K input + 2K output tokens, or **~$0.006 per compaction**. Set `MAX_COST_USD` generously when `COMPACTION_ENABLED=true` on long tasks.

## Infrastructure burn rates

### Redis

- The sandbox publishes one event per `message_update`/`tool_execution_*`/`agent_end`/`task_complete` etc. Each event triggers one `RPUSH` and the flush batch includes one `LTRIM` per 100 ms window, keeping the last 1000 events per task. A short 5-turn fix run with ~30 events therefore uses ~30–35 Redis commands.
- Free quota: **500K commands/month** → roughly **10,000–15,000 short tasks/month** at the current event volume.
- **Guardrail:** `MAX_TURNS`, the 1000-event `LTRIM` cap, and 100 ms batching limit command volume.

### E2B

- The free Hobby tier provides $100 in one-time credits before any paid usage begins.
- After credits are consumed, sandbox compute (vCPU/RAM) and snapshot storage are metered; for current rates see https://e2b.dev/pricing.
- The default `base` template ships Node 20; installing Node 22 at sandbox startup adds ~30–60 seconds of CPU time per run. The pre-built `daybreak-browser` template bakes in Node 22, Chromium, and `playwright-core`, eliminating per-run installation.
- The `daybreak-browser` template uses 2 vCPU / 1536 MB RAM, which is within the free-tier allowance and is required for Chromium's V8 renderer to avoid OOM.

### Cross-sandbox fork

M4 supports two fork strategies:

- **Git + re-install (default):** pays only for the fresh sandbox cold start plus the dependency install time. No snapshot storage. With the `daybreak-browser` template, the base environment is pre-baked; only repo-specific dependencies are re-installed.
- **E2B snapshot:** pays for snapshot creation (sandbox paused during snapshotting) plus ongoing snapshot storage, then the new sandbox runtime from that image. Snapshots are slower to spawn and less resource-efficient than templates; enable only when the benchmark shows the create+spawn time is lower than a clean install.

## Provider fallback cost implications

Provider fallback is a reliability feature, not a cost-saving feature. When the primary provider is free and the fallback is paid, every fallback turn is billed at the fallback model's rate. Configure fallback prices in `LLM_PRICING` (or `LLM_FALLBACK_INPUT_PRICE_PER_1M` / `LLM_FALLBACK_OUTPUT_PRICE_PER_1M`) so `estimatedCostUsd` reflects the active provider.

## Phase 4 time-travel budget impact

- **Git commit:** negligible. Each checkpoint is a local `git commit` plus a lightweight tag in the sandbox. No egress or external storage cost.
- **Session JSONL snapshot:** Each checkpoint copies the current Pi session `.jsonl` to `.daybreak/sessions/<taskId>/<turn>.jsonl`. With `DAYBREAK_SESSION_STORE_BACKEND=supabase` (default), the file is uploaded to the `session_snapshots` table (not Supabase Storage). A short session file is typically 5–50 KB.
- **Database checkpoint rows:** One `checkpoints` row per checkpoint with a small JSON-free payload.
- `DAYBREAK_MAX_CHECKPOINTS_PER_TASK` (default 100) caps per-task checkpoint growth.

| Phase 4 cost driver | Default behavior | Approx. cost | Controlling env |
|---------------------|------------------|--------------|-----------------|
| Per-checkpoint git commit | local in sandbox | ~$0 | n/a |
| Per-tool checkpoint | enabled by `DAYBREAK_CHECKPOINT_INTERVAL=tool` | storage only | `DAYBREAK_CHECKPOINT_INTERVAL` |
| Session snapshot upload | Supabase `session_snapshots` table | 5–50 KB per checkpoint | `DAYBREAK_SESSION_STORE_BACKEND` |
| Fork branch runtime | new sandbox, own budget | ~$0.0003–0.001 per branch | `DAYBREAK_FORK_STRATEGY` |
| Snapshot storage | only with `snapshot` strategy | ~$0.0000045/GiB/s | `DAYBREAK_FORK_STRATEGY=snapshot` |
| Maximum checkpoints | 100 per task | storage cap | `DAYBREAK_MAX_CHECKPOINTS_PER_TASK` |

## Phase 5 CI self-healing budget impact

- **Extra E2B sandbox (or reconnect):** Each failed `check_run` may start a new sandbox or reconnect to a kept-alive sandbox. A reconnect avoids a cold start; a new sandbox pays the usual cold-start + dependency-install cost.
- **Extra LLM turns per heal:** The agent receives the CI error context and reruns tests, typically 3–8 additional turns per heal.
- **GitHub API log download:** `actions/jobs/{job_id}/logs` and `check-runs/{id}/annotations` are free under GitHub REST API quota for `repo`/`actions:read` tokens.
- `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` (default `2`) and `DAYBREAK_HEAL_COOLDOWN_SECONDS` (default `60`) prevent runaway heals.

## Phase 6 cleanup and retention budget impact

- `DAYBREAK_MAX_CONCURRENT_TASKS` and `DAYBREAK_GLOBAL_MAX_CONCURRENT_SANDBOXES` cap parallel E2B runtime.
- `DAYBREAK_DEFAULT_TENANT_TASKS_PER_HOUR` and `DAYBREAK_DEFAULT_TENANT_DAILY_COST_USD` stop runaway spend at the ingress layer.
- `DAYBREAK_COST_ALERT_THRESHOLD` emits a `cost_alert` when a task crosses 80% of `MAX_COST_USD`.
- `DAYBREAK_BRANCH_TTL_DAYS` (default 7) deletes stale `daybreak/<uuid>` branches.
- `DAYBREAK_SANDBOX_IDLE_TTL_MINUTES` (default 15) kills idle sandboxes.
- `DAYBREAK_DATA_RETENTION_DAYS` (default 30) prunes old `session_snapshots` rows; old `checkpoints` rows are marked `abandoned` rather than deleted to preserve lineage.

---

# Appendix B — Security Audit Findings

Phase 6 M6 reviewed sandbox escape vectors, LLM injection risks, path traversal, and log sanitization. The mitigations below are in `packages/shared/src/safety.ts` and `packages/shared/src/security.ts`.

| Finding | Mitigation |
|---------|------------|
| Path traversal in file tools (`read ../.env`) | `sanitizePath(cwd, requestedPath)` resolves the path and rejects `..` or anything outside `cwd`. |
| Path traversal in `bash` commands (`cat /etc/passwd`) | `SafetyMiddleware` tokenizes `bash` commands, treats path-like tokens as candidate paths, and runs `sanitizePath` and `isSensitivePath` on each. |
| Secrets leaked in event streams and logs | `redactSecrets()` is applied in `agent-runner/src/stream.ts`, `control-plane/src/server.ts` (`appendLog` and `publishEvent`), and `control-plane/src/ci-logs.ts`. |
| Protected-branch bypasses (`git switch main`, `git merge main`, `push --delete main`) | `parseGitBranchArg` covers `checkout`, `switch`, `merge`, refspec deletions, `push --delete`, and `branch -D/-d`. |
| Denylist too narrow | `DEFAULT_DENYLIST_PATTERNS` in `packages/shared/src/config.ts` was extended with `.aws/credentials`, `.docker/config.json`, `.netrc`, `.pgpass`, `.my.cnf`, `id_rsa`, `id_ed25519`, `*.p8`, `*.mobileprovision`, and shell histories. |

**Verification:** `sanitizePath`, `redactSecrets`, and `SafetyMiddleware` have unit tests covering workspace-relative paths, `..` traversal, absolute paths outside the workspace, URL credentials, `api_key`/`token` values, GitHub tokens, `Authorization`/`Bearer` headers, PEM blocks, AWS access keys, and blocked `read ../.env` / `cat /etc/passwd` / `git push origin main` commands.
