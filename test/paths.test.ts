import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDatabaseCandidates, expandHome } from '../src/auth/paths.ts';

test('candidatos por plataforma', () => {
  assert.deepEqual(defaultDatabaseCandidates('linux', {}, '/home/u'), [
    '/home/u/.local/share/kiro-cli/data.sqlite3',
    '/home/u/.local/share/amazon-q/data.sqlite3',
  ]);
  assert.equal(
    defaultDatabaseCandidates('linux', { XDG_DATA_HOME: '/x' }, '/home/u')[0],
    '/x/kiro-cli/data.sqlite3',
  );
  assert.equal(
    defaultDatabaseCandidates('darwin', {}, '/Users/u')[0],
    '/Users/u/Library/Application Support/kiro-cli/data.sqlite3',
  );
  assert.equal(
    defaultDatabaseCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')[0],
    'C:\\Users\\u\\AppData\\Local\\kiro-cli\\data.sqlite3',
  );
});

test('expandHome', () => {
  assert.equal(expandHome('~/a/b', '/home/u'), '/home/u/a/b');
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
});
