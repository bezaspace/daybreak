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
- The agent should never read this from inside a sandbox. The control plane injects a short-lived sandbox API key only when spawning a workspace.

### GitHub
- `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET` — GitHub App configuration.
- `GITHUB_TOKEN` — per-installation token with limited scopes (`contents:write`, `pull_requests:write`, `checks:read`, `issues:read`).
- Store `GITHUB_WEBHOOK_SECRET` as a Cloudflare secret and verify HMAC in the worker.

### Redis / Supabase / Langfuse
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_TOKEN` are high-sensitivity; the sandbox uses them to publish the event stream and the control plane uses them to read it back.
- `SUPABASE_SERVICE_KEY` is high-sensitivity and is used by the control plane to persist tasks and events.
- Langfuse keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) are lower risk but still kept out of source control.

## Never commit secrets

The repo uses a denylist that blocks the agent from reading files matching sensitive patterns such as `.env`, `*.pem`, `*.key`, `.npmrc`, and paths containing `secret`/`token`/`password`. CI rejects pushes that add unencrypted secret files.

## Generating `.env` locally

```bash
cp .env.example .env
# edit .env with your keys
```

`.env` is already in `.gitignore`.
