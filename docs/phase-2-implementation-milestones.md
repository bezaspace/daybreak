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

- [x] Implement a composite provider in `packages/agent-runner/src/llm.ts` that wraps the primary and optional fallback providers.
  - On primary failure it tries the fallback once per LLM call, then stays on fallback for the rest of the task.
  - Mutates the final `AssistantMessage.provider` to the real provider id so telemetry and cost accounting are accurate.
- [x] Register both providers with their own API keys under `daybreak-primary` and `daybreak-fallback`; expose a single `daybreak` composite provider to the `AgentSession`.
- [x] Emit stream events `provider_switched` and `fallback_applied` with `from`, `to`, `reason`, and `modelId`.
- [x] Add per-model token-pricing inputs in `packages/shared/src/types.ts` and `packages/shared/src/config.ts`:
  - `LLM_INPUT_PRICE_PER_1M` / `LLM_OUTPUT_PRICE_PER_1M` and fallback variants.
  - `LLM_PRICING` JSON map keyed by `provider/modelId`, `modelId`, or `*`.
  - Use the map in `MetricsCollector` to compute `estimatedCostUsd` instead of relying on Pi's `usage.cost`.
- [x] Update `sandbox.ts` to pass `LLM_*_PRICE_*` and `LLM_PRICING` env vars into the E2B sandbox.
- [x] Surface provider usage and total cost in `task_complete`/`task_failed` metrics via `estimatedCostUsd`.

**Acceptance:**
- Set `LLM_BASE_URL` to a failing/unreachable endpoint and `LLM_FALLBACK_BASE_URL` to a working one.
- Run a task; it completes successfully using the fallback provider.
- The Langfuse trace shows the provider switch; the stream/event log contains `fallback_applied`.
- `estimatedCostUsd` is non-zero and based on the active provider's pricing.

---

### M3 — Control-plane trace context and persistence

**What it ships:** The control plane knows the trace ID and provider for each task and exposes them via the API.

- [x] Extend `packages/control-plane/src/db.ts` `Task`/`PersistedTask` to store `traceId`, `provider`, and `costUsd`.
- [x] In `server.ts`, when the runner exits, read the final `task_complete`/`task_failed` event from Redis and persist `traceId`, `provider`, and `costUsd` to the task record.
- [x] Add `GET /api/tasks/:id/trace` that proxies/fetches the Langfuse trace for the task (or returns a redirect to Langfuse UI with `?redirect=1`).
- [x] Add `GET /api/tasks/:id/logs` to expose the runner log file.
- [x] Capture runner stdout/stderr when spawning the sandbox (`stdio: ["ignore", "pipe", "pipe"]`) and write them to a local log file and a Redis `daybreak:logs:<taskId>` list.
- [x] Ensure the Langfuse keys are not exposed in API responses or logs; the server uses them only for the internal Langfuse API call.

**Acceptance:**
- `GET /api/tasks/:id` returns `traceId`, `provider`, and `costUsd` after a task finishes.
- `GET /api/tasks/:id/trace` returns the trace JSON or a valid Langfuse URL.
- Runner errors are visible in the local log file and Redis log key.

---

### M4 — Dashboard trace tree and cost dashboard

**What it ships:** The local React dashboard can visualize the reasoning tree and total cost.

- [x] Add a trace view in `packages/ui/src/TraceView.tsx` integrated into `App.tsx`.
  - Fetches `GET /api/tasks/:id/trace`.
  - Renders Langfuse observations as a tree by `parentObservationId`.
  - Color-codes span kinds: LLM (blue), `tool:*` (orange), `turn` (green), `compaction` (purple), other (gray).
  - Shows per-node: model, provider, tokens, cost, and latency.
- [x] Add a cost dashboard in `packages/ui/src/CostDashboard.tsx`.
  - Total cost across completed tasks.
  - Provider breakdown table.
  - Daily spend table (local aggregation from `/api/tasks`).
- [x] Update `formatEvent` and metrics box to show provider name and fallback status.
  - `provider_switched`/`fallback_applied` events are rendered with `from → to` and reason.
  - `task_complete`/`task_failed` include the active provider and final cost.
  - Metrics box shows the active provider and flags `(fallback)` when it differs from the configured primary provider.

**Acceptance:**
- Start a task from the UI; after completion, the trace tab shows the reasoning tree with per-step cost and latency.
- The metrics box shows `estimatedCostUsd` and the active provider.
- The dashboard survives a page refresh and still loads the completed trace.

---

### M5 — Eval harness, budget update, and phase sign-off

**What it ships:** Phase 2 is repeatable and the free-tier budget is updated with real numbers.

- [x] Extend `packages/evals/src/index.ts`:
  - Asserts `traceId` is present on completed tasks.
  - Asserts `estimatedCostUsd` is present, non-negative, and within `MAX_COST_USD`.
  - Optionally verifies the trace exists in Langfuse when `LANGFUSE_*` keys are configured.
  - Reports provider and cost for each fixture.
- [x] Extend `packages/evals/src/e2e.ts`:
  - Fetches task details (`traceId`, `provider`, `costUsd`) from `GET /api/tasks/:id`.
  - Fetches `traceUrl` from `GET /api/tasks/:id/trace`.
  - Reports PR URL, trace URL, provider, and total cost in the summary table.
  - Asserts completed tasks have `traceId` and a non-negative `estimatedCostUsd`.
- [x] Update `docs/COST_BUDGET.md`:
  - Recorded observed trace/observation unit usage per task (~1 trace + 15–25 observations).
  - Modeled monthly Langfuse unit burn at 10/50/100 tasks/day.
  - Documented provider fallback cost implications.
- [x] Update `roadmap.md` Phase 2 checklist and marked Phase 2 complete.
- [x] `packages/agent-runner/src/instrumentation.ts` is not needed; `telemetry.ts` is already bundled through `run-task.ts`.

**Acceptance:**
- `pnpm eval` will pass and report trace/cost metrics when run with a valid `.env` and fixture.
- `pnpm eval:e2e` will pass on a real sandbox run and reports PR URL, trace URL, total cost, and provider.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter agent-runner build:bundle`, and `pnpm --filter ui build` pass.
- Phase 2 is marked complete in `roadmap.md`.

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
