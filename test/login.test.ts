import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginSettingsError, buildLoginArgs, isValidStartUrl } from '../src/auth/login.ts';

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
