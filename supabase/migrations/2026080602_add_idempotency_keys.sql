-- Phase 6 M2: idempotency keys and delivery deduplication

alter table if exists tasks
  add column if not exists idempotency_key text;

create table if not exists idempotency_keys (
  key text primary key,
  task_id uuid references tasks(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_idempotency_keys_task_id on idempotency_keys(task_id);
