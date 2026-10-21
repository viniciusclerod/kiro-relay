import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteUnavailableError } from './errors.ts';

export interface SnapshotDb {
  /** Runs a SELECT and returns all rows. */
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  tables(): string[];
}

interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

export async function loadNodeSqlite(): Promise<NodeSqliteModule> {
  try {
    return (await import('node:sqlite')) as unknown as NodeSqliteModule;
  } catch (cause) {
    throw new SqliteUnavailableError(cause);
  }
}

async function copyIfExists(from: string, to: string): Promise<void> {
  try {
    await fs.copyFile(from, to);
    await fs.chmod(to, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Opens a SNAPSHOT of the database: copies the file (and the -wal, if any) to a
 * private temporary directory and opens the copy. The original is never opened,
 * so we never create -shm/-wal files or lock anything next to kiro-cli's
 * database, and real SQLite applies the WAL correctly (unlike a reader of "only
 * the main file", which could return a token that was already replaced).
 *
 * The WAL is copied BEFORE the main file: if a checkpoint happens in between,
 * the copied main file already has everything; replaying old frames is harmless.
 * The copy (which contains tokens) is deleted at the end, even on error.
 */
export async function withSnapshot<T>(
  dbPath: string,
  fn: (db: SnapshotDb) => T | Promise<T>,
): Promise<T> {
  const { DatabaseSync } = await loadNodeSqlite();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-snap-'));
  try {
    await fs.chmod(dir, 0o700);
    const copy = path.join(dir, 'snapshot.sqlite3');

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await copyIfExists(`${dbPath}-wal`, `${copy}-wal`);
        await fs.copyFile(dbPath, copy);
        await fs.chmod(copy, 0o600);

        const db = new DatabaseSync(copy);
        try {
          return await fn({
            all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
            tables: () =>
              (
                db
                  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                  .all() as { name: string }[]
              ).map((r) => r.name),
          });
        } finally {
          db.close();
        }
      } catch (e) {
        lastError = e;
        // Possibly inconsistent copy (concurrent write by kiro-cli): try again.
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(dir, { mode: 0o700 });
      }
    }
    throw lastError;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
