import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessToken } from '../src/auth/tokenProvider.ts';
import type { FetchFn } from '../src/kiro/api.ts';
import { UsageTracker, creditItem, getUsageLimits, parseUsage, progressBar } from '../src/kiro/usage.ts';

const ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF';

/** Response observed on 2026-10-21 (user fields removed). */
const REAL = {
  daysUntilReset: null,
  limits: null,
  nextDateReset: 1793491200,
  overageConfiguration: { overageStatus: 'DISABLED' },
  subscriptionInfo: {
    overageCapability: 'OVERAGE_CAPABLE',
    subscriptionManagementTarget: 'MANAGE',
    subscriptionTitle: 'KIRO PRO',
    type: 'Q_DEVELOPER_STANDALONE_PRO',
    upgradeCapability: 'UPGRADE_INCAPABLE',
  },
  usageBreakdownList: [
    {
      addOnMetadata: null,
      bonuses: [],
      currency: 'USD',
      currentOverages: 0,
      currentOveragesWithPrecision: 0,
      currentUsage: 8,
      currentUsageWithPrecision: 8.69,
      dimensionType: null,
      displayName: 'Credit',
      displayNamePlural: 'Credits',
      freeTrialInfo: null,
      nextDateReset: 1793491200,
      overageCap: 10000,
      overageCapWithPrecision: 10000,
      overageCharges: 0,
      overageCredits: [],
      overageRate: 0.04,
      resourceType: 'CREDIT',
      unit: 'INVOCATIONS',
      usageLimit: 1000,
      usageLimitWithPrecision: 1000,
    },
  ],
  userInfo: { email: 'someone@example.com', userId: 'u-1' },
};

function token(): AccessToken {
  return {
    token: 'AT-FAKE',
    expiresAt: new Date(Date.now() + 3600_000),
    region: 'us-east-1',
    profileArn: ARN,
    hasClientRegistration: true,
    source: 'fake',
  };
}

test('parseUsage: the real response', () => {
  const u = parseUsage(REAL);
  assert.deepEqual(u, {
    plan: 'KIRO PRO',
    resetsAt: new Date('2026-11-01T00:00:00Z'),
    overagesEnabled: false,
    items: [{ resourceType: 'CREDIT', name: 'Credits', used: 8.69, limit: 1000, percentUsed: 0 }],
    bonuses: [],
  });
  assert.ok(!JSON.stringify(u).includes('someone@example.com'), 'user info is not kept');
});

test('parseUsage: percent rounds down, unlimited plans, missing fields', () => {
  const item = (used: number, limit: number) => ({ resourceType: 'CREDIT', currentUsage: used, usageLimit: limit });
  assert.equal(parseUsage({ usageBreakdownList: [item(199.9, 1000)] }).items[0]!.percentUsed, 19);
  assert.equal(parseUsage({ usageBreakdownList: [item(5000, 1000)] }).items[0]!.percentUsed, 100);
  const unlimited = parseUsage({ usageBreakdownList: [item(42, 999_999)] }).items[0]!;
  assert.equal(unlimited.limit, undefined);
  assert.equal(unlimited.percentUsed, undefined);
  assert.deepEqual(parseUsage(null), { plan: undefined, resetsAt: undefined, overagesEnabled: false, items: [], bonuses: [] });
  assert.equal(parseUsage({ usageBreakdownList: [{ nextDateReset: '2026-12-01T00:00:00Z' }] }).resetsAt?.toISOString(), '2026-12-01T00:00:00.000Z');
});

test('parseUsage: bonuses follow the Kiro IDE rules', () => {
  const u = parseUsage({
    overageConfiguration: { overageStatus: 'ENABLED' },
    usageBreakdownList: [
      {
        resourceType: 'CREDIT',
        currentUsage: 1,
        usageLimit: 50,
        freeTrialInfo: { freeTrialStatus: 'ACTIVE', currentUsage: 10, usageLimit: 500, freeTrialExpiry: 1793491200 },
        bonuses: [
          { status: 'ACTIVE', displayName: 'Launch bonus', currentUsage: 2, usageLimit: 100, expiresAt: 1793491200 },
          { status: 'EXHAUSTED', currentUsage: 20, usageLimit: 20 },
          { status: 'EXPIRED', displayName: 'Old', currentUsage: 0, usageLimit: 999 },
        ],
      },
    ],
  });
  assert.equal(u.overagesEnabled, true);
  assert.equal(u.items[0]!.limit, 50, 'bonuses do not change the main limit');
  assert.deepEqual(
    u.bonuses.map((b) => [b.name, b.used, b.total]),
    [
      ['Welcome bonus', 10, 500],
      ['Launch bonus', 2, 100],
      ['Bonus', 20, 20],
    ],
  );
});

test('getUsageLimits: host, path, query and headers', async () => {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url: new URL(url), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(REAL), { status: 200 });
  };
  const u = await getUsageLimits({ token: token(), userAgent: 'kiro-relay/test', fetch: fetchFn });
  assert.equal(u.plan, 'KIRO PRO');
  const { url, headers } = calls[0]!;
  assert.equal(`${url.origin}${url.pathname}`, 'https://management.us-east-1.kiro.dev/getUsageLimits');
  assert.equal(url.searchParams.get('origin'), 'AI_EDITOR');
  assert.equal(url.searchParams.get('profileArn'), ARN);
  assert.equal(headers.Authorization, 'Bearer AT-FAKE');
  assert.equal(headers['x-amz-target'], undefined);

  const failing: FetchFn = async () => new Response('{"message":"Invalid token"}', { status: 403 });
  await assert.rejects(getUsageLimits({ token: token(), userAgent: 'ua', fetch: failing }), /GetUsageLimits: HTTP 403: Invalid token/);
});

test('UsageTracker: TTL, single-flight, last good value on failure, onChange', async () => {
  let now = 0;
  let fail = false;
  let calls = 0;
  const changes: string[] = [];
  const tracker = new UsageTracker({
    getToken: async () => token(),
    userAgent: 'ua',
    ttlMs: 1000,
    now: () => now,
    fetch: async () => {
      calls++;
      return fail ? new Response('{"message":"boom"}', { status: 500 }) : new Response(JSON.stringify(REAL), { status: 200 });
    },
    onChange: (u) => changes.push(u.plan ?? '?'),
  });
  assert.equal(tracker.current, undefined);
  await Promise.all([tracker.refresh(), tracker.refresh()]);
  assert.equal(calls, 1);
  assert.deepEqual(changes, ['KIRO PRO']);

  now = 500;
  await tracker.refresh();
  assert.equal(calls, 1, 'fresh value is reused');

  fail = true;
  const kept = await tracker.refresh({ force: true });
  assert.equal(calls, 2);
  assert.equal(kept?.plan, 'KIRO PRO');
  assert.match(tracker.lastError!, /HTTP 500/);
  assert.deepEqual(changes, ['KIRO PRO'], 'no change event on failure');

  const empty = new UsageTracker({ getToken: async () => { throw new Error('token expired'); }, userAgent: 'ua' });
  assert.equal(await empty.refresh(), undefined, 'never throws');
  assert.equal(empty.lastError, 'token expired');
});

test('creditItem and progressBar', () => {
  assert.equal(creditItem(parseUsage(REAL))?.name, 'Credits');
  assert.equal(creditItem(parseUsage({})), undefined);
  assert.equal(progressBar(0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(progressBar(20), '▰▰▱▱▱▱▱▱▱▱');
  assert.equal(progressBar(100), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(progressBar(250, 4), '▰▰▰▰');
});
