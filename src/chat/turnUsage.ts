// Credits and context use per chat interaction. Pure module: no vscode.
//
// One user question can take several Kiro requests (Agent mode: tool call, tool result, ...). The
// requests of one question share the same conversation prefix up to the user's last text message,
// so that prefix identifies the interaction and the usage is summed across its requests.

import { createHash } from 'node:crypto';
import type { ChatMessage } from './request.ts';

export interface TurnUsage {
  requests: number;
  credits: number;
  /** Context window use reported by the last request, 0..100. */
  contextPercent?: number;
}

/** Invisible separator: wraps the usage footer so it can be found and removed from the history. */
export const FOOTER_MARK = '⁣';
const FOOTER_RE = new RegExp(`\\n*${FOOTER_MARK}[^${FOOTER_MARK}]*${FOOTER_MARK}`, 'g');

/** Wraps a footer line so stripFooters() can remove it later. */
export function markFooter(line: string): string {
  return `\n\n${FOOTER_MARK}${line.replaceAll(FOOTER_MARK, '')}${FOOTER_MARK}`;
}

/** Removes usage footers from text sent back to the model. */
export function stripFooters(text: string): string {
  return text.replace(FOOTER_RE, '');
}

/**
 * Key of the interaction a request belongs to: a hash of the messages up to and including the
 * user's last message that has text (tool results alone do not start a new interaction).
 */
export function interactionKey(messages: ChatMessage[]): string {
  let end = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.trim() !== '')) {
      end = i;
      break;
    }
  }
  const hash = createHash('sha256');
  for (const m of messages.slice(0, end + 1)) {
    hash.update(m.role);
    for (const p of m.parts) {
      if (p.type === 'text') hash.update(`t:${stripFooters(p.text)}`);
      else if (p.type === 'toolCall') hash.update(`c:${p.id}`);
      else if (p.type === 'toolResult') hash.update(`r:${p.id}`);
      else hash.update(`i:${p.data.length}`);
    }
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

/** Sums usage per interaction and for the session. Keeps a bounded number of interactions. */
export class TurnUsageTracker {
  private readonly turns = new Map<string, TurnUsage>();
  private readonly maxTurns: number;
  session = { interactions: 0, requests: 0, credits: 0 };
  last: TurnUsage | undefined;

  constructor(maxTurns = 200) {
    this.maxTurns = maxTurns;
  }

  /** Adds one finished request and returns the interaction's running total. */
  add(key: string, credits: number | undefined, contextPercent: number | undefined): TurnUsage {
    let turn = this.turns.get(key);
    if (!turn) {
      turn = { requests: 0, credits: 0 };
      this.turns.set(key, turn);
      this.session.interactions++;
      if (this.turns.size > this.maxTurns) this.turns.delete(this.turns.keys().next().value!);
    }
    turn.requests++;
    turn.credits += credits ?? 0;
    if (contextPercent !== undefined) turn.contextPercent = contextPercent;
    this.session.requests++;
    this.session.credits += credits ?? 0;
    this.last = { ...turn };
    return { ...turn };
  }
}

/** Approximate input tokens from the context use and the model's window. */
export function estimateContextTokens(contextPercent: number | undefined, maxInputTokens: number): number | undefined {
  if (contextPercent === undefined || !(maxInputTokens > 0)) return undefined;
  return Math.round((contextPercent / 100) * maxInputTokens);
}
