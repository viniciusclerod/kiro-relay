import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p)) as Record<string, string>;

/** English source strings passed to vscode.l10n.t in src/. */
function l10nKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (rel.endsWith('.ts')) {
        for (const m of read(rel).matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]!);
      }
    }
  };
  walk('src');
  return keys;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
}

test('every vscode.l10n.t string has a pt-BR translation with the same placeholders', () => {
  const keys = l10nKeys();
  const ptBr = readJson('l10n/bundle.l10n.pt-br.json');
  assert.ok(keys.size > 0);
  for (const key of keys) {
    assert.ok(key in ptBr, `missing pt-BR translation: ${key}`);
    assert.deepEqual(placeholders(ptBr[key]!), placeholders(key), `placeholders differ: ${key}`);
  }
  for (const key of Object.keys(ptBr)) assert.ok(keys.has(key), `unused pt-BR translation: ${key}`);
});

test('every %key% in package.json exists in package.nls.json and package.nls.pt-br.json', () => {
  const used = new Set([...read('package.json').matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]!));
  const en = readJson('package.nls.json');
  const ptBr = readJson('package.nls.pt-br.json');
  assert.ok(used.size > 0);
  for (const key of used) {
    assert.ok(key in en, `missing in package.nls.json: ${key}`);
    assert.ok(key in ptBr, `missing in package.nls.pt-br.json: ${key}`);
  }
  assert.deepEqual(Object.keys(ptBr).sort(), Object.keys(en).sort());
});
