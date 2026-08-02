alter table tasks
  add column if not exists sandbox_id text,
  add column if not exists keep_alive_until timestamptz;
