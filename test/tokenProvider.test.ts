import test from 'node:test';
import assert from 'node:assert/strict';
import type { Credentials } from '../src/auth/credentials.ts';
import { NotLoggedInError, TokenExpiredError } from '../src/auth/errors.ts';
import type { CredentialSource, LoadResult } from '../src/auth/source.ts';
import { KiroCliTokenProvider } from '../src/auth/tokenProvider.ts';

const T0 = Date.parse('2026-10-20T12:00:00Z');

function cred(token: string, expiresInMs: number, source = 'fake'): Credentials {
  return {
    accessToken: token,
    expiresAt: new Date(T0 + expiresInMs),
    hasClientRegistration: false,
    source,
  };
}

class FakeSource implements CredentialSource {
  readonly id: string;
  readonly label = 'fake';
  loads = 0;
  result: LoadResult | Error;
  constructor(id: string, result: LoadResult | Error) {
    this.id = id;
    this.result = result;
  }
  async load(): Promise<LoadResult> {
    this.loads++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const MIN = 60_000;

test('returns a valid token and uses the cache without re-reading the source', async () => {
  const s = new FakeSource('a', { credentials: [cred('T1', 60 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  assert.equal((await p.getAccessToken()).token, 'T1');
  assert.equal((await p.getAccessToken()).token, 'T1');
  assert.equal(s.loads, 1);
});

test('forceReload and invalidate force a new read', async () => {
  const s = new FakeSource('a', { credentials: [cred('T1', 60 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  await p.getAccessToken();
  await p.getAccessToken({ forceReload: true });
  p.invalidate();
  await p.getAccessToken();
  assert.equal(s.loads, 3);
});

test('close to expiry re-reads the source and picks up the token renewed by kiro-cli', async () => {
  let now = T0;
  const s = new FakeSource('a', { credentials: [cred('OLD', 10 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], leewayMs: 5 * MIN, now: () => now });
  assert.equal((await p.getAccessToken()).token, 'OLD');

  now = T0 + 6 * MIN; // inside the 5 min leeway
  s.result = { credentials: [cred('NEW', 66 * MIN)], notes: [] }; // kiro-cli renewed it
  assert.equal((await p.getAccessToken()).token, 'NEW');
  assert.equal(s.loads, 2);
});

test('expired token nobody renewed: TokenExpiredError (never renews by itself)', async () => {
  const s = new FakeSource('a', { credentials: [cred('OLD', -MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  await assert.rejects(p.getAccessToken(), (e) => {
    assert.ok(e instanceof TokenExpiredError);
    assert.match(e.message, /kiro-cli/);
    return true;
  });
});

test('inside the leeway counts as expired', async () => {
  const s = new FakeSource('a', { credentials: [cred('T', 2 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], leewayMs: 5 * MIN, now: () => T0 });
  await assert.rejects(p.getAccessToken(), TokenExpiredError);
});

test('no credentials: NotLoggedInError aggregates the notes of every source', async () => {
  const a = new FakeSource('db', { credentials: [], notes: ['database not found'] });
  const b = new FakeSource('sso', new Error('permission denied'));
  const p = new KiroCliTokenProvider({ sources: [a, b], now: () => T0 });
  await assert.rejects(p.getAccessToken(), (e) => {
    assert.ok(e instanceof NotLoggedInError);
    assert.deepEqual(e.details, ['[db] database not found', '[sso] error: permission denied']);
    return true;
  });
});

test('source order: the first one with a valid token wins; an expired one falls through to the next', async () => {
  const a = new FakeSource('db', { credentials: [cred('EXPIRED', -MIN, 'db')], notes: [] });
  const b = new FakeSource('sso', { credentials: [cred('VALID', 30 * MIN, 'sso')], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [a, b], now: () => T0 });
  const t = await p.getAccessToken();
  assert.equal(t.token, 'VALID');
  assert.equal(t.source, 'sso');
});

test('concurrent calls share a single read', async () => {
  const s = new FakeSource('a', { credentials: [cred('T', 60 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  const r = await Promise.all([p.getAccessToken(), p.getAccessToken(), p.getAccessToken()]);
  assert.ok(r.every((x) => x.token === 'T'));
  assert.equal(s.loads, 1);
});
