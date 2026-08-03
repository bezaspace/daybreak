-- Phase 6 M3: retry engine and dead-letter handling

alter table if exists tasks
  add column if not exists retry_count integer default 0,
  add column if not exists max_retries integer default 2,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_error text;

create table if not exists dead_letter_tasks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete set null,
  repo text,
  branch text,
  pr_branch text,
  error text,
  retry_count integer,
  created_at timestamptz default now(),
  resolved_at timestamptz,
  resolution text
);

create index if not exists idx_dead_letter_tasks_task_id on dead_letter_tasks(task_id);

create or replace function claim_next_pending_task(max_concurrent integer, worker_id text default null)
returns setof tasks
language plpgsql
as $$
declare
  running_count integer;
begin
  select count(*) into running_count from tasks where status = 'running';
  if running_count >= max_concurrent then
    return;
  end if;

  return query
    update tasks
    set status = 'running', claimed_at = now(), worker_id = claim_next_pending_task.worker_id
    where id = (
      select id
      from tasks
      where status = 'pending'
         or (status = 'retry_scheduled' and (next_retry_at is null or next_retry_at <= now()))
      order by started_at asc nulls last, created_at asc nulls last, id asc
      for update skip locked
      limit 1
    )
    returning *;
end;
$$;
