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

// ---------------------------------------------------------------------------
// Renewal through kiro-cli (the `renew` hook)
// ---------------------------------------------------------------------------

test('expired token: asks kiro-cli to renew, re-reads and returns the renewed token', async () => {
  const s = new FakeSource('db', { credentials: [cred('OLD', -MIN)], notes: [] });
  let renewals = 0;
  const p = new KiroCliTokenProvider({
    sources: [s],
    now: () => T0,
    renew: async () => {
      renewals++;
      s.result = { credentials: [cred('NEW', 60 * MIN)], notes: [] }; // kiro-cli wrote a new token
    },
  });
  assert.equal((await p.getAccessToken()).token, 'NEW');
  assert.equal(renewals, 1);
  assert.equal(s.loads, 2);
});

test('valid token: kiro-cli is never run', async () => {
  const s = new FakeSource('db', { credentials: [cred('T', 60 * MIN)], notes: [] });
  let renewals = 0;
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0, renew: async () => void renewals++ });
  await p.getAccessToken();
  await p.getAccessToken({ forceReload: true });
  assert.equal(renewals, 0);
});

test('inside the leeway but still valid: used as is when kiro-cli did not renew it', async () => {
  const s = new FakeSource('db', { credentials: [cred('ALMOST', 2 * MIN)], notes: [] });
  let renewals = 0;
  const p = new KiroCliTokenProvider({ sources: [s], leewayMs: 5 * MIN, now: () => T0, renew: async () => void renewals++ });
  assert.equal((await p.getAccessToken()).token, 'ALMOST');
  assert.equal(renewals, 1);
});

test('too close to expiry after renewal: TokenExpiredError', async () => {
  const s = new FakeSource('db', { credentials: [cred('EDGE', 10_000)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0, renew: async () => {}, minValidityMs: 30_000 });
  await assert.rejects(p.getAccessToken(), TokenExpiredError);
});

test('session ended: kiro-cli deleted the token, so NotLoggedInError', async () => {
  const s = new FakeSource('db', { credentials: [cred('OLD', -MIN)], notes: [] });
  const p = new KiroCliTokenProvider({
    sources: [s],
    now: () => T0,
    renew: async () => {
      s.result = { credentials: [], notes: ['none of the token keys exist in auth_kv'] };
    },
  });
  await assert.rejects(p.getAccessToken(), (e) => {
    assert.ok(e instanceof NotLoggedInError);
    assert.deepEqual(e.details, ['[db] none of the token keys exist in auth_kv']);
    return true;
  });
});

test('no credentials at all: renewal is not attempted (only "kiro-cli login" helps)', async () => {
  const s = new FakeSource('db', { credentials: [], notes: ['database not found'] });
  let renewals = 0;
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0, renew: async () => void renewals++ });
  await assert.rejects(p.getAccessToken(), NotLoggedInError);
  assert.equal(renewals, 0);
});

test('renewal that changes nothing: TokenExpiredError, and concurrent callers share one renewal', async () => {
  const s = new FakeSource('db', { credentials: [cred('OLD', -MIN)], notes: [] });
  let renewals = 0;
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0, renew: async () => void renewals++ });
  const results = await Promise.allSettled([p.getAccessToken(), p.getAccessToken()]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason instanceof TokenExpiredError));
  assert.equal(renewals, 1);
});
