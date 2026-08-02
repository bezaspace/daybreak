# Phase 2 Implementation Milestones

**Sub-document of:** <../roadmap.md>  
**Phase name:** Observability, Cost Control & Provider Resilience  
**Goal:** Every prompt, token count, tool call, and latency is emitted as OpenTelemetry spans to Langfuse; the dashboard renders the agent's reasoning tree; and the system survives primary LLM provider outages.

This document breaks the Phase 2 exit criteria into small, independently-demoable milestones. Each milestone ships a visible capability and can be reviewed on its own.

---

## Exit criteria for the whole phase

> From <../roadmap.md>: Run a task → open the local dashboard trace view → see the full reasoning tree with per-step token cost and latency. Total task cost is displayed. Pulling the primary LLM endpoint offline causes an automatic fallback with a visible trace event.

---

## Milestones

### M1 — Telemetry foundation in the agent runner

**What it ships:** The agent runner emits a real OpenTelemetry trace for every task, with spans for turns, LLM calls, and tool calls, exported to Langfuse.

- [x] Add `packages/agent-runner/src/telemetry.ts` that initializes an OpenTelemetry `TracerProvider`.
  - Use a direct `OTLPTraceExporter` to `${LANGFUSE_BASE_URL}/api/public/otel/v1/traces` with Basic Auth and `x-langfuse-ingestion-version: 4`.
  - Derive the trace ID from `TASK_ID` so the UI can later correlate.
- [x] Instrument `TaskRunner` in `packages/agent-runner/src/session.ts`.
  - Root span: `task`.
  - Child spans:
    - `turn` per `turn_start`/`agent_end`.
    - `llm` per `message_end`, capturing model, prompt/completion tokens, latency, and cost.
    - `tool` per `tool_execution_start`/`tool_execution_end`, capturing tool name, arg summary, result size, latency, and error status.
    - `compaction` on `compaction_start`/`compaction_end`.
- [x] Pass `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` through `sandbox.ts` envs and `control-plane/src/server.ts` spawn env.
- [x] Flush and shutdown the OTel SDK before the sandbox exits. `TaskRunner.shutdown()` calls `provider.shutdown()`; `run-task.ts`, `spike.ts`, and `evals/src/index.ts` call `runner.shutdown()`.
- [x] Set `gen_ai.*` attributes on the `llm` span so Langfuse renders it as a generation with token usage and cost.

**Acceptance:**
- `pnpm --filter agent-runner spike` (or an E2E run) produces a trace in Langfuse.
- The trace contains at least one `turn` span and one `llm` span with token counts and latency.
- No spans are dropped when the sandbox finishes (verify by checking Langfuse after the sandbox is killed).

---

### M2 — Provider fallback and real cost calculation

**What it ships:** When the primary LLM provider is rate-limited or down, the agent automatically switches to the fallback provider, and the trace records the switch.

- [ ] Choose a fallback strategy:
  - **Preferred:** configure Pi's `retry.fallbackChains` setting through `SettingsManager.inMemory()` in `session.ts`.
  - **Fallback:** if the installed Pi API does not expose `retry.fallbackChains`, wrap `modelRuntime`/`session.prompt()` in `llm.ts`/`session.ts` to catch provider errors and swap to the fallback model.
- [ ] Register both providers with their own API keys (already partially supported in `llm.ts` via `getFallbackModel`).
- [ ] Emit stream events `provider_switched` and `fallback_applied` with `from`, `to`, and `reason`.
- [ ] Add a per-model token-pricing map (env or config file) keyed by `provider/modelId`.
  - Use it in `MetricsCollector` to compute `estimatedCostUsd` instead of relying on Pi's `usage.cost` (currently all zeros in `llm.ts`).
- [ ] Update `sandbox.ts` to accept and pass `LLM_FALLBACK_*` env vars.
- [ ] Surface provider usage and total cost in `task_complete`/`task_failed` metrics.

**Acceptance:**
- Set `LLM_BASE_URL` to a failing/unreachable endpoint and `LLM_FALLBACK_BASE_URL` to a working one.
- Run a task; it completes successfully using the fallback provider.
- The Langfuse trace shows the provider switch; the stream/event log contains `fallback_applied`.
- `estimatedCostUsd` is non-zero and based on the active provider's pricing.

---

### M3 — Control-plane trace context and persistence

**What it ships:** The control plane knows the trace ID and provider for each task and exposes them via the API.

- [ ] Extend `packages/control-plane/src/db.ts` `Task`/`PersistedTask` to store `traceId`, `provider`, and `costUsd`.
- [ ] In `server.ts`, when the runner exits, persist these fields if they are present in the final event payload.
- [ ] Add `GET /api/tasks/:id/trace` that proxies/fetches the Langfuse trace for the task (or returns a redirect to Langfuse UI).
- [ ] Capture runner stdout/stderr when spawning the sandbox (currently `stdio: "ignore"`) and redirect to a Redis log key or at least a local log file, so telemetry/fallback debugging is not blind.
- [ ] Ensure the Langfuse keys are not exposed in API responses or logs.

**Acceptance:**
- `GET /api/tasks/:id` returns `traceId`, `provider`, and `costUsd` after a task finishes.
- `GET /api/tasks/:id/trace` returns the trace JSON or a valid Langfuse URL.
- Runner errors are visible somewhere other than the sandbox's ephemeral console.

---

### M4 — Dashboard trace tree and cost dashboard

**What it ships:** The local React dashboard can visualize the reasoning tree and total cost.

- [ ] Add a trace view to `packages/ui/src/App.tsx` or a new route.
  - Fetch `GET /api/tasks/:id/trace` or the Langfuse API directly.
  - Render observations as a tree by `parentObservationId`.
  - Color-code span kinds (LLM, tool, turn, compaction).
  - Show per-node: model, provider, tokens, cost, latency.
- [ ] Add a cost dashboard panel:
  - Total cost per task.
  - Provider breakdown.
  - Aggregated daily/weekly spend (local state + Supabase query).
- [ ] Update `formatEvent` and metrics box to show provider name and fallback status.

**Acceptance:**
- Start a task from the UI; after completion, the trace tab shows the reasoning tree with per-step cost and latency.
- The metrics box shows `estimatedCostUsd` and the active provider.
- The dashboard survives a page refresh and still loads the completed trace.

---

### M5 — Eval harness, budget update, and phase sign-off

**What it ships:** Phase 2 is repeatable and the free-tier budget is updated with real numbers.

- [ ] Extend `packages/evals/src/e2e.ts` (and `packages/evals/src/index.ts`):
  - Assert that a Langfuse trace exists for the completed task.
  - Assert that `estimatedCostUsd` is present and reasonable.
  - Optional: add a fallback fixture that uses a bad primary endpoint.
- [ ] Update `docs/COST_BUDGET.md`:
  - Record observed trace/observation unit usage per task.
  - Model monthly Langfuse unit burn at expected eval/task volume.
  - Document provider fallback cost implications.
- [ ] Update `roadmap.md` Phase 2 checklist and mark Phase 2 complete when exit criteria pass.
- [ ] Add `packages/agent-runner/src/instrumentation.ts` to the build/bundle script if needed.

**Acceptance:**
- `pnpm eval` passes and reports trace/cost metrics.
- `pnpm eval:e2e` passes on a real sandbox run and reports PR URL, trace URL, total cost, and provider.
- CI lint/typecheck/test pass.

---

## Recommended order

1. **M1** first — it creates the data everything else consumes.
2. **M2** next — it depends on M1's spans to verify fallback behavior.
3. **M3** in parallel with M2 — control-plane plumbing is independent but should land before the UI.
4. **M4** after M1–M3 — the UI needs traces and API endpoints.
5. **M5** last — wrap up evals and documentation.

M1 and M2 can be a single PR if desired, but M4 should be separate to keep UI review focused.

---

## Major risks and mitigations

| Risk | Mitigation |
|------|------------|
| Langfuse free tier (50K units/month) exhausted | Emit one span per turn/LLM/tool, not per `message_update`; sample high-volume eval runs; document unit burn in `COST_BUDGET.md`. |
| Spans lost when `sandbox.ts` kills the container | Call `otelSDK.shutdown()` / `langfuseSpanProcessor.forceFlush()` in `run-task.ts` before exit. |
| Pi's `retry.fallbackChains` API differs from docs | Verify against the installed `@earendil-works/pi-coding-agent@0.83.0` package; fall back to a manual wrapper if needed. |
| Cost is zero because `llm.ts` sets `cost` to `0` | Maintain an external price map per `provider/modelId`; compute `estimatedCostUsd` from token counts × price. |
| Control plane cannot debug runner telemetry failures | Capture runner stdout/stderr to a log key instead of `stdio: "ignore"`. |

---

## Verification commands

```bash
# Lint/typecheck/test
pnpm lint && pnpm typecheck && pnpm test

# Local spike with telemetry
pnpm --filter agent-runner spike

# E2E through control plane with telemetry + fallback
pnpm --filter evals eval:e2e

# UI dev server
pnpm --filter ui dev
```

---

*This milestone document should be updated as Phase 2 is built. Mark each checkbox when the acceptance criteria are verified.*
