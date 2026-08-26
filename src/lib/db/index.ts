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
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) db.close();
}
