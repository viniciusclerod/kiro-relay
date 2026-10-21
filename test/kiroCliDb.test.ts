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

test('lê token, registro de cliente e perfil (modo WAL, sem checkpoint)', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, true);
  put(db, 'auth_kv', 'kirocli:odic:token', {
    access_token: 'AT-ODIC', refresh_token: 'RT', expires_at: future(), region: 'us-east-1',
  });
  put(db, 'auth_kv', 'kirocli:odic:device-registration', { client_id: 'cid', client_secret: 'sec' });
  put(db, 'state', 'api.codewhisperer.profile', { arn: ARN, profile_name: 'x' });

  // A conexão de escrita continua aberta: os dados estão só no -wal.
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

  // Não deixou rastros ao lado do banco original.
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  db.close();
});

test('respeita a prioridade das chaves (social antes de odic)', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, false);
  put(db, 'auth_kv', 'kirocli:odic:token', { access_token: 'B', expires_at: future() });
  put(db, 'auth_kv', 'kirocli:social:token', { access_token: 'A', expires_at: future() });
  db.close();

  const { credentials } = await new KiroCliDbSource([path.join(dir, 'data.sqlite3')]).load();
  assert.deepEqual(credentials.map((c) => c.accessToken), ['A', 'B']);
  assert.equal(credentials[0]!.hasClientRegistration, false);
});

test('banco inexistente vira nota, não exceção', async () => {
  const r = await new KiroCliDbSource(['/nao/existe/data.sqlite3']).load();
  assert.equal(r.credentials.length, 0);
  assert.match(r.notes[0]!, /não encontrado/);
});

test('sem tabela auth_kv: nota lista as tabelas existentes', async () => {
  const dir = tmpdir();
  const db = new DatabaseSync(path.join(dir, 'data.sqlite3'));
  db.exec('CREATE TABLE outra (x)');
  db.close();
  const r = await new KiroCliDbSource([path.join(dir, 'data.sqlite3')]).load();
  assert.equal(r.credentials.length, 0);
  assert.match(r.notes[0]!, /auth_kv ausente.*outra/);
});

test('chave com JSON inválido gera nota sem vazar o valor', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, false);
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', 'SEGREDO-NAO-JSON');
  db.close();
  const r = await new KiroCliDbSource([path.join(dir, 'data.sqlite3')]).load();
  assert.equal(r.credentials.length, 0);
  assert.ok(r.notes.some((n) => /kirocli:social:token/.test(n)));
  assert.ok(!r.notes.join('\n').includes('SEGREDO'));
});

test('inspectDatabase expõe nomes de campos e fingerprint, nunca o token', async () => {
  const dir = tmpdir();
  const db = makeDb(dir, false);
  put(db, 'auth_kv', 'kirocli:social:token', {
    access_token: 'TOKEN-SECRETO-123', refresh_token: 'R', expires_at: future(), extra: 1,
  });
  db.close();
  const info = await inspectDatabase(path.join(dir, 'data.sqlite3'));
  const text = JSON.stringify(info);
  assert.ok(!text.includes('TOKEN-SECRETO-123'));
  const e = info.entries.find((x) => x.key === 'kirocli:social:token')!;
  assert.deepEqual(e.fields, ['access_token', 'expires_at', 'extra', 'refresh_token']);
  assert.match(e.token!.fingerprint!, /^[0-9a-f]{8}$/);
  assert.equal(e.token!.hasRefreshToken, true);
});
