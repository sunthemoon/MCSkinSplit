import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial revision schema",
    sql: readFileSync(new URL("./migrations/001_initial.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    name: "reusable part assets",
    sql: readFileSync(new URL("./migrations/002_parts.sql", import.meta.url), "utf8"),
  },
  {
    version: 3,
    name: "AI jobs and auditable runs",
    sql: readFileSync(new URL("./migrations/003_ai_jobs.sql", import.meta.url), "utf8"),
  },
  {
    version: 4,
    name: "composition projects and ordered layers",
    sql: readFileSync(new URL("./migrations/004_compositions.sql", import.meta.url), "utf8"),
  },
  {
    version: 5,
    name: "aggregate part bundles",
    sql: readFileSync(new URL("./migrations/005_part_bundles.sql", import.meta.url), "utf8"),
  },
];

export function openRevisionDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath, { timeout: 5_000 });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("trusted_schema = OFF");
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function applyMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const current = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration")
    .get() as { version: number };

  for (const migration of migrations) {
    if (migration.version <= current.version) {
      continue;
    }

    const run = database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, new Date().toISOString());
    });
    run.immediate();
  }
}
