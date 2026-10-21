// Converts VS Code chat request messages into neutral ChatMessages. Pure module: no vscode import.
//
// Parts are recognized by shape instead of `instanceof`, so this runs in tests without VS Code:
//   LanguageModelTextPart       { value: string }
//   LanguageModelToolCallPart   { callId, name, input }
//   LanguageModelToolResultPart { callId, content: unknown[] }
//   LanguageModelDataPart       { mimeType: string, data: Uint8Array }
//   LanguageModelThinkingPart   { value, id, metadata }   (proposed API; dropped)
// Role numbers: 1 = User, 2 = Assistant, 3 = System (proposed API, sent by VS Code 1.142).

import type { ChatMessage, ChatPart, ChatTool } from './request.ts';

export interface VsCodeMessageLike {
  readonly role: number;
  readonly content: ReadonlyArray<unknown>;
}

export interface VsCodeToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}

const utf8 = new TextDecoder();

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

function isDataPart(p: Record<string, unknown>): p is { mimeType: string; data: Uint8Array } {
  return typeof p.mimeType === 'string' && p.data instanceof Uint8Array;
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json');
}

/** Text of a tool result's content; images inside it are returned separately. */
function toolResultContent(content: unknown): { text: string; images: ChatPart[] } {
  const texts: string[] = [];
  const images: ChatPart[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const p = rec(item);
    if (!p) continue;
    if (typeof p.value === 'string') texts.push(p.value);
    else if (isDataPart(p)) {
      if (p.mimeType.startsWith('image/')) images.push({ type: 'image', mimeType: p.mimeType, data: p.data });
      else if (isTextMime(p.mimeType)) texts.push(utf8.decode(p.data));
    } else if (p.value !== undefined) {
      // LanguageModelPromptTsxPart and other unknown parts: best-effort JSON.
      try {
        texts.push(JSON.stringify(p.value));
      } catch {
        // not serializable
      }
    }
  }
  return { text: texts.join('\n'), images };
}

export function fromVsCodeMessages(messages: ReadonlyArray<VsCodeMessageLike>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const role = m.role === 2 ? 'assistant' : m.role === 3 ? 'system' : 'user';
    const parts: ChatPart[] = [];
    for (const item of m.content) {
      const p = rec(item);
      if (!p) continue;
      // Thinking parts are dropped: Kiro rejects reasoning without a valid signature.
      if ('id' in p && 'metadata' in p && 'value' in p) continue;
      if (typeof p.callId === 'string' && typeof p.name === 'string' && 'input' in p) {
        parts.push({ type: 'toolCall', id: p.callId, name: p.name, input: p.input });
      } else if (typeof p.callId === 'string' && Array.isArray(p.content)) {
        const { text, images } = toolResultContent(p.content);
        parts.push({ type: 'toolResult', id: p.callId, text });
        parts.push(...images);
      } else if (typeof p.value === 'string') {
        parts.push({ type: 'text', text: p.value });
      } else if (isDataPart(p)) {
        if (p.mimeType.startsWith('image/')) parts.push({ type: 'image', mimeType: p.mimeType, data: p.data });
        else if (isTextMime(p.mimeType)) parts.push({ type: 'text', text: utf8.decode(p.data) });
        // Other data parts (e.g. cache-control markers) carry no content for Kiro.
      }
      // Unknown parts are dropped.
    }
    out.push({ role, parts });
  }
  return out;
}

export function fromVsCodeTools(tools: ReadonlyArray<VsCodeToolLike> | undefined): ChatTool[] {
  return (tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
}
