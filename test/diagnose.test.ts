import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDiagnostics } from '../src/auth/diagnose.ts';
import { KiroCliDbSource } from '../src/auth/kiroCliDb.ts';
import { fingerprint } from '../src/auth/redact.ts';
import { KiroCliTokenProvider } from '../src/auth/tokenProvider.ts';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const SECRETS = ['AT-FAKE-xyz', 'RT-FAKE-xyz', 'CID-FAKE', 'CSECRET-FAKE'];

/** Layout observed in kiro-cli 2.33.0 (IdC / DeviceCode login), with fake values. */
function makeRealLayoutDb(dir: string): string {
  const file = path.join(dir, 'data.sqlite3');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE history (id INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE migrations (id INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)');
  const put = db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)');
  put.run('kirocli:odic:token', JSON.stringify({
    access_token: SECRETS[0],
    expires_at: '2026-10-20T12:12:30.123456789Z',
    oauth_flow: 'DeviceCode',
    refresh_token: SECRETS[1],
    region: 'us-east-1',
    scopes: ['codewhisperer:completions'],
    start_url: 'https://example.awsapps.com/start',
  }));
  put.run('kirocli:odic:device-registration', JSON.stringify({
    client_id: SECRETS[2],
    client_secret: SECRETS[3],
    client_secret_expires_at: '2027-01-18T12:00:00.987654321Z',
    oauth_flow: 'DeviceCode',
    region: 'us-east-1',
    scopes: ['codewhisperer:completions'],
  }));
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run(
    'api.codewhisperer.profile',
    JSON.stringify({
      arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF',
      device_code_disabled: false,
      profile_name: 'fake',
    }),
  );
  db.close();
  return file;
}

test('diagnostics with the real layout: now, remaining time, fingerprints and client_secret_expires_at', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-diag-'));
  const dbFile = makeRealLayoutDb(dir);
  const now = () => T0;
  const provider = new KiroCliTokenProvider({
    sources: [new KiroCliDbSource([dbFile])],
    leewayMs: 0,
    now,
  });

  const report = await runDiagnostics({
    cliPath: path.join(dir, 'missing-kiro-cli'),
    databaseCandidates: [dbFile],
    ssoCacheDir: path.join(dir, 'sso'),
    host: {},
    provider,
    now,
  });

  assert.match(report, /^now: 2026-10-20T12:00:00\.000Z$/m);
  assert.match(
    report,
    new RegExp(`access token: fingerprint=${fingerprint(SECRETS[0]!)}, expires=2026-10-20T12:12:30\\.123Z \\(expires in 12 min\\)`),
  );
  assert.match(report, new RegExp(`refresh token: fingerprint=${fingerprint(SECRETS[1]!)}`));
  assert.match(report, new RegExp(`client_id: fingerprint=${fingerprint(SECRETS[2]!)}`));
  assert.match(report, /client_secret_expires_at: 2027-01-18T12:00:00\.987Z \(expires in \d+ h \d{2} min\)/);
  assert.match(report, /- OK: got a valid token/);
  for (const s of SECRETS) assert.ok(!report.includes(s), 'the report must not contain secrets');
});

test('diagnostics with an expired token show how long ago it expired', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-diag-'));
  const dbFile = makeRealLayoutDb(dir);
  const now = () => T0 + 20 * 60_000;
  const report = await runDiagnostics({
    cliPath: path.join(dir, 'missing-kiro-cli'),
    databaseCandidates: [dbFile],
    ssoCacheDir: path.join(dir, 'sso'),
    host: {},
    provider: new KiroCliTokenProvider({ sources: [new KiroCliDbSource([dbFile])], leewayMs: 0, now }),
    now,
  });
  assert.match(report, /access token: .*\(expired 7 min ago\)/);
  assert.match(report, /- FAILED \[/);
  for (const s of SECRETS) assert.ok(!report.includes(s));
});
