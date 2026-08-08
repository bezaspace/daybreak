# Daybreak

Open-source, cloud-native autonomous coding-agent platform with time-travel state branching and full OpenTelemetry lineage, built to run on $0 free-tier infrastructure.

- **Roadmap, status, cost model, and security findings:** [roadmap.md](./roadmap.md)
- **Decision log, environment variables, and secrets reference:** [decisions.md](./decisions.md)
- **Local self-hosting strategy and runbook:** [local-mode-strategy.md](./local-mode-strategy.md)

## Quick start (cloud mode, default)

1. `pnpm install`
2. `cp .env.example .env` and fill in your keys.
3. `pnpm dev` starts the control plane and UI.
4. `pnpm --filter agent-runner build:bundle` builds the sandbox runner.
5. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter ui build` are the required green gates.

## Quick start (local self-hosting)

Local mode runs all backing services on your machine so you can develop and test without spending E2B, Supabase, Upstash, or Langfuse credits.

1. `pnpm install`
2. `pnpm local:up` starts Den, Redis, the UpRedis-compatible REST proxy, Arize Phoenix, and Supabase Local CLI.
3. `pnpm local:down` stops the local stack.
4. `pnpm --filter control-plane dev` and `pnpm --filter ui dev` start the app.
5. `pnpm --filter agent-runner build:bundle` builds the sandbox runner.

The `local-up` script writes `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to `.env.local` automatically; `DAYBREAK_MODE` is set to `local` there. You only need to set `LLM_*` keys if you want the agent to actually call an LLM (without a key the task will fail at the LLM step, but all infrastructure paths still run).

See `local-mode-strategy.md` for the full replacement map, milestones, and switch instructions.
