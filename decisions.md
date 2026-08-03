# Decisions — Daybreak

**A living log of the architectural, product, and sequencing decisions behind the Daybreak roadmap.**

> **Status:** Updated through Phase 5.  
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
- For the browser/Playwright tool, the `base` template's ~418 MiB memory limit caused Chromium's V8 renderer to OOM. A custom `daybreak-browser` E2B template with 2 vCPU / 1536 MB RAM, Node 22, Chromium, and `playwright-core` is built once and used by `sandbox.ts --template=daybreak-browser` or `E2B_TEMPLATE=daybreak-browser`.
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
- The Phase 1 schema adds `tasks` (task metadata and PR URL), `events` (per-task event stream), `sessions` (Pi state reference), and `checkpoints` (turn/snapshot references for time-travel). The control plane persists every event it reads from the Redis stream and serves `GET /api/tasks/:id/events` from Postgres.

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

## D15. GitHub App triggers instead of PAT for production (deferred)

**Decision:** Phase 1 uses a Personal Access Token (PAT) for speed. Phase 3 continues to use a PAT with manually configured repo webhooks. The GitHub App migration — with scoped 1-hour installation tokens — is deferred to Phase 7 (Cloudflare deployment).

**Rationale:** A GitHub App is the cleaner long-term solution, but it requires a public webhook endpoint, App registration, private-key management, and JWT token exchange. Until the control plane is hosted on Cloudflare, the local control plane can receive repo webhooks via `cloudflared`/`ngrok` and use an existing PAT. This lets Phase 3 ship the trigger/review-loop behavior earlier.

**Consequences:**
- The PR delivery path in Phase 3 uses the PAT (`GITHUB_TOKEN`).
- A later Phase 7 migration will add JWT signing, installation-token exchange, and per-installation multi-tenancy.
- See D36 for the Phase 3 PAT-only workarounds and the full deferred-item list.

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
- Sandbox image grows and cold start may increase slightly. To avoid installing Chromium at runtime, a custom `daybreak-browser` E2B template is built with Node 22, Chromium, and `playwright-core` pre-installed.
- The `base` template's 512 MB memory limit was too small for Chromium's V8 renderer; the `daybreak-browser` template is provisioned with 1536 MB RAM.
- Screenshots are emitted as `browser_screenshot` events and streamed to the UI over the existing Upstash Redis/SSE channel.

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

## D31. Context compaction and circuit breakers in Phase 1

**Decision:** Wire Pi's built-in context compaction into `session.ts` from Phase 1, controlled by `COMPACTION_ENABLED`, `COMPACTION_RESERVE_TOKENS`, and `COMPACTION_KEEP_RECENT_TOKENS` environment variables. The existing `MAX_TURNS`, `MAX_WALL_CLOCK_MINUTES`, and `MAX_COST_USD` circuit breakers continue to abort the task when exceeded.

**Rationale:** Long agent runs on non-trivial repos will exceed the context window. Relying on the Pi SDK's compaction keeps the implementation aligned with the kernel and avoids building a custom summarizer. The circuit breakers prevent runaway cost or time.

**Consequences:**
- Compaction events (`compaction_start`/`compaction_end`) are emitted to the stream and persisted, so the dashboard can show when context was summarized.
- Compaction consumes extra LLM tokens/cost (a summarization call), so `MAX_COST_USD` must be set high enough to allow it.
- Tuning `reserveTokens`/`keepRecentTokens` is model- and task-dependent; the defaults (4000/8000) are conservative for small-context models.

---

## D32. E2E eval harness against the control-plane + E2B pipeline

**Decision:** Run the Phase 0 eval harness end-to-end through the real control plane and E2B sandbox (`packages/evals/src/e2e.ts`) rather than only through the local `TaskRunner`.

**Rationale:** Local `TaskRunner` evals prove agent logic but do not exercise sandbox provisioning, git push, GitHub PR creation, Upstream Redis streaming, or Supabase persistence. The E2E harness gives the true MVP exit-criteria signal.

**Consequences:**
- The E2E harness triggers `POST /api/tasks`, polls for completion, reads stream events, and records wall-clock, turns, tool calls, token count, cost, and the PR URL.
- Each run creates a real PR on the target repo (`bezaspace/daybreak-target`), so evals need an isolated fixture or a dedicated eval target repo.
- The local `TaskRunner` mode is retained for fast iteration and debugging agent behavior without E2B spend.

---

## D33. Pre-checkout feature branch and denylist `bash` sensitive paths

**Decision:** `run-task.ts` now creates the `daybreak/<task-id>` feature branch and sets the bot git identity before the Pi agent runs. `SafetyMiddleware` parses `bash` command tokens and blocks any command that references a sensitive path matching the denylist (e.g., `cat .env`).

**Rationale:** The LLM occasionally issues `git push origin main` or `cat .env` despite prompt instructions. Enforcing branch and denylist at the tool level makes the guardrail independent of prompt compliance.

**Consequences:**
- The sandbox workspace is always on the feature branch, so `git push` without an explicit branch argument pushes the feature branch.
- `.env`, `.env.*`, `*.pem`, `.ssh/**`, `.git/config`, and other denylist paths are blocked whether the agent uses the `read` tool or a `bash` command.

## D34. Dashboard exit-criteria presets

**Decision:** The React dashboard exposes two preset buttons: "Fix failing-sum test" (runs the `bezaspace/daybreak-target` fixture with default circuit breakers) and "Demo MAX_TURNS=3" (overrides `maxTurns` to demonstrate the circuit breaker).

**Rationale:** A one-click demo makes the Phase 1 exit criteria repeatable and easy to verify without manually filling the repo/branch form.

**Consequences:**
- Presets set `repo` and `branch` and call `POST /api/tasks` with optional per-task `maxTurns`/`maxCostUsd`/`maxWallClockMinutes` overrides.
- The UI shows live metrics and a circuit-breaker banner above the terminal.

## D35. Target fixture repo with CI and a decoy `.env`

**Decision:** The `bezaspace/daybreak-target` scratch repo contains a `.github/workflows/test.yml` that runs `npm test` on every PR and a decoy `.env` file. The workflow is intentionally simple so the agent-created PR gets an immediate green check.

**Rationale:** The exit criteria require a PR that passes CI and a verified denylist. A small Node test fixture with a known one-line bug keeps the demo fast and deterministic.

**Consequences:**
- The decoy `.env` is not a real secret; it exists only to prove the agent never reads it.
- CI must be kept minimal (`node --test`) so it passes quickly after the agent fixes `sum.js`.

## D36. Phase 3 PAT-only authentication and deferred GitHub App work

**Decision:** Phase 3 uses a Personal Access Token (PAT) for GitHub API and git authentication. GitHub App registration, JWT signing, 1-hour installation tokens, and per-installation multi-tenancy are deferred to Phase 7 (Cloudflare deployment).

**Rationale:** A GitHub App is the cleaner long-term solution, but it requires a public webhook endpoint, App registration, private-key management, and JWT token exchange. Until the control plane is hosted on Cloudflare, the local control plane can receive repo webhooks via `cloudflared`/`ngrok` and use an existing PAT. This lets Phase 3 ship the trigger/review-loop behavior earlier.

**Phase 3 workarounds:**
- **Tokens:** `GITHUB_TOKEN` (PAT) is passed to the sandbox and used for `createPullRequest` and `git push`. It must have `contents:write` and `pull_requests:write` on the target repos.
- **Webhooks:** Events are delivered through manually configured repository (or organization) webhooks pointing at the local tunnel URL. The `GITHUB_WEBHOOK_SECRET` is used to verify `X-Hub-Signature-256`.
- **Repo trust:** A repo allowlist (`GITHUB_WEBHOOK_REPO_ALLOWLIST`) prevents the agent from running on untrusted public repos. This replaces the per-installation scoping a GitHub App would provide.
- **Multi-tenancy:** Per-sender (`sender.login`) or per-repo rate limits are used instead of per-installation rate limits. The `installations` table and `installation_id` foreign key are deferred.
- **Bot identity:** The `@daybreak-bot` mention is detected as a string in `comment.body`. The PAT owner account will be the author of commits and PRs; a separate bot user account can be used by providing its PAT.
- **CI self-healing stub:** `check_run` webhooks are acknowledged in Phase 3 but not acted on. Full CI self-healing (Phase 5) will be wired once the GitHub App path is in place.

**Deferred to Phase 7 / GitHub App migration:**
- Register a GitHub App with least-privilege permissions (`contents:write`, `pull_requests:write`, `issues:read`, `checks:read`, `metadata:read`).
- Implement JWT signing and `POST /app/installations/{id}/access_tokens` exchange for 1-hour installation tokens.
- Replace `GITHUB_TOKEN` with installation tokens in `createPullRequest` and sandbox git auth.
- Add per-installation multi-tenancy (`installations` table, `tasks.installation_id`, per-installation rate limits).
- Auto-subscribe to events on App install rather than manually configuring repo webhooks.

**Consequences:**
- A PAT is long-lived and broader in scope than an installation token; it must be kept out of source control and out of logs.
- Webhook setup is manual per repo until the App is available.
- The multi-tenancy and trust model is coarser (repo/sender based) in Phase 3.

---

## D37. Phase 4 time-travel checkpoint strategy

**Decision:** Use per-turn (or per-tool) git commits as the default filesystem checkpoint mechanism. Pi session state is serialized to a turn-specific JSONL snapshot and reloaded via `SessionManager.open`. Cross-sandbox forks default to a fresh E2B sandbox checking out the checkpoint commit and re-installing dependencies (`git-reinstall` strategy); E2B snapshots are supported but must be benchmarked before being enabled as the default.

**Rationale:** Git commits are nearly free, deterministic, and avoid expensive per-turn E2B snapshots. Pi session serialization was proven in the Phase 0 spike: `SessionManager` writes a `.jsonl` file that can be copied and reopened by a new `SessionManager` instance, preserving context. E2B snapshots are slower to create and less resource-efficient than the pre-built `daybreak-browser` template, so they are the fallback, not the default.

**Consequences:**
- Every agent turn (or tool call, when `DAYBREAK_CHECKPOINT_INTERVAL=tool`) creates a `git commit` and lightweight tag plus a JSONL snapshot.
- Rewind checks out the checkpoint commit, restores the JSONL into the active session directory, and resumes `TaskRunner` from that turn.
- Forks spawn a new sandbox, clone the repo, checkout the checkpoint commit, re-install dependencies from the lockfile, and restore the JSONL snapshot.
- `DAYBREAK_FORK_STRATEGY=snapshot` can bypass re-install when the benchmark justifies the snapshot cost.

---

## D38. CI self-healing failure context (Phase 5 M2)

**Decision:** Build a dedicated `packages/control-plane/src/ci-logs.ts` module that fetches structured `check_run` annotations first, then downloads the raw job logs via `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`, truncates from the end to a configurable byte budget, strips timestamps / ANSI control codes / GitHub group markers, extracts a configurable window of context around each failure block, and redacts secrets before the text reaches the agent prompt.

**Rationale:** Annotations provide precise failure locations (path and line number), while raw logs contain the actual error output and stack traces. The `check_run.id` GitHub exposes is the Actions job id, so the `actions/jobs/{job_id}/logs` endpoint is the correct primary source. Truncating from the end of the log preserves the most recent failure output, which is usually where the actionable information lives. Secret redaction is defense-in-depth against leaking repository or cloud credentials into the LLM context.

**Consequences:**
- `CiLogFetcher` fetches `check-runs/{id}/annotations` and `actions/jobs/{id}/logs`, following the 302 redirect and respecting `DAYBREAK_MAX_CI_LOG_BYTES` (default 512 KiB).
- `CiLogParser` cleans the log and extracts failure blocks using markers such as `FAIL`, `Error:`, `npm ERR!`, `Tests: ... failed`, and `AssertionError`, keeping `DAYBREAK_CI_LOG_CONTEXT_LINES` (default 20) on each side.
- `redactSecrets` removes `token=...`, `api_key=...`, `SECRET=...`, bearer tokens, URL credentials, and query-string credentials without mangling surrounding text.
- This module is consumed by the heal-task builder in M3 and is unit-tested against a 100 KB mocked log fixture.

---

## D39. Phase 5 CI self-healing final design

**Decision:** Implement CI self-healing as a `check_run` webhook handler (not `check_suite`) in the control plane. The handler reuses the existing `REVIEW_MODE` branch-iteration path in `packages/agent-runner/src/run-task.ts` by passing `HEAL_MODE=true`, so the agent pushes a follow-up commit to the existing PR branch rather than opening a new PR. Failed-job context is built from `check-runs/{id}/annotations` first, then `actions/jobs/{job_id}/logs` (because `check_run.id` is the Actions job id), truncated from the end, cleaned, and redacted before being injected into the prompt. Only Daybreak PRs (`daybreak/` prefix or a matching `pr_branch` in `tasks`) are healed; `main`/`master`/`protectedBranches` are refused. Duplicate `check_run.id` values are deduplicated via a 24-hour Redis key, and a per-PR max-attempt counter plus a same-commit cooldown guard prevent infinite self-heal loops.

**Rationale:** `check_run` is the granular unit GitHub uses for Actions status, and it carries the `check_run.id` that maps directly to the `actions/jobs/{job_id}/logs` endpoint. Annotations provide path/line-level failure metadata, while raw logs contain the actual stack trace and error output. Reusing the review/commit path keeps the implementation small and consistent with Phase 3/4 branch iteration. Branch-prefix and known-task guards prevent the agent from healing arbitrary or protected branches. The 24-hour dedupe and max-attempt circuit breakers are the minimum viable safety net for an autonomous fix-and-push loop.

**Consequences:**
- `packages/control-plane/src/server.ts` has a `check_run` webhook case, `CiLogFetcher`/`CiLogParser` helpers, `runHeal`, and a guard chain (duplicate `checkRunId`, in-flight task, 24-hour attempt budget, same-commit cooldown, branch safety).
- `packages/agent-runner/src/run-task.ts` and `sandbox.ts` treat `HEAL_MODE=true` like `REVIEW_MODE` for branch iteration and emit `heal_task_start`/`heal_complete`/`heal_failed`/`heal_skipped` events.
- `packages/control-plane/src/server.test.ts` covers the webhook handler, log parser, and circuit breakers.
- `packages/evals/src/ci-self-heal.ts` provides a real end-to-end harness (create a broken PR, wait for CI failure, send webhook, wait for heal) and a fast local integration mode that runs the control-plane `check_run` tests.
- `docs/COST_BUDGET.md` and `docs/SECRETS.md` are updated to reflect the extra per-heal sandbox/LLM cost and the `actions:read`/`checks:read` PAT requirements.

---

## D30. Open questions that can change these decisions

- ~~Can `pi-agent-core` serialize and fork sessions cleanly?~~ **Answered in Phase 4 M1/M3:** `SessionManager` writes a `.jsonl` that can be copied and reopened with `SessionManager.open`; true in-process forking is not required because we always start a fresh `TaskRunner` from the restored state.
- ~~What is the real cost and latency of per-turn E2B snapshots?~~ **Answered in Phase 4 M4:** snapshots are supported but more expensive/slower than `git-reinstall` with the `daybreak-browser` template, so `git-reinstall` is the default.
- Which free LLM provider gives the best coding-task success rate within its rate limits?
- Will Cloudflare Workers free tier support the expected webhook and Durable Object load?
- How do we prevent prompt-injection or sandbox-escape attacks from malicious repositories?

These questions should be answered by the Phase 0 feasibility spikes and eval harness.
