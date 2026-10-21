import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventStreamError,
  crc32,
  decodeEventStream,
  decodeFrame,
  encodeFrame,
  type EventMessage,
} from '../src/chat/eventstream.ts';

const enc = new TextEncoder();

function frame(eventType: string, payload: unknown, messageType = 'event'): Uint8Array {
  return encodeFrame(
    { ':event-type': eventType, ':content-type': 'application/json', ':message-type': messageType },
    enc.encode(JSON.stringify(payload)),
  );
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

async function collect(it: AsyncIterable<EventMessage>): Promise<EventMessage[]> {
  const out: EventMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

test('crc32 matches the IEEE reference value', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('decodeFrame round-trips headers and payload', () => {
  const m = decodeFrame(frame('assistantResponseEvent', { content: 'hi' }));
  assert.equal(m.headers[':event-type'], 'assistantResponseEvent');
  assert.equal(m.headers[':message-type'], 'event');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(m.payload)), { content: 'hi' });
});

test('decodeFrame reads every header type', () => {
  // name "b" true, "f" false, "i8" byte -2, "i16" -300, "i32" 70000, "i64" 2^40, "bin" bytes [1,2], "ts" timestamp, "id" uuid
  const h: number[] = [];
  const name = (s: string) => h.push(s.length, ...enc.encode(s));
  name('b'); h.push(0);
  name('f'); h.push(1);
  name('i8'); h.push(2, 0xfe);
  name('i16'); h.push(3, 0xfe, 0xd4);
  name('i32'); h.push(4, 0x00, 0x01, 0x11, 0x70);
  name('i64'); h.push(5, 0, 0, 0x01, 0, 0, 0, 0, 0);
  name('bin'); h.push(6, 0, 2, 1, 2);
  name('ts'); h.push(8, 0, 0, 0, 0, 0, 0, 0x03, 0xe8);
  name('id'); h.push(9, ...Array.from({ length: 16 }, (_, i) => i));
  const headers = Uint8Array.from(h);
  const total = 12 + headers.length + 4;
  const f = new Uint8Array(total);
  const v = new DataView(f.buffer);
  v.setUint32(0, total);
  v.setUint32(4, headers.length);
  v.setUint32(8, crc32(f.subarray(0, 8)));
  f.set(headers, 12);
  v.setUint32(total - 4, crc32(f.subarray(0, total - 4)));

  const m = decodeFrame(f);
  assert.equal(m.headers.b, true);
  assert.equal(m.headers.f, false);
  assert.equal(m.headers.i8, -2);
  assert.equal(m.headers.i16, -300);
  assert.equal(m.headers.i32, 70000);
  assert.equal(m.headers.i64, 2 ** 40);
  assert.deepEqual(m.headers.bin, Uint8Array.from([1, 2]));
  assert.equal(m.headers.ts, 1000);
  assert.equal((m.headers.id as Uint8Array).length, 16);
  assert.equal(m.payload.length, 0);
});

test('decodeEventStream handles frames split at any byte', async () => {
  const bytes = concat(
    frame('assistantResponseEvent', { content: 'a' }),
    frame('assistantResponseEvent', { content: 'b' }),
    frame('metadataEvent', { stopReason: 'END_TURN' }),
  );
  for (const size of [1, 3, 7, 64, bytes.length]) {
    const msgs = await collect(decodeEventStream(chunked(bytes, size)));
    assert.deepEqual(
      msgs.map((m) => m.headers[':event-type']),
      ['assistantResponseEvent', 'assistantResponseEvent', 'metadataEvent'],
      `chunk size ${size}`,
    );
  }
});

test('decodeEventStream rejects corruption and truncation', async () => {
  const good = frame('assistantResponseEvent', { content: 'x' });

  const badCrc = good.slice();
  badCrc[badCrc.length - 6]! ^= 0xff;
  await assert.rejects(collect(decodeEventStream(chunked(badCrc, 8))), /CRC/);

  const badPrelude = good.slice();
  badPrelude[5]! ^= 0x01;
  await assert.rejects(collect(decodeEventStream(chunked(badPrelude, 8))), EventStreamError);

  await assert.rejects(collect(decodeEventStream(chunked(good.slice(0, good.length - 3), 8))), /middle of a frame/);

  const tiny = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
  await assert.rejects(collect(decodeEventStream(chunked(tiny, 8))), /invalid frame length/);
});
