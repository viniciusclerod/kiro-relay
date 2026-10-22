import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SsoCacheSource, inspectSsoCache } from '../src/auth/ssoCache.ts';

const createdDirs: string[] = [];
after(() => createdDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-sso-'));
  createdDirs.push(d);
  return d;
}
const future = () => new Date(Date.now() + 3600_000).toISOString();

test('reads kiro-auth-token.json and detects the client registration through clientIdHash', async () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'kiro-auth-token.json'),
    JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: future(), clientIdHash: 'abc123', region: 'us-east-1' }),
  );
  fs.writeFileSync(path.join(dir, 'abc123.json'), JSON.stringify({ clientId: 'c', clientSecret: 's' }));

  const r = await new SsoCacheSource(dir).load();
  assert.equal(r.credentials.length, 1);
  assert.equal(r.credentials[0]!.accessToken, 'AT');
  assert.equal(r.credentials[0]!.hasClientRegistration, true);
});

test('a malicious clientIdHash (path traversal) is ignored', async () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'kiro-auth-token.json'),
    JSON.stringify({ accessToken: 'AT', expiresAt: future(), clientIdHash: '../../etc/passwd' }),
  );
  const r = await new SsoCacheSource(dir).load();
  assert.equal(r.credentials[0]!.hasClientRegistration, false);
});

test('a missing or invalid file becomes a note', async () => {
  const dir = tmpdir();
  assert.match((await new SsoCacheSource(dir).load()).notes[0]!, /not found/);
  fs.writeFileSync(path.join(dir, 'kiro-auth-token.json'), 'garbage');
  assert.match((await new SsoCacheSource(dir).load()).notes[0]!, /JSON/);
});

test('inspectSsoCache does not leak the token', async () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'kiro-auth-token.json'),
    JSON.stringify({ accessToken: 'SECRET-TOKEN', expiresAt: future() }),
  );
  const info = await inspectSsoCache(dir);
  assert.ok(!JSON.stringify(info).includes('SECRET-TOKEN'));
  assert.deepEqual(info.token!.fields, ['accessToken', 'expiresAt']);
});
