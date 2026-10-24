import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginSettingsError, buildInstallCommand, buildLoginArgs, isCliInstalled, isValidStartUrl } from '../src/auth/login.ts';

test('CLI detection probes the configured executable without signing in', async () => {
  assert.equal(await isCliInstalled('/custom/kiro-cli', async (file, args, options) => {
    assert.equal(file, '/custom/kiro-cli');
    assert.deepEqual(args, ['--version']);
    assert.equal(options.timeout, 5_000);
    return { exitCode: 0 };
  }), true);
});

test('only a missing executable triggers installation', async () => {
  assert.equal(await isCliInstalled('kiro-cli', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }), false);
  for (const code of ['EACCES', 'ETIMEDOUT']) {
    await assert.rejects(isCliInstalled('kiro-cli', async () => {
      throw Object.assign(new Error('failed'), { code });
    }), { code });
  }
  assert.equal(await isCliInstalled('kiro-cli', async () => ({ exitCode: 1 })), true);
});

test('macOS and Linux use the official installer with pipeline failure propagation', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(buildInstallCommand(platform), {
      shellPath: '/bin/bash',
      shellArgs: ['-c', 'set -o pipefail; curl -fsSL https://cli.kiro.dev/install | bash'],
    });
  }
  assert.equal(buildInstallCommand('freebsd'), undefined);
});

test('Windows installs inside WSL rather than invoking a Unix installer on the host', () => {
  assert.deepEqual(buildInstallCommand('win32'), {
    shellPath: 'wsl.exe',
    shellArgs: ['--exec', 'bash', '-c', 'set -o pipefail; curl -fsSL https://cli.kiro.dev/install | bash'],
  });
});

test('no settings: plain login, device flow only in remote windows', () => {
  assert.deepEqual(buildLoginArgs({}, false), ['login']);
  assert.deepEqual(buildLoginArgs({}, true), ['login', '--use-device-flow']);
  assert.deepEqual(buildLoginArgs({ deviceFlow: 'always' }, false), ['login', '--use-device-flow']);
  assert.deepEqual(buildLoginArgs({ deviceFlow: 'never' }, true), ['login']);
});

test('IAM Identity Center: license, start URL and region', () => {
  assert.deepEqual(
    buildLoginArgs({ license: 'pro', startUrl: ' https://example.awsapps.com/start/ ', region: 'us-east-1' }, true),
    ['login', '--license', 'pro', '--identity-provider', 'https://example.awsapps.com/start/', '--region', 'us-east-1', '--use-device-flow'],
  );
});

test('free license ignores the Identity Center settings', () => {
  assert.deepEqual(buildLoginArgs({ license: 'free', startUrl: 'https://example.awsapps.com/start', region: 'us-east-1' }, false), [
    'login',
    '--license',
    'free',
  ]);
});

test('invalid values are rejected with the setting name', () => {
  const bad = (s: Parameters<typeof buildLoginArgs>[0], setting: string) =>
    assert.throws(() => buildLoginArgs(s, false), (e: unknown) => e instanceof LoginSettingsError && e.setting === setting);
  bad({ license: 'enterprise' }, 'kirorelay.login.license');
  bad({ startUrl: 'http://example.awsapps.com/start' }, 'kirorelay.login.startUrl');
  bad({ startUrl: 'https://x.com/start; rm -rf ~' }, 'kirorelay.login.startUrl');
  bad({ region: 'us-east-1; echo' }, 'kirorelay.login.region');
  bad({ region: 'Mars' }, 'kirorelay.login.region');
});

test('isValidStartUrl', () => {
  assert.equal(isValidStartUrl('https://pagbank-like.awsapps.com/start/'), true);
  assert.equal(isValidStartUrl('https://d-1234567890.awsapps.com/start#/'), true);
  assert.equal(isValidStartUrl('ftp://x'), false);
  assert.equal(isValidStartUrl('not a url'), false);
  assert.equal(isValidStartUrl('https://x.com/"quoted"'), false);
});
