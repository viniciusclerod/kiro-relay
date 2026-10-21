import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, type ChatMessage } from '../src/chat/request.ts';
import {
  FOOTER_MARK,
  TurnUsageTracker,
  estimateContextTokens,
  interactionKey,
  markFooter,
  stripFooters,
} from '../src/chat/turnUsage.ts';
import { fromVsCodeMessages } from '../src/chat/vscodeMessages.ts';

const user = (text: string): ChatMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] });

test('footers are marked and stripped, leaving the rest of the text intact', () => {
  const answer = `Hello!${markFooter('*Kiro · 0.66 credits*')}`;
  assert.ok(answer.includes(FOOTER_MARK));
  assert.equal(stripFooters(answer), 'Hello!');
  assert.equal(stripFooters(`a${markFooter('x')} b${markFooter('y')}`), 'a b');
  assert.equal(stripFooters('no footer'), 'no footer');
  assert.equal(markFooter(`evil${FOOTER_MARK}in*side`), `\n\n*${FOOTER_MARK}evilinside${FOOTER_MARK}*`);
  // Emphasis closes: the closing asterisk follows the mark, not punctuation followed by the mark.
  assert.match(markFooter('0.17 credits · context 5.3% (≈53K tokens)'), /\)\u2063\*$/);
});

test('footers never reach the model', () => {
  const messages = fromVsCodeMessages([
    { role: 1, content: [{ value: 'hi' }] },
    { role: 2, content: [{ value: `Hello!${markFooter('*Kiro · 0.66 credits*')}` }] },
    { role: 2, content: [{ value: markFooter('*Kiro · only a footer*') }] },
    { role: 1, content: [{ value: 'again' }] },
  ]);
  const body = JSON.stringify(buildRequest({ modelId: 'm', messages, conversationId: 'c' }));
  assert.ok(!body.includes('Kiro ·'));
  assert.ok(!body.includes(FOOTER_MARK));
  assert.deepEqual(messages[1], { role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }] });
  assert.deepEqual(messages[2], { role: 'assistant', parts: [] });
});

test('interactionKey: tool steps of one question share a key; a new question gets a new one', () => {
  const q1 = [user('read package.json')];
  const step2: ChatMessage[] = [
    ...q1,
    { role: 'assistant', parts: [{ type: 'toolCall', id: 't1', name: 'read', input: {} }] },
    { role: 'user', parts: [{ type: 'toolResult', id: 't1', text: '{}' }] },
  ];
  assert.equal(interactionKey(q1), interactionKey(step2));
  const q2 = [...step2, assistant(`version 1${markFooter('x')}`), user('and the name?')];
  assert.notEqual(interactionKey(q2), interactionKey(q1));
  // The footer in the history does not change the key of later steps.
  const q2b = [...step2, assistant('version 1'), user('and the name?')];
  assert.equal(interactionKey(q2), interactionKey(q2b));
});

test('TurnUsageTracker sums requests per interaction and for the session', () => {
  const t = new TurnUsageTracker(2);
  t.add('a', 0.5, 1);
  const a = t.add('a', 0.25, 2.5);
  assert.deepEqual(a, { requests: 2, credits: 0.75, contextPercent: 2.5 });
  t.add('b', undefined, undefined);
  t.add('c', 1, 3);
  assert.deepEqual(t.session, { interactions: 3, requests: 4, credits: 1.75 });
  assert.deepEqual(t.last, { requests: 1, credits: 1, contextPercent: 3 });
  // 'a' was evicted (max 2): it starts over as a new interaction.
  assert.deepEqual(t.add('a', 0.1, undefined), { requests: 1, credits: 0.1 });
});

test('estimateContextTokens', () => {
  assert.equal(estimateContextTokens(1.58, 1_000_000), 15_800);
  assert.equal(estimateContextTokens(undefined, 1_000_000), undefined);
  assert.equal(estimateContextTokens(10, 0), undefined);
});
