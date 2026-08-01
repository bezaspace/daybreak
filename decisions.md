# Decisions — Daybreak

**A living log of the architectural, product, and sequencing decisions behind the Daybreak roadmap.**

> **Status:** Draft — updated with Roadmap v2.0  
> **Started:** 2026-08-01

---

## D1. Project scope and purpose

**Decision:** Daybreak is a learning/demonstration project, not a commercial product. It replicates the cloud coding-agent class of system (Devin, Cursor) and adds two novel public features: full OpenTelemetry lineage and time-travel state branching, all on free-tier infrastructure.

**Rationale:** The product category is crowded. The value is in the *combination* of features and the *transparency thesis*, not in trying to ship a new closed-source competitor.

**Consequences:**
- No billing, multi-tenant SaaS, or enterprise sales features.
- We optimize for clarity, observability, and demoability over market-fit velocity.

---

## D2. Agent kernel: Pi SDK (`pi-coding-agent` / `pi-agent-core`)

**Decision:** Build the agent runner on top of the Pi SDK (`@earendil-works/pi-coding-agent`, which wraps `pi-agent-core`, currently `0.83.0`).

**Rationale:** `pi-coding-agent` ships with the built-in read/bash/edit/write tools, `AgentSession`, and tree-structured session management that Phase 0 needs. It is open-source and matches the TypeScript/Node control-plane stack. `pi-agent-core` remains the underlying abstraction for tool-call hooks and event streaming.

**Alternatives considered:**
- LangChain/LangGraph: heavier and more opinionated.
- A from-scratch agent loop: too much boilerplate and risk.

**Consequences:**
- We are tied to Pi's tool-registration and session APIs.
- The time-travel feature depends on whether Pi sessions can be serialized/forked. If not, we must wrap or extend it.

---

## D3. Safety is Phase 0 work, not Phase 6

**Decision:** Guardrails, branch protection, sensitive-file denylisting, human approval gates, and resource/cost circuit breakers are built before the first MVP loop runs.

**Rationale:** An autonomous agent with `write`, `bash`, `git push`, and PR privileges is dangerous from the first iteration. Waiting until Phase 6 would expose every earlier phase to data loss, secret leakage, or `main`-branch corruption.

**Consequences:**
- Phase 0 is larger than the original plan.
- Every later phase inherits these controls and must not bypass them.

---

## D4. Local-first, cloud-ready control plane

**Decision:** Implement the control plane as Node.js/TypeScript that runs locally for development, but constrain it to Cloudflare Workers/Pages-compatible APIs from the start.

**Rationale:** Local iteration is faster, but a later rewrite for Cloudflare would be costly. Writing Worker-compatible code now makes deployment a configuration step.

**Consequences:**
- No Node-only modules (`fs`, `child_process`, `http` server) in core control-plane code.
- Long-running tasks must not live inside a Worker invocation; they must be offloaded to E2B sandboxes and triggered via durable queues/Durable Objects.

---

## D5. Cloudflare Workers + Pages for the cloud control plane and UI

**Decision:** Use Cloudflare Workers for the control-plane API, Cloudflare Pages for the React UI, and Durable Objects/Queues for WebSocket/queue handling.

**Rationale:** Free tier, edge deployment, and native integration with the local-first code in D4.

**Consequences:**
- We must respect Workers free-tier CPU/time limits; heavy work belongs in E2B.
- WebSocket/streaming to the browser requires Durable Objects.
- We need `wrangler.toml` bindings for all secrets and external services.

---

## D6. E2B sandboxes for execution

**Decision:** Use E2B SDK-provisioned Linux containers as the agent execution environment.

**Rationale:** E2B sandboxes have unrestricted outbound internet by default, which is required for the OpenAI-compatible Kilo.ai gateway. They support full Linux command execution, filesystem operations, git, snapshots, and a free Hobby tier with $100 in one-time credits. This replaces Daytona, whose sandbox network only allows a fixed allow-list of LLM providers and reset `api.kilo.ai`.

**Consequences:**
- We depend on E2B's API stability and free-tier credit availability.
- The default `base` template ships Node 20; the runner installs Node 22 at sandbox startup to match the bundled `undici`/`pi-agent-core` runtime.
- Per-turn snapshots for time-travel may be expensive or slow; we must measure and fall back if needed.

---

## D7. OpenAI-compatible LLM with provider fallback

**Decision:** The agent kernel talks to any OpenAI-compatible endpoint. The configuration supports a primary and a fallback provider.

**Rationale:** Avoids vendor lock-in and lets the project ride free-tier endpoints (Groq, OpenRouter, self-hosted vLLM/Ollama). Provider reliability is handled explicitly.

**Consequences:**
- We must normalize differences in context window, rate limits, and error behavior.
- Prompts and evals should be written to work across providers, not tuned to a single model.

---

## D8. Upstash Redis for real-time streaming

**Decision:** Use Upstash Redis free tier as the stream broker between sandboxes and the UI.

**Rationale:** Serverless Redis with a free tier and a simple REST API; works with both local and Cloudflare deployments.

**Consequences:**
- Free tier is 500K commands/month. Events are appended to per-task lists with batched `RPUSH` and a single `LTRIM` per flush, keeping the last 1000 events. This keeps command volume low enough for thousands of short runs per month.
- If the quota is exhausted, streaming degrades or stops; the 1000-event retention and SSE replay still let a late-joining UI catch up while the quota lasts.
- The implementation uses `@upstash/redis` inside the agent bundle and inside the control plane, so both local and Cloudflare deployments share the same client.

---

## D9. Supabase Postgres for session persistence

**Decision:** Use Supabase Postgres for `sessions`, `tasks`, `events`, `checkpoints`, installations, and task-queue state.

**Rationale:** Free-tier managed Postgres with a generous REST/Realtime API.

**Consequences:**
- 500MB limit requires retention/archival policy for old traces and events.
- We must be careful with row counts and payload sizes for streamed events.

---

## D10. Langfuse for OpenTelemetry traces

**Decision:** Emit OTel spans to Langfuse Cloud for prompt tracing, tool latency, and reasoning-tree visualization.

**Rationale:** Purpose-built for LLM observability, offers a free trace tier, and natively supports OTel ingestion.

**Consequences:**
- 50,000 free traces/month may require sampling or selective full tracing for large task volumes.
- Dashboard queries to Langfuse add a dependency; the UI must cache traces.

---

## D11. Time-travel strategy: prove before building

**Decision:** Time-travel is the headline feature, but it is deliberately de-risked through a Phase 0 feasibility spike before Phase 4 begins.

**Rationale:** The two primitives (Pi session serialization and E2B per-turn snapshots) are unproven. Committing to a full Phase 4 without proof risks a major pivot.

**Alternatives considered:**
- Build it as Phase 1: too risky; would block the MVP.
- Skip it: removes the project's primary differentiator.

**Consequences:**
- If Pi serialization is not available, we build a wrapper or use git-per-turn checkpoints.
- If E2B snapshots are too slow/expensive, we use a per-turn `git commit` strategy with a dependency cache.

---

## D12. Filesystem rewind: snapshots first, git fallback

**Decision:** Prefer E2B filesystem snapshots for rewinding, but retain a per-turn `git commit` + dependency-cache fallback.

**Rationale:** Snapshots are the cleanest conceptual match for time-travel, but cost and latency may make them impractical at turn granularity.

**Consequences:**
- Phase 0 measures snapshot latency/cost and decides the default for Phase 4.
- The agent runner must support both modes through a common checkpoint interface.

---

## D13. Evaluation harness as a first-class package

**Decision:** Create `packages/evals` in Phase 0 and run it in CI for every subsequent phase.

**Rationale:** An autonomous coding agent cannot be judged by unit tests alone. A repeatable benchmark measures regressions and guides model/provider choices.

**Consequences:**
- Extra upfront work in Phase 0.
- Every phase has an objective exit criterion beyond "it looks like it works."

---

## D14. Cost and quota budget as a deliverable

**Decision:** Produce a living `docs/COST_BUDGET.md` in Phase 0 and update it as the project evolves.

**Rationale:** The "$0 operating cost" claim is central to the project. It must be modeled, not asserted.

**Consequences:**
- We may need to throttle streaming, sample traces, or reduce snapshot frequency to stay inside free tiers.
- The budget becomes an input to design decisions (e.g., why we batch Redis commands).

---

## D15. GitHub App triggers instead of PAT for production

**Decision:** Phase 1 uses a Personal Access Token (PAT) for speed, but Phase 3 replaces it with a GitHub App using scoped 1-hour installation tokens.

**Rationale:** PATs are simpler for an MVP but are broad-lived credentials. Installation tokens are scoped to an org/repo and expire quickly, which matches the security model.

**Consequences:**
- The PR delivery path is implemented twice (PAT, then App), but the second implementation is a configuration swap.
- We must implement JWT signing and token exchange in the control plane.

---

## D16. Human approval gate for destructive actions

**Decision:** Pause the agent and require explicit approval before `git push`, `git push --force`, branch deletion, destructive `rm`, or PR open/merge.

**Rationale:** Trust and safety are critical for an autonomous agent that can modify source code and open public PRs.

**Consequences:**
- Adds UI surface area and webhook flow complexity.
- May slow down fully-autonomous demos, but can be configured per-task or per-installation.

---

## D17. Branch protection: never commit to `main`/`master`

**Decision:** The agent is hard-blocked from committing to `main`, `master`, or any protected branch by default. Every task creates a feature branch and the control plane opens a Pull Request for it.

**Rationale:** Prevents accidental or adversarial destruction of the default branch.

**Consequences:**
- The PR delivery path is the normal way to land code.
- A temporary `PROTECTED_BRANCHES=__none__` override was used during the first Phase 1 slice to enable direct `main` pushes while the sandbox flow was being proven. That override is removed now that the agent creates `daybreak/<task-id>` branches and the control plane opens PRs via the GitHub API.
- Some operations (e.g., automated releases) may need explicit out-of-scope handling.

---

## D18. Sensitive-file denylist and output redaction

**Decision:** Maintain a denylist of paths and patterns (`.env`, `*.pem`, `.ssh/*`, `.git/config`, `*secret*`, `*token*`) and redact potential secrets from tool output.

**Rationale:** Prevents the LLM or logs from seeing or leaking credentials.

**Consequences:**
- Denylist must be updated as new secret patterns are discovered.
- Redaction is defense-in-depth; it does not replace proper secret management.

---

## D19. Browser/Playwright tool in Phase 1

**Decision:** Integrate headless Chromium/Playwright inside the sandbox from Phase 1, not later.

**Rationale:** The README promises browser-based visual verification. Without it, the MVP cannot handle web-app tasks or visually confirm UI changes.

**Consequences:**
- Sandbox image grows and cold start may increase slightly.
- Screenshots must be streamed efficiently to the UI.

---

## D20. Task queue, idempotency, and retry (Phase 6, not MVP)

**Decision:** Use a simple in-memory/Single-process queue in Phase 1–3; introduce a durable queue with idempotency and retry only in Phase 6.

**Rationale:** A full queue system is not needed for a single-user local demo. It becomes essential once the GitHub App is public and multiple triggers can arrive concurrently.

**Consequences:**
- Early phases can lose or duplicate tasks under concurrent load, which is acceptable for local demos but not production.
- The control plane is designed with queue semantics from the start so the later migration is mechanical.

---

## D21. Phase ordering: observability before GitHub triggers

**Decision:** Build OTel/Langfuse observability (Phase 2) before exposing GitHub triggers (Phase 3).

**Rationale:** Debugging webhook-driven, multi-turn, remote-sandbox tasks is extremely hard without traces. Observability first makes Phase 3 development faster and safer.

---

## D22. Phase ordering: time-travel before CI self-healing

**Decision:** Build time-travel (Phase 4) before CI self-healing (Phase 5).

**Rationale:** Time-travel is the headline differentiator and is the harder vertical slice. CI self-healing is valuable but relies on Phase 3 webhook and PR machinery already in place.

**Consequences:**
- If the Phase 0 feasibility spike fails and time-travel is descoped, Phase 5 (CI self-healing) can still ship independently.

---

## D23. Secrets management strategy

**Decision:** No secrets in source code. Local development uses `.env` plus a team-managed secret manager (1Password/direnv). Cloud deployment uses Cloudflare Worker secrets and Supabase Vault. GitHub App private keys are Cloudflare/Worker secrets.

**Rationale:** Prevents secret leakage and supports rotation without code changes.

**Consequences:**
- `.env.example` is the only committed reference.
- Documentation must clearly describe how to provision each secret.

---

## D24. Multi-tenancy postponed to Phase 6

**Decision:** The MVP and GitHub trigger phases target a single installation/owner. Full multi-tenancy (per-org quotas, rate limits, isolation) is Phase 6.

**Rationale:** Multi-tenancy is complex and not needed for a working demo or a single-user GitHub App install.

**Consequences:**
- Phase 3 tables can assume one active installation; Phase 6 migrates to a tenant-aware schema.

---

## D25. Deny public untrusted repos without approval

**Decision:** Running against public repositories the user does not own/control requires an explicit approval gate and is out of scope for v1.0.

**Rationale:** Prevents abuse and accidental execution of arbitrary public code in our free-tier sandboxes.

---

## D26. Documentation as a deliverable

**Decision:** Every phase ends with updated documentation: `README.md`, `ROADMAP.md`, `decisions.md`, `docs/COST_BUDGET.md`, and eventually `DEPLOYMENT.md` and operator runbooks.

**Rationale:** The project is meant to demonstrate the engineering of autonomous coding agents. Documentation is part of the artifact.

---

## D27. No custom vector/RAG memory for v1.0

**Decision:** Do not build a custom long-term memory or RAG system. Use existing tools and Pi's context/compaction for memory.

**Rationale:** Scope control. The differentiators are time-travel, lineage, and free-tier operation, not a novel memory architecture.

---

## D28. Language/runtime support in sandbox image

**Decision:** Pre-install git, Node.js, pnpm, Python, and common build tools in the default E2B workspace image.

**Rationale:** Daybreak should handle common repo types out of the box. The Pi SDK is TypeScript, but target repos may be Python, JavaScript, etc.

**Consequences:**
- Image size grows; keep it lean and document extension for other languages (Go, Rust, Java) as needed.

---

## D29. CI for Daybreak itself

**Decision:** Run lint, typecheck, unit tests, and the eval harness on every push.

**Rationale:** A project that ships fixes to other repos must be reliable itself. The eval harness is the closest thing to a self-test of the agent.

---

## D30. Open questions that can change these decisions

- Can `pi-agent-core` serialize and fork sessions cleanly?
- What is the real cost and latency of per-turn E2B snapshots?
- Which free LLM provider gives the best coding-task success rate within its rate limits?
- Will Cloudflare Workers free tier support the expected webhook and Durable Object load?
- How do we prevent prompt-injection or sandbox-escape attacks from malicious repositories?

These questions should be answered by the Phase 0 feasibility spikes and eval harness.
