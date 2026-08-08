-- Initial baseline schema for the Daybreak control plane.
-- All later migrations add columns/tables with IF NOT EXISTS, so applying this
-- first is safe and makes the local Supabase stack self-contained.

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core tenant/workspace tables first because tasks reference them.
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  value text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (type, value)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('repo', 'sender')),
  value text NOT NULL,
  tasks_per_hour integer NOT NULL DEFAULT 10,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (type, value)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo text NOT NULL,
  branch text NOT NULL,
  pr_branch text NOT NULL,
  status text NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  exit_code integer,
  pr_url text,
  trace_id text,
  provider text,
  cost_usd numeric,
  trigger_source text,
  github_sender text,
  pr_number integer,
  prompt text,
  sandbox_id text,
  keep_alive_until timestamptz,
  workspace_id uuid REFERENCES workspaces(id),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  head_checkpoint_id uuid,
  root_checkpoint_id uuid,
  parent_task_id uuid,
  parent_checkpoint_id uuid,
  head_sha text,
  check_run_id text,
  heal_attempt integer,
  claimed_at timestamptz,
  worker_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  idempotency_key text,
  retry_count integer DEFAULT 0,
  max_retries integer DEFAULT 2,
  next_retry_at timestamptz,
  last_error text,
  archived boolean DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Checkpoints: depends on tasks.
CREATE TABLE IF NOT EXISTS checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn integer NOT NULL DEFAULT 0,
  timestamp timestamptz NOT NULL DEFAULT now(),
  git_commit text,
  session_ref text,
  parent_checkpoint_id uuid,
  branch_task_id uuid,
  status text NOT NULL DEFAULT 'active',
  tool_call_id text,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Add deferred self/cross references now that both tables exist.
ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_head_checkpoint FOREIGN KEY (head_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_tasks_root_checkpoint FOREIGN KEY (root_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_tasks_parent_checkpoint FOREIGN KEY (parent_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_tasks_parent_task FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE checkpoints
  ADD CONSTRAINT fk_checkpoints_parent FOREIGN KEY (parent_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_checkpoints_branch_task FOREIGN KEY (branch_task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- Event stream.
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb DEFAULT '{}'::jsonb,
  timestamp bigint NOT NULL,
  event_id text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (task_id, event_id)
);

-- Normalized chat messages.
CREATE TABLE IF NOT EXISTS task_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role text NOT NULL,
  type text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text,
  sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Durable JSONL session snapshots.
CREATE TABLE IF NOT EXISTS session_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn integer NOT NULL,
  jsonl text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Tenant membership.
CREATE TABLE IF NOT EXISTS tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

-- Idempotency key deduplication.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- Dead-letter queue.
CREATE TABLE IF NOT EXISTS dead_letter_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  repo text,
  branch text,
  pr_branch text,
  error text,
  retry_count integer,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolution text
);

-- Cleanup audit log.
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_count integer NOT NULL DEFAULT 0
);

-- Indexes.
CREATE INDEX IF NOT EXISTS idx_events_task_id_id ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task_id_timestamp ON events(task_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task_id ON checkpoints(task_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_branch ON checkpoints(branch_task_id);
CREATE INDEX IF NOT EXISTS idx_session_snapshots_task_turn ON session_snapshots(task_id, turn);
CREATE INDEX IF NOT EXISTS idx_task_messages_task_id_sequence ON task_messages(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_dead_letter_tasks_task_id ON dead_letter_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_task_id ON idempotency_keys(task_id);
CREATE INDEX IF NOT EXISTS idx_cleanup_runs_started_at ON cleanup_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_pr_branch_status_ended_at ON tasks(pr_branch, status, ended_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sandbox_id_keep_alive ON tasks(sandbox_id, keep_alive_until) WHERE sandbox_id IS NOT NULL;
