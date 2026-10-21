import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, type SessionRecord, type SessionStore } from '../src/auth/session.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T14:30:00Z');

function memoryStore(): SessionStore & { value?: SessionRecord } {
  const store: SessionStore & { value?: SessionRecord } = {
    get: () => store.value,
    set: (r) => {
      store.value = r;
    },
  };
  return store;
}

test('sign-in seen right away: the session ends sessionHours later (estimate)', () => {
  const store = memoryStore();
  const s = new SessionTracker(store, () => 8);
  s.observe({ refreshFingerprint: 'aaaa', expiresAt: new Date(T0 + 59 * MIN) }, T0);
  assert.deepEqual(s.estimate(), { endsAt: new Date(T0 - MIN + 8 * 60 * MIN), exact: false });
  // Later renewals with the same refresh token keep the sign-in time.
  s.observe({ refreshFingerprint: 'aaaa', expiresAt: new Date(T0 + 3 * 60 * MIN) }, T0 + 2 * 60 * MIN, T0 + 2 * 60 * MIN);
  assert.equal(s.estimate().endsAt?.getTime(), T0 - MIN + 8 * 60 * MIN);
});

test('refresh token first seen late: the end is unknown until a capped renewal reveals it', () => {
  const store = memoryStore();
  const s = new SessionTracker(store);
  s.observe({ refreshFingerprint: 'bbbb', expiresAt: new Date(T0 + 20 * MIN) }, T0);
  assert.deepEqual(s.estimate(), { exact: false });
  // A renewal that only gives 31 min: capped by the session end.
  const now = T0 + 25 * MIN;
  s.observe({ refreshFingerprint: 'bbbb', expiresAt: new Date(now + 31 * MIN) }, now, now - 10_000);
  assert.deepEqual(s.estimate(), { endsAt: new Date(now + 31 * MIN), exact: true });
});

test('a short token without a recent renewal is not taken as the session end', () => {
  const store = memoryStore();
  const s = new SessionTracker(store);
  s.observe({ refreshFingerprint: 'cccc', expiresAt: new Date(T0 + 10 * MIN) }, T0);
  s.observe({ refreshFingerprint: 'cccc', expiresAt: new Date(T0 + 10 * MIN) }, T0 + MIN, T0 - 10 * MIN);
  assert.deepEqual(s.estimate(), { exact: false });
});

test('a new sign-in replaces the previous session', () => {
  const store = memoryStore();
  const s = new SessionTracker(store, () => 1);
  s.observe({ refreshFingerprint: 'old', expiresAt: new Date(T0 + 5 * MIN) }, T0, T0);
  assert.equal(s.estimate().exact, true);
  s.observe({ refreshFingerprint: 'new', expiresAt: new Date(T0 + 60 * MIN) }, T0);
  assert.deepEqual(s.estimate(), { endsAt: new Date(T0 + 60 * MIN), exact: false });
  assert.equal(store.value?.refreshFingerprint, 'new');
});

test('tokens without a refresh token are ignored', () => {
  const store = memoryStore();
  new SessionTracker(store).observe({ expiresAt: new Date(T0 + 60 * MIN) }, T0);
  assert.equal(store.value, undefined);
});
