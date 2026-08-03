-- Phase 6 M1: durable task queue and concurrency control

alter table if exists tasks
  add column if not exists claimed_at timestamptz,
  add column if not exists worker_id text,
  add column if not exists metadata jsonb default '{}'::jsonb;

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
      order by started_at asc nulls last, created_at asc nulls last, id asc
      for update skip locked
      limit 1
    )
    returning *;
end;
$$;
