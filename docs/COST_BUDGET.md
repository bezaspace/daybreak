# Cost and quota budget

Daybreak is designed to live on free-tier infrastructure. This document records the free quotas, expected burn rates, and the guardrails that enforce them.

## Free-tier quotas

| Service | Free tier | Source |
|---------|-----------|--------|
| **Upstash Redis** | 256 MB data, 500K commands/month, 10 GB bandwidth, 10K max commands/sec | Upstash free tier |
| **Supabase** | 500 MB DB, 5 GB egress, 1 GB file storage, 50K MAU, 2 projects, 500K Edge Function invocations/month | Supabase free tier |
| **Langfuse** | 50K units/month on Hobby plan | Langfuse pricing |
| **Daytona** | $200 in free credits; vCPU $0.0504/h, RAM $0.0162/GiB/h, storage first 5 GB free then $0.000108/GiB/h | Daytona pricing |
| **Groq** | 30 RPM, 6K TPM, 1K RPD for most models | Groq docs |
| **OpenRouter free** | 50 requests/day, 20 RPM | OpenRouter docs |

## Model cost assumptions

Free providers are used wherever possible. For paid fallbacks, the target model is a small, cheap model such as `gpt-4o-mini` or `inclusionai/Ling-3.0-flash:free`:

- Typical agent turn: ~2K input tokens + ~1K output tokens.
- At OpenAI `gpt-4o-mini` rates: ~$0.0005 per prompt + $0.0006 per completion = **~$0.0011 per turn**.
- A 40-turn task therefore costs roughly **$0.044**, well under the default `MAX_COST_USD=0.50`.

## Infrastructure burn rates

### Redis
- Each task turn may read/write state and stream stdout chunks. At 10 commands per turn and a 40-turn task, one task uses ~400 Redis commands.
- Free quota: **500K commands/month** → ~1,250 tasks/month.
- **Guardrail:** `MAX_TURNS` and stream batching limit command volume.

### Daytona
- A sandbox running 1 vCPU + 2 GiB RAM costs ~$0.083/h.
- `$200` credits ≈ **2,400 sandbox-hours**.
- A single task that runs for 5 minutes costs ~$0.0069.
- Time-travel snapshots are the main wildcard: a full filesystem snapshot per turn is expensive, so Phase 4 should benchmark snapshot size and latency before enabling per-turn snapshots.

### Supabase / Langfuse
- Database writes are batched per task, not per turn.
- Langfuse traces one span per turn; 40 turns × 100 tasks = 4K spans/day, under the 50K units/month quota if averaged.

## Circuit breakers

The agent runner enforces three hard limits by default:

| Limit | Default | Config env |
|-------|---------|------------|
| Max turns | 40 | `MAX_TURNS` |
| Max wall-clock time | 20 minutes | `MAX_WALL_CLOCK_MINUTES` |
| Max cost per task | $0.50 USD | `MAX_COST_USD` |

These are intentionally tight. Raise them only after measuring real usage in your account.
