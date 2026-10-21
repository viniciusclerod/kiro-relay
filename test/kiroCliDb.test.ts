import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KiroCliDbSource, inspectDatabase } from '../src/auth/kiroCliDb.ts';

const ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
}

function makeDb(dir: string, wal: boolean): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, 'data.sqlite3'));
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

function put(db: DatabaseSync, table: string, key: string, value: unknown): void {
  db.prepare(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
}

const future = () => new Date(Date.now() + 3600_000).toISOString().replace('Z', '123456Z');

test('reads the token, client registration and profile (WAL mode, no checkpoint)', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, true);
  put(db, 'auth_kv', 'kirocli:odic:token', {
    access_token: 'AT-ODIC', refresh_token: 'RT', expires_at: future(), region: 'us-east-1',
  });
  put(db, 'auth_kv', 'kirocli:odic:device-registration', { client_id: 'cid', client_secret: 'sec' });
  put(db, 'state', 'api.codewhisperer.profile', { arn: ARN, profile_name: 'x' });

  // The writing connection stays open: the data is only in the -wal.
  assert.ok(fs.existsSync(path.join(dir, 'data.sqlite3-wal')));
  const before = fs.readdirSync(dir).sort();

  const src = new KiroCliDbSource([path.join(dir, 'data.sqlite3')]);
  const { credentials, notes } = await src.load();

  assert.deepEqual(notes, []);
  assert.equal(credentials.length, 1);
  const c = credentials[0]!;
  assert.equal(c.accessToken, 'AT-ODIC');
  assert.equal(c.profileArn, ARN);
  assert.equal(c.region, 'us-east-1');
  assert.equal(c.hasClientRegistration, true);
  assert.equal(c.source, 'kiro-cli-db:kirocli:odic:token');

  // Left no traces next to the original database.
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  db.close();
});

test('respects key priority (social before odic)', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, false);
  put(db, 'auth_kv', 'kirocli:odic:token', { access_token: 'B', expires_at: future() });
  put(db, 'auth_kv', 'kirocli:social:token', { access_token: 'A', expires_at: future() });
  db.close();

  const { credentials } = await new KiroCliDbSource([path.join(dir, 'data.sqlite3')]).load();
  assert.deepEqual(credentials.map((c) => c.accessToken), ['A', 'B']);
  assert.equal(credentials[0]!.hasClientRegistration, false);
});

test('a missing database becomes a note, not an exception', async () => {
  const r = await new KiroCliDbSource(['/does/not/exist/data.sqlite3']).load();
  assert.equal(r.credentials.length, 0);
  assert.match(r.notes[0]!, /not found/);
});

test('no auth_kv table: the note lists the existing tables', async () => {
  const dir = tmpdir();
  const db = new DatabaseSync(path.join(dir, 'data.sqlite3'));
  db.exec('CREATE TABLE other (x)');
  db.close();
  const r = await new KiroCliDbSource([path.join(dir, 'data.sqlite3')]).load();
  assert.equal(r.credentials.length, 0);
  assert.match(r.notes[0]!, /auth_kv table missing.*other/);
});

test('a key with invalid JSON produces a note without leaking the value', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, false);
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', 'SECRET-NOT-JSON');
  db.close();
  const r = await new KiroCliDbSource([path.join(dir, 'data.sqlite3')]).load();
  assert.equal(r.credentials.length, 0);
  assert.ok(r.notes.some((n) => /kirocli:social:token/.test(n)));
  assert.ok(!r.notes.join('\n').includes('SECRET'));
});

test('inspectDatabase exposes field names and a fingerprint, never the token', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, false);
  put(db, 'auth_kv', 'kirocli:social:token', {
    access_token: 'SECRET-TOKEN-123', refresh_token: 'R', expires_at: future(), extra: 1,
  });
  db.close();
  const info = await inspectDatabase(path.join(dir, 'data.sqlite3'));
  const text = JSON.stringify(info);
  assert.ok(!text.includes('SECRET-TOKEN-123'));
  const e = info.entries.find((x) => x.key === 'kirocli:social:token')!;
  assert.deepEqual(e.fields, ['access_token', 'expires_at', 'extra', 'refresh_token']);
  assert.match(e.token!.fingerprint!, /^[0-9a-f]{8}$/);
  assert.equal(e.token!.hasRefreshToken, true);
});
