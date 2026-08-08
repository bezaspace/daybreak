# Local Mode Strategy

**Goal:** Run Daybreak entirely on a developer's machine during testing, eliminating free-tier usage of E2B, Supabase Cloud, Upstash, and Langfuse.

## Concept

A single **Cloud / Local** toggle selects the whole backend package.

- **Cloud mode:** Uses the existing hosted services (E2B, Supabase Cloud, Upstash, Langfuse).
- **Local mode:** Uses self-hosted alternatives orchestrated with Docker Compose.

The toggle is a package switch, not a per-service menu. Cloud mode stays the default so existing behavior is unaffected.

## Replacement map

| Cloud service | Local replacement |
|---|---|
| E2B sandbox | Den |
| Supabase Cloud | Supabase Local CLI |
| Upstash Redis | Local Redis + UpRedis REST proxy |
| Langfuse Cloud | Arize Phoenix (self-hosted) |

## Milestones

All milestones are implemented. Cloud mode remains the default.

1. **Mode package toggle** — `DAYBREAK_MODE=cloud|local` is read from `packages/shared/src/config.ts`. The UI exposes the mode and `TraceView` uses the correct trace provider. ✅
2. **Local observability** — In local mode the agent emits OpenTelemetry spans to Arize Phoenix over OTLP/protobuf at `http://localhost:6006`. ✅
3. **Local event stream** — Local Redis runs on `localhost:6379`; the `up-redis` container exposes an Upstash-compatible REST proxy on `localhost:8079`. The existing `@upstash/redis` SDK is pointed at the proxy. ✅
4. **Local persistence** — Supabase Local CLI provides Postgres/PostgREST on `localhost:54321`. The existing migrations are applied automatically; a grant migration gives `service_role` the privileges it needs. ✅
5. **Local sandbox** — Den is used instead of E2B in local mode. Sandbox containers run on the `den-net` Docker network and resolve `up-redis`, `phoenix`, and `kong` by service name. ✅
6. **Local Docker Compose stack** — `pnpm local:up` starts everything and writes `.env.local` with the local Supabase key. `pnpm local:down` stops it. ✅
7. **Final verification** — `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter ui build`, and `pnpm --filter agent-runner build:bundle` pass. A full local task creates a sandbox, clones the repo, persists events to Supabase, streams them through Redis, and exports traces to Phoenix. It intentionally fails at the LLM step when no key is configured, which proves all infrastructure paths work. ✅

## How to switch between cloud and local

- **Cloud (default):** keep `DAYBREAK_MODE=cloud` in `.env` and fill in the E2B, Supabase, Upstash, and Langfuse keys.
- **Local:** run `pnpm local:up`, then start `pnpm --filter control-plane dev` and `pnpm --filter ui dev` from the same checkout. The `local-up` script writes `.env.local` with `DAYBREAK_MODE=local` and the local service URLs. To go back, stop the control-plane/UI and run `pnpm local:down`.

The precedence is: system environment < `.env` < `.env.local`, so `.env.local` can override cloud credentials that happen to be in the shell environment.

## Default local ports

| Service | Host port | Notes |
|---|---|---|
| Den | 8080 | Listens on host network; spawned sandboxes join `den-net`. |
| Arize Phoenix | 6006 | OTLP endpoint at `/v1/traces`. |
| Redis | 6379 | Used internally by `up-redis`. |
| up-redis | 8079 | Upstash-compatible REST proxy; maps to container port `8080`. |
| Supabase API | 54321 | PostgREST/Realtime/Kong. |
| Supabase DB | 54322 | Postgres direct connection. |
| Supabase Studio | 54323 | Optional web UI for inspecting local tables. |

## Guiding principles

- Cloud mode remains the default.
- Each provider is swappable behind the mode switch without rewriting core logic.
- Keep existing APIs, SDKs, and migrations; only change endpoints or credentials.
- Prefer mature, open-source, self-hostable tools.
- Ports, paths, and timeouts are configured through environment variables; sensible defaults are documented in `.env.example`.
