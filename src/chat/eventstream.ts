// Decoder for the AWS event stream binary format (application/vnd.amazon.eventstream).
// Pure module: no vscode, no dependencies.
//
// Frame layout (big-endian):
//   total_length u32 | headers_length u32 | prelude_crc u32 | headers | payload | message_crc u32
// prelude_crc covers the first 8 bytes; message_crc covers everything before it.

export interface EventMessage {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Uint8Array;
}

/** Frames above this size are treated as corruption. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const PRELUDE_BYTES = 12;
const MIN_FRAME_BYTES = PRELUDE_BYTES + 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), as used by the event stream format. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class EventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventStreamError';
  }
}

const utf8 = new TextDecoder();

function decodeHeaders(bytes: Uint8Array): EventMessage['headers'] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: EventMessage['headers'] = {};
  let i = 0;
  const need = (n: number) => {
    if (i + n > bytes.length) throw new EventStreamError('truncated header');
  };
  while (i < bytes.length) {
    need(1);
    const nameLen = bytes[i++]!;
    need(nameLen + 1);
    const name = utf8.decode(bytes.subarray(i, i + nameLen));
    i += nameLen;
    const type = bytes[i++]!;
    switch (type) {
      case 0:
        headers[name] = true;
        break;
      case 1:
        headers[name] = false;
        break;
      case 2:
        need(1);
        headers[name] = view.getInt8(i);
        i += 1;
        break;
      case 3:
        need(2);
        headers[name] = view.getInt16(i);
        i += 2;
        break;
      case 4:
        need(4);
        headers[name] = view.getInt32(i);
        i += 4;
        break;
      case 5: // int64
      case 8: // timestamp (ms since epoch)
        need(8);
        headers[name] = Number(view.getBigInt64(i));
        i += 8;
        break;
      case 6: // bytes
      case 7: {
        // string
        need(2);
        const len = view.getUint16(i);
        i += 2;
        need(len);
        const value = bytes.subarray(i, i + len);
        headers[name] = type === 7 ? utf8.decode(value) : value.slice();
        i += len;
        break;
      }
      case 9: // uuid
        need(16);
        headers[name] = bytes.slice(i, i + 16);
        i += 16;
        break;
      default:
        throw new EventStreamError(`unknown header type ${type}`);
    }
  }
  return headers;
}

/** Decodes one complete frame. */
export function decodeFrame(frame: Uint8Array): EventMessage {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const total = view.getUint32(0);
  const headersLen = view.getUint32(4);
  if (total !== frame.length) throw new EventStreamError('frame length mismatch');
  if (crc32(frame.subarray(0, 8)) !== view.getUint32(8)) throw new EventStreamError('prelude CRC mismatch');
  if (crc32(frame.subarray(0, total - 4)) !== view.getUint32(total - 4)) {
    throw new EventStreamError('message CRC mismatch');
  }
  if (PRELUDE_BYTES + headersLen > total - 4) throw new EventStreamError('headers exceed frame');
  return {
    headers: decodeHeaders(frame.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headersLen)),
    payload: frame.slice(PRELUDE_BYTES + headersLen, total - 4),
  };
}

/**
 * Splits a byte stream into event messages. Chunks may cut frames anywhere.
 * A truncated last frame or any corruption throws EventStreamError (no resync).
 */
export async function* decodeEventStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<EventMessage> {
  let buffer = new Uint8Array(0);
  for await (const chunk of chunks) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    while (buffer.length >= 4) {
      const total = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
      if (total < MIN_FRAME_BYTES || total > MAX_FRAME_BYTES) {
        throw new EventStreamError(`invalid frame length ${total}`);
      }
      if (buffer.length < total) break;
      yield decodeFrame(buffer.subarray(0, total));
      buffer = buffer.slice(total);
    }
  }
  if (buffer.length > 0) throw new EventStreamError('stream ended in the middle of a frame');
}

// ---------------------------------------------------------------------------
// Encoder, used by tests to build fixtures.
// ---------------------------------------------------------------------------

export function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    parts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const headerBytes = Uint8Array.from(parts);
  const total = PRELUDE_BYTES + headerBytes.length + payload.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, PRELUDE_BYTES);
  frame.set(payload, PRELUDE_BYTES + headerBytes.length);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}
