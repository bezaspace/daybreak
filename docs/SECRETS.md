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
- `GITHUB_TOKEN` — a Personal Access Token (PAT) for Phase 3. It must have `contents:write` and `pull_requests:write` on every repo Daybreak touches. `checks:read` and `issues:read` are useful for context. For fine-grained PATs, grant `Contents` and `Pull requests` read/write on the selected repos.
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
