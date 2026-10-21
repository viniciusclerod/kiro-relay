import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEHOLDER,
  RequestBuildError,
  buildRequest,
  sanitizeSchema,
  type ChatMessage,
} from '../src/chat/request.ts';

const ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF';
const base = { modelId: 'm', conversationId: 'conv-1', profileArn: ARN };
const user = (text: string): ChatMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] });

type Body = {
  conversationState: {
    chatTriggerType: string;
    conversationId: string;
    currentMessage: { userInputMessage: Record<string, any> };
    history?: Array<Record<string, any>>;
  };
  profileArn?: string;
  additionalModelRequestFields?: Record<string, unknown>;
};
const build = (o: Partial<Parameters<typeof buildRequest>[0]> & { messages: ChatMessage[] }) =>
  buildRequest({ ...base, ...o }) as Body;

test('single user message: the shape that worked against the backend', () => {
  const body = build({ messages: [user('Reply with exactly: ok')] });
  assert.deepEqual(body, {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'conv-1',
      currentMessage: {
        userInputMessage: { content: 'Reply with exactly: ok', modelId: 'm', origin: 'AI_EDITOR' },
      },
    },
    profileArn: ARN,
  });
});

test('system prompt is folded into the first user turn; effort goes to additionalModelRequestFields', () => {
  const body = build({
    messages: [{ role: 'system', parts: [{ type: 'text', text: 'Be terse.' }] }, user('hi'), assistant('hello'), user('again')],
    requestFields: { reasoning: { effort: 'low' } },
  });
  const history = body.conversationState.history!;
  assert.equal(history[0]!.userInputMessage.content, 'Be terse.\n\nhi');
  assert.equal(history[1]!.assistantResponseMessage.content, 'hello');
  assert.equal(body.conversationState.currentMessage.userInputMessage.content, 'again');
  assert.deepEqual(body.additionalModelRequestFields, { reasoning: { effort: 'low' } });
});

test('structural rules: merge same-role turns, leading user, trailing assistant, placeholders', () => {
  const body = build({ messages: [assistant('a1'), assistant('a2'), user(''), user('u2'), assistant('last')] });
  const h = body.conversationState.history!;
  assert.deepEqual(h.map((t) => Object.keys(t)[0]), [
    'userInputMessage',
    'assistantResponseMessage',
    'userInputMessage',
    'assistantResponseMessage',
  ]);
  assert.equal(h[0]!.userInputMessage.content, PLACEHOLDER, 'leading placeholder user turn');
  assert.equal(h[1]!.assistantResponseMessage.content, 'a1\na2', 'merged assistant turns');
  assert.equal(h[2]!.userInputMessage.content, 'u2', 'merged user turns, empty text dropped');
  assert.equal(h[3]!.assistantResponseMessage.content, 'last');
  assert.equal(body.conversationState.currentMessage.userInputMessage.content, PLACEHOLDER);
});

test('tools: spec format, schema sanitization, tool uses in history and paired tool results', () => {
  const body = build({
    tools: [
      {
        name: 'get_weather',
        description: '  ',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' }, opts: { type: 'object', additionalProperties: false, required: [] } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    ],
    messages: [
      user('weather?'),
      { role: 'assistant', parts: [{ type: 'toolCall', id: 't1', name: 'get_weather', input: { city: 'Lisbon' } }] },
      { role: 'user', parts: [{ type: 'toolResult', id: 't1', text: '' }] },
    ],
  });
  const current = body.conversationState.currentMessage.userInputMessage;
  assert.deepEqual(current.userInputMessageContext.tools, [
    {
      toolSpecification: {
        name: 'get_weather',
        description: 'Tool: get_weather',
        inputSchema: {
          json: { type: 'object', properties: { city: { type: 'string' }, opts: { type: 'object' } }, required: ['city'] },
        },
      },
    },
  ]);
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    { toolUseId: 't1', content: [{ text: '(empty result)' }], status: 'success' },
  ]);
  assert.equal(current.content, PLACEHOLDER);
  assert.deepEqual(body.conversationState.history![1]!.assistantResponseMessage.toolUses, [
    { toolUseId: 't1', name: 'get_weather', input: { city: 'Lisbon' } },
  ]);
  // Tools are only declared on the current message.
  assert.equal(body.conversationState.history![0]!.userInputMessage.userInputMessageContext, undefined);
});

test('unpaired tool results and tool parts without declared tools become text', () => {
  const orphan = build({
    tools: [{ name: 't', description: 'd' }],
    messages: [user('x'), assistant('no tool call here'), { role: 'user', parts: [{ type: 'toolResult', id: 'zz', text: 'r', isError: true }] }],
  });
  const cur = orphan.conversationState.currentMessage.userInputMessage;
  assert.equal(cur.content, '[Tool Result (zz) [error]]\nr');
  assert.equal(cur.userInputMessageContext.toolResults, undefined);

  const noTools = build({
    messages: [
      user('x'),
      { role: 'assistant', parts: [{ type: 'toolCall', id: 't1', name: 'f', input: '{"a":1}' }] },
      { role: 'user', parts: [{ type: 'toolResult', id: 't1', text: 'done' }] },
    ],
  });
  assert.equal(noTools.conversationState.history![1]!.assistantResponseMessage.content, '[Tool: f (t1)]\n"{\\"a\\":1}"');
  assert.equal(noTools.conversationState.currentMessage.userInputMessage.content, '[Tool Result (t1)]\ndone');
  assert.equal(noTools.conversationState.currentMessage.userInputMessage.userInputMessageContext, undefined);
});

test('tool call input given as a JSON string is parsed; garbage becomes {}', () => {
  const body = build({
    tools: [{ name: 'f', description: 'd' }],
    messages: [
      user('x'),
      {
        role: 'assistant',
        parts: [
          { type: 'toolCall', id: 'a', name: 'f', input: '{"k":"v"}' },
          { type: 'toolCall', id: 'b', name: 'f', input: 'nope' },
          { type: 'toolCall', id: 'c', name: 'f', input: [1, 2] },
        ],
      },
      { role: 'user', parts: [{ type: 'toolResult', id: 'a', text: '1' }, { type: 'toolResult', id: 'b', text: '2' }, { type: 'toolResult', id: 'c', text: '3' }] },
    ],
  });
  assert.deepEqual(
    body.conversationState.history![1]!.assistantResponseMessage.toolUses.map((u: { input: unknown }) => u.input),
    [{ k: 'v' }, {}, {}],
  );
});

test('images go on the user message as base64 with the bare format', () => {
  const body = build({
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', mimeType: 'image/jpg', data: Uint8Array.from([1, 2, 3]) },
          { type: 'image', mimeType: 'image/svg+xml', data: Uint8Array.from([4]) },
        ],
      },
    ],
  });
  assert.deepEqual(body.conversationState.currentMessage.userInputMessage.images, [
    { format: 'jpeg', source: { bytes: 'AQID' } },
    { format: 'svg', source: { bytes: 'BA==' } },
  ]);
});

test('tool names longer than 64 characters are rejected', () => {
  assert.throws(
    () => build({ tools: [{ name: 'x'.repeat(65), description: 'd' }], messages: [user('hi')] }),
    RequestBuildError,
  );
});

test('sanitizeSchema keeps non-empty required and nested arrays', () => {
  assert.deepEqual(
    sanitizeSchema({ anyOf: [{ type: 'string', additionalProperties: true }, { required: [] }], required: ['a'] }),
    { anyOf: [{ type: 'string' }, {}], required: ['a'] },
  );
  assert.equal(sanitizeSchema(null), null);
});
