#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${REPO_URL:-https://github.com/bezaspace/daybreak-target}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
PROMPT="${PROMPT:-Fix the failing test in this repository. Read the source and test files, understand the bug, make the minimal fix, and run the test command until it passes.}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:8787}"
DEN_URL="${DEN_URL:-http://127.0.0.1:8080}"
LLM_MODEL="${LLM_MODEL:-inclusionai/ling-3.0-tiny:free}"
MAX_TURNS="${MAX_TURNS:-20}"
MAX_COST_USD="${MAX_COST_USD:-0.10}"
MAX_WALL_CLOCK_MINUTES="${MAX_WALL_CLOCK_MINUTES:-10}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
POLL_TIMEOUT="${POLL_TIMEOUT:-900}"

cd "$REPO_DIR"

# Ensure the local Docker stack is running.
if ! curl -fsS "$DEN_URL/api/v1/health" >/dev/null 2>&1; then
  echo "[run-local-e2e] starting local stack..."
  pnpm local:up
else
  echo "[run-local-e2e] local stack already running"
fi

# Build the agent runner bundle.
echo "[run-local-e2e] building agent bundle..."
pnpm --filter agent-runner build:bundle

# Start the control plane in the background if it isn't reachable.
CP_PID=""
if ! curl -fsS "$CONTROL_PLANE_URL/api/queue/status" >/dev/null 2>&1; then
  echo "[run-local-e2e] starting control plane..."
  # Export the corrected model so the secret value with an invalid suffix is overridden.
  export LLM_MODEL
  (cd packages/control-plane && pnpm exec tsx src/server.ts) &
  CP_PID=$!
  for i in $(seq 1 30); do
    if curl -fsS "$CONTROL_PLANE_URL/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "$CONTROL_PLANE_URL/api/queue/status" >/dev/null 2>&1; then
    echo "[run-local-e2e] control plane failed to start" >&2
    exit 1
  fi
fi

cleanup() {
  if [ -n "$CP_PID" ] && kill -0 "$CP_PID" 2>/dev/null; then
    echo "[run-local-e2e] stopping control plane (pid $CP_PID)..."
    kill "$CP_PID" 2>/dev/null || true
    wait "$CP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Trigger a task.
echo "[run-local-e2e] triggering task..."
RESPONSE=$(curl -s -X POST "$CONTROL_PLANE_URL/api/tasks" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: local-e2e-$(date +%s%N)" \
  -d "{\"repo\":\"$REPO_URL\",\"branch\":\"$TARGET_BRANCH\",\"prompt\":\"$PROMPT\",\"maxTurns\":$MAX_TURNS,\"maxCostUsd\":$MAX_COST_USD,\"maxWallClockMinutes\":$MAX_WALL_CLOCK_MINUTES}")
TASK_ID=$(echo "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["taskId"])')
echo "[run-local-e2e] task id: $TASK_ID"

LOG_FILE="/tmp/daybreak-logs/$TASK_ID.log"
STARTED=$(date +%s)
while true; do
  STATUS_JSON=$(curl -s "$CONTROL_PLANE_URL/api/tasks/$TASK_ID")
  STATUS=$(echo "$STATUS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
  PR_URL=$(echo "$STATUS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("prUrl",""))')
  echo "[run-local-e2e] $(date -Iseconds) status=$STATUS pr=$PR_URL"

  if [ "$STATUS" = "complete" ] || [ "$STATUS" = "failed" ]; then
    break
  fi

  NOW=$(date +%s)
  if [ $((NOW - STARTED)) -ge "$POLL_TIMEOUT" ]; then
    echo "[run-local-e2e] timed out waiting for task" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL"
done

if [ "$STATUS" = "complete" ]; then
  echo "[run-local-e2e] task completed: $PR_URL"
else
  echo "[run-local-e2e] task failed" >&2
  if [ -f "$LOG_FILE" ]; then
    echo "[run-local-e2e] --- task log ---"
    tail -n 80 "$LOG_FILE"
  fi
  echo "[run-local-e2e] --- events ---"
  curl -s "$CONTROL_PLANE_URL/api/tasks/$TASK_ID/events" | python3 -m json.tool 2>/dev/null | tail -n 60
  exit 1
fi
