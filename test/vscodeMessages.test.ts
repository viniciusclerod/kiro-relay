import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/chat/request.ts';
import { fromVsCodeMessages, fromVsCodeTools } from '../src/chat/vscodeMessages.ts';

// Plain objects with the same shape as the VS Code part classes.
const text = (value: string) => ({ value });
const toolCall = (callId: string, name: string, input: object) => ({ callId, name, input });
const toolResult = (callId: string, content: unknown[]) => ({ callId, content });
const data = (mimeType: string, bytes: number[] | string) => ({
  mimeType,
  data: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes),
});
const thinking = (value: string) => ({ value, id: 'th1', metadata: { signature: 'x' } });

test('roles and part kinds', () => {
  const out = fromVsCodeMessages([
    { role: 3, content: [text('system rules')] },
    { role: 1, content: [text('look'), data('image/png', [1, 2]), data('text/plain', 'attached'), data('cache_control', 'ephemeral')] },
    { role: 2, content: [thinking('hmm'), text('calling'), toolCall('c1', 'read_file', { path: 'a.ts' })] },
    { role: 1, content: [toolResult('c1', [text('line 1'), data('application/json', '{"ok":true}'), data('image/jpeg', [9])])] },
  ]);
  assert.deepEqual(out, [
    { role: 'system', parts: [{ type: 'text', text: 'system rules' }] },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: Uint8Array.from([1, 2]) },
        { type: 'text', text: 'attached' },
      ],
    },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'calling' },
        { type: 'toolCall', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      parts: [
        { type: 'toolResult', id: 'c1', text: 'line 1\n{"ok":true}' },
        { type: 'image', mimeType: 'image/jpeg', data: Uint8Array.from([9]) },
      ],
    },
  ]);
});

test('unknown parts are dropped; prompt-tsx values in tool results become JSON', () => {
  const out = fromVsCodeMessages([
    { role: 1, content: [42, null, { something: 'else' }, toolResult('c', [{ value: { node: 1 } }])] },
  ]);
  assert.deepEqual(out, [{ role: 'user', parts: [{ type: 'toolResult', id: 'c', text: '{"node":1}' }] }]);
});

test('an agent-mode turn converts into a valid Kiro request', () => {
  const tools = fromVsCodeTools([
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  ]);
  const messages = fromVsCodeMessages([
    { role: 3, content: [text('You are an assistant.')] },
    { role: 1, content: [text('open a.ts')] },
    { role: 2, content: [toolCall('c1', 'read_file', { path: 'a.ts' })] },
    { role: 1, content: [toolResult('c1', [text('export {}')])] },
  ]);
  const body = buildRequest({ modelId: 'claude-x', messages, tools, conversationId: 'id' }) as any;
  const state = body.conversationState;
  assert.equal(state.history[0].userInputMessage.content, 'You are an assistant.\n\nopen a.ts');
  assert.deepEqual(state.history[1].assistantResponseMessage.toolUses, [
    { toolUseId: 'c1', name: 'read_file', input: { path: 'a.ts' } },
  ]);
  const current = state.currentMessage.userInputMessage;
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    { toolUseId: 'c1', content: [{ text: 'export {}' }], status: 'success' },
  ]);
  assert.equal(current.userInputMessageContext.tools[0].toolSpecification.name, 'read_file');
});
