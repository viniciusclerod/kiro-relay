import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, type EventMessage } from '../src/chat/eventstream.ts';
import { KiroStreamError, parseChatEvents, type ChatEvent } from '../src/chat/response.ts';

const enc = new TextEncoder();

function ev(eventType: string, payload: unknown): EventMessage {
  return decodeFrame(
    encodeFrame({ ':event-type': eventType, ':message-type': 'event' }, enc.encode(JSON.stringify(payload))),
  );
}

function exception(type: string, payload: unknown): EventMessage {
  return decodeFrame(
    encodeFrame({ ':exception-type': type, ':message-type': 'exception' }, enc.encode(JSON.stringify(payload))),
  );
}

async function* from(msgs: EventMessage[]): AsyncGenerator<EventMessage> {
  yield* msgs;
}

async function collect(msgs: EventMessage[]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of parseChatEvents(from(msgs))) out.push(e);
  return out;
}

test('text stream as observed on the backend', async () => {
  const events = await collect([
    ev('assistantResponseEvent', { content: 'o', modelId: 'm' }),
    ev('assistantResponseEvent', { content: 'k', modelId: 'm' }),
    ev('metadataEvent', { stopReason: 'END_TURN' }),
    ev('contextUsageEvent', { contextUsagePercentage: 1.4 }),
    ev('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.005 }),
  ]);
  assert.deepEqual(events, [
    { type: 'text', text: 'o' },
    { type: 'text', text: 'k' },
    { type: 'end', stopReason: 'END_TURN', credits: 0.005, contextUsagePercentage: 1.4 },
  ]);
});

test('tool call fragments are joined until stop (sequence observed on the backend)', async () => {
  const id = 'call_1';
  const events = await collect([
    ev('toolUseEvent', { name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { input: '{"', name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { input: 'city', name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { input: '":"', name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { input: 'Lis', name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { input: 'bon', name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { input: '"}', name: 'get_weather', toolUseId: id }),
    ev('toolUseEvent', { name: 'get_weather', stop: true, toolUseId: id }),
    ev('metadataEvent', { stopReason: 'END_TURN' }),
  ]);
  assert.deepEqual(events, [
    { type: 'toolCall', id, name: 'get_weather', input: { city: 'Lisbon' } },
    { type: 'end', stopReason: 'END_TURN' },
  ]);
});

test('two interleaved tool calls, a fragment without id, a missing stop and invalid JSON', async () => {
  const events = await collect([
    ev('toolUseEvent', { name: 'a', toolUseId: 't1', input: '{"x":' }),
    ev('toolUseEvent', { input: '1}' }), // no id: extends the most recent call
    ev('toolUseEvent', { name: 'b', toolUseId: 't2', input: 'not json' }),
    ev('toolUseEvent', { toolUseId: 't1', stop: true }),
    ev('toolUseEvent', { toolUseId: 't1', stop: true }), // duplicate stop is ignored
  ]);
  assert.deepEqual(events, [
    { type: 'toolCall', id: 't1', name: 'a', input: { x: 1 } },
    { type: 'toolCall', id: 't2', name: 'b', input: {} },
    { type: 'end' },
  ]);
});

test('reasoning, unknown events and empty payloads', async () => {
  const events = await collect([
    ev('reasoningContentEvent', { text: 'thinking' }),
    ev('followupPromptEvent', { anything: true }),
    ev('assistantResponseEvent', { content: '' }),
    decodeFrame(encodeFrame({ ':event-type': 'assistantResponseEvent' }, new Uint8Array(0))),
  ]);
  assert.deepEqual(events, [{ type: 'reasoning', text: 'thinking' }, { type: 'end' }]);
});

test('exceptions in the stream throw KiroStreamError', async () => {
  await assert.rejects(
    collect([
      ev('assistantResponseEvent', { content: 'partial' }),
      exception('ThrottlingException', { message: 'slow down', reason: 'MONTHLY_REQUEST_COUNT' }),
    ]),
    (e: unknown) => {
      assert.ok(e instanceof KiroStreamError);
      assert.equal(e.exceptionType, 'ThrottlingException');
      assert.equal(e.reason, 'MONTHLY_REQUEST_COUNT');
      assert.match(e.message, /slow down/);
      return true;
    },
  );
  await assert.rejects(collect([ev('internalServerException', { message: 'boom' })]), /internalServerException: boom/);
});
