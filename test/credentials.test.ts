import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProfileArn,
  parseTimestamp,
  parseTokenRecord,
  regionFromArn,
} from '../src/auth/credentials.ts';

test('parseTimestamp truncates nanoseconds to milliseconds', () => {
  const d = parseTimestamp('2026-10-20T10:00:00.123456789Z');
  assert.equal(d.toISOString(), '2026-10-20T10:00:00.123Z');
});

test('parseTimestamp accepts offsets, short fractions and epochs', () => {
  assert.equal(parseTimestamp('2026-10-20T10:00:00+00:00').toISOString(), '2026-10-20T10:00:00.000Z');
  assert.equal(parseTimestamp('2026-10-20T10:00:00.5Z').toISOString(), '2026-10-20T10:00:00.500Z');
  assert.equal(parseTimestamp(1_790_000_000).getTime(), 1_790_000_000_000);
  assert.equal(parseTimestamp(1_790_000_000_000).getTime(), 1_790_000_000_000);
});

test('parseTimestamp rejects garbage', () => {
  assert.throws(() => parseTimestamp('yesterday'));
  assert.throws(() => parseTimestamp(''));
  assert.throws(() => parseTimestamp(undefined));
});

test('parseTokenRecord accepts snake_case and camelCase', () => {
  const a = parseTokenRecord(
    JSON.stringify({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_at: '2026-10-20T10:00:00Z',
      region: 'us-east-1',
      oauth_flow: 'DeviceCode',
    }),
    'x',
  );
  assert.equal(a.accessToken, 'AT');
  assert.equal(a.refreshToken, 'RT');
  assert.equal(a.region, 'us-east-1');
  assert.equal(a.oauthFlow, 'DeviceCode');

  const b = parseTokenRecord(
    JSON.stringify({ accessToken: 'AT2', expiresAt: '2026-10-20T10:00:00Z', profileArn: 'arn:aws:codewhisperer:eu-west-1:1:profile/X' }),
    'y',
  );
  assert.equal(b.accessToken, 'AT2');
  assert.equal(b.region, 'eu-west-1'); // derived from the ARN
});

test('parseTokenRecord reports missing fields without leaking values', () => {
  assert.throws(() => parseTokenRecord('{"expires_at":"2026-10-20T10:00:00Z"}', 'x'), /access_token/);
  assert.throws(() => parseTokenRecord('{"access_token":"SECRET"}', 'x'), (e: Error) => {
    assert.match(e.message, /expires_at/);
    assert.doesNotMatch(e.message, /SECRET/);
    return true;
  });
  assert.throws(() => parseTokenRecord('not json', 'x'), /JSON/);
});

test('regionFromArn and extractProfileArn', () => {
  assert.equal(regionFromArn('arn:aws:codewhisperer:us-east-1:123:profile/ABC'), 'us-east-1');
  assert.equal(regionFromArn('garbage'), undefined);
  const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/ABC';
  assert.equal(extractProfileArn(arn), arn);
  assert.equal(extractProfileArn(JSON.stringify(arn)), arn);
  assert.equal(extractProfileArn(JSON.stringify({ arn })), arn);
  assert.equal(extractProfileArn(JSON.stringify({ profile_arn: arn })), arn);
  assert.equal(extractProfileArn('{"x":1}'), undefined);
});
