-- Durable JSONL session snapshots for cross-sandbox restore.
create table if not exists session_snapshots (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  turn integer not null,
  jsonl text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_session_snapshots_task_turn on session_snapshots(task_id, turn);

-- Track the current head and the root checkpoint of a task.
alter table if exists tasks
  add column if not exists head_checkpoint_id uuid,
  add column if not exists root_checkpoint_id uuid;
