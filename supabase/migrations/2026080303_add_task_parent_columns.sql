alter table tasks
  add column if not exists parent_task_id uuid references tasks(id) on delete set null,
  add column if not exists parent_checkpoint_id uuid references checkpoints(id) on delete set null;
