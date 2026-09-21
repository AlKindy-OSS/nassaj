import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeBuiltInCommands, builtInCommands } from '../commands.js';

test('merge: falls back to the static list when probe returns null/empty', () => {
  // Simulates a failed/timed-out probe (getClaudeBuiltInCommands → null).
  // Cast to `never` because the JSDoc type narrows the param to an array; at
  // runtime the function guards against null/undefined and returns the static
  // fallback, which is exactly what we assert here.
  assert.deepEqual(mergeBuiltInCommands(null as never), [...builtInCommands]);
  assert.deepEqual(mergeBuiltInCommands([]), [...builtInCommands]);
  assert.deepEqual(mergeBuiltInCommands(undefined as never), [...builtInCommands]);
});

test('merge: adds new dynamic commands as passthrough (hasHandler=false)', () => {
  const merged = mergeBuiltInCommands([
    { name: 'rewind', description: 'Rewind the conversation' },
  ]);

  const added = merged.find((c) => c.name === '/rewind');
  assert.ok(added, 'dynamic command should be appended');
  assert.equal(added?.metadata?.hasHandler, false);
  assert.equal(added?.namespace, 'builtin');
  // Static list is preserved in full as the fallback layer.
  for (const staticCmd of builtInCommands) {
    assert.ok(
      merged.some((c) => c.name === staticCmd.name),
      `static ${staticCmd.name} must remain present`,
    );
  }
});

test('merge: a dynamic command aliased to a static name is NOT duplicated', () => {
  // Dynamic `usage` carries alias `cost`; static `/cost` already exists, so the
  // dynamic entry must be dropped to avoid duplicating /cost.
  const merged = mergeBuiltInCommands([
    { name: 'usage', description: 'Show usage', aliases: ['cost'] },
  ]);

  assert.equal(
    merged.filter((c) => c.name === '/cost').length,
    1,
    'static /cost must not be duplicated by an aliased dynamic command',
  );
  assert.ok(
    !merged.some((c) => c.name === '/usage'),
    'dynamic /usage aliased to /cost must be skipped',
  );
});

test('merge: a dynamic command matching a static NAME is skipped (handler precedence)', () => {
  const merged = mergeBuiltInCommands([
    { name: 'help', description: 'rogue help' },
  ]);

  const helps = merged.filter((c) => c.name === '/help');
  assert.equal(helps.length, 1, '/help must not be duplicated');
  // The surviving /help is the static, handler-backed one.
  assert.equal(helps[0]?.metadata?.hasHandler, true);
});

test('merge: dynamic commands do not duplicate among themselves via shared alias', () => {
  const merged = mergeBuiltInCommands([
    { name: 'alpha', description: 'first', aliases: ['shared'] },
    { name: 'beta', description: 'second', aliases: ['shared'] },
  ]);

  assert.ok(merged.some((c) => c.name === '/alpha'));
  assert.ok(
    !merged.some((c) => c.name === '/beta'),
    'second dynamic command sharing an alias must be skipped',
  );
});

test('merge: preserves aliases and argumentHint on added commands', () => {
  const merged = mergeBuiltInCommands([
    { name: 'todos', description: 'List todos', aliases: ['tasks'], argumentHint: '<filter>' },
  ]);
  const added = merged.find((c) => c.name === '/todos');
  assert.deepEqual(added?.metadata?.aliases, ['tasks']);
  assert.equal(added?.metadata?.argumentHint, '<filter>');
});
