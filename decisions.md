# Decisions — Daybreak

**A living log of the architectural, product, and sequencing decisions behind the Daybreak project.**

> **Status:** Updated through Phase 6 (complete). Phase 7 is the remaining work.  
> **Started:** 2026-08-01

---

## D1. Project scope and purpose

**Decision:** Daybreak is a learning/demonstration project, not a commercial product. It replicates the cloud coding-agent class of system (Devin, Cursor) and adds two novel public features: full OpenTelemetry lineage and time-travel state branching, all on free-tier infrastructure.

**Rationale:** The product category is crowded. The value is in the *combination* of features and the *transparency thesis*, not in trying to ship a new closed-source competitor.

**Consequences:**
- No billing, multi-tenant SaaS, or enterprise sales features.
- Optimize for clarity, observability, and demoability over market-fit velocity.

---

## D2. Agent kernel: Pi SDK (`pi-coding-agent` / `pi-agent-core`)

**Decision:** Build the agent runner on top of the Pi SDK (`@earendil-works/pi-agent-core`, currently `0.83.0`), wrapped by `@earendil-works/pi-coding-agent`.

**Rationale:** Pi ships with the built-in `read`/`bash`/`edit`/`write` tools, `AgentSession`, and tree-structured session management. It is open-source and matches the TypeScript/Node control-plane stack.

**Alternatives considered:**
- LangChain/LangGraph: heavier and more opinionated.
- A from-scratch agent loop: too much boilerplate and risk.

**Consequences:**
- We are tied to Pi's tool-registration and session APIs.
- The time-travel feature depends on whether Pi sessions can be serialized/forked. `SessionManager` JSONL files are portable across Node processes, so we serialize the session and reload it rather than trying to snapshot a running `Agent` object.

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
- No Node-only modules (`fs`, `child_process`, `http` server) in core control-plane logic.
- Long-running tasks must not live inside a Worker invocation; they are offloaded to E2B sandboxes and triggered via durable queues.

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

**Rationale:** E2B sandboxes have unrestricted outbound internet by default, which is required for arbitrary OpenAI-compatible providers. They support full Linux command execution, filesystem operations, git, snapshots, and a free Hobby tier with $100 in one-time credits.

**Consequences:**
- We depend on E2B's API stability and free-tier credit availability.
- The default `base` template ships Node 20; the runner installs Node 22 at sandbox startup.
- For the browser/Playwright tool, the `base` template's ~418 MiB memory limit caused Chromium's V8 renderer to OOM. A custom `daybreak-browser` E2B template with 2 vCPU / 1536 MB RAM, Node 22, Chromium, and `playwright-core` is built once and used by `sandbox.ts --template=daybreak-browser` or `E2B_TEMPLATE=daybreak-browser`.
- Per-turn snapshots for time-travel may be expensive or slow; we measured and fell back to git-based checkpoints with optional E2B snapshots for forks.

---

## D7. OpenAI-compatible LLM with provider fallback

**Decision:** The agent kernel talks to any OpenAI-compatible endpoint. The configuration supports a primary and a fallback provider.

**Rationale:** Avoids vendor lock-in and lets the project ride free-tier endpoints (Groq, OpenRouter, self-hosted vLLM/Ollama). Provider reliability is handled explicitly.

**Consequences:**
- We normalize differences in context window, rate limits, and error behavior through config.
- Prompts and evals are written to work across providers, not tuned to a single model.
- The control-plane can fail-fast to the fallback after `DAYBREAK_PROVIDER_FAILURE_THRESHOLD` consecutive retryable errors.

---

## D8. Upstash Redis for real-time streaming

**Decision:** Use Upstash Redis free tier as the stream broker between sandboxes and the UI.

**Rationale:** Serverless Redis with a free tier and a simple REST API; works with both local and Cloudflare deployments.

**Consequences:**
- Free tier is 500K commands/month. Events are appended to per-task lists with batched `RPUSH` and a single `LTRIM` per flush, keeping the last 1000 events.
- If the quota is exhausted, streaming degrades or stops; the 1000-event retention and SSE replay still let a late-joining UI catch up while the quota lasts.
- Both the agent runner and the control plane use `@upstash/redis`.

---

## D9. Supabase Postgres for session persistence

**Decision:** Use Supabase Postgres for `tasks`, `events`, `messages`, `checkpoints`, `session_snapshots`, tenant, and queue state.

**Rationale:** Free-tier managed Postgres with a generous REST/Realtime API.

**Consequences:**
- 500MB limit requires retention/archival policy for old events.
- We must be careful with row counts and payload sizes for streamed events.
- The control plane persists every event it reads from the Redis stream and serves `GET /api/tasks/:id/events` from Postgres.

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
- Phase 0 measured snapshot latency/cost and decided the default for Phase 4.
- The agent runner supports both modes through a common checkpoint interface.
- See D37 for the final default (`git-reinstall`) and optional snapshot strategy.

---

## D13. Evaluation harness as a first-class package

**Decision:** Create `packages/evals` in Phase 0 and run it in CI for every subsequent phase.

**Rationale:** An autonomous coding agent cannot be judged by unit tests alone. A repeatable benchmark measures regressions and guides model/provider choices.

**Consequences:**
- Extra upfront work in Phase 0.
- Every phase has an objective exit criterion beyond "it looks like it works."

---

## D14. Cost and quota budget as a deliverable

**Decision:** Produce a living cost/quotabudget model in Phase 0 and update it as the project evolves.

**Rationale:** The "$0 operating cost" claim is central to the project. It must be modeled, not asserted.

**Consequences:**
- We may need to throttle streaming, sample traces, or reduce snapshot frequency to stay inside free tiers.
- The budget becomes an input to design decisions (e.g., why we batch Redis commands).
- The budget summary lives in `roadmap.md` Appendix A.

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
- May slow down fully-autonomous demos, but can be configured per-task or per-installation (`requireApprovalForDestructive`).

---

## D17. Branch protection: never commit to `main`/`master`

**Decision:** The agent is hard-blocked from committing to `main`, `master`, or any protected branch by default. Every task creates a feature branch and the control plane opens a Pull Request for it.

**Rationale:** Prevents accidental or adversarial destruction of the default branch.

**Consequences:**
- The PR delivery path is the normal way to land code.
- A temporary `PROTECTED_BRANCHES=__none__` override was used during the first Phase 1 slice but has been removed.

---

## D18. Sensitive-file denylist and output redaction

**Decision:** Maintain a denylist of paths and patterns (`.env`, `*.pem`, `.ssh/*`, `.git/config`, `*secret*`, `*token*`) and redact potential secrets from tool output.

**Rationale:** Prevents the LLM or logs from seeing or leaking credentials.

**Consequences:**
- Denylist must be updated as new secret patterns are discovered.
- Redaction is defense-in-depth; it does not replace proper secret management.
- See `roadmap.md` Appendix B for the Phase 6 security audit findings.

---

## D19. Browser/Playwright tool in Phase 1

**Decision:** Integrate headless Chromium/Playwright inside the sandbox from Phase 1, not later.

**Rationale:** The project promises browser-based visual verification. Without it, the MVP cannot handle web-app tasks or visually confirm UI changes.

**Consequences:**
- Sandbox image grows and cold start may increase slightly. To avoid installing Chromium at runtime, a custom `daybreak-browser` E2B template is built with Node 22, Chromium, and `playwright-core` pre-installed.
- The `base` template's 512 MB memory limit was too small for Chromium's V8 renderer; the `daybreak-browser` template is provisioned with 1536 MB RAM.
- Screenshots are emitted as `browser_screenshot` events and streamed to the UI.

---

## D20. Task queue, idempotency, and retry in Phase 6

**Decision:** Use a simple in-memory/single-process queue in Phase 1–3; introduce a durable queue with idempotency and retry in Phase 6.

**Rationale:** A full queue system is not needed for a single-user local demo. It becomes essential once the GitHub webhook surface is public and multiple triggers can arrive concurrently.

**Consequences:**
- Early phases could lose or duplicate tasks under concurrent load, which was acceptable for local demos but not production.
- The control plane was designed with queue semantics from the start so the later migration is mechanical.
- Phase 6 ships `TaskQueue`, `IdempotencyStore`, `RetryScheduler`, and `CleanupService` in `packages/control-plane/src`.

---

## D21. Phase ordering: observability before GitHub triggers

**Decision:** Build OTel/Langfuse observability (Phase 2) before exposing GitHub triggers (Phase 3).

**Rationale:** Debugging webhook-driven, multi-turn, remote-sandbox tasks is extremely hard without traces. Observability first makes Phase 3 development faster and safer.

---

## D22. Phase ordering: time-travel before CI self-healing

**Decision:** Build time-travel (Phase 4) before CI self-healing (Phase 5).

**Rationale:** Time-travel is the headline differentiator and is the harder vertical slice. CI self-healing is valuable but relies on Phase 3 webhook and PR machinery already in place.

**Consequences:**
- If the Phase 0 feasibility spike had failed and time-travel was descoped, Phase 5 (CI self-healing) could still ship independently.

---

## D23. Secrets management strategy

**Decision:** No secrets in source code. Local development uses `.env` plus a team-managed secret manager. Cloud deployment uses Cloudflare Worker secrets and Supabase Vault. GitHub App private keys are Cloudflare/Worker secrets.

**Rationale:** Prevents secret leakage and supports rotation without code changes.

**Consequences:**
- `.env.example` is the only committed reference.
- The full environment variable and secret inventory is in the **Environment & Secrets Reference** appendix of this document.

---

## D24. Multi-tenancy postponed to Phase 6

**Decision:** The MVP and GitHub trigger phases target a single installation/owner. Full multi-tenancy (per-org quotas, rate limits, isolation) is Phase 6.

**Rationale:** Multi-tenancy is complex and not needed for a working demo or a single-user GitHub App install.

**Consequences:**
- Phase 3 tables assumed one active installation; Phase 6 migrates to a tenant-aware schema (`TenantService`).

---

## D25. Deny public untrusted repos without approval

**Decision:** Running against public repositories the user does not own/control requires an explicit approval gate and is out of scope for v1.0.

**Rationale:** Prevents abuse and accidental execution of arbitrary public code in our free-tier sandboxes.

---

## D26. Documentation as a deliverable

**Decision:** Every phase ends with updated documentation. The canonical project documents are `roadmap.md` (plan, status, budget, security findings) and `decisions.md` (decisions, environment reference).

**Rationale:** The project is meant to demonstrate the engineering of autonomous coding agents. Documentation is part of the artifact.

**Consequences:**
- All other planning/spec docs are merged into these two files or removed when superseded.

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

**Decision:** Wire Pi's built-in context compaction into `packages/agent-runner/src/session.ts` from Phase 1, controlled by `COMPACTION_ENABLED`, `COMPACTION_RESERVE_TOKENS`, and `COMPACTION_KEEP_RECENT_TOKENS` environment variables. The existing `MAX_TURNS`, `MAX_WALL_CLOCK_MINUTES`, and `MAX_COST_USD` circuit breakers continue to abort the task when exceeded.

**Rationale:** Long agent runs on non-trivial repos will exceed the context window. Relying on the Pi SDK's compaction keeps the implementation aligned with the kernel and avoids building a custom summarizer. The circuit breakers prevent runaway cost or time.

**Consequences:**
- Compaction events (`compaction_start`/`compaction_end`) are emitted to the stream and persisted.
- Compaction consumes extra LLM tokens/cost, so `MAX_COST_USD` must be set high enough to allow it.
- Tuning `reserveTokens`/`keepRecentTokens` is model- and task-dependent; the defaults (4000/8000) are conservative for small-context models.

---

## D32. E2E eval harness against the control-plane + E2B pipeline

**Decision:** Run the Phase 0 eval harness end-to-end through the real control plane and E2B sandbox (`packages/evals/src/e2e.ts`) rather than only through the local `TaskRunner`.

**Rationale:** Local `TaskRunner` evals prove agent logic but do not exercise sandbox provisioning, git push, GitHub PR creation, Upstash Redis streaming, or Supabase persistence. The E2E harness gives the true MVP exit-criteria signal.

**Consequences:**
- The E2E harness triggers `POST /api/tasks`, polls for completion, reads stream events, and records wall-clock, turns, tool calls, token count, cost, and the PR URL.
- Each run creates a real PR on the target repo (`bezaspace/daybreak-target`), so evals need an isolated fixture or a dedicated eval target repo.
- The local `TaskRunner` mode is retained for fast iteration and debugging agent behavior without E2B spend.

---

## D33. Pre-checkout feature branch and denylist `bash` sensitive paths

**Decision:** `packages/agent-runner/src/run-task.ts` creates the `daybreak/<task-id>` feature branch and sets the bot git identity before the Pi agent runs. `SafetyMiddleware` parses `bash` command tokens and blocks any command that references a sensitive path matching the denylist (e.g., `cat .env`).

**Rationale:** The LLM occasionally issues `git push origin main` or `cat .env` despite prompt instructions. Enforcing branch and denylist at the tool level makes the guardrail independent of prompt compliance.

**Consequences:**
- The sandbox workspace is always on the feature branch, so `git push` without an explicit branch argument pushes the feature branch.
- `.env`, `.env.*`, `*.pem`, `.ssh/**`, `.git/config`, and other denylist paths are blocked whether the agent uses the `read` tool or a `bash` command.

---

## D34. Dashboard exit-criteria presets

**Decision:** The React dashboard exposes preset triggers for common demos, e.g., "Fix failing-sum test" and a "Demo MAX_TURNS=3" override, that call `POST /api/tasks` with the appropriate repo/branch and limits.

**Rationale:** A one-click demo makes the Phase 1 exit criteria repeatable and easy to verify without manually filling the repo/branch form.

**Consequences:**
- Presets set `repo` and `branch` and call `POST /api/tasks` with optional per-task `maxTurns`/`maxCostUsd`/`maxWallClockMinutes` overrides.
- The UI shows live metrics and a circuit-breaker banner above the terminal.

---

## D35. Target fixture repo with CI and a decoy `.env`

**Decision:** The `bezaspace/daybreak-target` scratch repo contains a `.github/workflows/test.yml` that runs `npm test` on every PR and a decoy `.env` file. The workflow is intentionally simple so the agent-created PR gets an immediate green check.

**Rationale:** The exit criteria require a PR that passes CI and a verified denylist. A small Node test fixture with a known bug keeps the demo fast and deterministic.

**Consequences:**
- The decoy `.env` is not a real secret; it exists only to prove the agent never reads it.
- CI must be kept minimal (`node --test`) so it passes quickly after the agent fixes the fixture.

---

## D36. Phase 3 PAT-only authentication and deferred GitHub App work

**Decision:** Phase 3 uses a Personal Access Token (PAT) for GitHub API and git authentication. GitHub App registration, JWT signing, 1-hour installation tokens, and per-installation multi-tenancy are deferred to Phase 7 (Cloudflare deployment).

**Rationale:** A GitHub App is the cleaner long-term solution, but it requires a public webhook endpoint, App registration, private-key management, and JWT token exchange. Until the control plane is hosted on Cloudflare, the local control plane can receive repo webhooks via `cloudflared`/`ngrok` and use an existing PAT. This lets Phase 3 ship the trigger/review-loop behavior earlier.

**Phase 3 workarounds:**
- **Tokens:** `GITHUB_TOKEN` (PAT) is passed to the sandbox and used for `createPullRequest` and `git push`. It must have `contents:write` and `pull_requests:write` on the target repos.
- **Webhooks:** Events are delivered through manually configured repository (or organization) webhooks pointing at the local tunnel URL. The `GITHUB_WEBHOOK_SECRET` is used to verify `X-Hub-Signature-256`.
- **Repo trust:** A repo allowlist (`GITHUB_WEBHOOK_REPO_ALLOWLIST`) prevents the agent from running on untrusted public repos. This replaces the per-installation scoping a GitHub App would provide.
- **Multi-tenancy:** Per-sender (`sender.login`) or per-repo rate limits are used instead of per-installation rate limits. The `installations` table and `installation_id` foreign key are deferred.
- **Bot identity:** The `@daybreak-bot` mention is detected as a string in `comment.body`. The PAT owner account will be the author of commits and PRs; a separate bot user account can be used by providing its PAT.
- **CI self-healing:** `check_run` webhooks are fully implemented in Phase 5, not merely acknowledged.

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

**Implementation notes:**
- `SessionManager` stores messages and tool-call entries in an append-only JSONL tree with `id`/`parentId` links. Restored sessions must use the same `ModelRuntime` and model id because provider cache keys are tied to the runtime config.
- The `Agent` object itself cannot be serialized; a fresh `AgentSession` is created and its `state.messages` is seeded from the session tree.
- Restores are only safe at an idle leaf (between turns), not mid-tool-call.
- Per-turn E2B snapshots were measured in `packages/agent-runner/src/spikes/snapshot-benchmark.ts` and found to be slower and more expensive than the git + re-install path for routine branching.

---

## D38. CI self-healing failure context (Phase 5 M2)

**Decision:** Build a dedicated `packages/control-plane/src/ci-logs.ts` module that fetches structured `check_run` annotations first, then downloads the raw job logs via `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`, truncates from the end to a configurable byte budget, strips timestamps / ANSI control codes / GitHub group markers, extracts a configurable window of context around each failure block, and redacts secrets before the text reaches the agent prompt.

**Rationale:** Annotations provide precise failure locations (path and line number), while raw logs contain the actual error output and stack traces. The `check_run.id` GitHub exposes is the Actions job id, so the `actions/jobs/{job_id}/logs` endpoint is the correct primary source. Truncating from the end of the log preserves the most recent failure output, which is usually where the actionable information lives. Secret redaction is defense-in-depth against leaking repository or cloud credentials into the LLM context.

**Consequences:**
- `CiLogFetcher` fetches `check-runs/{id}/annotations` and `actions/jobs/{id}/logs`, following the 302 redirect and respecting `DAYBREAK_MAX_CI_LOG_BYTES` (default 512 KiB).
- `CiLogParser` cleans the log and extracts failure blocks using markers such as `FAIL`, `Error:`, `npm ERR!`, `Tests: ... failed`, and `AssertionError`, keeping `DAYBREAK_CI_LOG_CONTEXT_LINES` (default 20) on each side.
- `redactSecrets` removes `token=...`, `api_key=...`, `SECRET=...`, bearer tokens, URL credentials, and query-string credentials without mangling surrounding text.
- This module is consumed by the heal-task builder and is unit-tested against a mocked log fixture.

---

## D39. Phase 5 CI self-healing final design

**Decision:** Implement CI self-healing as a `check_run` webhook handler (not `check_suite`) in the control plane. The handler reuses the existing `REVIEW_MODE` branch-iteration path in `packages/agent-runner/src/run-task.ts` by passing `HEAL_MODE=true`, so the agent pushes a follow-up commit to the existing PR branch rather than opening a new PR. Failed-job context is built from `check-runs/{id}/annotations` first, then `actions/jobs/{job_id}/logs` (because `check_run.id` is the Actions job id), truncated from the end, cleaned, and redacted before being injected into the prompt. Only Daybreak PRs (`daybreak/` prefix or a matching `pr_branch` in `tasks`) are healed; `main`/`master`/`protectedBranches` are refused. Duplicate `check_run.id` values are deduplicated via a 24-hour Redis key, and a per-PR max-attempt counter plus a same-commit cooldown guard prevent infinite self-heal loops.

**Rationale:** `check_run` is the granular unit GitHub uses for Actions status, and it carries the `check_run.id` that maps directly to the `actions/jobs/{job_id}/logs` endpoint. Annotations provide path/line-level failure metadata, while raw logs contain the actual stack trace and error output. Reusing the review/commit path keeps the implementation small and consistent with Phase 3/4 branch iteration. Branch-prefix and known-task guards prevent the agent from healing arbitrary or protected branches. The 24-hour dedupe and max-attempt circuit breakers are the minimum viable safety net for an autonomous fix-and-push loop.

**Consequences:**
- `packages/control-plane/src/server.ts` has a `check_run` webhook case, `CiLogFetcher`/`CiLogParser` helpers, and a guard chain (duplicate `checkRunId`, in-flight task, 24-hour attempt budget, same-commit cooldown, branch safety).
- `packages/agent-runner/src/run-task.ts` and `sandbox.ts` treat `HEAL_MODE=true` like `REVIEW_MODE` for branch iteration and emit `heal_task_start`/`heal_complete`/`heal_failed`/`heal_skipped` events.
- `packages/control-plane/src/server.test.ts` covers the webhook handler, log parser, and circuit breakers.
- `packages/evals/src/ci-self-heal.ts` provides a real end-to-end harness and a fast local integration mode.

---

## D40. Cleanup, retention, and idle-sandbox termination (Phase 6 M7)

**Decision:** Stale `daybreak/<uuid>` PR branches, expired E2B sandboxes, and old `session_snapshots`/`checkpoints` are cleaned up automatically by a `CleanupService` in the control plane. The service supports `dryRun`, records every run in a `cleanup_runs` audit table, and can be triggered via `POST /api/cleanup` or a dashboard button. In local mode an optional `setInterval` runs the cleanup loop; Phase 7 will replace this with Cloudflare scheduled Workers.

**Rationale:** Daybreak creates many ephemeral branches and sandboxes. Without cleanup, target repos accumulate stale branches and E2B runtime spend continues after tasks finish. Automated cleanup with TTLs and audit logging keeps the project within free-tier limits and avoids surprising repo owners.

**Consequences:**
- `DAYBREAK_BRANCH_TTL_DAYS` (default 7), `DAYBREAK_SANDBOX_IDLE_TTL_MINUTES` (default 15), `DAYBREAK_DATA_RETENTION_DAYS` (default 30), and `DAYBREAK_CLEANUP_ENABLED` (default `true`) control cleanup behavior.
- Branch deletion also removes remote checkpoint tags `daybreak/checkpoint/<taskId>/*` so restored checkpoints cannot outlive their branch.
- Sandbox cleanup kills any `running` task whose `keep_alive_until` is in the past and any terminal task that still has a `sandbox_id`.
- Data retention marks old `checkpoints` as `abandoned` and deletes old `session_snapshots` rows, reducing Supabase storage growth.
- `cleanup_runs` records `type`, `started_at`, `completed_at`, `details`, and `deleted_count` for observability.

---

## D41. Phase 6 M8/M9 final polish (compaction, large-repo limits, provider fail-fast, resilience evals)

**Decision:** Cap file reads by bytes and lines in `SafetyMiddleware`, allow shallow clones via `DAYBREAK_MAX_REPO_CLONE_DEPTH`, tune Pi context compaction through centralized config plus per-task `POST /api/tasks` overrides, fail-fast to the fallback provider after a configurable streak of 5xx/429 errors, and verify all of these with a deterministic, in-memory `resilience.ts` eval that runs under `pnpm eval`.

**Rationale:** Long tasks on large repos risk context-window exhaustion, oversized file reads, and provider timeout cascades. Bounding file reads prevents multi-megabyte artifacts from entering the LLM context. Shallow clones reduce clone time and storage for history-irrelevant evals. Compaction tuning keeps long conversations within the model window. Provider fail-fast avoids burning E2B runtime while the primary provider is unhealthy. A zero-external-dependency resilience eval gives fast CI feedback on queue, idempotency, retry, tenant quotas, security, circuit-breaker, and cleanup behavior.

**Consequences:**
- `SafetyMiddleware` checks `stats.size` and line count for `read`/`write`/`edit`, emitting `file_too_large` when `DAYBREAK_MAX_FILE_READ_BYTES` or `DAYBREAK_MAX_FILE_READ_LINES` is exceeded.
- `packages/agent-runner/src/run-task.ts` passes `--depth N` to `git clone` when `DAYBREAK_MAX_REPO_CLONE_DEPTH > 0`.
- `COMPACTION_RESERVE_TOKENS` and `COMPACTION_KEEP_RECENT_TOKENS` are read from `loadConfig()` and can be overridden per task; `TaskRunner` emits `compaction_advised` (and calls `session.compact()` if available) when `contextWindow - reserveTokens` is crossed.
- `createModelRuntime` tracks consecutive primary-provider retryable failures; after `DAYBREAK_PROVIDER_FAILURE_THRESHOLD` it immediately tries the fallback instead of waiting for each call to time out.
- `packages/evals/src/resilience.ts` runs against in-memory control-plane modules by emptying `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_TOKEN` at module load, so `pnpm eval` can validate Phase 6 behavior without live credentials. `packages/evals/src/index.ts` runs the resilience checks first and skips LLM fixtures when `LLM_API_KEY` is not configured.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter agent-runner build:bundle`, and `pnpm --filter ui build` are the required green gates.

---

## D42. Cloud / Local mode package toggle

**Decision:** Add a single `DAYBREAK_MODE=cloud|local` package switch that selects the entire pluggable infrastructure stack. In `cloud` mode the system uses existing managed services (E2B, Supabase Cloud, Upstash, Langfuse Cloud). In `local` mode it uses self-hosted replacements (Den, Supabase Local CLI, local Redis + UpRedis, Arize Phoenix). The UI exposes one toggle, not per-service toggles.

**Rationale:** A single switch prevents accidental hybrid configurations that still consume cloud quotas, and it keeps the UI and configuration model simple. During heavy testing the whole stack can be pointed locally with one change.

**Consequences:**
- `packages/shared/src/config.ts` gains a `mode` field and provider URLs/credentials that vary by mode.
- The control plane and agent runner select provider implementations based on `mode`.
- Cloud mode remains the default so existing deployments are unaffected.

---

## D43. Self-hosted sandbox: Den

**Decision:** Use Den (`github.com/us/den`) as the local-mode sandbox provider, replacing E2B. The existing E2B provider remains the cloud-mode default. Daytona stays available as a fallback if Den proves immature.

**Rationale:** Den is a single-binary, Docker-backed sandbox with a TypeScript SDK and a REST API designed as a drop-in E2B alternative. It avoids E2B credit consumption during development and testing.

**Consequences:**
- `packages/agent-runner` gains a Den-backed sandbox implementation alongside `sandbox.ts` and `sandbox-daytona.ts`.
- Local Docker Compose includes a Den service.
- If Den lacks browser or snapshot features, Daytona can be swapped in with the same interface.

---

## D44. Local persistence: Supabase Local CLI

**Decision:** Use Supabase Local CLI (`npx supabase start`) for local-mode persistence, replacing Supabase Cloud. It runs Postgres + PostgREST + Realtime in Docker.

**Rationale:** The existing Supabase SDK, migrations, and table schemas remain unchanged. Supabase Local CLI is the closest local equivalent to Supabase Cloud, so the migration from local dev to hosted production stays trivial.

**Consequences:**
- Local Docker Compose (or a Supabase-managed set of containers) provides Postgres and the Supabase services.
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in local mode point to the local CLI endpoints.
- No Supabase Cloud storage or row limits are consumed during local testing.

---

## D45. Local event stream: Redis + UpRedis-compatible REST proxy

**Decision:** Replace Upstash Redis Cloud with a local Redis container plus an Upstash-compatible REST proxy (`up-redis` preferred, `serverless-redis-http` as fallback) for local-mode event streaming. The `@upstash/redis` SDK stays in place; only the URL and token change.

**Rationale:** The proxy implements the Upstash Redis REST API, so the existing Redis code paths and SDK calls work without rewriting. This avoids the 500K command/month free-tier cap during heavy testing.

**Consequences:**
- Local Docker Compose includes `redis` and the REST proxy.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_TOKEN` point to the local proxy.
- If the proxy has compatibility gaps, we can later switch to a native Redis client, but that is a larger change.

---

## D46. Local observability: Arize Phoenix

**Decision:** Replace Langfuse Cloud with self-hosted Arize Phoenix for local-mode observability. Langfuse Cloud remains the cloud-mode default.

**Rationale:** Langfuse Cloud's free trace tier is small for heavy testing, and self-hosted Langfuse requires ClickHouse, Postgres, and Redis — a heavy local footprint. Arize Phoenix is open-source, runs in Docker, supports OpenTelemetry ingestion, and provides trace/cost views with a smaller resource footprint.

**Consequences:**
- The OTel exporter endpoint switches to Phoenix in local mode.
- The existing Langfuse trace-tree UI may need a Phoenix-compatible adapter, or Phoenix's own UI can be used during local development.
- If Phoenix does not cover a needed Langfuse feature, we can reconsider self-hosted Langfuse or sampling in cloud mode.

---

# Appendix A — Environment & Secrets Reference

This appendix merges the operational reference from the former `docs/SECRETS.md` and `.env.example`. The exact environment variable names are the source of truth in `packages/shared/src/config.ts`.

## Environments

| Environment | Use case | Storage |
|-------------|----------|---------|
| Local development (Phase 0) | Running the agent spike and evals | `.env` file loaded by `dotenv` |
| CI (GitHub Actions) | Lint, typecheck, tests | Repository `Secrets` / `Variables` |
| Cloudflare Workers | Control plane, GitHub App, queue, UI | `wrangler secret` / `wrangler.toml` vars (non-sensitive only) |
| E2B | Sandbox API key | Cloudflare secret, passed to the sandbox at creation time |
| Supabase | Database, Edge Functions | Supabase Vault / project API keys, stored in Cloudflare secrets |

## Secret inventory

### LLM providers
- `LLM_API_KEY` and `LLM_FALLBACK_API_KEY` — primary and fallback OpenAI-compatible API keys.
- Rotate keys through the provider dashboard. Use `LLM_FALLBACK_*` so the agent can degrade gracefully on rate limits.

### E2B
- `E2B_API_KEY` — create/destroy sandboxes.
- `E2B_TEMPLATE` — optional sandbox template name. The built-in `daybreak-browser` template ships Node 22, Chromium, and `playwright-core` for the browser tool. Leave unset or set to `base` for the default template.
- The agent should never read this from inside a sandbox. The control plane injects a short-lived sandbox API key only when spawning a workspace.

### GitHub
- `GITHUB_TOKEN` — a Personal Access Token (PAT) for Phase 3 and Phase 5. It must have `contents:write` and `pull_requests:write` on every repo Daybreak touches. Phase 5 additionally requires `actions:read` and `checks:read` to fetch failed CI job logs and annotations (these are usually included in the `repo` scope of a classic PAT). For fine-grained PATs, grant `Contents`, `Pull requests`, `Actions`, and `Checks` read/write on the selected repos.
- `GITHUB_WEBHOOK_SECRET` — used to verify `X-Hub-Signature-256` on repo webhook deliveries. Store it as a Cloudflare/Worker secret for Phase 7; locally it lives in `.env`.
- `GITHUB_WEBHOOK_REPO_ALLOWLIST` — comma-separated `owner/repo` or `owner/*` patterns limiting which repos may trigger the control plane.
- `GITHUB_WEBHOOK_RATE_LIMIT` — maximum webhook-triggered tasks per repo or per sender in the last hour (default `10`).
- `GITHUB_APP_ID` — **deferred to Phase 7**. The App will replace the PAT, add JWT signing, 1-hour installation tokens, and automatic per-installation webhooks.

### Local webhook tunnel
For Phase 3, the control plane runs locally and receives repo webhooks through a tunnel:

```bash
# Install cloudflared (or use ngrok)
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:8787
```

Copy the tunnel URL (e.g. `https://<random>.trycloudflare.com`) and add it as a webhook in the target repo:

1. Repo **Settings** → **Webhooks** → **Add webhook**.
2. **Payload URL**: `https://<random>.trycloudflare.com/api/webhooks/github`
3. **Content type**: `application/json`.
4. **Secret**: the value of `GITHUB_WEBHOOK_SECRET`.
5. Choose **Issue comments**, **Pull request review comments**, **Pull request reviews**, and **Check runs**.
6. Ensure the repo is in `GITHUB_WEBHOOK_REPO_ALLOWLIST`.

### Redis / Supabase / Langfuse
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_TOKEN` are high-sensitivity; the sandbox uses them to publish the event stream and the control plane uses them to read it back.
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are high-sensitivity and are used by the control plane to persist tasks and events.
- Langfuse keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`) are lower risk but still kept out of source control.

## Phase 6 runtime configuration

These values are not secrets but are tenant- and quota-sensitive:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DAYBREAK_MAX_CONCURRENT_TASKS` | `2` | Max parallel running tasks in the worker. |
| `DAYBREAK_QUEUE_WORKER_POLL_MS` | `1000` | How often the worker polls Supabase. |
| `DAYBREAK_DEFAULT_TENANT_DAILY_COST_USD` | `0.50` | Per-tenant daily cost budget. |
| `DAYBREAK_DEFAULT_TENANT_TASKS_PER_HOUR` | `10` | Per-tenant task creation rate limit. |
| `DAYBREAK_DEFAULT_TENANT_MAX_CONCURRENT` | `2` | Per-tenant concurrent task cap. |
| `DAYBREAK_GLOBAL_MAX_CONCURRENT_SANDBOXES` | `5` | Hard ceiling across all tenants. |
| `DAYBREAK_COST_ALERT_THRESHOLD` | `0.8` | Fraction of `MAX_COST_USD` that triggers `cost_alert`. |
| `DAYBREAK_BRANCH_TTL_DAYS` | `7` | How long stale `daybreak/` branches are kept. |
| `DAYBREAK_SANDBOX_IDLE_TTL_MINUTES` | `15` | Grace period before an idle or terminal sandbox is killed. |
| `DAYBREAK_DATA_RETENTION_DAYS` | `30` | Old `session_snapshots` and checkpoints are pruned after this. |
| `DAYBREAK_CLEANUP_ENABLED` | `true` | Set to `false` to disable the background cleanup interval. |
| `DAYBREAK_MAX_FILE_READ_BYTES` | `200000` | Hard cap on `read`/`write`/`edit` target file bytes. |
| `DAYBREAK_MAX_FILE_READ_LINES` | `5000` | Hard cap on `read`/`write`/`edit` target file line count. |
| `DAYBREAK_MAX_REPO_CLONE_DEPTH` | `0` | Set to `>0` to clone repos with `--depth N`. |
| `DAYBREAK_PROVIDER_FAILURE_THRESHOLD` | `3` | Consecutive 5xx/429 errors before fail-fast to fallback. |
| `DAYBREAK_MAX_CHECKPOINTS_PER_TASK` | `100` | Caps per-task checkpoint growth. |
| `DAYBREAK_CHECKPOINT_INTERVAL` | `tool` | Create a checkpoint per tool call (`tool`) or per turn (`turn`). |
| `DAYBREAK_SESSION_STORE_BACKEND` | `supabase` | Where to upload session JSONL snapshots (`file` or `supabase`). |
| `DAYBREAK_FORK_STRATEGY` | `auto` | Default cross-sandbox fork strategy. `auto` currently resolves to `git-reinstall`; `snapshot` is supported but benchmark before enabling. |
| `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` | `2` | Max `check_run` heal attempts per PR per 24h. |
| `DAYBREAK_HEAL_COOLDOWN_SECONDS` | `60` | Same-commit heal cooldown. |
| `DAYBREAK_MAX_CI_LOG_BYTES` | `524288` | Max raw CI log bytes fetched per heal. |
| `DAYBREAK_CI_LOG_CONTEXT_LINES` | `20` | Context lines kept around each failure block. |
| `DAYBREAK_PR_BRANCH_PREFIX` | `daybreak/` | Prefix for agent-created feature branches. |
| `REVIEW_KEEP_ALIVE_MS` | `900000` (15 min) | How long a review/heal sandbox stays alive for reconnects. |
| `COMPACTION_ENABLED` | `true` | Enable Pi context compaction. |
| `COMPACTION_RESERVE_TOKENS` | `4000` | Token headroom before `compaction_advised` is emitted. |
| `COMPACTION_KEEP_RECENT_TOKENS` | `8000` | Recent messages preserved during Pi compaction. |

**Note:** `COMPACTION_RESERVE_TOKENS` and `COMPACTION_KEEP_RECENT_TOKENS` intentionally do **not** use a `DAYBREAK_` prefix in the code and `.env.example`; set them exactly as shown above. The other Phase 6 runtime variables use the `DAYBREAK_` prefix.

### Tenant headers

For local testing and Phase 7 per-installation routing, the control plane accepts:

- `X-Daybreak-Tenant-Id` — override the tenant id for a request.
- `X-Daybreak-User-Id` — identify the caller within the tenant.
- `X-Daybreak-Role` — one of `admin`, `operator`, `viewer`. `viewer` cannot create tasks.

If no tenant headers are sent, the control plane creates or reuses a default tenant so existing single-user demos continue to work.

### Never commit secrets

The repo uses a denylist that blocks the agent from reading files matching sensitive patterns such as `.env`, `*.pem`, `*.key`, `.npmrc`, and paths containing `secret`/`token`/`password`. CI rejects pushes that add unencrypted secret files.

### Generating `.env` locally

```bash
cp .env.example .env
# edit .env with your keys
```

`.env` is already in `.gitignore`.

---

# Open Questions

These questions can change future decisions. The first two were answered in Phase 4 and are kept here for traceability.

- ~~Can `pi-agent-core` serialize and fork sessions cleanly?~~ **Answered in Phase 4:** `SessionManager` writes a `.jsonl` that can be copied and reopened with `SessionManager.open`; true in-process forking is not required because we always start a fresh `TaskRunner` from the restored state.
- ~~What is the real cost and latency of per-turn E2B snapshots?~~ **Answered in Phase 4:** snapshots are supported but more expensive/slower than `git-reinstall` with the `daybreak-browser` template, so `git-reinstall` is the default.
- Which free LLM provider gives the best coding-task success rate within its rate limits?
- Will Cloudflare Workers free tier support the expected webhook and Durable Object load?
- How do we prevent prompt-injection or sandbox-escape attacks from malicious repositories?
