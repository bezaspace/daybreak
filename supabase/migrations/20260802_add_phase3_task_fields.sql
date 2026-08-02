alter table tasks
  add column if not exists trigger_source text,
  add column if not exists github_sender text,
  add column if not exists pr_number integer,
  add column if not exists prompt text;
