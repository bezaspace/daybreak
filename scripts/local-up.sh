#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[local-up] starting local backing services (Den, Redis/up-redis, Phoenix)..."
docker compose -f docker-compose.local.yml up -d --build

echo "[local-up] waiting for Den health endpoint..."
for i in {1..60}; do
  if curl -fsS http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1; then
    echo "[local-up] Den is healthy"
    break
  fi
  sleep 1
done

echo "[local-up] waiting for Phoenix..."
for i in {1..60}; do
  if curl -fsS http://127.0.0.1:6006/healthz >/dev/null 2>&1; then
    echo "[local-up] Phoenix is healthy"
    break
  fi
  sleep 1
done

echo "[local-up] waiting for up-redis..."
for i in {1..60}; do
  if curl -fsS http://127.0.0.1:8079/health >/dev/null 2>&1; then
    echo "[local-up] up-redis is healthy"
    break
  fi
  sleep 1
done

if [ ! -f supabase/config.toml ]; then
  echo "[local-up] initializing supabase project..."
  npx supabase init
fi

echo "[local-up] starting Supabase local stack on den-net..."
npx supabase start --network-id den-net

echo "[local-up] reading Supabase credentials..."
SUPABASE_ENV=$(npx supabase status -o env)

SUPABASE_URL=$(echo "$SUPABASE_ENV" | awk -F= '/^API_URL=/{print $2}' | tr -d '"')
SUPABASE_SERVICE_KEY=$(echo "$SUPABASE_ENV" | awk -F= '/^SERVICE_ROLE_KEY=/{print $2}' | tr -d '"')

echo "[local-up] writing .env.local..."
cat > .env.local <<EOF
DAYBREAK_MODE=local
DEN_URL=http://127.0.0.1:8080
DEN_API_KEY=
PHOENIX_URL=http://127.0.0.1:6006
PHOENIX_PROJECT=default
PHOENIX_API_KEY=
UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079
UPSTASH_REDIS_TOKEN=local-token
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
SANDBOX_SUPABASE_URL=http://kong:8000
SANDBOX_UPSTASH_REDIS_REST_URL=http://up-redis:8080
SANDBOX_PHOENIX_URL=http://phoenix:6006
EOF

echo "[local-up] local stack is ready."
echo "[local-up] Run 'pnpm --filter control-plane dev' and 'pnpm --filter ui dev' to start the app."
