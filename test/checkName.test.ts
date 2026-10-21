import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, normalize, parseMarketplace, parseOpenVsx } from '../scripts/check-name.ts';

test('normalize ignores case, spaces and punctuation', () => {
  assert.equal(normalize('Kiro  Tether!'), 'kirotether');
  assert.equal(normalize('kiro-tether'), 'kirotether');
});

test('classify: exact, similar and different', () => {
  const mk = (id: string, displayName: string) => ({ registry: 'marketplace' as const, id, displayName });
  assert.equal(classify('Kiro Tether', mk('acme.kiro-tether', 'Whatever')).exact, true);
  assert.equal(classify('Kiro Tether', mk('acme.x', 'Kiro-Tether')).exact, true);
  const sim = classify('Kiro Tether', mk('acme.x', 'Kiro Tether Pro'));
  assert.equal(sim.exact, false);
  assert.equal(sim.similar, true);
  const other = classify('Kiro Tether', mk('acme.y', 'Prettier'));
  assert.equal(other.exact || other.similar, false);
});

test('parsers for both APIs', () => {
  const m = parseMarketplace({
    results: [{ extensions: [{ extensionName: 'kiro-x', displayName: 'Kiro X', publisher: { publisherName: 'acme' } }] }],
  });
  assert.deepEqual(m, [{ registry: 'marketplace', id: 'acme.kiro-x', displayName: 'Kiro X' }]);
  const o = parseOpenVsx({ extensions: [{ namespace: 'acme', name: 'kiro-x', displayName: 'Kiro X' }] });
  assert.deepEqual(o, [{ registry: 'open-vsx', id: 'acme.kiro-x', displayName: 'Kiro X' }]);
  assert.deepEqual(parseMarketplace({}), []);
  assert.deepEqual(parseOpenVsx({}), []);
});
