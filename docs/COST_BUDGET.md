# Cost and quota budget

Daybreak is designed to live on free-tier infrastructure. This document records the free quotas, expected burn rates, and the guardrails that enforce them.

## Free-tier quotas

| Service | Free tier | Source |
|---------|-----------|--------|
| **Upstash Redis** | 256 MB data, 500K commands/month, 10 GB bandwidth, 10K max commands/sec | Upstash free tier |
| **Supabase** | 500 MB DB, 5 GB egress, 1 GB file storage, 50K MAU, 2 projects, 500K Edge Function invocations/month | Supabase free tier |
| **Langfuse** | 50K units/month on Hobby plan | Langfuse pricing |
| **E2B** | Hobby: $100 in one-time credits; paid vCPU/RAM/storage only after credits consumed | E2B pricing |
| **Groq** | 30 RPM, 6K TPM, 1K RPD for most models | Groq docs |
| **OpenRouter free** | 50 requests/day, 20 RPM | OpenRouter docs |

## Observed Phase 1 exit-criteria run

The `bezaspace/daybreak-target` failing-sum fixture produced a `task_complete` result with the following metrics on a free-tier LLM endpoint:

- **Turns:** 6
- **Tool calls:** 8
- **Total tokens:** ~18,013
- **Estimated cost:** $0.00 (free-tier provider)
- **Wall-clock time:** ~10.8 s

A `MAX_TURNS=3` override run aborted after 3 turns with `task_failed: Max turns (3) reached`, demonstrating the circuit breaker.

## Model cost assumptions

Free providers are used wherever possible. For paid fallbacks, the target model is a small, cheap model such as `gpt-4o-mini` or `inclusionai/Ling-3.0-flash:free`:

- Typical agent turn: ~2K input tokens + ~1K output tokens.
- At OpenAI `gpt-4o-mini` rates: ~$0.0005 per prompt + $0.0006 per completion = **~$0.0011 per turn**.
- A 40-turn task therefore costs roughly **$0.044**, well under the default `MAX_COST_USD=0.50`.
- Context compaction triggers a summarization LLM call. On a 32K-token summary this may add ~8K input + ~2K output tokens, or **~$0.006 per compaction**. Set `MAX_COST_USD` generously when `COMPACTION_ENABLED=true` on long tasks.

## Infrastructure burn rates

### Redis
- The sandbox publishes one event per `message_update`/`tool_execution_*`/`agent_end`/`task_complete` etc. Each event triggers one `RPUSH` and the flush batch includes one `LTRIM` per 100 ms window, keeping the last 1000 events per task. A short 5-turn fix run with ~30 events therefore uses ~30–35 Redis commands.
- Free quota: **500K commands/month** → roughly **10,000–15,000 short tasks/month** at the current event volume.
- **Guardrail:** `MAX_TURNS`, the 1000-event `LTRIM` cap, and 100 ms batching limit command volume. Monitor the Upstash dashboard; if usage climbs, increase batch interval or sample events.

### E2B
- The free Hobby tier provides $100 in one-time credits before any paid usage begins.
- After credits are consumed, sandbox compute (vCPU/RAM) and snapshot storage are metered; for current rates see https://e2b.dev/pricing.
- The default `base` template ships Node 20; installing Node 22 at sandbox startup adds ~30–60 seconds of CPU time per run. The pre-built `daybreak-browser` template bakes in Node 22, Chromium, and `playwright-core`, eliminating per-run installation and improving cold-start time.
- The `daybreak-browser` template uses 2 vCPU / 1536 MB RAM, which is within the free-tier allowance and is required for Chromium's V8 renderer to avoid OOM.
- Time-travel snapshots are the main wildcard: a full filesystem snapshot per turn is expensive, so Phase 4 should benchmark snapshot size and latency before enabling per-turn snapshots.

### Cross-sandbox fork (M4)

M4 supports two fork strategies. The default is **git + re-install**; the alternative is an **E2B snapshot**. Choose based on the `packages/agent-runner/src/spikes/snapshot-benchmark.ts` results.

- **Git + re-install (default):** pays only for the fresh sandbox cold start plus the dependency install time. No snapshot storage. With the `daybreak-browser` template, the base environment (Node 22, Chromium, `playwright-core`) is pre-baked; only repo-specific dependencies are re-installed from the lockfile. This is the cheapest and usually fastest option.
- **E2B snapshot:** pays for the time to create the snapshot (sandbox is paused during snapshotting) plus ongoing snapshot storage, then pays for the new sandbox runtime from that image. E2B snapshots are slower to spawn and less resource-efficient than templates because memory fragmentation reduces prefetch effectiveness. Use this only when the benchmark shows the snapshot create+spawn time is lower than a clean install, or when the installed state is too expensive to rebuild.

Estimated costs (Hobby tier, see https://e2b.dev/pricing for current rates):

- Sandbox compute: ~$0.000014/s for 2 vCPU / 1.5 GB RAM.
- A 60-second dependency install in a fresh sandbox costs ~$0.00084 in compute.
- A full snapshot restore that takes 20 seconds to spawn costs ~$0.00028 in compute, plus snapshot storage ($0.0000045/GiB/s).
- Snapshot creation time is dominated by filesystem and memory size; the E2B SDK does not expose snapshot size or credit cost directly, so measure with the spike and monitor the E2B dashboard.

#### Sandbox keep-alive (Phase 3 review loop)
- When an issue-comment task opens a PR, the sandbox stays alive for `REVIEW_KEEP_ALIVE_MS` (default 15 minutes) so a later `pull_request_review_comment` can reconnect to the same sandbox instead of paying for a cold start.
- Hobby-tier sandboxes have a maximum lifetime of 1 hour, so `REVIEW_KEEP_ALIVE_MS` is capped below that. The default 15 minutes balances responsiveness with cost.
- A kept-alive sandbox consumes vCPU/RAM for the entire keep-alive window. At 2 vCPU / 1536 MB RAM, 15 minutes ≈ 0.5 vCPU-hours + 1.5 GB-hours per review cycle. Keep the window short and close the sandbox promptly if no review arrives.

### Supabase
- The control plane inserts one `tasks` row per task and one `events` row per stream event (~300–500 events for a short fix run).
- At ~400 events per task, 1,000 tasks/month = ~400K rows and ~200–400 MB depending on payload size, so the 500MB DB cap is the binding constraint before the 500K Edge Function limit.
- The 1000-event Redis `LTRIM` cap and `MAX_TURNS` guardrail also bound Supabase row growth.
- Retention/archival of old `events` rows will be added before moving out of the free tier.

### Langfuse
- Langfuse traces one span per turn; 40 turns × 100 tasks = 4K spans/day, under the 50K units/month quota if averaged.

## Phase 2 telemetry observations

The M1 spike produced a single trace with **17 observations** across a short 6-turn run. A typical short fix run generates roughly **1 trace + 15–25 observations**, i.e. **16–26 Langfuse units** per task.

| Eval volume | Units/day | Units/month | % of 50K free tier |
|-------------|-----------|-------------|---------------------|
| 10 tasks/day | ~200 | ~6,000 | 12% |
| 50 tasks/day | ~1,000 | ~30,000 | 60% |
| 100 tasks/day | ~2,000 | ~60,000 | 120% (over quota) |

At the target **10 tasks/day** eval cadence, Langfuse usage stays comfortably inside the Hobby tier. Running more than ~70 tasks/day continuously exceeds the quota; options are to (a) reduce observation granularity, (b) sample traces, or (c) upgrade.

## Provider fallback cost implications

Provider fallback is a reliability feature, not a cost-saving feature. When the primary provider is free (`Groq`, `OpenRouter free`, etc.) and the fallback is a paid endpoint (`gpt-4o-mini`, `OpenRouter paid`, etc.), every fallback turn is billed at the fallback model's rate.

- Configure fallback prices in `LLM_PRICING` or via `LLM_FALLBACK_INPUT_PRICE_PER_1M` / `LLM_FALLBACK_OUTPUT_PRICE_PER_1M` so `estimatedCostUsd` reflects the active provider.
- The `MAX_COST_USD` circuit breaker still applies after a fallback; if the fallback is expensive, a task will hit the cap sooner.
- For long eval runs, prefer a cheap primary *and* a cheap fallback (e.g. `gpt-4o-mini` for both) so a fallback does not blow the budget.

## Circuit breakers

The agent runner enforces three hard limits by default:

| Limit | Default | Config env |
|-------|---------|------------|
| Max turns | 40 | `MAX_TURNS` |
| Max wall-clock time | 20 minutes | `MAX_WALL_CLOCK_MINUTES` |
| Max cost per task | $0.50 USD | `MAX_COST_USD` |

These are intentionally tight. Raise them only after measuring real usage in your account.
