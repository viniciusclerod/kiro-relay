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

test('devolve token válido e usa o cache sem reler a fonte', async () => {
  const s = new FakeSource('a', { credentials: [cred('T1', 60 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  assert.equal((await p.getAccessToken()).token, 'T1');
  assert.equal((await p.getAccessToken()).token, 'T1');
  assert.equal(s.loads, 1);
});

test('forceReload e invalidate forçam nova leitura', async () => {
  const s = new FakeSource('a', { credentials: [cred('T1', 60 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  await p.getAccessToken();
  await p.getAccessToken({ forceReload: true });
  p.invalidate();
  await p.getAccessToken();
  assert.equal(s.loads, 3);
});

test('perto do vencimento relê a fonte e pega o token renovado pelo kiro-cli', async () => {
  let now = T0;
  const s = new FakeSource('a', { credentials: [cred('OLD', 10 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], leewayMs: 5 * MIN, now: () => now });
  assert.equal((await p.getAccessToken()).token, 'OLD');

  now = T0 + 6 * MIN; // dentro da margem de 5 min
  s.result = { credentials: [cred('NEW', 66 * MIN)], notes: [] }; // kiro-cli renovou
  assert.equal((await p.getAccessToken()).token, 'NEW');
  assert.equal(s.loads, 2);
});

test('token vencido e ninguém renovou: TokenExpiredError (nunca renova sozinho)', async () => {
  const s = new FakeSource('a', { credentials: [cred('OLD', -MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  await assert.rejects(p.getAccessToken(), (e) => {
    assert.ok(e instanceof TokenExpiredError);
    assert.match(e.message, /kiro-cli/);
    return true;
  });
});

test('dentro da margem conta como vencido', async () => {
  const s = new FakeSource('a', { credentials: [cred('T', 2 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], leewayMs: 5 * MIN, now: () => T0 });
  await assert.rejects(p.getAccessToken(), TokenExpiredError);
});

test('sem credenciais: NotLoggedInError agrega as notas de todas as fontes', async () => {
  const a = new FakeSource('db', { credentials: [], notes: ['banco não encontrado'] });
  const b = new FakeSource('sso', new Error('permissão negada'));
  const p = new KiroCliTokenProvider({ sources: [a, b], now: () => T0 });
  await assert.rejects(p.getAccessToken(), (e) => {
    assert.ok(e instanceof NotLoggedInError);
    assert.deepEqual(e.details, ['[db] banco não encontrado', '[sso] erro: permissão negada']);
    return true;
  });
});

test('ordem das fontes: a primeira com token válido vence; vencido numa fonte cai para a próxima', async () => {
  const a = new FakeSource('db', { credentials: [cred('EXPIRED', -MIN, 'db')], notes: [] });
  const b = new FakeSource('sso', { credentials: [cred('VALID', 30 * MIN, 'sso')], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [a, b], now: () => T0 });
  const t = await p.getAccessToken();
  assert.equal(t.token, 'VALID');
  assert.equal(t.source, 'sso');
});

test('chamadas concorrentes compartilham uma única leitura', async () => {
  const s = new FakeSource('a', { credentials: [cred('T', 60 * MIN)], notes: [] });
  const p = new KiroCliTokenProvider({ sources: [s], now: () => T0 });
  const r = await Promise.all([p.getAccessToken(), p.getAccessToken(), p.getAccessToken()]);
  assert.ok(r.every((x) => x.token === 'T'));
  assert.equal(s.loads, 1);
});
