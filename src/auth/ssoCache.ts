import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseTokenObject } from './credentials.ts';
import { fingerprint } from './redact.ts';
import { SSO_TOKEN_FILE } from './paths.ts';
import { fileExists } from './sqliteSnapshot.ts';
import type { CredentialSource, LoadResult, Logger } from './source.ts';

/** Reads ~/.aws/sso/cache/kiro-auth-token.json (plain JSON, no SQLite). */
export class SsoCacheSource implements CredentialSource {
  readonly id = 'sso-cache';
  readonly label = 'SSO cache (kiro-auth-token.json)';
  private readonly dir: string;
  private readonly log: Logger;

  constructor(dir: string, log: Logger = () => {}) {
    this.dir = dir;
    this.log = log;
  }

  async load(): Promise<LoadResult> {
    const file = path.join(this.dir, SSO_TOKEN_FILE);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { credentials: [], notes: [`file not found: ${file}`] };
      }
      throw e;
    }
    this.log(`reading ${file}`);

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { credentials: [], notes: [`${file} is not valid JSON`] };
    }

    try {
      const c = parseTokenObject(obj, `sso-cache:${SSO_TOKEN_FILE}`);
      // clientIdHash points to <hash>.json with clientId/clientSecret (IdC logins).
      const hash = obj.clientIdHash;
      if (typeof hash === 'string' && /^[A-Za-z0-9_-]+$/.test(hash)) {
        c.hasClientRegistration = await fileExists(path.join(this.dir, `${hash}.json`));
      }
      return { credentials: [c], notes: [] };
    } catch (e) {
      return { credentials: [], notes: [`${file} is invalid: ${(e as Error).message}`] };
    }
  }
}

export interface SsoInspection {
  dir: string;
  exists: boolean;
  files: string[];
  token?: { fields: string[]; expiresAt?: string; fingerprint?: string; error?: string };
}

export async function inspectSsoCache(dir: string): Promise<SsoInspection> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).sort();
  } catch {
    return { dir, exists: false, files: [] };
  }
  const out: SsoInspection = { dir, exists: true, files };
  if (files.includes(SSO_TOKEN_FILE)) {
    try {
      const obj = JSON.parse(await fs.readFile(path.join(dir, SSO_TOKEN_FILE), 'utf8')) as Record<
        string,
        unknown
      >;
      const info: NonNullable<SsoInspection['token']> = { fields: Object.keys(obj).sort() };
      try {
        const c = parseTokenObject(obj, SSO_TOKEN_FILE);
        info.expiresAt = c.expiresAt.toISOString();
        info.fingerprint = fingerprint(c.accessToken);
      } catch (e) {
        info.error = (e as Error).message;
      }
      out.token = info;
    } catch {
      out.token = { fields: [], error: 'not valid JSON' };
    }
  }
  return out;
}
