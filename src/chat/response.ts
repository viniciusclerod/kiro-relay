// Turns GenerateAssistantResponse event stream messages into chat events. Pure module: no vscode.
//
// Observed on 2026-10-21: assistantResponseEvent {content}, toolUseEvent {toolUseId, name, input
// fragment, stop}, metadataEvent {stopReason}, contextUsageEvent, meteringEvent {usage, unit}.

import type { EventMessage } from './eventstream.ts';

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'end'; stopReason?: string; credits?: number; contextUsagePercentage?: number };

/** Error event inside the stream (`:message-type: exception`). */
export class KiroStreamError extends Error {
  readonly exceptionType: string;
  readonly reason?: string;

  constructor(exceptionType: string, message: string, reason?: string) {
    super(`${exceptionType}: ${message}`);
    this.name = 'KiroStreamError';
    this.exceptionType = exceptionType;
    this.reason = reason;
  }
}

const utf8 = new TextDecoder();

function payloadOf(m: EventMessage): Record<string, unknown> {
  if (m.payload.length === 0) return {};
  try {
    const v = JSON.parse(utf8.decode(m.payload)) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface PendingTool {
  id: string;
  name: string;
  input: string;
}

/**
 * Yields text and reasoning as they arrive, each tool call once its arguments are complete, and a
 * final `end` event. Throws KiroStreamError for exceptions in the stream.
 */
export async function* parseChatEvents(messages: AsyncIterable<EventMessage>): AsyncGenerator<ChatEvent> {
  const pending = new Map<string, PendingTool>();
  const emitted = new Set<string>();
  let lastToolId: string | undefined;
  const end: Extract<ChatEvent, { type: 'end' }> = { type: 'end' };

  function* finishTool(id: string): Generator<ChatEvent> {
    const t = pending.get(id);
    if (!t) return;
    pending.delete(id);
    if (emitted.has(id)) return;
    emitted.add(id);
    yield { type: 'toolCall', id: t.id, name: t.name, input: parseArguments(t.input) };
  }

  for await (const m of messages) {
    const messageType = m.headers[':message-type'];
    const eventType = m.headers[':event-type'];
    const exceptionType = m.headers[':exception-type'];
    const p = payloadOf(m);

    if (messageType === 'exception' || typeof exceptionType === 'string' || eventType === 'internalServerException') {
      const type = typeof exceptionType === 'string' ? exceptionType : String(eventType ?? 'UnknownException');
      const reason = typeof p.reason === 'string' ? p.reason : undefined;
      throw new KiroStreamError(type, typeof p.message === 'string' ? p.message : 'unknown error', reason);
    }

    switch (eventType) {
      case 'assistantResponseEvent':
        if (typeof p.content === 'string' && p.content) yield { type: 'text', text: p.content };
        break;
      case 'reasoningContentEvent':
        if (typeof p.text === 'string' && p.text) yield { type: 'reasoning', text: p.text };
        break;
      case 'toolUseEvent': {
        const id = typeof p.toolUseId === 'string' && p.toolUseId ? p.toolUseId : lastToolId;
        if (!id) break;
        lastToolId = id;
        let t = pending.get(id);
        if (!t) {
          if (emitted.has(id)) break;
          t = { id, name: '', input: '' };
          pending.set(id, t);
        }
        if (typeof p.name === 'string' && p.name) t.name = p.name;
        if (typeof p.input === 'string') t.input += p.input;
        if (p.stop === true) yield* finishTool(id);
        break;
      }
      case 'metadataEvent':
        if (typeof p.stopReason === 'string') end.stopReason = p.stopReason;
        break;
      case 'contextUsageEvent':
        if (typeof p.contextUsagePercentage === 'number') end.contextUsagePercentage = p.contextUsagePercentage;
        break;
      case 'meteringEvent':
        if (typeof p.usage === 'number') end.credits = (end.credits ?? 0) + p.usage;
        break;
      default:
        // Other event types (citations, follow-up prompts, ...) are not used.
        break;
    }
  }
  // Tool calls whose `stop` never arrived are still delivered.
  for (const id of [...pending.keys()]) yield* finishTool(id);
  yield end;
}
