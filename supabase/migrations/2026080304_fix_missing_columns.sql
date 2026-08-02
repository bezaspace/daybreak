-- Fix missing columns in tasks and checkpoints for environments that had an older
-- baseline schema before the Phase 3/4 migrations were finalized.

alter table if exists tasks
  add column if not exists cost_usd numeric,
  add column if not exists trigger_source text,
  add column if not exists github_sender text,
  add column if not exists pr_number integer,
  add column if not exists prompt text,
  add column if not exists provider text,
  add column if not exists pr_url text,
  add column if not exists exit_code integer,
  add column if not exists trace_id text,
  add column if not exists sandbox_id text,
  add column if not exists keep_alive_until timestamptz,
  add column if not exists workspace_id uuid references workspaces(id),
  add column if not exists head_checkpoint_id uuid,
  add column if not exists root_checkpoint_id uuid,
  add column if not exists parent_task_id uuid references tasks(id) on delete set null,
  add column if not exists parent_checkpoint_id uuid references checkpoints(id) on delete set null;

alter table if exists checkpoints
  add column if not exists id uuid default gen_random_uuid() not null,
  add column if not exists task_id uuid,
  add column if not exists turn integer not null default 0,
  add column if not exists timestamp timestamptz not null default now(),
  add column if not exists git_commit text,
  add column if not exists session_ref text,
  add column if not exists parent_checkpoint_id uuid,
  add column if not exists branch_task_id uuid,
  add column if not exists status text not null default 'active',
  add column if not exists tool_call_id text,
  add column if not exists cost_usd numeric,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Existing deployments already have primary/foreign key constraints for checkpoints.
-- This migration only adds columns that might be missing from older baselines.
