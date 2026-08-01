# Roadmap — Daybreak

**Open-source, cloud-native, autonomous AI software engineer platform with time-travel state branching and full OpenTelemetry lineage.**

> **Status:** Planning — spec complete, build pending.  
> **Started:** 2026-08-01 (planning)  
> **Document version:** 2.0

---

## 0. Vision & North Star

Daybreak is an open-source replica of the cloud coding-agent class of system (Devin, Cursor's cloud agent), built to **understand and demonstrate the engineering behind autonomous coding agents** rather than to ship a commercial product. It takes the same core primitives — a sandboxed Linux execution environment with shell, editor, and browser tools; a planner-executor reasoning loop; and GitHub-native PR delivery — and adds two things the closed-source originals do not expose: **full OpenTelemetry lineage** (every prompt, token, tool call, and latency is traceable) and **time-travel state branching** (rewind the cloud sandbox filesystem and agent state to any step, edit the context, and spawn a parallel attempt in a separate sandbox). The entire platform is engineered to run on **$0 of free-tier infrastructure**.

The differentiator is the *combination* and the *transparency thesis*, not the concept itself. What is novel here is the specific stack: **time-travel branching + full OTel lineage + $0 free-tier + open-source + GitHub-native CI self-healing**.

---

## 1. Guiding Principles

- [x] 1.1. **Safety before features.** Guardrails, branch protection, sensitive-file denylisting, and resource/cost circuit breakers are built in Phase 0 and are non-negotiable for any loop that can `write`, `bash`, `git push`, or open PRs.
- [ ] 1.2. **Local-first development, cloud-ready architecture.** All code is written, tested, and demoed locally first. Control-plane code is constrained to Cloudflare Workers/Pages-compatible APIs from the start so cloud deployment is a configuration step, not a rewrite.
- [ ] 1.3. **Vertical slice first, differentiators later.** The MVP (Phase 1) proves the end-to-end loop is demoable on its own before observability, GitHub triggers, time-travel, or CI self-healing.
- [ ] 1.4. **Every milestone is demoable on its own.** No phase exists only to enable a later phase; each ships a visible capability.
- [ ] 1.5. **Track cost, latency, token usage, and success rate from day one.** The $0 thesis is a continuously-verified invariant, not an afterthought.
- [ ] 1.6. **Provider-agnostic intelligence with fallback.** The agent kernel talks to any OpenAI-compatible endpoint and degrades gracefully to a fallback provider if the primary is rate-limited or down.
- [ ] 1.7. **Transparency by construction.** Observability is not bolted on — it is a first-class layer that every subsequent phase emits into.
- [x] 1.8. **Evaluations are a feature, not an afterthought.** A repeatable eval/benchmark harness is created in Phase 0 and runs in CI for every subsequent phase.
- [x] 1.9. **Fail safe, not fail fast.** Resource circuit breakers, sensitive-file denylists, human approval gates for destructive actions, and branch-protection locks are first-class.
- [ ] 1.10. **AI-Agent Friendly Codebase.** Highly modular, strongly typed, and extensively documented to provide maximum context to the AI agents doing the building.

---

## 2. Phase Overview

Progress is measured by the completion of demoable vertical slices and objective eval metrics, not calendar estimates.

| Phase | Name | Ships |
|-------|------|-------|
| [x] 0 | Foundation, Safety Baseline & Feasibility Spikes | Agent loop + guardrails + eval harness + cost/quotabudget model + time-travel feasibility proof |
| [ ] 1 | Safe Local MVP Vertical Slice | End-to-end dashboard → E2B sandbox → stream via Upstash + local control-plane + React UI. Supabase persistence, GitHub PRs, browser tool, approval gates, and eval harness integration remain for follow-up slices. |
| [ ] 2 | Observability, Cost Control & Provider Resilience | OTel/Langfuse trace tree, cost dashboard, provider fallback |
| [ ] 3 | GitHub-Native Triggers & Review Loop | GitHub App, issue/PR-comment triggers, scoped 1h tokens, review-loop listener |
| [ ] 4 | Time-Travel State Branching | Per-turn checkpoints, filesystem + Pi-state rewind, parallel attempt forking |
| [ ] 5 | CI Self-Healing | `check_run` webhook → wake sandbox → fix commit |
| [ ] 6 | Resilience, Scale & Polish | Task queue, multi-tenancy, idempotency, retry, security audit, branch cleanup |
| [ ] 7 | Cloudflare Deployment & v1.0 | Workers/Pages, Durable Objects/Queues, production webhooks, release docs |

---

## 3. Phase 0 — Foundation, Safety Baseline & Feasibility Spikes

**Goal:** Stand up the repo, prove the agent kernel runs end-to-end against a free OpenAI-compatible provider, establish safety guardrails, an eval harness, and a cost/quotabudget model **before** any cloud plumbing or UI is built. Also prove the two riskiest headline primitives (Pi session serialization and E2B snapshot rewind) before committing to them.

- [x] 3.1. Initialize `daybreak` monorepo with pnpm workspaces: `packages/control-plane`, `packages/agent-runner`, `packages/ui`, `packages/shared`.
- [x] 3.2. Create `ROADMAP.md` (this document) and `decisions.md`.
- [x] 3.3. Create `.env.example` documenting `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_MODEL`, E2B, Upstash, Supabase, Langfuse, and GitHub credentials.
- [x] 3.4. Pi SDK spike: standalone TypeScript script using `@earendil-works/pi-agent-core` that wires `read`/`write`/`edit`/`bash` and drives a multi-turn loop against an OpenAI-compatible provider.
- [x] 3.5. **Safety baseline (Phase 0, not Phase 6):**
  - [x] 3.5.1. Tool middleware denylist: block `read`/`write`/`edit` on `.env`, `*.pem`, `.ssh/*`, `.git/config`, `id_*`, `*secret*`, `*token*` unless explicitly approved.
  - [x] 3.5.2. Branch-protection lock: agent refuses to commit, push, or reset `main`/`master` or any protected branch; every task must use a feature branch.
  - [x] 3.5.3. Resource circuit breakers: default `MAX_TURNS=40`, `MAX_WALL_CLOCK_MINUTES=20`, `MAX_COST_USD=0.50` per task. Exceeding any limit stops the task gracefully with a final trace.
  - [x] 3.5.4. Human approval gate: pause before destructive actions (`git push`, `git push --force`, branch deletion, `rm -rf`, opening a PR, force-merging) and require UI/webhook approval.
- [x] 3.6. **Eval harness:** Define a `packages/evals` package with a small benchmark set (a toy repo, a real-ish one-line bug, a failing test). Each phase must be able to run `pnpm eval` and report pass/fail, token count, cost, and wall-clock time.
- [x] 3.7. **Cost and quota-budget model:** Produce a living budget document (`docs/COST_BUDGET.md`) that models:
  - LLM tokens per turn and per task against chosen free-tier provider(s).
  - Upstash Redis free-tier 10,000 commands/day and Supabase 500MB/500k row limits.
  - E2B snapshot frequency, latency, and credit consumption for time-travel.
  - Langfuse free trace tier (50,000 traces/month).
- [x] 3.8. **Secrets management strategy:** No secrets in code. Local: `.env` + 1Password/direnv or similar. Cloud: Cloudflare Worker secrets + Supabase Vault. GitHub App private key stored as a Cloudflare secret/Worker secret. Document rotation policy.
- [x] 3.9. **Time-travel feasibility spike (critical):**
  - [x] 3.9.1. Prove Pi session state can be serialized to a deterministic blob, reloaded into a fresh process, and optionally branched/forked. If `pi-agent-core` does not expose this, identify the minimal wrapper or patch needed.
  - [x] 3.9.2. Measure E2B `sandbox.createSnapshot()` latency and cost on a small workspace; determine if per-turn snapshots are viable or if a per-turn `git commit` + dependency-cache strategy is required.
  - [x] 3.9.3. Document the chosen checkpoint strategy in `docs/TIME_TRAVEL.md` before Phase 4 begins. If feasibility fails, downgrade time-travel to git-based checkpoints.
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

**Goal:** The full Daybreak loop, demoable end-to-end locally, with safety, evals, and cost tracking already in place.

- [x] 4.1. **Control plane (local MVP):** Local Hono server (`packages/control-plane`) exposes `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/events`, and `GET /api/tasks/:id/stream`. It spawns the E2B-based agent runner and reads from Upstash Redis. Supabase persistence, auth, and Cloudflare Worker migration are deferred.
- [x] 4.2. **Agent runner:** Runs inside the E2B sandbox. Wraps Pi SDK, clones the target repo, configures bot committer, iterates (`read`/`bash`/`edit`), then commits and pushes directly to the target branch (`main` for this slice, per user authorization).
- [x] 4.3. **Sandbox provisioning:** E2B TypeScript SDK `Sandbox.create()` from the `base` template; runtime prep installs git and Node 22. pnpm/Python and additional runtimes are pending Phase-1 extensions.
- [x] 4.4. **Real-time stream:** Sandbox publishes lifecycle and tool events to an Upstash Redis list (`daybreak:stream:<taskId>`) using batched `rpush` + `ltrim`, keeping the last 1000 events per task. The control plane serves them via SSE (`/api/tasks/:id/stream`).
- [x] 4.5. **UI (local MVP):** React + Vite dashboard (`packages/ui`) with a repo/branch trigger form, live terminal panel, and recent task list. It consumes the Hono SSE endpoint. PR links and approval-gate buttons are deferred.
- [ ] 4.6. **Persistence:** Supabase Postgres. `sessions`, `tasks`, `events`, `checkpoints` (stub) tables.
- [x] 4.7. **Event schema (MVP):** `task_start`, `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `tool_execution_update`, `auto_retry_start`, `auto_retry_end`, `agent_end`, `bash_execution_update`, `task_complete`, `task_failed`. Additional fields (`approval_request`, `approval_response`, etc.) are added when approval gates are implemented.
- [ ] 4.8. **Context compaction:** Integrate Pi's compaction settings and the hard `MAX_TURNS` cap from Phase 0.
- [ ] 4.9. **Browser/Playwright tool:** Integrate headless Chromium inside the sandbox so the agent can visually verify running web apps and interact with DOM elements; stream screenshots to the UI.
- [x] 4.10. **PR delivery path:** direct branch/`main` push via HTTPS with `GITHUB_TOKEN` (user-authorized for this slice); GitHub API `POST /repos/{owner}/{repo}/pulls` creation deferred to Phase 3.
- [x] 4.11. **Control channel (MVP):** Control plane issues the spawn command and `TASK_ID` to the E2B sandbox; the sandbox pushes all events to Upstash Redis. Interactive commands and bidirectional control are deferred.
- [x] 4.12. **UI streaming:** Browser connects to the Hono SSE endpoint `/api/tasks/:id/stream` and renders events live. WebSocket migration is deferred to a later phase if needed.
- [ ] 4.13. Run the Phase 0 eval harness against this local MVP and record wall-clock time, token count, and $-cost per task.
- [ ] 4.14. **Exit criteria:** From the local dashboard, click "Fix failing test on repo X" → watch live terminal and browser stream → a PR appears on GitHub. The PR contains a real fix that passes CI, no `.env` was read, the branch is not `main`, and `MAX_TURNS`/`MAX_COST` are enforced.

---

## 5. Phase 2 — Observability, Cost Control & Provider Resilience

**Goal:** Every prompt, token count, tool call, and latency is emitted as OpenTelemetry spans to Langfuse, the dashboard renders the reasoning tree, and the system survives primary LLM provider outages.

- [ ] 5.1. **OTel instrumentation:** In the agent runner. A root `task` span with child spans per LLM call (model, prompt/completion token counts, latency) and per tool call (tool name, args, result size, latency).
- [ ] 5.2. **Langfuse ingestion:** Spans exported via the OTel HTTP exporter to the Langfuse OTel endpoint.
- [ ] 5.3. **DAG trace visualizer:** In the UI. Query Langfuse API for a task's trace; render reasoning tree with per-node cost and latency; color-code tool types; surface token totals.
- [ ] 5.4. **Cost dashboard:** Aggregate $-spend per task, per provider, per day, sourced from span token counts × provider pricing.
- [ ] 5.5. Map the Phase 1 event schema 1:1 to OTel span attributes.
- [ ] 5.6. Wrap Pi SDK's LLM-call and tool-execution hooks with span start/end.
- [ ] 5.7. **Provider fallback:** When the primary `LLM_BASE_URL` returns 429/5xx or a configurable retry budget is exhausted, switch to `LLM_FALLBACK_*`. Record provider usage in traces.
- [ ] 5.8. Build the Langfuse query client for the visualizer.
- [ ] 5.9. Render the DAG with React Flow or D3; make nodes clickable to show full prompt/response.
- [ ] 5.10. Validate the $0 invariant: confirm free-tier observation budgets cover the expected eval task volume.
- [ ] 5.11. **Exit criteria:** Run a task → open the local dashboard trace view → see the full reasoning tree with per-step token cost and latency. Total task cost is displayed. Pulling the primary LLM endpoint offline causes an automatic fallback with a visible trace event.

---

## 6. Phase 3 — GitHub-Native Triggers & Review Loop

**Goal:** Daybreak is triggerable from a GitHub Issue or a PR review comment, uses scoped 1-hour installation tokens, and listens for reviewer comments to iterate.

- [ ] 6.1. **GitHub App:** Register with least-privilege permissions: `contents: write`, `pull_requests: write`, `issues: read`, `checks: read`, `metadata: read`. Subscribes to `issue_comment`, `pull_request_review_comment`, `pull_request_review`, `check_run`.
- [ ] 6.2. **Local Webhook Tunneling:** Use `cloudflared` or `ngrok` to expose the local control plane to GitHub webhooks during development.
- [ ] 6.3. **Webhook handler:** In the control plane. Verifies signature, fetches a scoped 1-hour installation token via the App's JWT, creates a task, provisions the sandbox with the token injected.
- [ ] 6.4. **Issue/PR-comment parsing:** Extracts the instruction, target repo/branch, and context; maps to a task spec.
- [ ] 6.5. **Review-loop listener:** On new `pull_request_review_comment` with `@daybreak-bot`, wakes the sandbox, applies the review feedback, pushes to the existing PR branch.
- [ ] 6.6. **Multi-tenancy stub:** In Supabase, map GitHub installation → workspace/org/user, and enforce per-installation task-rate limits.
- [ ] 6.7. Generate the GitHub App private key; store as a Cloudflare/Worker secret; implement JWT signing + installation-token exchange.
- [ ] 6.8. Replace the MVP PAT path with installation tokens everywhere.
- [ ] 6.9. Implement comment-trigger routing: distinguish "new task" (issue) vs. "iterate on existing PR" (review comment).
- [ ] 6.10. Add sandbox standby/keep-alive: a PR-opened task keeps its sandbox alive (idle) for a configurable window to absorb review feedback, subject to cost/turn caps.
- [ ] 6.11. **Exit criteria:** Comment `@daybreak-bot fix the flaky test` on an issue → Daybreak opens a PR. A reviewer comments `@daybreak-bot also handle the null case` → Daybreak pushes a follow-up commit to the same PR. All token/cost guardrails remain active.

---

## 7. Phase 4 — Time-Travel State Branching *(Headline Feature)*

**Goal:** Rewind the agent's execution tree to any step, edit the context or prompt, and spawn a parallel attempt branch in a separate sandbox. This phase depends on the feasibility report from Phase 0.

- [ ] 7.1. **Checkpoint model:** A checkpoint is `{ turn, timestamp, piStateRef, fsSnapshotId, parentCheckpointId }` stored in Supabase. One checkpoint per turn.
- [ ] 7.2. **Filesystem rewind:** Use the strategy proven in Phase 0 — either E2B snapshots per turn or a per-turn `git commit` + dependency-cache fallback.
- [ ] 7.3. **Agent-state rewind:** Serialize Pi session at each checkpoint and reload/fork from `piStateRef`.
- [ ] 7.4. **Parallel attempt branching:** Fork the sandbox and fork the Pi session from checkpoint `N`.
- [ ] 7.5. **Branch UI:** In the dashboard. A tree visualization of checkpoints. User clicks a node, edits context/instruction, clicks "Branch". A new sandbox is spun from the snapshot, Pi state is restored and forked, and the new branch begins executing live.
- [ ] 7.6. Implement the checkpoint manager in the agent runner: after each tool turn, snapshot filesystem and serialize Pi state.
- [ ] 7.7. Implement the fork endpoint in the control plane: given `checkpointId`, provision a sandbox from `fsSnapshotId` and restore `piStateRef`.
- [ ] 7.8. Build the UI tree component. Allow context-window editing before spawning a branch.
- [ ] 7.9. Handle branch convergence: allow the user to promote a branch to become the primary PR, abandoning or pausing others.
- [ ] 7.10. **Exit criteria:** Run a task to completion. Rewind to step 3. Edit the prompt. Click "Branch". Watch a second, parallel sandbox execute a different path. Promote the second branch to a new PR.

---

## 8. Phase 5 — CI Self-Healing

**Goal:** Listen for failed GitHub Actions status checks on Daybreak's own PRs, intercept error logs, and push self-healing fix commits automatically.

- [ ] 8.1. **Webhook listener:** For `check_run` events with `conclusion: failure`.
- [ ] 8.2. **Log fetcher:** Uses GitHub API to pull the failed CI step logs.
- [ ] 8.3. **Heal task router:** Creates a new task in an existing (or forked) sandbox, injecting the CI failure logs as context for the Pi agent.
- [ ] 8.4. **Commit path:** Agent applies fix and pushes a new commit to the existing PR branch. CI re-runs automatically.
- [ ] 8.5. Filter `check_run` webhooks to only those on Daybreak PRs.
- [ ] 8.6. Implement log parsing to extract the relevant error block (avoid sending 10MB of raw logs to the LLM).
- [ ] 8.7. Feed the error to Pi with a targeted prompt: "CI failed with: [error]. Fix it."
- [ ] 8.8. Add circuit breaker: max 2 self-heal attempts per PR to prevent infinite CI loops; still subject to `MAX_TURNS` and `MAX_COST`.
- [ ] 8.9. **Exit criteria:** Merge a PR with a deliberately broken test. CI fails. Daybreak receives the webhook, analyzes the log, pushes a fix, and CI goes green.

---

## 9. Phase 6 — Resilience, Scale & Polish

**Goal:** Make the platform safe, resilient, and multi-user without blowing context windows, quotas, or budgets.

- [ ] 9.1. **Context compaction:** Tune Pi's compaction settings for long tasks and large repositories.
- [ ] 9.2. **Resource circuit breakers:** Finalize wall-clock (20 min), turn (40), and cost ($0.50) per task with graceful failure and full trace.
- [ ] 9.3. **Sensitive-file denylist:** Finalize and expand path patterns; add runtime log redaction so LLM/tool outputs cannot leak secrets.
- [ ] 9.4. **Branch-protection locks:** Agent refuses to commit directly to `main`/`master`; always uses feature branches.
- [ ] 9.5. **Cost circuit breaker:** Abort task if total $-cost exceeds threshold; emit alert.
- [ ] 9.6. **Task queue / worker:** Introduce a durable queue (Cloudflare Queues or Redis Streams) so multiple webhooks and UI triggers are processed without data loss or duplication.
- [ ] 9.7. **Idempotency and deduplication:** Webhook events and tasks carry idempotency keys; duplicate triggers are collapsed.
- [ ] 9.8. **Retry and dead-letter handling:** Failed tasks retry with exponential backoff; permanently failed tasks land in a dead-letter row in Supabase for manual inspection.
- [ ] 9.9. **Multi-tenancy and auth:** Per-GitHub-installation isolation, per-user/per-org task quotas, and role-based actions.
- [ ] 9.10. **Security audit:** Review sandbox escape vectors, LLM injection risks, path traversal in tool paths, and log sanitization.
- [ ] 9.11. **Branch cleanup:** Delete or archive stale feature branches and terminate idle sandboxes automatically.
- [ ] 9.12. **Exit criteria:** Attempt to make the agent read `.env` → blocked. Run a task in a loop that never passes tests → hits the 40-turn cap and stops. Simulate a webhook flood → queue absorbs it without duplicate tasks or quota exhaustion.

---

## 10. Phase 7 — Cloudflare Deployment & v1.0 Release

**Goal:** Take the fully functional, locally-tested codebase and deploy it to the $0 free-tier cloud infrastructure (Cloudflare Workers/Pages, Upstash, Supabase, Langfuse, E2B).

- [ ] 10.1. **Control Plane Migration:** Adapt the local Node.js control plane to run natively on Cloudflare Workers. Move long-lived WebSocket/queue handling to Durable Objects or Cloudflare Queues; replace Node-only APIs with Web standard APIs.
- [ ] 10.2. **Architecture audit:** Confirm no long-running agent work executes inside a Worker invocation. Agent orchestration is enqueue + signal; E2B containers do the heavy work.
- [ ] 10.3. **UI Deployment:** Deploy React + Vite app to Cloudflare Pages. Ensure Edge compatibility for any API routes.
- [ ] 10.4. **Environment Configuration:** Move all local `.env` secrets to Cloudflare Worker secrets and Upstash/Supabase dashboards.
- [ ] 10.5. **Production Webhooks:** Point GitHub App webhook URL to the deployed Cloudflare Worker URL.
- [ ] 10.6. **Documentation:** `DEPLOYMENT.md` guide, architecture diagrams, operator runbook, and v1.0 release notes.
- [ ] 10.7. Set up Durable Objects for the WebSocket bridge between Upstash Redis and the browser.
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

- Does `pi-agent-core` expose true session serialization and fork primitives, or do we need to build a wrapper?
- What is the real latency and credit cost of per-turn E2B snapshots at the task volumes we expect?
- Which free-tier OpenAI-compatible provider gives the best success-rate/availability for coding tasks, and what are its exact rate limits?
- Can Cloudflare Workers free tier handle webhook fan-in and Durable Object usage without hitting limits?
- How do we sanitize tool output so an adversarial repo cannot exfiltrate secrets even if the denylist is bypassed?

---

## 13. Reference

- Pi SDK: https://github.com/earendil-works/pi (`@earendil-works/pi-agent-core`, MIT, by Mario Zechner)
- E2B: https://e2b.dev
- OpenTelemetry: https://opentelemetry.io/
- Langfuse: https://langfuse.com/
