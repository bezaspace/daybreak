# Daybreak Phase 7 Plan — Cloudflare Deployment & v1.0 Release

## Completion status

- **Phases 0–6 are complete in code.** Git history shows implementation commits through `Phase 6 M8/M9`, and the corresponding source files exist (`checkpoint.ts`, `session-store.ts`, `TimeTravelView.tsx`, `TaskQueue`, `CleanupService`, GitHub webhook handlers, etc.).
- **Documentation status is inconsistent:** `roadmap.md` Phase Overview still marks Phases 3 and 4 `[ ]`, but their detailed milestone checklists are mostly `[x]`. Phase 4 M1 doc checkboxes are also still `[ ]` even though `packages/agent-runner/src/spikes/session-fork.ts` and `docs/TIME_TRAVEL.md` exist. These are checkbox-maintenance issues, not missing implementation.
- **Phase 7 is not started.** No `wrangler.toml`, Worker entry, Cloudflare-specific config, or GitHub App authentication exists yet. `packages/control-plane/src/server.ts` is still a Node-only server (`node:child_process`, `node:fs`, `node:os`, `@hono/node-server`).

## Recommended next phase

**Phase 7 — Cloudflare Deployment & v1.0 Release.**

## Should it be implemented in one go?

No. The phase is too large and has an architectural boundary in the middle: the control plane currently spawns a local `pnpm` process to run the E2B sandbox, and Cloudflare Workers cannot do that. The work should be split into **six milestones**, each independently demoable.

## Milestones

### M1 — Cloudflare-Worker-ready control-plane skeleton

- Split `server.ts` into a runtime-agnostic `app.ts` (Hono routes) and a Node-only `server.ts` (local dev server).
- Add `packages/control-plane/wrangler.toml` and a Worker entry (`src/worker.ts`).
- Remove Node-only APIs from the exported control-plane core:
  - Replace `node:crypto` (`createHmac`, `randomUUID`) with Web Crypto.
  - Replace local disk logs (`node:fs`, `node:os.tmpdir`) with a `logs` Supabase table and update `GET /api/tasks/:id/logs`.
  - Replace `node:child_process.spawn` with an `AgentExecutor` abstraction; implement a Node adapter that still runs `pnpm --filter agent-runner sandbox` for local dev.
- Make `@daybreak/shared` config loader accept a `Record<string, string|undefined>` environment so it works without `dotenv` and `node:os`/`node:path` inside a Worker.
- **Acceptance:** `pnpm lint && pnpm typecheck` pass, `wrangler dev --local` serves the API, and local `pnpm dev` still works.

### M2 — Remote agent execution driver on E2B

- Define the `AgentExecutor` interface: `startTask(spec)`, `cancelTask(id)`, `getStatus(id)`, `killSandbox(id)`.
- Add a `packages/agent-runner` build that produces a single `run-task.cjs` bundle suitable to run inside an E2B sandbox without `pnpm`/`tsx`.
- Build and publish a `daybreak-worker` E2B template containing Node 22 + the `run-task.cjs` bundle.
- Implement the Cloudflare `E2BAgentExecutor` using direct E2B REST calls to create a sandbox from the template, start `run-task.cjs` as a background process with the task env vars, and immediately return.
- The running bundle continues to publish stream events to Upstash Redis and checkpoints to Supabase as it does today; the Worker polls Supabase/Redis for completion and uses E2B API for cleanup/cancel.
- **Acceptance:** A task enqueued via the deployed Worker starts an E2B sandbox, runs to completion, and events appear on `GET /api/tasks/:id/events` without any local Node spawn.

### M3 — GitHub App authentication and multi-tenancy

- Register a GitHub App (manual step outside code) and store its private key as a Cloudflare Worker secret.
- Add `packages/control-plane/src/github-app.ts` with JWT signing and `POST /app/installations/{id}/access_tokens` exchange (use the `jose` library, which is Worker-compatible).
- Add an `installations` Supabase table and `tasks.installation_id` foreign key.
- Update tenant resolution to derive the tenant from `payload.installation.id`.
- Replace `GITHUB_TOKEN` usage in `createPullRequest` and sandbox git auth with scoped 1-hour installation tokens.
- Handle `installation` and `installation_repositories` events to auto-subscribe repos instead of relying on a manual allowlist.
- **Acceptance:** A webhook from the GitHub App creates a task, and the resulting PR and commits are authored by the App with an installation token.

### M4 — Dashboard on Cloudflare Pages

- Configure `packages/ui` for a Pages deployment: add `wrangler.toml`/Pages config, make the API base URL env-driven (`VITE_API_URL`), and remove the dev-only Vite proxy for production builds.
- Build and deploy the static UI with `wrangler pages deploy` (or equivalent CI step).
- Keep real-time updates via the existing `GET /api/tasks/:id/stream` SSE endpoint; skip Durable Objects unless free-tier CPU limits prove the polling SSE is too slow.
- **Acceptance:** The public Pages URL loads the dashboard, lists tasks, and streams events from the Worker.

### M5 — Production secrets, webhooks, and operational wiring

- Move all `.env` secrets to Cloudflare Worker Secrets and/or bindings; keep non-secrets (`SUPABASE_URL`, `UPSTASH_REDIS_REST_URL`) in `wrangler.toml` bindings.
- Point the GitHub App webhook URL to the deployed Worker URL.
- Add `DEPLOYMENT.md` with the env-to-binding mapping, GitHub App setup checklist, and operator runbook.
- **Acceptance:** `wrangler deploy` from CI succeeds, the dashboard has a public URL, and a GitHub webhook reaches the Worker.

### M6 — E2E production test and v1.0 release

- Run the full end-to-end production test: GitHub Issue comment `@daybreak-bot` -> Cloudflare Worker -> E2B sandbox -> Upstash stream -> Supabase -> Pages dashboard -> GitHub PR.
- Run the review-comment follow-up and CI self-heal paths against the deployed environment.
- Verify free-tier usage stays within budget.
- Update `README.md` and `roadmap.md` Phase 7 status to `[x]`, tag `v1.0.0`, and write release notes.
- **Acceptance:** The Phase 7 exit criteria in `roadmap.md` 10.10 are met.

## Open risks to watch

- E2B’s TypeScript SDK officially supports Node only; the remote executor must use the REST API or a confirmed edge-compatible patch.
- Long agent runs cannot be awaited inside a Worker request; the design must be enqueue + poll, with the E2B sandbox as the long-running host.
- GitHub App private-key signing with PKCS8 PEM inside a Worker is doable with `jose` but should be tested early in M3.
