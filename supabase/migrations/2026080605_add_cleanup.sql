-- Cleanup audit log and supporting indexes for branch/sandbox/data retention.

create table if not exists cleanup_runs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  details jsonb not null default '{}',
  deleted_count integer not null default 0
);

create index if not exists idx_cleanup_runs_started_at on cleanup_runs(started_at desc);

-- Speed up branch cleanup queries that filter by PR branch prefix, terminal status, and age.
create index if not exists idx_tasks_pr_branch_status_ended_at on tasks(pr_branch, status, ended_at);

-- Speed up sandbox cleanup queries that look for expired keep-alives.
create index if not exists idx_tasks_sandbox_id_keep_alive on tasks(sandbox_id, keep_alive_until) where sandbox_id is not null;
