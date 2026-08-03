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

## Phase 4 time-travel budget impact

### Per-checkpoint costs

- **Git commit:** negligible. Each checkpoint is a local `git commit` plus a lightweight tag in the sandbox. No egress or external storage cost.
- **Session JSONL snapshot:** Each checkpoint copies the current Pi session `.jsonl` to `.daybreak/sessions/<taskId>/<turn>.jsonl`. With `DAYBREAK_SESSION_STORE_BACKEND=supabase` (default), the file is uploaded to Supabase Storage. A short session file is typically 5–50 KB. At 40 checkpoints per task × 10 tasks/day, this is ~2–20 MB/day, well under Supabase's 1 GB file storage free tier.
- **Database checkpoint rows:** One `checkpoints` row per checkpoint with a small JSON-free payload. At 40 checkpoints per task × 1,000 tasks/month = 40K rows, still within Supabase's 500 MB / 500K edge-invocation limits; the 500 MB DB cap and 500K events row cap remain the binding constraints.

### Fork strategies

- **`git-reinstall` / `auto` (default):** pays only for a fresh E2B sandbox plus dependency re-install time. No snapshot storage. With the `daybreak-browser` template (Node 22, Chromium, `playwright-core` pre-baked), only repo-specific dependencies need reinstall, typically 10–60 s of compute.
- **`snapshot`:** pays for snapshot creation (sandbox paused during snapshotting) plus ongoing snapshot storage, then the new sandbox runtime from that image. Snapshot creation is dominated by filesystem and memory size; see `packages/agent-runner/src/spikes/snapshot-benchmark.ts` for measured create/spawn latency on your workloads. Only enable when the benchmark shows snapshot create+spawn is faster than a clean install.
- Estimated E2B compute for a 60-second re-install at 2 vCPU / 1.5 GB RAM: ~$0.00084. A 20-second snapshot spawn: ~$0.00028 plus snapshot storage at ~$0.0000045/GiB/s.

### Parallel branches and budget

- Each fork is a **new task** with its own `MAX_TURNS` and `MAX_COST_USD` budget. The parent task's budget is not consumed by a branch.
- A `MAX_COST_USD` limit on the parent still protects the original run; branches that exceed their own limit fail independently.
- **Abandonment stops metered E2B consumption:** calling `POST /api/tasks/:id/abandon` or promoting a sibling kills the sandbox and stops runtime charges. Branch tasks in `abandoned` or `promoted` status still occupy negligible Supabase/Redis rows but no longer consume E2B compute.
- `DAYBREAK_MAX_CHECKPOINTS_PER_TASK` (default 100) caps per-task checkpoint growth. Older checkpoints are not deleted automatically in v1, but new checkpoints beyond the cap can be refused or older `active` checkpoints can be marked `abandoned` to stay within storage budget.

### Summary table

| Phase 4 cost driver | Default behavior | Approx. cost | Controlling env |
|---------------------|------------------|--------------|-----------------|
| Per-checkpoint git commit | local in sandbox | ~$0 | n/a |
| Per-tool checkpoint | enabled by `DAYBREAK_CHECKPOINT_INTERVAL=tool` | storage only | `DAYBREAK_CHECKPOINT_INTERVAL` |
| Session snapshot upload | Supabase Storage | 5–50 KB per checkpoint | `DAYBREAK_SESSION_STORE_BACKEND` |
| Fork branch runtime | new sandbox, own budget | ~$0.0003–0.001 per branch | `DAYBREAK_FORK_STRATEGY` |
| Snapshot storage | only with `snapshot` strategy | ~$0.0000045/GiB/s | `DAYBREAK_FORK_STRATEGY=snapshot` |
| Maximum checkpoints | 100 per task | storage cap | `DAYBREAK_MAX_CHECKPOINTS_PER_TASK` |

## Phase 5 CI self-healing budget impact

### Per-heal costs

- **Extra E2B sandbox (or reconnect):** Each failed `check_run` may start a new sandbox or reconnect to a kept-alive sandbox from the original PR task. A reconnect avoids a cold start; a new sandbox pays the usual cold-start + dependency-install cost (see Phase 4 fork table).
- **Extra LLM turns per heal:** The agent receives the CI error context and reruns tests, typically 3–8 additional turns per heal. Each turn consumes primary/fallback provider tokens and is billed at the active model's rate.
- **GitHub API log download:** `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` and `GET /repos/{owner}/{repo}/check-runs/{id}/annotations` are free under GitHub REST API quota for `repo`/`actions:read` tokens. No egress cost from GitHub.
- **Webhook deduplication Redis key:** One `daybreak:heal-checkrun:{checkRunId}` key per failed check run, 24-hour TTL. Negligible memory and command volume.

### Circuit breakers

- `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` (default `2`) caps the number of heal tasks spawned for a single PR.
- `DAYBREAK_HEAL_COOLDOWN_SECONDS` (default `60`) prevents rapid re-triggering on the same commit.
- Standard `MAX_TURNS` and `MAX_COST_USD` still apply inside each heal task.

### Summary table

| Phase 5 cost driver | Default behavior | Approx. cost | Controlling env |
|---------------------|------------------|--------------|-----------------|
| Heal sandbox spawn | reconnect if kept-alive, else new sandbox | reconnect ~$0; new ~$0.0003–0.001 | `REVIEW_KEEP_ALIVE_MS` |
| LLM turns per heal | 3–8 extra turns | ~$0.003–0.009 at gpt-4o-mini rates | `MAX_COST_USD`, `MAX_TURNS` |
| GitHub log/annotation fetch | REST API, free under quota | ~$0 | `DAYBREAK_MAX_CI_LOG_BYTES` |
| Per-check-run dedupe key | Redis key with 24h TTL | ~$0 | n/a |
| Heal attempt cap | 2 per PR per 24h | prevents runaway cost | `DAYBREAK_MAX_HEAL_ATTEMPTS_PER_PR` |
