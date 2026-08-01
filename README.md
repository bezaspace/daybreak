# Daybreak — Autonomous AI Software Engineer Platform

An open-source, cloud-native developer agent platform that autonomously plans, writes, executes, tests, and ships production software. Ingests natural-language prompts, GitHub Issues, or PR review comments; provisions an isolated Linux execution sandbox; and iterates toward a solution until tests pass and a pull request is submitted. Built with enterprise transparency, deep observability, and **time-travel state rewinding** at its core — every model prompt, token count, tool latency, and reasoning step is traceable, and a human can pause, rewind the agent's execution tree to any step, edit the context, and spawn a parallel attempt branch without starting over.

**Status**: Planning — spec complete, build pending.
**Started**: 2026-08-01 (planning)

---

## What It Is

A user (or a GitHub Issue, or a PR review comment) gives Daybreak a task. The platform:

1. **Triggers** via the web dashboard or a GitHub Issue tag (`@daybreak-bot fix test failure`). The Cloudflare Worker control plane authenticates, fetches a 1-hour scoped GitHub token, and logs the session in Supabase.
2. **Provisions a sandbox** — invokes the Daytona SDK to launch a pre-configured Linux sandbox (<90ms cold start).
3. **Prepares the workspace** — inside the sandbox, the Pi SDK agent clones the target repo, configures bot committer details, and checks out a new feature branch.
4. **Iterates** — analyzes the codebase with `read` and `bash`, parses errors, applies fixes with `edit`/`write`, re-runs tests. Terminal output streams live to the React dashboard over Upstash Redis WebSockets.
5. **Delivers** — pushes the branch, submits a Pull Request via the GitHub API, marks the task complete.
6. **Monitors** — registers webhook listeners for CI status checks and reviewer comments, keeping the sandbox on standby to self-heal failed CI or apply review feedback.

The differentiators that make this more than "another coding agent":

- **Full OpenTelemetry lineage** — every prompt, token count, tool latency, and reasoning step emitted as spans to Langfuse. A DAG visualizer renders the agent's reasoning tree with cost-per-step and tool latencies.
- **Time-travel state manipulation** — rewind the agent's stateful execution tree to step *N*, edit the context or prompt, and spawn a parallel attempt branch without starting over. The headline feature.
- **Stateful execution sandboxes** — instant, persistent Daytona containers that maintain filesystem and dependency state across long-running, multi-turn task loops.
- **Autonomous GitHub CI self-healing** — listens for failed GitHub Actions status checks on its own PRs, intercepts error logs, and pushes self-healing fix commits automatically.
- **$0 operating cost** — engineered to run entirely on free-tier infrastructure.

## Tech Stack

- **Agent Kernel**: Pi SDK (`@earendil-works/pi-agent-core`) — minimalist, tree-structured TypeScript agent framework handling execution history, context-window compaction, and tool loops. Tools: `read`, `write`, `edit`, `bash`.
- **Control Plane & API**: Node.js / TypeScript on Cloudflare Workers & Pages — edge serverless gateway for webhook processing, session routing, and auth.
- **UI**: React / Next.js on Cloudflare Pages / Vercel — real-time streaming terminal logs, code diff previews, and trace trees.
- **Cloud Execution**: Daytona.io SDK — instant (<90ms), stateful Linux container sandboxes ($200 free compute credit, no credit card; snapshots + volumes included, which backs the time-travel filesystem rewind).
- **LLM Intelligence**: any OpenAI-compatible LLM provider — the agent kernel talks to whatever OpenAI-compatible endpoint is configured (base URL + API key). This keeps the platform provider-agnostic and lets it ride the wide ecosystem of free OpenAI-compatible endpoints available online (Groq, OpenRouter free tiers, self-hosted vLLM/Ollama, etc.) rather than being locked to a single vendor. The $0 thesis depends on picking a free-tier OpenAI-compatible provider at deploy time, not on any one vendor's quota staying generous.
- **Real-Time Stream Engine**: Upstash Redis (free tier, 10,000 commands/day) — distributed pub/sub for WebSocket event streaming between sandboxes and the web UI.
- **Data & Session Persistence**: PostgreSQL on Supabase (free tier, 500MB) — user sessions, GitHub App installations, task histories, checkpoint metadata.
- **Observability & Tracing**: OpenTelemetry standard emitted to Langfuse Cloud (50,000 free traces/month) — prompt tracing, tool latency, execution-tree graph rendering.

## Build Plan (MVP vertical slice first, then layer the differentiators)

1. **Phase 0** — Repo + `PROJECT_PLAN.md` + `PROGRESS.md`. Pi SDK spike: prove `Agent` + `read`/`write`/`edit`/`bash` tools run against an OpenAI-compatible LLM provider.
2. **Phase 1 (MVP)** — Dashboard trigger → Cloudflare Worker → Daytona sandbox → Pi agent clones a repo, runs tests, edits, pushes a branch, opens a PR. Stream terminal output to a minimal React UI via Upstash. *Demoable on its own.*
3. **Phase 2** — OTel instrumentation → Langfuse; DAG trace visualizer in the dashboard.
4. **Phase 3** — GitHub App: issue/PR-comment triggers, scoped tokens, review-loop listener.
5. **Phase 4** — Time-travel: per-turn Daytona snapshots + Pi state serialization → rewind + branch UI. *(The headline feature, deliberately late — it's the hardest part.)*
6. **Phase 5** — CI self-healing: webhook on failed check runs → wake sandbox → fix commit.
7. **Phase 6** — Context compaction, resource circuit breakers (20-min wall-clock, 40-turn cap), sensitive-file denylist (`.env`, `*.pem`, `.ssh/*`), branch-protection locks (no commits to `main`/`master`).

Every milestone should be demoable on its own. Track cost, latency, and token usage from day one.

## Notes

- The *product category* (autonomous coding agent) is crowded — Devin, OpenHands, SWE-agent, Aider, Cursor, Pi's own coding-agent. What's actually novel here is the **specific combination**: time-travel branching + full OTel lineage + $0 free-tier + open-source + GitHub-native CI self-healing. The combination and the transparency thesis are the differentiator, not the concept itself.
- Time-travel is the hardest feature and the spec hand-waves the implementation. FS rewind needs Daytona snapshots (they exist) or a per-turn git-checkpoint strategy; conversation rewind needs Pi's state to be serializable and re-branchable. It's deliberately Phase 4, not the MVP, even though it's the headline.

## Reference

- Pi SDK: https://github.com/earendil-works/pi (`@earendil-works/pi-agent-core`, MIT, by Mario Zechner)
- Daytona: https://www.daytona.io/ ($200 free compute, sub-90ms cold start, snapshots + volumes)
