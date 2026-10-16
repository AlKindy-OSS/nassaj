/**
 * T-2037: custom-command bash snippets are detected by Claude Code's
 * `!`backtick`` syntax, not by any exclamation mark, and capped at 10.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBashSnippets } from '../commands.js';

test('a plain exclamation mark is not a bash snippet', () => {
  assert.deepEqual(extractBashSnippets('Hello! Great work!'), []);
  assert.deepEqual(extractBashSnippets('a!`ls`'), [], '`!` glued to a word is not a snippet');
  assert.deepEqual(extractBashSnippets('!`multi\nline`'), []);
});

test('finds `!`cmd`` at line start, after whitespace or `(`', () => {
  assert.deepEqual(extractBashSnippets('Run !`git log -1` now'), ['git log -1']);
  assert.deepEqual(extractBashSnippets('!`pwd`\n(see !`ls -la`)'), ['pwd', 'ls -la']);
});

test('caps at 10 snippets and 500 chars each', () => {
  const many = Array.from({ length: 15 }, (_, i) => `!\`echo ${i}\``).join('\n');
  const found = extractBashSnippets(many);
  assert.equal(found.length, 10);
  assert.equal(found[9], 'echo 9');
  assert.deepEqual(extractBashSnippets(`!\`${'x'.repeat(501)}\``), []);
  assert.equal(extractBashSnippets(`!\`${'x'.repeat(500)}\``).length, 1);
  assert.deepEqual(extractBashSnippets(undefined as unknown as string), []);
});
