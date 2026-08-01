# Daybreak — Autonomous AI Software Engineer Platform

An open-source, cloud-native developer agent platform that autonomously plans, writes, executes, tests, and ships production software. Ingests natural-language prompts, GitHub Issues, or PR review comments; provisions an isolated Linux execution sandbox; and iterates toward a solution until tests pass and a pull request is submitted. Built with enterprise transparency, deep observability, and **time-travel state rewinding** at its core — every model prompt, token count, tool latency, and reasoning step is traceable, and a human can pause, rewind the agent's execution tree to any step, edit the context, and spawn a parallel attempt branch without starting over.

**Status**: Phase 0 complete; Phase 1 local MVP implemented with E2B sandboxing (including a `daybreak-browser` template for Playwright/Chromium), Upstash streaming, PR delivery, Supabase persistence, and the browser tool streaming screenshots to the UI.
**Started**: 2026-08-01

---

## Inspiration & Positioning

Daybreak is inspired by the cloud coding agents built by **Devin AI** (Cognition) and **Cursor AI** — autonomous software engineers that plan, write, execute, test, and ship code inside isolated cloud sandboxes. Both are impressive products, but they are closed-source: their reasoning, tool latency, token cost, and decision lineage are not exposed to the user, and their state-rewinding capabilities (where they exist) are session-bound and not branchable into parallel attempts.

Daybreak is an open-source replica of that class of system, built to understand and demonstrate the engineering behind autonomous coding-agent platforms. It takes the same core ideas — a sandboxed execution environment with shell, editor, and browser tools; a planner-executor reasoning loop; GitHub-native PR delivery and CI self-healing — and adds two things the closed-source originals do not offer: **full OpenTelemetry lineage** (every prompt, token, tool call, and latency is traceable) and **time-travel state branching** (rewind the cloud sandbox filesystem and agent state to any step, edit the context, and spawn a parallel attempt in a separate sandbox). The whole platform is also engineered to run on $0 of free-tier infrastructure.

This is a learning and demonstration project, not a product to sell.

---

## What It Is

A user (or a GitHub Issue, or a PR review comment) gives Daybreak a task. The platform:

1. **Triggers** via the local React dashboard or a `curl` to the local Hono control plane (`POST /api/tasks`). The control plane provisions an E2B sandbox and opens an SSE stream from Upstash Redis.
2. **Provisions a sandbox** — invokes the E2B SDK to launch the `base` (or a pre-built `daybreak-browser`) template. The `daybreak-browser` template includes Node 22, Chromium, and `playwright-core` so the agent can run the browser tool without runtime installation.
3. **Prepares the workspace** — inside the sandbox, the Pi SDK agent clones the target repo, configures bot committer details, and checks out the target branch.
4. **Iterates** — analyzes the codebase with `read` and `bash`, parses errors, applies fixes with `edit`/`write`, and re-runs tests. The `browser` tool can navigate pages, take screenshots, read text/HTML, click/fill elements, and evaluate JavaScript. Screenshot events stream to the React dashboard over Upstash Redis via a Hono SSE endpoint.
5. **Delivers** — creates a feature branch (e.g., `daybreak/<task-id>`), commits and pushes the fix there, then the control plane opens a Pull Request via the GitHub API. `main`/`master` are protected by default.
6. **Monitors** — the UI receives the `task_complete` or `task_failed` event and shows the final status. Every task and event is persisted to Supabase Postgres so the dashboard survives control-plane restarts. Webhook listeners for CI/review are deferred.

The differentiators that make this more than "another coding agent":

- **Full OpenTelemetry lineage** — every prompt, token count, tool latency, and reasoning step emitted as spans to Langfuse. A DAG visualizer renders the agent's reasoning tree with cost-per-step and tool latencies.
- **Time-travel state manipulation** — rewind the agent's stateful execution tree to step *N*, edit the context or prompt, and spawn a parallel attempt branch without starting over. The headline feature.
- **Stateful execution sandboxes** — persistent E2B containers that maintain filesystem and dependency state across long-running, multi-turn task loops (free Hobby tier, outbound internet enabled by default).
- **Autonomous GitHub CI self-healing** — listens for failed GitHub Actions status checks on its own PRs, intercepts error logs, and pushes self-healing fix commits automatically.
- **$0 operating cost** — engineered to run entirely on free-tier infrastructure.

## Tech Stack

- **Agent Kernel**: Pi SDK (`@earendil-works/pi-agent-core`) — minimalist, tree-structured TypeScript agent framework handling execution history, context-window compaction, and tool loops. Tools: `read`, `write`, `edit`, `bash`, `browser` (headless Chromium via Playwright — navigate pages, take screenshots, interact with DOM elements, and visually verify running web apps inside the sandbox).
- **Control Plane & API**: Node.js / TypeScript with Hono, run locally for the MVP (`packages/control-plane`). It is written with Worker-compatible APIs where possible, but Cloudflare Worker deployment is deferred to Phase 7.
- **UI**: React + Vite local dev server (`packages/ui`) — real-time streaming terminal panel, task trigger form, and recent task list. Cloudflare Pages / Next.js are deferred.
- **Cloud Execution**: E2B SDK — stateful Linux container sandboxes (free Hobby tier with $100 in one-time credits, no credit card; snapshots + volumes included, which backs the time-travel filesystem rewind; unrestricted outbound internet for OpenAI-compatible providers).
- **LLM Intelligence**: any OpenAI-compatible LLM provider — the agent kernel talks to whatever OpenAI-compatible endpoint is configured (base URL + API key). This keeps the platform provider-agnostic and lets it ride the wide ecosystem of free OpenAI-compatible endpoints available online (Groq, OpenRouter free tiers, self-hosted vLLM/Ollama, etc.) rather than being locked to a single vendor. The $0 thesis depends on picking a free-tier OpenAI-compatible provider at deploy time, not on any one vendor's quota staying generous.
- **Real-Time Stream Engine**: Upstash Redis (free tier, 500K commands/month) — sandbox events are appended to a per-task Redis list with batched `RPUSH` + `LTRIM`; the control plane exposes them as SSE.
- **Data & Session Persistence**: PostgreSQL on Supabase (free tier, 500MB) — user sessions, GitHub App installations, task histories, checkpoint metadata.
- **Observability & Tracing**: OpenTelemetry standard emitted to Langfuse Cloud (50,000 free traces/month) — prompt tracing, tool latency, execution-tree graph rendering.

## Build Plan (MVP vertical slice first, then layer the differentiators)

1. **Phase 0** — Repo + `PROJECT_PLAN.md` + `PROGRESS.md`. Pi SDK spike: prove `Agent` + `read`/`write`/`edit`/`bash` tools run against an OpenAI-compatible LLM provider.
2. **Phase 1 (MVP)** — Dashboard trigger → local Hono control plane → E2B sandbox → Pi agent clones a repo, runs tests, edits, pushes the fix to a `daybreak/<task-id>` feature branch, the control plane opens a GitHub PR, and every event is persisted to Supabase Postgres. Streams events to a minimal React + Vite UI via Upstash Redis + Hono SSE. *Demoable on its own.*
3. **Phase 2** — OTel instrumentation → Langfuse; DAG trace visualizer in the dashboard.
4. **Phase 3** — GitHub App: issue/PR-comment triggers, scoped tokens, review-loop listener.
5. **Phase 4** — Time-travel: per-turn E2B snapshots + Pi state serialization → rewind + branch UI. *(The headline feature, deliberately late — it's the hardest part.)*
6. **Phase 5** — CI self-healing: webhook on failed check runs → wake sandbox → fix commit.
7. **Phase 6** — Context compaction, resource circuit breakers (20-min wall-clock, 40-turn cap), sensitive-file denylist (`.env`, `*.pem`, `.ssh/*`), branch-protection locks (no commits to `main`/`master`).

Every milestone should be demoable on its own. Track cost, latency, and token usage from day one.

## Notes

- The *product category* (autonomous coding agent) is crowded — Devin, OpenHands, SWE-agent, Aider, Cursor, Pi's own coding-agent. What's actually novel here is the **specific combination**: time-travel branching + full OTel lineage + $0 free-tier + open-source + GitHub-native CI self-healing. The combination and the transparency thesis are the differentiator, not the concept itself.
- Time-travel is the hardest feature and the spec hand-waves the implementation. FS rewind needs E2B snapshots (they exist) or a per-turn git-checkpoint strategy; conversation rewind needs Pi's state to be serializable and re-branchable. It's deliberately Phase 4, not the MVP, even though it's the headline.

## Reference

- Pi SDK: https://github.com/earendil-works/pi (`@earendil-works/pi-agent-core`, MIT, by Mario Zechner)
- E2B: https://e2b.dev (free Hobby tier with $100 in one-time credits, snapshots + volumes, outbound internet enabled by default)
