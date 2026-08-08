# Daybreak

Open-source, cloud-native autonomous coding-agent platform with time-travel state branching and full OpenTelemetry lineage, built to run on $0 free-tier infrastructure.

- **Roadmap, status, cost model, and security findings:** [roadmap.md](./roadmap.md)
- **Decision log, environment variables, and secrets reference:** [decisions.md](./decisions.md)

## Quick start

1. `pnpm install`
2. `cp .env.example .env` and fill in your keys.
3. `pnpm dev` starts the control plane and UI.
4. `pnpm --filter agent-runner build:bundle` builds the sandbox runner.
5. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter ui build` are the required green gates.

See `roadmap.md` for the current state (Phases 0–6 complete, Phase 7 deployment pending) and `decisions.md` for the architectural rationale.
