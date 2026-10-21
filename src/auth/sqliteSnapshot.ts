import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteUnavailableError } from './errors.ts';

export interface SnapshotDb {
  /** Executa um SELECT e devolve todas as linhas. */
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
 * Abre um SNAPSHOT do banco: copia o arquivo (e o -wal, se existir) para um
 * diretório temporário privado e abre a cópia. O original nunca é aberto, então
 * nunca criamos -shm/-wal nem travamos nada ao lado do banco do kiro-cli, e o
 * SQLite real aplica o WAL corretamente (ao contrário de um leitor "só do
 * arquivo principal", que pode devolver um token já substituído).
 *
 * O WAL é copiado ANTES do arquivo principal: se um checkpoint ocorrer no meio,
 * o principal copiado já contém tudo; reaplicar frames antigos é inofensivo.
 * A cópia (que contém tokens) é apagada ao final, mesmo em caso de erro.
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
        // Cópia possivelmente inconsistente (escrita concorrente do kiro-cli): tenta de novo.
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
