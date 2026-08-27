import Database from "better-sqlite3";
import { CONTROL_PLANE_SCHEMA, SCHEMA_VERSION } from "./schema";

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

/** Open and initialize a control-plane database. */
export function openDatabase(
  filename = ":memory:",
  options: OpenDatabaseOptions = {},
): SqliteDatabase {
  const db = new Database(filename, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
    timeout: 5_000,
  });
  if (options.readonly) {
    db.pragma("foreign_keys = ON");
  } else {
    initializeDatabase(db);
  }
  return db;
}

/** Initialize an already-open database. Safe to call more than once. */
export function initializeDatabase(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(CONTROL_PLANE_SCHEMA);
  // The control-plane database predates explicit project ownership. Keep
  // existing installations safe by treating legacy rows as manager-owned and
  // adding the column without recreating or rewriting the projects table.
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "ownership")) {
    db.exec("ALTER TABLE projects ADD COLUMN ownership TEXT NOT NULL DEFAULT 'manager-owned' CHECK (ownership IN ('manager-owned', 'external'))");
  }
  const jobsTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string } | undefined;
  if (jobsTable && !jobsTable.sql.includes("'update-project'")) {
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        CREATE TABLE jobs_v3 (
          id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('create-project', 'update-project', 'start-project', 'stop-project', 'restart-project', 'delete-project', 'check-project')),
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          requested_by TEXT NOT NULL REFERENCES users(id),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          stage TEXT,
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        INSERT INTO jobs_v3 SELECT * FROM jobs;
        DROP TABLE jobs;
        ALTER TABLE jobs_v3 RENAME TO jobs;
        CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
      `);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) db.close();
}
