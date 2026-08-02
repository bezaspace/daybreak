create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('repo', 'sender')),
  value text not null,
  tasks_per_hour integer not null default 10,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(type, value)
);

alter table tasks
  add column if not exists workspace_id uuid references workspaces(id);
