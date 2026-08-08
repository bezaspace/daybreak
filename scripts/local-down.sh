#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[local-down] stopping Supabase local stack..."
npx supabase stop || true

echo "[local-down] stopping Docker Compose stack..."
docker compose -f docker-compose.local.yml down

echo "[local-down] local stack stopped."
