-- Phase 2: message model and persistence for the chat-first UI.
-- Normalized chat messages are derived from StreamEvents and stored here so the
-- UI can fetch a conversation thread directly instead of rebuilding it client-side.

create table if not exists task_messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  role text not null,
  type text not null,
  content jsonb not null default '{}'::jsonb,
  status text,
  sequence integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_task_messages_task_id_sequence on task_messages(task_id, sequence);
