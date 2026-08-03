ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at);
