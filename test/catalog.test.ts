import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessToken } from '../src/auth/tokenProvider.ts';
import {
  KiroApiError,
  MAX_PAGES,
  ModelCatalog,
  listAvailableModels,
  parseModel,
  toChatModelInfo,
  type FetchFn,
} from '../src/models/catalog.ts';

const ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF';

function token(value = 'AT-FAKE', region: string | undefined = 'us-east-1'): AccessToken {
  return {
    token: value,
    expiresAt: new Date(Date.now() + 3600_000),
    region,
    profileArn: ARN,
    hasClientRegistration: true,
    source: 'fake',
  };
}

/** Entries in the format observed on the backend (real field values, fake names). */
const OPUS = {
  modelId: 'claude-opus-x',
  modelName: 'Claude Opus X',
  description: 'Test model',
  modelProvider: null,
  rateMultiplier: 2.2,
  rateUnit: 'Credit',
  tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
  supportedInputTypes: ['TEXT', 'IMAGE'],
  additionalModelRequestFieldsSchema: { type: 'object', properties: { thinking: { type: 'object' } } },
  status: null,
};
const TEXT_ONLY = {
  modelId: 'glm-x',
  modelName: null,
  rateMultiplier: 0.5,
  rateUnit: 'Credit',
  tokenLimits: null,
  supportedInputTypes: ['TEXT'],
  additionalModelRequestFieldsSchema: null,
};

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function fakeFetch(pages: Array<{ status?: number; body: unknown }>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url: new URL(url), headers: init.headers as Record<string, string> });
    const page = pages[Math.min(i++, pages.length - 1)]!;
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn, calls };
}

test('parseModel: complete fields, fallbacks and invalid entries', () => {
  const m = parseModel(OPUS)!;
  assert.equal(m.id, 'claude-opus-x');
  assert.equal(m.name, 'Claude Opus X');
  assert.equal(m.maxInputTokens, 1_000_000);
  assert.equal(m.maxOutputTokens, 128_000);
  assert.equal(m.supportsImages, true);
  assert.deepEqual(Object.keys(m.requestFieldsSchema!), ['type', 'properties']);

  const t = parseModel(TEXT_ONLY)!;
  assert.equal(t.name, 'glm-x', 'without modelName it uses the id');
  assert.equal(t.maxInputTokens, 200_000);
  assert.equal(t.maxOutputTokens, 64_000);
  assert.equal(t.supportsImages, false);
  assert.equal(t.requestFieldsSchema, undefined);

  assert.equal(parseModel({ modelName: 'no id' }), undefined);
  assert.equal(parseModel(null), undefined);
  assert.equal(parseModel('x'), undefined);
});

test('listAvailableModels: host, query, headers and defaultModel', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { models: [OPUS, TEXT_ONLY], defaultModel: { modelId: 'claude-opus-x' }, nextToken: null } },
  ]);
  const list = await listAvailableModels({ token: token(), userAgent: 'kiro-relay/test', fetch });

  assert.equal(calls.length, 1);
  const { url, headers } = calls[0]!;
  assert.equal(url.origin, 'https://management.us-east-1.kiro.dev');
  assert.equal(url.pathname, '/ListAvailableModels');
  assert.equal(url.searchParams.get('origin'), 'AI_EDITOR');
  assert.equal(url.searchParams.get('profileArn'), ARN);
  assert.equal(url.searchParams.has('nextToken'), false);
  assert.equal(headers.Authorization, 'Bearer AT-FAKE');
  assert.equal(headers['User-Agent'], 'kiro-relay/test');
  // The chat runtime headers give a 404 on the management host.
  assert.equal(headers['x-amz-target'], undefined);
  assert.equal(headers['Content-Type'], undefined);

  assert.deepEqual(list.models.map((m) => m.id), ['claude-opus-x', 'glm-x']);
  assert.equal(list.defaultModelId, 'claude-opus-x');
});

test('listAvailableModels: follows nextToken, drops duplicates and respects the page cap', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { models: [OPUS], nextToken: 'p2' } },
    { body: { models: [OPUS, TEXT_ONLY], nextToken: null } },
  ]);
  const list = await listAvailableModels({ token: token(), userAgent: 'ua', fetch });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url.searchParams.get('nextToken'), 'p2');
  assert.deepEqual(list.models.map((m) => m.id), ['claude-opus-x', 'glm-x']);

  const endless = fakeFetch([{ body: { models: [OPUS], nextToken: 'forever' } }]);
  await listAvailableModels({ token: token(), userAgent: 'ua', fetch: endless.fetch });
  assert.equal(endless.calls.length, MAX_PAGES);
});

test('listAvailableModels: an HTTP error becomes KiroApiError without leaking the token', async () => {
  const { fetch } = fakeFetch([{ status: 403, body: { message: 'Invalid token', reason: null } }]);
  await assert.rejects(
    listAvailableModels({ token: token('AT-SECRET'), userAgent: 'ua', fetch }),
    (e: unknown) => {
      assert.ok(e instanceof KiroApiError);
      assert.equal(e.status, 403);
      assert.match(e.message, /HTTP 403: Invalid token/);
      assert.ok(!e.message.includes('AT-SECRET'));
      return true;
    },
  );
});

test('listAvailableModels: a missing or invalid region fails before touching the network', async () => {
  const { fetch, calls } = fakeFetch([{ body: { models: [] } }]);
  await assert.rejects(listAvailableModels({ token: { ...token(), region: undefined }, userAgent: 'ua', fetch }), /region/);
  await assert.rejects(listAvailableModels({ token: token('x', 'evil.com/'), userAgent: 'ua', fetch }), /region/);
  assert.equal(calls.length, 0);
});

test('toChatModelInfo: VS Code format', () => {
  const info = toChatModelInfo(parseModel(OPUS)!, 'claude-opus-x');
  assert.deepEqual(info, {
    id: 'claude-opus-x',
    name: 'Claude Opus X',
    family: 'claude-opus-x',
    version: 'claude-opus-x',
    tooltip: 'Test model\nDefault Kiro model.',
    detail: '2.2x credits',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { imageInput: true, toolCalling: true },
  });
  const t = toChatModelInfo(parseModel(TEXT_ONLY)!, 'other');
  assert.equal(t.tooltip, undefined);
  assert.equal(t.capabilities.imageInput, false);
});

test('ModelCatalog: TTL cache, single-flight and the previous list on failure', async () => {
  let now = 0;
  let fail = false;
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    calls++;
    if (fail) return new Response('{"message":"boom"}', { status: 500 });
    return new Response(JSON.stringify({ models: [OPUS] }), { status: 200 });
  };
  const catalog = new ModelCatalog({
    getToken: async () => token(),
    userAgent: 'ua',
    fetch: fetchFn,
    ttlMs: 1000,
    now: () => now,
  });

  const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
  assert.equal(calls, 1, 'concurrent calls share the fetch');
  assert.equal(a, b);

  now = 500;
  await catalog.get();
  assert.equal(calls, 1, 'within the TTL it uses the cache');

  now = 1500;
  fail = true;
  const stale = await catalog.get();
  assert.equal(calls, 2);
  assert.deepEqual(stale.models.map((m) => m.id), ['claude-opus-x'], 'a failure keeps the previous list');

  catalog.invalidate();
  await assert.rejects(catalog.get(), /HTTP 500/);
});

test('ModelCatalog: a 403 re-reads credentials and retries once; an empty catalog is an error', async () => {
  const reloads: boolean[] = [];
  const { fetch, calls } = fakeFetch([
    { status: 403, body: { message: 'Invalid token' } },
    { body: { models: [OPUS] } },
  ]);
  const catalog = new ModelCatalog({
    getToken: async (o) => {
      reloads.push(Boolean(o?.forceReload));
      return token(o?.forceReload ? 'NEW' : 'OLD');
    },
    userAgent: 'ua',
    fetch,
  });
  const list = await catalog.get();
  assert.deepEqual(reloads, [false, true]);
  assert.equal(calls[1]!.headers.Authorization, 'Bearer NEW');
  assert.equal(list.models.length, 1);

  const empty = new ModelCatalog({
    getToken: async () => token(),
    userAgent: 'ua',
    fetch: fakeFetch([{ body: { models: [] } }]).fetch,
  });
  await assert.rejects(empty.get(), /empty/);
});
