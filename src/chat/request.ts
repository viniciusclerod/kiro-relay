// Builds the GenerateAssistantResponse request body. Pure module: no vscode.
//
// Body shape and structural rules follow what the backend accepts (verified on 2026-10-21, and
// the kirogo project's notes). Breaking them gives "Improperly formed request.".

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: Uint8Array }
  | { type: 'toolCall'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; text: string; isError?: boolean };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  parts: ChatPart[];
}

export interface ChatTool {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface BuildOptions {
  modelId: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  profileArn?: string;
  /** Merged into additionalModelRequestFields (e.g. the reasoning effort). */
  requestFields?: Record<string, unknown>;
  conversationId: string;
}

export const PLACEHOLDER = '(no content)';
export const MAX_TOOL_NAME_LENGTH = 64;
const ORIGIN = 'AI_EDITOR';

export class RequestBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestBuildError';
  }
}

interface KiroImage {
  format: string;
  source: { bytes: string };
}
interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}
interface KiroToolResult {
  toolUseId: string;
  content: Array<{ text: string }>;
  status: 'success' | 'error';
}
interface UserTurn {
  role: 'user';
  text: string;
  images: KiroImage[];
  toolResults: KiroToolResult[];
}
interface AssistantTurn {
  role: 'assistant';
  text: string;
  toolUses: KiroToolUse[];
}
type Turn = UserTurn | AssistantTurn;

function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\n${b}`;
}

function imageFormat(mimeType: string): string {
  const sub = mimeType.toLowerCase().split('/')[1]?.split(/[+;]/)[0];
  return sub === 'jpg' ? 'jpeg' : sub || 'png';
}

function inputObject(input: unknown): unknown {
  if (typeof input === 'string') {
    try {
      return inputObject(JSON.parse(input));
    } catch {
      return {};
    }
  }
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
}

/** Drops what the backend rejects: `additionalProperties` anywhere and empty `required` arrays. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    if (k === 'required' && Array.isArray(v) && v.length === 0) continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

/** Converts neutral messages into alternating user/assistant turns that satisfy the backend rules. */
export function toTurns(messages: ChatMessage[], toolsDeclared: boolean): { system: string; turns: Turn[] } {
  let system = '';
  const turns: Turn[] = [];
  const last = () => turns[turns.length - 1];

  for (const msg of messages) {
    if (msg.role === 'system') {
      for (const p of msg.parts) if (p.type === 'text') system = joinText(system, p.text);
      continue;
    }
    if (msg.role === 'assistant') {
      let turn = last();
      if (turn?.role !== 'assistant') {
        turn = { role: 'assistant', text: '', toolUses: [] };
        turns.push(turn);
      }
      for (const p of msg.parts) {
        if (p.type === 'text') turn.text = joinText(turn.text, p.text);
        else if (p.type === 'toolCall') {
          if (toolsDeclared) turn.toolUses.push({ toolUseId: p.id, name: p.name, input: inputObject(p.input) });
          else turn.text = joinText(turn.text, `[Tool: ${p.name} (${p.id})]\n${JSON.stringify(p.input ?? {})}`);
        }
      }
      continue;
    }
    let turn = last();
    if (turn?.role !== 'user') {
      turn = { role: 'user', text: '', images: [], toolResults: [] };
      turns.push(turn);
    }
    for (const p of msg.parts) {
      if (p.type === 'text') turn.text = joinText(turn.text, p.text);
      else if (p.type === 'image') {
        turn.images.push({ format: imageFormat(p.mimeType), source: { bytes: Buffer.from(p.data).toString('base64') } });
      } else if (p.type === 'toolResult') {
        turn.toolResults.push({
          toolUseId: p.id,
          content: [{ text: p.text || '(empty result)' }],
          status: p.isError ? 'error' : 'success',
        });
      }
    }
  }

  // Tool results must pair with a tool use in the previous assistant turn; otherwise inline them as text.
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.role !== 'user' || turn.toolResults.length === 0) continue;
    const prev = turns[i - 1];
    const known = new Set(prev?.role === 'assistant' ? prev.toolUses.map((u) => u.toolUseId) : []);
    const kept: KiroToolResult[] = [];
    for (const r of turn.toolResults) {
      if (toolsDeclared && known.has(r.toolUseId)) kept.push(r);
      else {
        const tag = r.status === 'error' ? ' [error]' : '';
        turn.text = joinText(turn.text, `[Tool Result (${r.toolUseId})${tag}]\n${r.content[0]!.text}`);
      }
    }
    turn.toolResults = kept;
  }

  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', text: '', images: [], toolResults: [] });
  // The last turn must be the user's: move a trailing assistant turn into history.
  if (last()?.role === 'assistant') turns.push({ role: 'user', text: '', images: [], toolResults: [] });

  return { system, turns };
}

function userMessage(turn: UserTurn, modelId: string, tools?: unknown[]): Record<string, unknown> {
  const msg: Record<string, unknown> = { content: turn.text || PLACEHOLDER, modelId, origin: ORIGIN };
  if (turn.images.length) msg.images = turn.images;
  const ctx: Record<string, unknown> = {};
  if (tools?.length) ctx.tools = tools;
  if (turn.toolResults.length) ctx.toolResults = turn.toolResults;
  if (Object.keys(ctx).length) msg.userInputMessageContext = ctx;
  return msg;
}

function assistantMessage(turn: AssistantTurn): Record<string, unknown> {
  const msg: Record<string, unknown> = { content: turn.text || PLACEHOLDER };
  if (turn.toolUses.length) msg.toolUses = turn.toolUses;
  return msg;
}

export function buildRequest(opts: BuildOptions): Record<string, unknown> {
  const tools = (opts.tools ?? []).map((t) => {
    if (t.name.length > MAX_TOOL_NAME_LENGTH) {
      throw new RequestBuildError(`tool name longer than ${MAX_TOOL_NAME_LENGTH} characters: ${t.name}`);
    }
    return {
      toolSpecification: {
        name: t.name,
        description: t.description.trim() || `Tool: ${t.name}`,
        inputSchema: { json: sanitizeSchema(t.inputSchema ?? {}) ?? {} },
      },
    };
  });

  const { system, turns } = toTurns(opts.messages, tools.length > 0);
  // The backend rejects or ignores a systemPrompt field: fold it into the first user turn.
  if (system) {
    const first = turns[0] as UserTurn;
    first.text = first.text ? `${system}\n\n${first.text}` : system;
  }

  const current = turns[turns.length - 1] as UserTurn;
  const history = turns.slice(0, -1).map((t) =>
    t.role === 'user'
      ? { userInputMessage: userMessage(t, opts.modelId) }
      : { assistantResponseMessage: assistantMessage(t) },
  );

  const conversationState: Record<string, unknown> = {
    chatTriggerType: 'MANUAL',
    conversationId: opts.conversationId,
    currentMessage: { userInputMessage: userMessage(current, opts.modelId, tools) },
  };
  if (history.length) conversationState.history = history;

  const body: Record<string, unknown> = { conversationState };
  if (opts.profileArn) body.profileArn = opts.profileArn;
  if (opts.requestFields && Object.keys(opts.requestFields).length) {
    body.additionalModelRequestFields = opts.requestFields;
  }
  return body;
}
