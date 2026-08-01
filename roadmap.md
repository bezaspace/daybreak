# Roadmap — Daybreak

**Open-source, cloud-native, autonomous AI software engineer platform with time-travel state branching and full OTel lineage.**

> **Status:** Planning — spec complete, build pending.
> **Started:** 2026-08-01 (planning)
> **Document version:** 1.3 (Checkbox format for progress tracking)

---

## 0. Vision & North Star

Daybreak is an open-source replica of the cloud coding-agent class of system (Devin, Cursor's cloud agent), built to **understand and demonstrate the engineering behind autonomous coding agents** rather than to ship a commercial product. It takes the same core primitives — a sandboxed Linux execution environment with shell/editor/browser tools, a planner-executor reasoning loop, and GitHub-native PR delivery — and adds two things the closed-source originals do not expose: **full OpenTelemetry lineage** (every prompt, token, tool call, and latency is traceable) and **time-travel state branching** (rewind the cloud sandbox filesystem and agent state to any step, edit the context, and spawn a parallel attempt in a separate sandbox). The entire platform is engineered to run on **$0 of free-tier infrastructure**.

The differentiator is the *combination* and the *transparency thesis*, not the concept itself. What is novel here is the specific stack: **time-travel branching + full OTel lineage + $0 free-tier + open-source + GitHub-native CI self-healing**.

---

## 1. Guiding Principles

- [ ] 1.1. **Local-First Development, Cloud-Ready Architecture.** All code will be written, tested, and demoed locally using local Node.js/Vite dev servers and local tunneling (e.g., `ngrok` or `cloudflared`) for webhooks. The architecture will strictly adhere to Cloudflare Workers/Pages constraints so that the final deployment is a frictionless configuration step rather than a rewrite.
- [ ] 1.2. **Vertical slice first, differentiators later.** The MVP (Phase 1) proves the end-to-end loop is demoable on its own before any headline feature is touched. Time-travel is deliberately Phase 4.
- [ ] 1.3. **Every milestone is demoable on its own.** No phase exists only to enable a later phase; each ships a visible capability.
- [ ] 1.4. **Track cost, latency, and token usage from day one.** The $0 thesis is a continuously-verified invariant, not an afterthought.
- [ ] 1.5. **Provider-agnostic intelligence.** The agent kernel talks to any OpenAI-compatible endpoint.
- [ ] 1.6. **Transparency by construction.** Observability is not bolted on — it is a Phase 2 layer that every subsequent phase emits into.
- [ ] 1.7. **Fail safe, not fail fast.** Resource circuit breakers, sensitive-file denylists, and branch-protection locks are first-class.
- [ ] 1.8. **AI-Agent Friendly Codebase.** Highly modular, strongly typed, and extensively documented to provide maximum context to the AI agents doing the building.

---

## 2. Phase Overview

Because this project is being built autonomously by AI coding agents, strict time estimations are counterproductive. Progress is measured by the completion of demoable vertical slices.

- [ ] 2.1. **Phase 0 — Foundation & Spike:** Pi SDK proves `read/write/edit/bash` against an OpenAI-compatible LLM; repo setup.
- [ ] 2.2. **Phase 1 — Local MVP Vertical Slice:** Local React+Vite dashboard → Local Node control plane → Daytona sandbox → Pi agent clones, tests, edits, pushes, opens PR; live-streamed to UI.
- [ ] 2.3. **Phase 2 — Observability Layer:** Full OTel spans → Langfuse; DAG trace visualizer in dashboard.
- [ ] 2.4. **Phase 3 — GitHub-Native Triggers:** GitHub App: issue/PR-comment triggers, scoped 1h tokens, review-loop listener via local tunnel.
- [ ] 2.5. **Phase 4 — Time-Travel Branching:** Per-turn checkpoints (Pi state + Daytona snapshot) → rewind + fork into parallel attempt branch.
- [ ] 2.6. **Phase 5 — CI Self-Healing:** Webhook on failed `check_run` → wake sandbox → fix commit → push.
- [ ] 2.7. **Phase 6 — Guardrails & Compaction:** Context compaction, circuit breakers, denylist, branch-protection locks.
- [ ] 2.8. **Phase 7 — Cloudflare Deployment:** Adapt local codebase to Cloudflare Workers/Pages, configure free-tier infra, v1.0 release.

---

## 3. Phase 0 — Foundation & Spike

**Goal:** Stand up the repo and prove the agent kernel runs end-to-end against a free OpenAI-compatible provider before any cloud plumbing or UI is built.

- [ ] 3.1. Initialize `daybreak` monorepo (pnpm workspaces): `packages/control-plane`, `packages/agent-runner`, `packages/ui`, `packages/shared`.
- [ ] 3.2. Create `ROADMAP.md` (this document).
- [ ] 3.3. Pi SDK spike: a standalone TypeScript script that instantiates `@earendil-works/pi-agent-core`, wires `read/write/edit/bash` tools, and drives a multi-turn loop against a configured OpenAI-compatible endpoint (Groq / OpenRouter / local Ollama).
- [ ] 3.4. Create `.env.example` documenting `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
- [ ] 3.5. Set up CI: lint + typecheck + test on push.
- [ ] 3.6. Confirm Pi SDK package scope (`@earendil-works/pi-agent-core`, v0.74.0+) installs cleanly and the agent loop + tool registration API matches the documented core.
- [ ] 3.7. Spike each tool in isolation: `read` a file, `edit` it, `bash` `npm test`, observe the loop's compaction behavior on a long session.
- [ ] 3.8. Record baseline metrics: tokens/turn, p50 latency/turn, cost/task on a toy repo.
- [ ] 3.9. Document the chosen free LLM provider and its quota shape; note fallback providers.
- [ ] 3.10. **Exit criteria:** `pnpm spike` clones a toy repo, runs its tests, applies a one-line fix, re-runs tests until green, and prints a token/latency summary table. No cloud, no UI — just the loop.

---

## 4. Phase 1 — Local MVP Vertical Slice

**Goal:** The full Daybreak loop, demoable end-to-end locally: a local dashboard triggers a local control plane server, which provisions a Daytona sandbox, runs the Pi agent to clone/test/edit/push/open a PR, and streams terminal output live to the UI.

- [ ] 4.1. **Control plane:** Local Node.js/TypeScript server, structured for Cloudflare Worker migration. `/api/tasks` POST handler that authenticates, creates a Supabase session row, invokes Daytona, and streams events to Upstash Redis.
- [ ] 4.2. **Agent runner:** Runs inside the Daytona sandbox. Wraps Pi SDK, clones the target repo, configures bot committer, checks out a feature branch, iterates (`read`/`bash`/`edit`), pushes, opens a PR via GitHub API (PAT for MVP).
- [ ] 4.3. **Sandbox provisioning:** Daytona TypeScript SDK `daytona.create()` from a default snapshot; workspace prep script (git, node, repo clone).
- [ ] 4.4. **Real-time stream:** Sandbox publishes stdout/stderr/tool-events to an Upstash Redis pub/sub channel; local UI subscribes.
- [ ] 4.5. **UI:** Local React + Vite dev server. Task trigger form, live terminal panel, PR link, basic task list.
- [ ] 4.6. **Persistence:** Supabase Postgres. `sessions`, `tasks`, `events` tables; checkpoint metadata stub (filled in Phase 4).
- [ ] 4.7. Define the event schema (`tool_call`, `tool_result`, `stdout`, `stderr`, `llm_prompt`, `llm_response`, `task_complete`).
- [ ] 4.8. Build the Daytona workspace image: a snapshot with git, Node, common build tools preinstalled.
- [ ] 4.9. Implement the control plane → sandbox control channel: control plane issues commands over Daytona's process exec API; sandbox pushes events to Upstash.
- [ ] 4.10. Wire the UI WebSocket: local server holds the client connection, pulls from Upstash REST, relays to browser.
- [ ] 4.11. Implement the PR delivery path: branch push + `POST /repos/{owner}/{repo}/pulls`.
- [ ] 4.12. Record wall-clock time, token count, and $-cost per MVP task as a baseline.
- [ ] 4.13. **Exit criteria:** From the local dashboard, click "Fix failing test on repo X" → watch live terminal → a PR appears on GitHub. The PR contains a real fix that passes CI.

---

## 5. Phase 2 — Observability & Trace Visualization

**Goal:** Every prompt, token count, tool call, and latency is emitted as OpenTelemetry spans to Langfuse, and a DAG visualizer in the dashboard renders the agent's reasoning tree with cost-per-step.

- [ ] 5.1. **OTel instrumentation:** In the agent runner. A span per LLM call (model, prompt-token-count, completion-token-count, latency), a child span per tool call (tool name, args, result size, latency), all under a root `task` span.
- [ ] 5.2. **Langfuse ingestion:** Spans exported via the OTel HTTP exporter to the Langfuse OTel endpoint.
- [ ] 5.3. **DAG trace visualizer:** In the UI. Queries the Langfuse API for a task's trace, renders the reasoning tree with per-node cost and latency. Color-code tool types; surface token totals.
- [ ] 5.4. **Cost dashboard:** Aggregate $-spend per task, per provider, per day, sourced from span token counts × provider pricing.
- [ ] 5.5. Map the Phase 1 event schema 1:1 to OTel span attributes.
- [ ] 5.6. Wrap the Pi SDK's LLM-call and tool-execution hooks with span start/end.
- [ ] 5.7. Build the Langfuse query client (API key, project-scoped) for the visualizer.
- [ ] 5.8. Render the DAG with a library like React Flow or D3; make nodes clickable to show the full prompt/response.
- [ ] 5.9. Validate the $0 invariant: confirm Hobby-tier observation budget covers expected task volume.
- [ ] 5.10. **Exit criteria:** Run a task → open the local dashboard trace view → see the full reasoning tree with per-step token cost and latency. Total task cost displayed.

---

## 6. Phase 3 — GitHub-Native Triggers & Review Loop

**Goal:** Daybreak is triggerable from a GitHub Issue or a PR review comment, uses scoped 1-hour installation tokens, and listens for reviewer comments to iterate.

- [ ] 6.1. **GitHub App:** Registered with permissions: `contents: write`, `pull_requests: write`, `issues: read`, `checks: read`, `metadata: read`. Subscribes to `issue_comment`, `pull_request_review_comment`, `pull_request_review`, `check_run`.
- [ ] 6.2. **Local Webhook Tunneling:** Use `cloudflared` or `ngrok` to expose the local control plane to GitHub webhooks during development.
- [ ] 6.3. **Webhook handler:** In the control plane. Verifies signature, fetches a scoped 1-hour installation token via the App's JWT, creates a task, provisions the sandbox with the token injected.
- [ ] 6.4. **Issue/PR-comment parsing:** Extracts the instruction, target repo/branch, and context; maps to a task spec.
- [ ] 6.5. **Review-loop listener:** On new `pull_request_review_comment` with `@daybreak-bot`, wakes the sandbox, applies the review feedback, pushes to the existing PR branch.
- [ ] 6.6. **Session registry:** In Supabase. Maps GitHub installation → sandbox ID → active task.
- [ ] 6.7. Generate the GitHub App private key; store as a local secret; implement JWT signing + installation-token exchange.
- [ ] 6.8. Replace the MVP PAT path with installation tokens everywhere.
- [ ] 6.9. Implement comment-trigger routing: distinguish "new task" (issue) vs. "iterate on existing PR" (review comment).
- [ ] 6.10. Add sandbox standby/keep-alive: a PR-opened task keeps its sandbox alive (idle) for a configurable window to absorb review feedback.
- [ ] 6.11. **Exit criteria:** Comment `@daybreak-bot fix the flaky test` on an issue → Daybreak opens a PR. A reviewer comments `@daybreak-bot also handle the null case` → Daybreak pushes a follow-up commit to the same PR.

---

## 7. Phase 4 — Time-Travel State Branching *(Headline Feature)*

**Goal:** Rewind the agent's execution tree to any step, edit the context or prompt, and spawn a parallel attempt branch in a separate sandbox.

- [ ] 7.1. **Checkpoint model:** A checkpoint is a tuple `{ turn, timestamp, piStateRef, daytonaSnapshotId, parentCheckpointId }` stored in Supabase. One checkpoint per turn.
- [ ] 7.2. **Filesystem rewind:** Via Daytona snapshots. After each turn, capture a Daytona snapshot of the sandbox filesystem + dependency state.
- [ ] 7.3. **Agent-state rewind:** Via Pi session serialization. Leverage Pi's native `/tree` branching and `/fork` by serializing the Pi session at each checkpoint.
- [ ] 7.4. **Parallel attempt branching:** Via Daytona copy-on-write forks. When a user branches from checkpoint N, fork the sandbox and fork the Pi session.
- [ ] 7.5. **Branch UI:** In the dashboard. A tree visualization of checkpoints. User clicks a node, edits the context/instruction, clicks "Branch". A new sandbox is spun up from the snapshot, Pi state is restored and forked, and the new branch begins executing live.
- [ ] 7.6. Implement the checkpoint manager in the agent runner: after each tool turn, `daytona.snapshot()` + `pi.serialize()`.
- [ ] 7.7. Implement the fork endpoint in the control plane: given `checkpointId`, `daytona.fork(snapshotId)` + `pi.fork(stateRef)`.
- [ ] 7.8. Build the UI tree component. Allow context window editing before spawning a branch.
- [ ] 7.9. Handle branch convergence: allow the user to promote a branch to become the primary PR, abandoning or pausing others.
- [ ] 7.10. **Exit criteria:** Run a task to completion. Rewind to step 3. Edit the prompt. Click "Branch". Watch a second, parallel sandbox execute a different path. Promote the second branch to a new PR.

---

## 8. Phase 5 — CI Self-Healing

**Goal:** Listen for failed GitHub Actions status checks on Daybreak's own PRs, intercept error logs, and push self-healing fix commits automatically.

- [ ] 8.1. **Webhook listener:** For `check_run` events with `conclusion: failure`.
- [ ] 8.2. **Log fetcher:** Uses GitHub API to pull the failed CI step logs.
- [ ] 8.3. **Heal task router:** Creates a new task in an existing (or forked) sandbox, injecting the CI failure logs as context for the Pi agent.
- [ ] 8.4. **Commit path:** Agent applies fix, amends or pushes new commit to the existing PR branch. CI re-runs automatically.
- [ ] 8.5. Filter `check_run` webhooks to only those on Daybreak PRs.
- [ ] 8.6. Implement log parsing to extract the relevant error block (avoid sending 10MB of raw logs to the LLM).
- [ ] 8.7. Feed the error to Pi with a targeted prompt: "CI failed with: [error]. Fix it."
- [ ] 8.8. Add circuit breaker: max 2 self-heal attempts per PR to prevent infinite CI loops.
- [ ] 8.9. **Exit criteria:** Merge a PR with a deliberately broken test. CI fails. Watch Daybreak receive the webhook, analyze the log, push a fix, and watch CI go green.

---

## 9. Phase 6 — Guardrails & Compaction

**Goal:** Make the platform safe and resilient for long-running tasks without blowing context windows or budgets.

- [ ] 9.1. **Context compaction:** Integrate Pi's compaction settings to summarize older conversation history when approaching context limits.
- [ ] 9.2. **Resource circuit breakers:** Hard limits on wall-clock time (e.g., 20 min) and turn count (e.g., 40 turns) per task. If hit, task fails gracefully with a trace.
- [ ] 9.3. **Sensitive-file denylist:** Block `read`/`write`/`edit` tools on `.env`, `*.pem`, `.ssh/*`, etc.
- [ ] 9.4. **Branch-protection locks:** Agent refuses to commit directly to `main` or `master`; always uses feature branches.
- [ ] 9.5. **Cost circuit breaker:** Abort task if total $-cost for a session exceeds a threshold (e.g., $0.50).
- [ ] 9.6. Configure Pi's `compaction` settings in the agent runner initialization.
- [ ] 9.7. Implement middleware in the tool execution layer to intercept and block denylisted file paths.
- [ ] 9.8. Add a watchdog timer in the control plane that terminates sandboxes exceeding limits.
- [ ] 9.9. **Exit criteria:** Attempt to make the agent read `.env` → blocked. Run a task in a loop that never passes tests → hits 40-turn cap and stops. Run a huge task → context compacts and continues.

---

## 10. Phase 7 — Cloudflare Deployment & v1.0 Release

**Goal:** Take the fully functional, locally-tested codebase and deploy it to the $0 free-tier cloud infrastructure (Cloudflare Workers/Pages, Upstash, Supabase, Langfuse).

- [ ] 10.1. **Control Plane Migration:** Adapt the local Node.js control plane to run natively on Cloudflare Workers. Ensure WebSocket handling is moved to Durable Objects. Replace Node-specific APIs with Web standard APIs.
- [ ] 10.2. **UI Deployment:** Deploy React + Vite app to Cloudflare Pages. Ensure Edge compatibility for any API routes.
- [ ] 10.3. **Environment Configuration:** Move all local `.env` secrets to Cloudflare Worker secrets and Upstash/Supabase dashboards.
- [ ] 10.4. **Production Webhooks:** Point GitHub App webhook URL to the deployed Cloudflare Worker URL.
- [ ] 10.5. **Documentation:** `DEPLOYMENT.md` guide, architecture diagrams, and v1.0 release notes.
- [ ] 10.6. Audit codebase for Node.js built-ins not supported in Workerd. Replace with Cloudflare bindings or Web APIs.
- [ ] 10.7. Set up Durable Objects for the WebSocket bridge between Upstash Redis and the browser.
- [ ] 10.8. Configure `wrangler.toml` with all bindings (Supabase URL, Upstash REST URL, GitHub App ID, Langfuse keys).
- [ ] 10.9. Run end-to-end production test: trigger via GitHub Issue → Cloudflare Worker → Daytona → PR.
- [ ] 10.10. **Exit criteria:** The entire Daybreak platform is accessible via a public URL. A GitHub issue triggers the cloud-hosted agent, which opens a PR, with live logs streaming to the deployed dashboard. Total monthly operating cost = $0.
