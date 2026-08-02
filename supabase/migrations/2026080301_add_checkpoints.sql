create table if not exists checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete cascade,
  turn integer not null,
  timestamp timestamptz not null default now(),
  git_commit text,
  session_ref text,
  parent_checkpoint_id uuid references checkpoints(id),
  branch_task_id uuid references tasks(id),
  status text not null default 'active',
  tool_call_id text,
  cost_usd numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Allow this migration to be re-applied against an older checkpoints table that is missing columns.
alter table if exists checkpoints
  add column if not exists git_commit text,
  add column if not exists session_ref text,
  add column if not exists parent_checkpoint_id uuid references checkpoints(id),
  add column if not exists branch_task_id uuid references tasks(id),
  add column if not exists status text not null default 'active',
  add column if not exists tool_call_id text,
  add column if not exists cost_usd numeric,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_checkpoints_task_id on checkpoints(task_id);
create index if not exists idx_checkpoints_parent on checkpoints(parent_checkpoint_id);
create index if not exists idx_checkpoints_branch on checkpoints(branch_task_id);
