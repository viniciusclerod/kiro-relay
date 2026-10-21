import * as fs from 'node:fs/promises';
import {
  extractProfileArn,
  parseTimestamp,
  parseTokenRecord,
  pick,
  regionFromArn,
  type Credentials,
} from './credentials.ts';
import { fingerprint } from './redact.ts';
import { fileExists, withSnapshot, type SnapshotDb } from './sqliteSnapshot.ts';
import type { CredentialSource, LoadResult, Logger } from './source.ts';

// The "odic" spelling is kiro-cli's own typo and must be kept.
export const TOKEN_KEYS = [
  'kirocli:social:token',
  'kirocli:odic:token',
  'codewhisperer:odic:token',
] as const;

export const REGISTRATION_KEYS = [
  'kirocli:odic:device-registration',
  'codewhisperer:odic:device-registration',
] as const;

export const PROFILE_STATE_KEY = 'api.codewhisperer.profile';

function asText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return undefined;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

function readKv(db: SnapshotDb, table: string, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.all(
    `SELECT key, value FROM ${table} WHERE key IN (${placeholders(keys.length)})`,
    ...keys,
  );
  for (const row of rows) {
    const k = asText(row.key);
    const v = asText(row.value);
    if (k !== undefined && v !== undefined) out.set(k, v);
  }
  return out;
}

function hasRegistration(values: Map<string, string>): boolean {
  for (const raw of values.values()) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (pick(obj, 'client_id', 'clientId') && pick(obj, 'client_secret', 'clientSecret')) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    if (await fileExists(p)) return p;
  }
  return undefined;
}

/** Reads credentials from kiro-cli's SQLite database (read-only, through a snapshot). */
export class KiroCliDbSource implements CredentialSource {
  readonly id = 'kiro-cli-db';
  readonly label = 'kiro-cli SQLite database';
  private readonly candidates: string[];
  private readonly log: Logger;

  constructor(candidates: string[], log: Logger = () => {}) {
    this.candidates = candidates;
    this.log = log;
  }

  async load(): Promise<LoadResult> {
    const dbPath = await firstExisting(this.candidates);
    if (!dbPath) {
      return {
        credentials: [],
        notes: [`database not found (looked in: ${this.candidates.join(' | ')})`],
      };
    }
    this.log(`reading snapshot of ${dbPath}`);

    return withSnapshot(dbPath, (db): LoadResult => {
      const tables = db.tables();
      if (!tables.includes('auth_kv')) {
        return {
          credentials: [],
          notes: [
            `auth_kv table missing in ${dbPath} (tables: ${tables.join(', ') || 'none'})`,
          ],
        };
      }

      const notes: string[] = [];
      const tokens = readKv(db, 'auth_kv', TOKEN_KEYS);
      const registrations = readKv(db, 'auth_kv', REGISTRATION_KEYS);
      const clientRegistered = hasRegistration(registrations);

      let profileArn: string | undefined;
      if (tables.includes('state')) {
        const state = readKv(db, 'state', [PROFILE_STATE_KEY]).get(PROFILE_STATE_KEY);
        profileArn = state ? extractProfileArn(state) : undefined;
        if (state && !profileArn) notes.push('state[api.codewhisperer.profile] has an unknown format');
      }

      const credentials: Credentials[] = [];
      for (const key of TOKEN_KEYS) {
        const raw = tokens.get(key);
        if (raw === undefined) continue;
        try {
          const c = parseTokenRecord(raw, `kiro-cli-db:${key}`);
          c.hasClientRegistration = clientRegistered;
          c.profileArn ??= profileArn;
          c.region ??= regionFromArn(c.profileArn);
          credentials.push(c);
        } catch (e) {
          notes.push(`key ${key} is invalid: ${(e as Error).message}`);
        }
      }
      if (credentials.length === 0 && notes.length === 0) {
        notes.push(`none of the token keys (${TOKEN_KEYS.join(', ')}) exist in auth_kv`);
      }
      return { credentials, notes };
    });
  }
}

// ---------------------------------------------------------------------------
// Inspection for diagnostics: key/field names and metadata. NEVER values.
// ---------------------------------------------------------------------------

export interface EntryInfo {
  key: string;
  fields: string[];
  token?: {
    expiresAt?: string;
    fingerprint?: string;
    hasRefreshToken: boolean;
    /** Refresh token fingerprint: changes when kiro-cli rotates it. */
    refreshFingerprint?: string;
  };
  /** OIDC client registration (device-registration). */
  registration?: { clientIdFingerprint?: string; clientSecretExpiresAt?: string };
  error?: string;
}

export interface DbInspection {
  path: string;
  sizeBytes: number;
  mtime: string;
  walSizeBytes?: number;
  tables: string[];
  authKvKeys: string[];
  entries: EntryInfo[];
  error?: string;
}

function describe(key: string, raw: string): EntryInfo {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { key, fields: [], error: 'JSON value is not an object' };
    }
    const rec = obj as Record<string, unknown>;
    const info: EntryInfo = { key, fields: Object.keys(rec).sort() };
    const access = pick(rec, 'access_token', 'accessToken');
    if (typeof access === 'string') {
      let expiresAt: string | undefined;
      try {
        expiresAt = parseTokenRecord(raw, key).expiresAt.toISOString();
      } catch {
        // leave undefined
      }
      const refresh = pick(rec, 'refresh_token', 'refreshToken');
      info.token = {
        expiresAt,
        fingerprint: fingerprint(access),
        hasRefreshToken: typeof refresh === 'string' && refresh !== '',
        refreshFingerprint:
          typeof refresh === 'string' && refresh !== '' ? fingerprint(refresh) : undefined,
      };
    }
    const clientId = pick(rec, 'client_id', 'clientId');
    if (typeof clientId === 'string') {
      let clientSecretExpiresAt: string | undefined;
      const raw = pick(rec, 'client_secret_expires_at', 'clientSecretExpiresAt');
      if (raw !== undefined) {
        try {
          clientSecretExpiresAt = parseTimestamp(raw).toISOString();
        } catch {
          info.error = 'client_secret_expires_at has an unknown format';
        }
      }
      info.registration = { clientIdFingerprint: fingerprint(clientId), clientSecretExpiresAt };
    }
    return info;
  } catch {
    return { key, fields: [], error: 'value is not JSON' };
  }
}

export async function inspectDatabase(dbPath: string): Promise<DbInspection> {
  const stat = await fs.stat(dbPath);
  let walSizeBytes: number | undefined;
  try {
    walSizeBytes = (await fs.stat(`${dbPath}-wal`)).size;
  } catch {
    // no WAL
  }
  const base: DbInspection = {
    path: dbPath,
    sizeBytes: stat.size,
    mtime: stat.mtime.toISOString(),
    walSizeBytes,
    tables: [],
    authKvKeys: [],
    entries: [],
  };
  try {
    return await withSnapshot(dbPath, (db) => {
      base.tables = db.tables();
      if (!base.tables.includes('auth_kv')) return base;
      base.authKvKeys = db
        .all('SELECT key FROM auth_kv ORDER BY key')
        .map((r) => asText(r.key) ?? '?');
      const known = [...TOKEN_KEYS, ...REGISTRATION_KEYS];
      const values = readKv(db, 'auth_kv', known);
      for (const key of known) {
        const raw = values.get(key);
        if (raw !== undefined) base.entries.push(describe(key, raw));
      }
      if (base.tables.includes('state')) {
        const raw = readKv(db, 'state', [PROFILE_STATE_KEY]).get(PROFILE_STATE_KEY);
        if (raw !== undefined) {
          base.entries.push({
            key: `state:${PROFILE_STATE_KEY}`,
            fields: describe(PROFILE_STATE_KEY, raw).fields,
            error: extractProfileArn(raw) ? undefined : 'ARN not recognized',
          });
        }
      }
      return base;
    });
  } catch (e) {
    base.error = (e as Error).message;
    return base;
  }
}
