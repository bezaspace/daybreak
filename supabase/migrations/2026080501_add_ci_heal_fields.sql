-- Phase 5 CI self-healing fields for tasks

alter table if exists tasks
  add column if not exists head_sha text,
  add column if not exists check_run_id text,
  add column if not exists heal_attempt integer;
