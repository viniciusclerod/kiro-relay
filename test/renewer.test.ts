import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KiroCliRenewer, defaultRun, type RunFn } from '../src/auth/renewer.ts';

function fakeRun(impl: () => Promise<{ exitCode: number }>): { run: RunFn; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, args]);
      return impl();
    },
  };
}

test('runs the configured command and records the outcome', async () => {
  const logs: string[] = [];
  const { run, calls } = fakeRun(async () => ({ exitCode: 0 }));
  const r = new KiroCliRenewer({ cliPath: '/bin/kiro-cli', args: ['whoami'], run, log: (m) => logs.push(m) });
  const out = await r.renew();
  assert.equal(out.status, 'ran');
  assert.deepEqual(calls, [['/bin/kiro-cli', ['whoami']]]);
  assert.equal(r.last?.status, 'ran');
  assert.match(logs[0]!, /renewal: ran "\/bin\/kiro-cli whoami" \(exit 0/);
});

test('empty args disable renewal', async () => {
  const { run, calls } = fakeRun(async () => ({ exitCode: 0 }));
  const r = new KiroCliRenewer({ cliPath: 'kiro-cli', args: [], run });
  assert.equal(r.enabled, false);
  assert.deepEqual(await r.renew(), { status: 'skipped', reason: 'disabled' });
  assert.equal(calls.length, 0);
});

test('single-flight and rate limit', async () => {
  let now = 0;
  let release!: () => void;
  const { run, calls } = fakeRun(() => new Promise((r) => (release = () => r({ exitCode: 0 }))));
  const r = new KiroCliRenewer({ cliPath: 'kiro-cli', args: ['whoami'], run, now: () => now, minIntervalMs: 60_000 });
  const a = r.renew();
  const b = r.renew();
  release();
  assert.equal(await a, await b, 'concurrent calls share one run');
  assert.equal(calls.length, 1);

  now = 30_000;
  assert.deepEqual(await r.renew(), { status: 'skipped', reason: 'too-soon' });
  now = 61_000;
  const c = r.renew();
  release();
  assert.equal((await c).status, 'ran');
  assert.equal(calls.length, 2);
});

test('failures never throw and never log process output', async () => {
  const logs: string[] = [];
  const missing = new KiroCliRenewer({
    cliPath: '/nope/kiro-cli',
    args: ['whoami'],
    run: async () => {
      throw Object.assign(new Error('spawn /nope/kiro-cli ENOENT'), { code: 'ENOENT' });
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual((await missing.renew()).status, 'failed');
  assert.match(missing.last!.status === 'failed' ? missing.last!.error : '', /executable not found/);

  const killed = new KiroCliRenewer({
    cliPath: 'kiro-cli',
    args: ['whoami'],
    timeoutMs: 5,
    run: async () => {
      throw Object.assign(new Error('Command failed: kiro-cli whoami\nEmail: someone@example.com'), { killed: true, signal: 'SIGTERM' });
    },
    log: (m) => logs.push(m),
  });
  const out = await killed.renew();
  assert.equal(out.status, 'failed');
  assert.ok(!logs.join('\n').includes('someone@example.com'), 'stderr must not reach the log');
  assert.match(logs.join('\n'), /timed out after 5 ms/);
});

test('defaultRun: exit codes, missing executable and timeout (real processes)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell scripts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-renew-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  assert.deepEqual(await defaultRun(script('ok', 'echo secret@example.com'), ['whoami'], { timeout: 5000 }), { exitCode: 0 });
  assert.deepEqual(await defaultRun(script('fail', 'exit 3'), [], { timeout: 5000 }), { exitCode: 3 });
  await assert.rejects(defaultRun(path.join(dir, 'missing'), [], { timeout: 5000 }), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  await assert.rejects(defaultRun(script('slow', 'sleep 5'), [], { timeout: 50 }), (e: { killed?: boolean }) => e.killed === true);
});
