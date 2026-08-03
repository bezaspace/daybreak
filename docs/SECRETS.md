# Secrets management strategy

Daybreak needs several credentials across its lifecycle. This document explains how they are scoped, stored, and rotated. The actual values must never be committed.

## Environments

| Environment | Use case | Storage |
|-------------|----------|---------|
| Local development (Phase 0) | Running the agent spike and evals | `.env` file loaded by `dotenv` |
| CI (GitHub Actions) | Lint, typecheck, tests | Repository `Secrets` / `Variables` |
| Cloudflare Workers | Control plane, GitHub App, queue, UI | `wrangler secret` / `wrangler.toml` vars (non-sensitive only) |
| E2B | Sandbox API key | Cloudflare secret, passed to the sandbox at creation time |
| Supabase | Database, Edge Functions | Supabase Vault / project API keys, stored in Cloudflare secrets |

## Secret inventory

### LLM providers
- `LLM_API_KEY` and `LLM_FALLBACK_API_KEY` — primary and fallback OpenAI-compatible API keys.
- Rotate keys through the provider dashboard. Use `LLM_FALLBACK_*` so the agent can degrade gracefully on rate limits.

### E2B
- `E2B_API_KEY` — create/destroy sandboxes.
- `E2B_TEMPLATE` — optional sandbox template name. The built-in `daybreak-browser` template ships Node 22, Chromium, and `playwright-core` for the browser tool. Leave unset or set to `base` for the default template.
- The agent should never read this from inside a sandbox. The control plane injects a short-lived sandbox API key only when spawning a workspace.

### GitHub
- `GITHUB_TOKEN` — a Personal Access Token (PAT) for Phase 3 and Phase 5. It must have `contents:write` and `pull_requests:write` on every repo Daybreak touches. Phase 5 additionally requires `actions:read` and `checks:read` to fetch failed CI job logs and annotations (these are usually included in the `repo` scope of a classic PAT). For fine-grained PATs, grant `Contents`, `Pull requests`, `Actions`, and `Checks` read/write on the selected repos.
- `GITHUB_WEBHOOK_SECRET` — used to verify `X-Hub-Signature-256` on repo webhook deliveries. Store it as a Cloudflare/Worker secret for Phase 7; locally it lives in `.env`.
- `GITHUB_WEBHOOK_REPO_ALLOWLIST` — comma-separated `owner/repo` or `owner/*` patterns limiting which repos may trigger the control plane.
- `GITHUB_WEBHOOK_RATE_LIMIT` — maximum webhook-triggered tasks per repo or per sender in the last hour (default `10`).
- `GITHUB_APP_ID` — **deferred to Phase 7**. The App will replace the PAT, add JWT signing, 1-hour installation tokens, and automatic per-installation webhooks.

### Local webhook tunnel
For Phase 3, the control plane runs locally and receives repo webhooks through a tunnel:

```bash
# Install cloudflared (or use ngrok)
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:8787
```

Copy the tunnel URL (e.g. `https://<random>.trycloudflare.com`) and add it as a webhook in the target repo:

1. Repo **Settings** → **Webhooks** → **Add webhook**.
2. **Payload URL**: `https://<random>.trycloudflare.com/api/webhooks/github`
3. **Content type**: `application/json`.
4. **Secret**: the value of `GITHUB_WEBHOOK_SECRET`.
5. Choose **Issue comments**, **Pull request review comments**, **Pull request reviews**, and **Check runs** (check runs are deferred but subscribed now to avoid reconfiguring later).
6. Ensure the repo is in `GITHUB_WEBHOOK_REPO_ALLOWLIST`.

### Redis / Supabase / Langfuse
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_TOKEN` are high-sensitivity; the sandbox uses them to publish the event stream and the control plane uses them to read it back.
- `SUPABASE_SERVICE_KEY` is high-sensitivity and is used by the control plane to persist tasks and events.
- Langfuse keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) are lower risk but still kept out of source control.

## Phase 6 runtime configuration (M1-M9)

These values are not secrets but are documented here because they are tenant- and quota-sensitive:

- `DAYBREAK_MAX_CONCURRENT_TASKS` — default `2`; raise only after measuring E2B and Supabase usage.
- `DAYBREAK_QUEUE_WORKER_POLL_MS` — default `1000`; controls how often the worker polls Supabase.
- `DAYBREAK_DEFAULT_TENANT_DAILY_COST_USD` — default `0.50`.
- `DAYBREAK_DEFAULT_TENANT_TASKS_PER_HOUR` — default `10`.
- `DAYBREAK_DEFAULT_TENANT_MAX_CONCURRENT` — default `2`.
- `DAYBREAK_GLOBAL_MAX_CONCURRENT_SANDBOXES` — default `5`; hard ceiling across all tenants.
- `DAYBREAK_COST_ALERT_THRESHOLD` — default `0.8` (fraction of `MAX_COST_USD`).
- `DAYBREAK_BRANCH_TTL_DAYS` — default `7`; how long stale `daybreak/` branches are kept.
- `DAYBREAK_SANDBOX_IDLE_TTL_MINUTES` — default `15`; grace period before an idle or terminal sandbox is killed.
- `DAYBREAK_DATA_RETENTION_DAYS` — default `30`; old `session_snapshots` and active checkpoints are pruned after this.
- `DAYBREAK_CLEANUP_ENABLED` — default `true`; set to `false` to disable the background cleanup interval.
- `DAYBREAK_MAX_FILE_READ_BYTES` — default `200000`; hard cap on `read`/`write`/`edit` target file bytes.
- `DAYBREAK_MAX_FILE_READ_LINES` — default `5000`; hard cap on `read`/`write`/`edit` target file line count.
- `DAYBREAK_MAX_REPO_CLONE_DEPTH` — default `0`; set to `>0` to clone repos with `--depth N`.
- `DAYBREAK_PROVIDER_FAILURE_THRESHOLD` — default `3`; consecutive 5xx/429 errors before fail-fast to fallback.
- `DAYBREAK_COMPACTION_RESERVE_TOKENS` — default `4000`; token headroom before `compaction_advised` is emitted.
- `DAYBREAK_COMPACTION_KEEP_RECENT_TOKENS` — default `8000`; recent messages preserved during Pi compaction.

### Tenant headers

For local testing and Phase 7 per-installation routing, the control plane accepts:

- `X-Daybreak-Tenant-Id` — override the tenant id for a request.
- `X-Daybreak-User-Id` — identify the caller within the tenant.
- `X-Daybreak-Role` — one of `admin`, `operator`, `viewer`. `viewer` cannot create tasks.

If no tenant headers are sent, the control plane creates or reuses a default tenant so existing single-user demos continue to work.

## Never commit secrets

The repo uses a denylist that blocks the agent from reading files matching sensitive patterns such as `.env`, `*.pem`, `*.key`, `.npmrc`, and paths containing `secret`/`token`/`password`. CI rejects pushes that add unencrypted secret files.

### Eval harness

- `CONTROL_PLANE_URL` — optional; defaults to `http://localhost:8787` for `pnpm eval:e2e`.
- `EVAL_TARGET_REPO` and `EVAL_TARGET_BRANCH` — optional; the repo/branch the E2E eval harness tests (default `https://github.com/bezaspace/daybreak-target` `main`).
- `EVAL_TIMEOUT_MS` — optional timeout for each E2E eval case (default 10 minutes).

## Generating `.env` locally

```bash
cp .env.example .env
# edit .env with your keys
```

`.env` is already in `.gitignore`.
