-- Fix: claim_next_pending_task must exclude soft-deleted tasks (deleted_at IS NOT NULL).
-- Without this, deleted tasks get resurrected as "running" on server restart.

create or replace function claim_next_pending_task(max_concurrent integer, worker_id text default null)
returns setof tasks
language plpgsql
as $$
declare
  running_count integer;
begin
  select count(*) into running_count from tasks where status = 'running' and deleted_at is null;
  if running_count >= max_concurrent then
    return;
  end if;

  return query
    update tasks
    set status = 'running', claimed_at = now(), worker_id = claim_next_pending_task.worker_id
    where id = (
      select id
      from tasks
      where (status = 'pending'
             or (status = 'retry_scheduled' and (next_retry_at is null or next_retry_at <= now())))
        and deleted_at is null
      order by started_at asc nulls last, created_at asc nulls last, id asc
      for update skip locked
      limit 1
    )
    returning *;
end;
$$;
