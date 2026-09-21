/**
 * Unit tests for handleFiles() — the pure attachment-note injector.
 *
 * Security concern: The function appends a structured note to the agent
 * command. A no-op on empty input is critical for command-hash stability
 * (fileless messages must hash identically before and after this feature).
 *
 * Scenarios:
 *  A. No-op path: empty/null/undefined → command returned byte-for-byte.
 *  B. Single file  → correct header + numbered list.
 *  C. Multiple files → order preserved, each line numbered.
 *  D. Blank command string → header still appended (edge: command='').
 *  E. File object without name field → path still used (name is optional).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleFiles } from './claude-sdk.js';

// ---------------------------------------------------------------------------
// A. No-op path (security critical: command must be IDENTICAL, not just equal)
// ---------------------------------------------------------------------------

test('handleFiles — no-op: undefined files returns command unchanged (byte identity)', () => {
  const cmd = 'explain this code';
  const result = handleFiles(cmd, undefined);
  assert.strictEqual(result.modifiedCommand, cmd,
    'must return the exact same string — no appended bytes');
});

test('handleFiles — no-op: null files returns command unchanged', () => {
  const cmd = 'what is 2+2';
  const result = handleFiles(cmd, null);
  assert.strictEqual(result.modifiedCommand, cmd);
});

test('handleFiles — no-op: empty array returns command unchanged (byte identity)', () => {
  const cmd = 'fix bug in auth.js';
  const result = handleFiles(cmd, []);
  assert.strictEqual(result.modifiedCommand, cmd,
    'empty array must be a total no-op — fileless hash must not change');
});

test('handleFiles — no-op: result shape has only modifiedCommand key', () => {
  const result = handleFiles('hello', []);
  // The contract is { modifiedCommand: string } — no extra keys
  assert.deepStrictEqual(Object.keys(result), ['modifiedCommand']);
});

// ---------------------------------------------------------------------------
// B. Single file — header + one entry
// ---------------------------------------------------------------------------

test('handleFiles — single file: appends header and path', () => {
  const cmd = 'analyse this';
  const files = [{ path: '/tmp/project/.nassaj-uploads/inbox/report.pdf', name: 'report.pdf' }];
  const { modifiedCommand } = handleFiles(cmd, files);

  assert.ok(modifiedCommand.startsWith(cmd),
    'original command must be the prefix');
  assert.ok(modifiedCommand.includes('[Files provided at the following paths:]'),
    'header line must be present');
  assert.ok(modifiedCommand.includes('1. /tmp/project/.nassaj-uploads/inbox/report.pdf'),
    'numbered path entry must appear');
});

test('handleFiles — single file: separator is double-newline before header', () => {
  const cmd = 'summarise';
  const { modifiedCommand } = handleFiles(cmd, [{ path: '/abs/file.txt' }]);
  // The separator between the user command and the appended note must be \n\n
  assert.ok(modifiedCommand.includes('summarise\n\n[Files'),
    'double newline must separate command from file note');
});

// ---------------------------------------------------------------------------
// C. Multiple files — order preserved
// ---------------------------------------------------------------------------

test('handleFiles — multiple files: all paths present, order preserved', () => {
  const cmd = 'compare these files';
  const files = [
    { path: '/project/.nassaj-uploads/inbox/a.csv', name: 'a.csv' },
    { path: '/project/.nassaj-uploads/inbox/b.xlsx', name: 'b.xlsx' },
    { path: '/project/.nassaj-uploads/inbox/c.pdf', name: 'c.pdf' },
  ];
  const { modifiedCommand } = handleFiles(cmd, files);

  assert.ok(modifiedCommand.includes('1. /project/.nassaj-uploads/inbox/a.csv'));
  assert.ok(modifiedCommand.includes('2. /project/.nassaj-uploads/inbox/b.xlsx'));
  assert.ok(modifiedCommand.includes('3. /project/.nassaj-uploads/inbox/c.pdf'));

  // Order: 1 must appear before 2, 2 before 3
  const pos1 = modifiedCommand.indexOf('1. ');
  const pos2 = modifiedCommand.indexOf('2. ');
  const pos3 = modifiedCommand.indexOf('3. ');
  assert.ok(pos1 < pos2, 'file 1 must appear before file 2');
  assert.ok(pos2 < pos3, 'file 2 must appear before file 3');
});

test('handleFiles — multiple files: exactly one header line', () => {
  const files = [{ path: '/a.txt' }, { path: '/b.txt' }, { path: '/c.txt' }];
  const { modifiedCommand } = handleFiles('cmd', files);
  const headerCount = (modifiedCommand.match(/\[Files provided at the following paths:\]/g) || []).length;
  assert.strictEqual(headerCount, 1, 'header must appear exactly once');
});

// ---------------------------------------------------------------------------
// D. Edge: blank command
// ---------------------------------------------------------------------------

test('handleFiles — blank command string: header still appended', () => {
  const { modifiedCommand } = handleFiles('', [{ path: '/file.md' }]);
  assert.ok(modifiedCommand.includes('[Files provided at the following paths:]'));
  assert.ok(modifiedCommand.includes('1. /file.md'));
});

// ---------------------------------------------------------------------------
// E. File object without optional name field
// ---------------------------------------------------------------------------

test('handleFiles — file without name field: path is still used', () => {
  // The type allows name to be absent; only path is required for the note.
  const { modifiedCommand } = handleFiles('prompt', [{ path: '/data/results.json' }]);
  assert.ok(modifiedCommand.includes('/data/results.json'));
});
