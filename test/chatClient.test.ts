import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessToken } from '../src/auth/tokenProvider.ts';
import { FirstOutputTimeoutError, TARGET, streamChat, type ChatRequestOptions } from '../src/chat/client.ts';
import { encodeFrame } from '../src/chat/eventstream.ts';
import type { ChatEvent } from '../src/chat/response.ts';
import { KiroApiError, type FetchFn } from '../src/kiro/api.ts';

const enc = new TextEncoder();

function token(value = 'AT-FAKE'): AccessToken {
  return {
    token: value,
    expiresAt: new Date(Date.now() + 3600_000),
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/X',
    hasClientRegistration: true,
    source: 'fake',
  };
}

function frames(...events: Array<[string, unknown]>): Uint8Array[] {
  return events.map(([type, payload]) =>
    encodeFrame({ ':event-type': type, ':message-type': 'event' }, enc.encode(JSON.stringify(payload))),
  );
}

function streamResponse(chunks: Uint8Array[], delayMs = 0): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (cancelled) return;
        controller.enqueue(c);
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function options(responses: Array<() => Response | Promise<Response>>, extra: Partial<ChatRequestOptions> = {}) {
  const calls: Call[] = [];
  const reloads: boolean[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    const signal = init.signal;
    const res = await next();
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return res;
  };
  const opts: ChatRequestOptions = {
    getToken: async (o) => {
      reloads.push(Boolean(o?.forceReload));
      return token(o?.forceReload ? 'AT-NEW' : 'AT-FAKE');
    },
    buildBody: (t) => ({ profileArn: t.profileArn, conversationState: {} }),
    userAgent: 'kiro-relay/test',
    fetch: fetchFn,
    sleep: async () => {},
    ...extra,
  };
  return { opts, calls, reloads };
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test('request: runtime host, path, headers and body', async () => {
  const { opts, calls } = options([() => streamResponse(frames(['assistantResponseEvent', { content: 'ok' }]))]);
  const events = await collect(streamChat(opts));
  assert.deepEqual(events, [{ type: 'text', text: 'ok' }, { type: 'end' }]);
  assert.equal(calls[0]!.url, 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse');
  assert.deepEqual(calls[0]!.headers, {
    Authorization: 'Bearer AT-FAKE',
    'Content-Type': 'application/x-amz-json-1.0',
    'x-amz-target': TARGET,
    'x-amzn-kiro-agent-mode': 'vibe',
    'User-Agent': 'kiro-relay/test',
  });
  assert.deepEqual(calls[0]!.body, { profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/X', conversationState: {} });
});

test('403 re-reads the credentials and retries once with the new token', async () => {
  const { opts, calls, reloads } = options([
    () => jsonResponse(403, { message: 'Invalid token' }),
    () => streamResponse(frames(['assistantResponseEvent', { content: 'ok' }])),
  ]);
  await collect(streamChat(opts));
  assert.deepEqual(reloads, [false, true]);
  assert.equal(calls[1]!.headers.Authorization, 'Bearer AT-NEW');

  const twice = options([() => jsonResponse(403, { message: 'Invalid token' })]);
  await assert.rejects(collect(streamChat(twice.opts)), (e: unknown) => e instanceof KiroApiError && e.status === 403);
  assert.equal(twice.calls.length, 2);
});

test('429/5xx back off and retry; 400 does not; the last error carries the reason', async () => {
  const sleeps: number[] = [];
  const { opts, calls } = options(
    [() => jsonResponse(500, { message: 'boom' }), () => jsonResponse(429, { message: 'slow' }), () => streamResponse(frames(['assistantResponseEvent', { content: 'ok' }]))],
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  const events = await collect(streamChat(opts));
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(events[0]!.type, 'text');

  const bad = options([() => jsonResponse(400, { message: 'Improperly formed request.', reason: null })]);
  await assert.rejects(collect(streamChat(bad.opts)), /HTTP 400: Improperly formed request\./);
  assert.equal(bad.calls.length, 1);

  const quota = options([() => jsonResponse(429, { message: 'limit', reason: 'MONTHLY_REQUEST_COUNT' })]);
  await assert.rejects(collect(streamChat(quota.opts)), (e: unknown) => {
    assert.ok(e instanceof KiroApiError);
    assert.equal(e.reason, 'MONTHLY_REQUEST_COUNT');
    return true;
  });
  assert.equal(quota.calls.length, 3);
});

test('no output in time: retries, then FirstOutputTimeoutError', async () => {
  const slow = () => streamResponse(frames(['assistantResponseEvent', { content: 'late' }]), 200);
  const { opts, calls } = options([slow], { firstOutputTimeoutMs: 20, maxAttempts: 2 });
  await assert.rejects(collect(streamChat(opts)), FirstOutputTimeoutError);
  assert.equal(calls.length, 2);

  const recovers = options([slow, () => streamResponse(frames(['assistantResponseEvent', { content: 'fast' }]))], {
    firstOutputTimeoutMs: 20,
  });
  assert.deepEqual(await collect(streamChat(recovers.opts)), [{ type: 'text', text: 'fast' }, { type: 'end' }]);
});

test('after the first output, errors propagate without retry', async () => {
  const good = frames(['assistantResponseEvent', { content: 'partial' }])[0]!;
  const corrupt = good.slice(0, 10);
  const { opts, calls } = options([() => streamResponse([good, corrupt])]);
  const seen: ChatEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const e of streamChat(opts)) seen.push(e);
    })(),
    /middle of a frame/,
  );
  assert.deepEqual(seen, [{ type: 'text', text: 'partial' }]);
  assert.equal(calls.length, 1);
});

test('network errors are retried; other errors before output are not', async () => {
  const net = options([
    () => {
      throw new TypeError('fetch failed');
    },
    () => streamResponse(frames(['assistantResponseEvent', { content: 'ok' }])),
  ]);
  await collect(streamChat(net.opts));
  assert.equal(net.calls.length, 2);

  const expired = options([() => streamResponse([])], {
    getToken: async () => {
      throw new Error('token expired');
    },
  });
  await assert.rejects(collect(streamChat(expired.opts)), /token expired/);
  assert.equal(expired.calls.length, 0);
});

test('cancellation stops quietly', async () => {
  const controller = new AbortController();
  const { opts } = options([() => streamResponse(frames(['assistantResponseEvent', { content: 'a' }], ['assistantResponseEvent', { content: 'b' }]), 30)], {
    signal: controller.signal,
  });
  const seen: ChatEvent[] = [];
  for await (const e of streamChat(opts)) {
    seen.push(e);
    controller.abort();
  }
  assert.deepEqual(seen, [{ type: 'text', text: 'a' }]);
});
