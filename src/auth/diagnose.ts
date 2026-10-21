import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KiroAuthError, NotLoggedInError } from './errors.ts';
import { inspectDatabase, firstExisting, type DbInspection } from './kiroCliDb.ts';
import { inspectSsoCache } from './ssoCache.ts';
import { fingerprint, formatDuration } from './redact.ts';
import { loadNodeSqlite } from './sqliteSnapshot.ts';
import type { KiroCliTokenProvider } from './tokenProvider.ts';

const execFileAsync = promisify(execFile);

export interface DiagnoseInput {
  cliPath: string;
  databaseCandidates: string[];
  ssoCacheDir: string;
  /** Host information (VS Code version etc.). */
  host: Record<string, string>;
  provider: KiroCliTokenProvider;
  now?: () => number;
}

function section(lines: string[], title: string): void {
  lines.push('', `## ${title}`);
}

function remaining(iso: string | undefined, nowMs: number): string {
  if (!iso) return '?';
  return `${iso} (${formatDuration(Date.parse(iso) - nowMs)})`;
}

function formatDb(lines: string[], d: DbInspection, nowMs: number): void {
  lines.push(`- path: ${d.path}`);
  lines.push(`- size: ${d.sizeBytes} bytes, modified at ${d.mtime}`);
  lines.push(`- -wal file: ${d.walSizeBytes === undefined ? 'absent' : `${d.walSizeBytes} bytes`}`);
  if (d.error) lines.push(`- ERROR while inspecting: ${d.error}`);
  lines.push(`- tables: ${d.tables.join(', ') || '(none)'}`);
  lines.push(`- keys in auth_kv: ${d.authKvKeys.join(', ') || '(none)'}`);
  for (const e of d.entries) {
    lines.push(`- entry "${e.key}"`);
    lines.push(`    fields: ${e.fields.join(', ') || '(none)'}`);
    if (e.token) {
      lines.push(
        `    access token: fingerprint=${e.token.fingerprint}, ` +
          `expires=${remaining(e.token.expiresAt, nowMs)}`,
      );
      lines.push(
        `    refresh token: ${e.token.refreshFingerprint ? `fingerprint=${e.token.refreshFingerprint}` : 'absent'}`,
      );
    }
    if (e.registration) {
      lines.push(`    client_id: fingerprint=${e.registration.clientIdFingerprint}`);
      const secretExp = e.registration.clientSecretExpiresAt;
      lines.push(
        `    client_secret_expires_at: ${secretExp ? remaining(secretExp, nowMs) : '(absent)'}`,
      );
    }
    if (e.error) lines.push(`    warning: ${e.error}`);
  }
}

/** Builds a diagnostics report WITHOUT secrets (only field names and fingerprints). */
export async function runDiagnostics(input: DiagnoseInput): Promise<string> {
  const now = input.now ?? Date.now;
  const lines: string[] = ['# Kiro Relay: authentication diagnostics'];
  lines.push('', `now: ${new Date(now()).toISOString()}`);

  section(lines, 'Environment');
  for (const [k, v] of Object.entries(input.host)) lines.push(`- ${k}: ${v}`);
  lines.push(`- node: ${process.versions.node}`);
  lines.push(`- electron: ${process.versions.electron ?? '(not Electron)'}`);
  lines.push(`- platform: ${process.platform}/${process.arch}`);
  try {
    await loadNodeSqlite();
    lines.push('- node:sqlite: available');
  } catch (e) {
    lines.push(`- node:sqlite: UNAVAILABLE (${(e as Error).message})`);
  }

  section(lines, 'kiro-cli');
  try {
    const { stdout } = await execFileAsync(input.cliPath, ['--version'], { timeout: 5000 });
    lines.push(`- ${input.cliPath} --version: ${stdout.trim()}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    lines.push(
      err.code === 'ENOENT'
        ? `- executable not found: ${input.cliPath} (set kirorelay.cli.path)`
        : `- failed to run ${input.cliPath} --version: ${err.message}`,
    );
  }

  section(lines, 'kiro-cli SQLite database');
  for (const c of input.databaseCandidates) {
    lines.push(`- candidate: ${c}`);
  }
  const dbPath = await firstExisting(input.databaseCandidates);
  if (!dbPath) lines.push('- no candidate exists');
  else formatDb(lines, await inspectDatabase(dbPath), now());

  section(lines, 'SSO cache');
  const sso = await inspectSsoCache(input.ssoCacheDir);
  lines.push(`- directory: ${sso.dir} (${sso.exists ? 'exists' : 'does not exist'})`);
  if (sso.exists) lines.push(`- files: ${sso.files.join(', ') || '(empty)'}`);
  if (sso.token) {
    lines.push(`- kiro-auth-token.json, fields: ${sso.token.fields.join(', ') || '(none)'}`);
    if (sso.token.expiresAt) {
      lines.push(
        `    token: fingerprint=${sso.token.fingerprint}, expires=${sso.token.expiresAt}`,
      );
    }
    if (sso.token.error) lines.push(`    warning: ${sso.token.error}`);
  }

  section(lines, 'Token provider result');
  try {
    const t = await input.provider.getAccessToken({ forceReload: true });
    lines.push('- OK: got a valid token');
    lines.push(`- source: ${t.source}`);
    lines.push(`- fingerprint: ${fingerprint(t.token)}`);
    lines.push(`- ${formatDuration(t.expiresAt.getTime() - now())} (${t.expiresAt.toISOString()})`);
    lines.push(`- region: ${t.region ?? '(unknown)'}`);
    lines.push(`- profile ARN: ${t.profileArn ? 'present' : 'absent'}`);
    lines.push(`- oauth_flow: ${t.oauthFlow ?? '(absent)'}`);
    lines.push(`- OIDC client registration: ${t.hasClientRegistration ? 'yes' : 'no'}`);
  } catch (e) {
    if (e instanceof KiroAuthError) {
      lines.push(`- FAILED [${e.code}]: ${e.message}`);
      if (e instanceof NotLoggedInError) for (const d of e.details) lines.push(`    ${d}`);
    } else {
      lines.push(`- unexpected ERROR: ${(e as Error).message}`);
    }
  }
  return lines.join('\n');
}
