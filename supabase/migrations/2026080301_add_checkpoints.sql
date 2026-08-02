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

create index if not exists idx_checkpoints_task_id on checkpoints(task_id);
create index if not exists idx_checkpoints_parent on checkpoints(parent_checkpoint_id);
create index if not exists idx_checkpoints_branch on checkpoints(branch_task_id);
