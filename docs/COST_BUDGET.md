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

## Model cost assumptions

Free providers are used wherever possible. For paid fallbacks, the target model is a small, cheap model such as `gpt-4o-mini` or `inclusionai/Ling-3.0-flash:free`:

- Typical agent turn: ~2K input tokens + ~1K output tokens.
- At OpenAI `gpt-4o-mini` rates: ~$0.0005 per prompt + $0.0006 per completion = **~$0.0011 per turn**.
- A 40-turn task therefore costs roughly **$0.044**, well under the default `MAX_COST_USD=0.50`.

## Infrastructure burn rates

### Redis
- The sandbox publishes one event per `message_update`/`tool_execution_*`/`agent_end`/`task_complete` etc. Each event triggers one `RPUSH` and the flush batch includes one `LTRIM` per 100 ms window, keeping the last 1000 events per task. A short 5-turn fix run with ~30 events therefore uses ~30–35 Redis commands.
- Free quota: **500K commands/month** → roughly **10,000–15,000 short tasks/month** at the current event volume.
- **Guardrail:** `MAX_TURNS`, the 1000-event `LTRIM` cap, and 100 ms batching limit command volume. Monitor the Upstash dashboard; if usage climbs, increase batch interval or sample events.

### E2B
- The free Hobby tier provides $100 in one-time credits before any paid usage begins.
- After credits are consumed, sandbox compute (vCPU/RAM) and snapshot storage are metered; for current rates see https://e2b.dev/pricing.
- A single short task that runs for ~1 minute costs a small fraction of a cent, but Node 22 installation and large snapshots are the main cost drivers to measure.
- Time-travel snapshots are the main wildcard: a full filesystem snapshot per turn is expensive, so Phase 4 should benchmark snapshot size and latency before enabling per-turn snapshots.

### Supabase
- The control plane inserts one `tasks` row per task and one `events` row per stream event (~300–500 events for a short fix run).
- At ~400 events per task, 1,000 tasks/month = ~400K rows and ~200–400 MB depending on payload size, so the 500MB DB cap is the binding constraint before the 500K Edge Function limit.
- The 1000-event Redis `LTRIM` cap and `MAX_TURNS` guardrail also bound Supabase row growth.
- Retention/archival of old `events` rows will be added before moving out of the free tier.

### Langfuse
- Langfuse traces one span per turn; 40 turns × 100 tasks = 4K spans/day, under the 50K units/month quota if averaged.

## Circuit breakers

The agent runner enforces three hard limits by default:

| Limit | Default | Config env |
|-------|---------|------------|
| Max turns | 40 | `MAX_TURNS` |
| Max wall-clock time | 20 minutes | `MAX_WALL_CLOCK_MINUTES` |
| Max cost per task | $0.50 USD | `MAX_COST_USD` |

These are intentionally tight. Raise them only after measuring real usage in your account.
