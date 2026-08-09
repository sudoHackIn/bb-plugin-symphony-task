import type { BbPluginApi } from "@bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
      next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
      color TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      linked_bb_project_id TEXT,
      created_at TEXT NOT NULL,
      CHECK (prefix = upper(prefix)),
      CHECK (linked_bb_project_id IS NULL OR linked_bb_project_id GLOB 'proj_*')
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL CHECK (number >= 1),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled')),
      priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
      due_date TEXT,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      position REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, number),
      CHECK (parent_task_id IS NULL OR parent_task_id <> id),
      CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    );

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL,
      UNIQUE (project_id, name)
    );

    CREATE TABLE IF NOT EXISTS task_labels (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'system')),
      author_name TEXT NOT NULL,
      preset_name TEXT,
      thread_id TEXT,
      body TEXT NOT NULL,
      notified_count INTEGER NOT NULL DEFAULT 0 CHECK (notified_count >= 0),
      created_at TEXT NOT NULL,
      CHECK (thread_id IS NULL OR thread_id GLOB 'thr_*')
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      blob_path TEXT NOT NULL,
      is_image INTEGER NOT NULL CHECK (is_image IN (0, 1)),
      created_at TEXT NOT NULL,
      CHECK ((task_id IS NOT NULL AND comment_id IS NULL) OR (task_id IS NULL AND comment_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS task_threads (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      preset_name TEXT NOT NULL,
      title TEXT NOT NULL,
      live_status TEXT NOT NULL CHECK (live_status IN ('starting', 'working', 'idle', 'completed', 'failed')),
      attached_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, thread_id),
      CHECK (thread_id GLOB 'thr_*')
    );

    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      instructions TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);
    CREATE INDEX IF NOT EXISTS idx_projects_folder ON projects(folder_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(project_id, status, position);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, position);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_comments_task_order ON comments(task_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
    CREATE INDEX IF NOT EXISTS idx_task_threads_task_status ON task_threads(task_id, live_status);
    CREATE INDEX IF NOT EXISTS idx_task_threads_thread ON task_threads(thread_id);
  `,
  `
    UPDATE attachments
    SET is_image = CASE
      WHEN lower(mime) IN (
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'image/avif'
      ) THEN 1
      ELSE 0
    END;
  `,
  `
    ALTER TABLE presets
      ADD COLUMN environment_kind TEXT NOT NULL DEFAULT 'project-default'
      CHECK (environment_kind IN ('project-default', 'new-worktree'));
    ALTER TABLE presets ADD COLUMN base_branch TEXT;
    ALTER TABLE presets ADD COLUMN machine_id TEXT;
  `,
  `
    CREATE TABLE task_list_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    INSERT INTO task_list_revision (id, revision) VALUES (1, 0);

    CREATE TRIGGER task_list_revision_tasks_insert
    AFTER INSERT ON tasks BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_tasks_update
    AFTER UPDATE ON tasks BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_tasks_delete
    AFTER DELETE ON tasks BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER task_list_revision_labels_insert
    AFTER INSERT ON task_labels BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_labels_delete
    AFTER DELETE ON task_labels BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_label_names
    AFTER UPDATE OF name ON labels
    WHEN OLD.name <> NEW.name BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER task_list_revision_threads_insert
    AFTER INSERT ON task_threads BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_threads_update
    AFTER UPDATE ON task_threads BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_threads_delete
    AFTER DELETE ON task_threads BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER task_list_revision_project_prefix
    AFTER UPDATE OF prefix ON projects
    WHEN OLD.prefix <> NEW.prefix BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE INDEX idx_tasks_manual_page
      ON tasks(project_id, status, position, id);
    CREATE INDEX idx_tasks_priority_page ON tasks(
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        WHEN 'none' THEN 4
        ELSE 5
      END,
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date,
      project_id,
      status,
      position,
      id
    );
    CREATE INDEX idx_tasks_due_page ON tasks(
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date,
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        WHEN 'none' THEN 4
        ELSE 5
      END,
      project_id,
      status,
      position,
      id
    );
  `,
  `
    UPDATE presets
    SET permission_mode = CASE permission_mode
      WHEN 'workspace-write' THEN 'accept-edits'
      WHEN 'readonly' THEN 'accept-edits'
    END
    WHERE permission_mode IN ('workspace-write', 'readonly');
  `,
  `
    CREATE TABLE execution_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      max_workers INTEGER NOT NULL DEFAULT 2 CHECK (max_workers BETWEEN 1 AND 32),
      poll_interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK (poll_interval_seconds BETWEEN 5 AND 3600),
      default_token_budget INTEGER CHECK (default_token_budget IS NULL OR default_token_budget >= 1000),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
      updated_at TEXT NOT NULL
    );

    INSERT INTO execution_config (
      id,
      enabled,
      max_workers,
      poll_interval_seconds,
      default_token_budget,
      max_attempts,
      updated_at
    ) VALUES (1, 0, 2, 30, NULL, 3, CURRENT_TIMESTAMP);

    CREATE TABLE project_execution_policies (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'off'
        CHECK (mode IN ('off', 'opt_in', 'all_todo')),
      preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
      max_workers INTEGER CHECK (max_workers IS NULL OR max_workers BETWEEN 1 AND 32),
      token_budget INTEGER CHECK (token_budget IS NULL OR token_budget >= 1000),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE task_execution_policies (
      tracker TEXT NOT NULL CHECK (tracker IN ('local', 'beads', 'jira')),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('inherit', 'enabled', 'disabled')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tracker, project_id, work_item_id)
    );

    CREATE TABLE execution_runs (
      id TEXT PRIMARY KEY,
      tracker TEXT NOT NULL CHECK (tracker IN ('local', 'beads', 'jira')),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      task_title TEXT NOT NULL,
      external_version TEXT NOT NULL,
      thread_id TEXT UNIQUE,
      claim_id TEXT NOT NULL UNIQUE,
      claim_expires_at TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'claimed',
        'starting',
        'running',
        'waiting_review',
        'completed',
        'failed',
        'budget_exhausted',
        'canceled',
        'released'
      )),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
      token_budget INTEGER CHECK (token_budget IS NULL OR token_budget >= 1000),
      tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
      last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX execution_runs_one_active_item
      ON execution_runs(tracker, project_id, work_item_id)
      WHERE status IN ('claimed', 'starting', 'running');
    CREATE INDEX execution_runs_status_updated
      ON execution_runs(status, updated_at);
    CREATE INDEX execution_runs_project_status
      ON execution_runs(project_id, status, updated_at);
    CREATE INDEX execution_runs_thread
      ON execution_runs(thread_id) WHERE thread_id IS NOT NULL;
  `,
] as const;

export function initializeTasksSchema(db: PluginDatabase): void {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const hasVersion = db.prepare<[number], { found: number }>(
    "SELECT 1 AS found FROM schema_version WHERE version = ?",
  );
  const recordVersion = db.prepare<[number, string]>(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
  );

  const migrate = db.transaction(() => {
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (hasVersion.get(version)) continue;
      db.exec(sql);
      recordVersion.run(version, new Date().toISOString());
    }
  });

  migrate();
}
