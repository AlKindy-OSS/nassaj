/** ADR-205 D2 steps 3-8: public-row filter, raw cap, stable identities and neutral authors. */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { RAW_ROW_MAX_BYTES, authorOf, buildRawRows, capRawText, sanitizeRawRow } from './session-share-live-rows.js';

const msg = (fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: `id-${Math.random()}`, sessionId: 's', timestamp: new Date().toISOString(), provider: 'x', kind: 'text', ...fields,
}) as NormalizedMessage;

test('only user and main-agent text survives the filter', () => {
  const rows = buildRawRows('s', 1, [
    msg({ role: 'user', content: 'q' }), msg({ kind: 'thinking', content: 't' }), msg({ kind: 'tool_use', toolName: 'Bash' }),
    msg({ kind: 'tool_result', content: 'out' }), msg({ role: 'assistant', content: 'side', isSidechain: true }),
    msg({ role: 'assistant', content: 'sub', subagent: { id: 'a' } }), msg({ role: 'user', content: 'm', originKind: 'agent' }),
    msg({ role: 'system' as NormalizedMessage['role'], content: 'sys' }), msg({ role: 'assistant', content: 'a' }),
  ]);
  assert.deepEqual(rows.map((row) => row.text), ['q', 'a']);
});

test('N1: identities ignore parse-time timestamps and generated ids', () => {
  const history = () => [msg({ role: 'user', content: 'q' }), msg({ role: 'assistant', content: 'a' }), msg({ role: 'user', content: 'q' })];
  const first = buildRawRows('s', 1, history()).map((row) => row.sid);
  const second = buildRawRows('s', 1, history()).map((row) => row.sid);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 3);
});

test('authors: owner only for the owner id; null, missing or other ids are member; assistant rows are assistant', () => {
  assert.equal(authorOf(msg({ role: 'user', userId: 7 }), 7), 'owner');
  assert.equal(authorOf(msg({ role: 'user', userId: 8 }), 7), 'member');
  assert.equal(authorOf(msg({ role: 'user', userId: null as unknown as number }), 7), 'member');
  assert.equal(authorOf(msg({ role: 'user' }), 7), 'member', 'failed author load leaves userId unset');
  assert.equal(authorOf(msg({ role: 'assistant', userId: 7 }), 7), 'assistant');
});

test('M1: the raw cap cuts at the last newline and drops the partial last line, then marks truncation', () => {
  const line = `${'ب'.repeat(1000)}\n`;
  const text = line.repeat(Math.ceil(RAW_ROW_MAX_BYTES / Buffer.byteLength(line)) + 2);
  const capped = capRawText(text);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text) <= RAW_ROW_MAX_BYTES);
  assert.ok(capped.text.split('\n').every((piece) => piece.length === 1000), 'no partial line survives');
  assert.deepEqual(capRawText('short'), { text: 'short', truncated: false });
  assert.equal(capRawText('x'.repeat(RAW_ROW_MAX_BYTES + 1)).text, '', 'no newline: nothing survives');
  const [row] = buildRawRows('s', 1, [msg({ role: 'user', content: text })]);
  assert.deepEqual(sanitizeRawRow(row, {}).parts.at(-1), { t: 'redacted', cat: 'truncated' });
});

test('a sanitized row redacts known secrets and keeps reading', () => {
  const [row] = buildRawRows('s', 1, [msg({ role: 'assistant', content: `token ghp_${'Ab1'.repeat(12)} done` })]);
  const memo = sanitizeRawRow(row, {});
  assert.deepEqual(memo.parts, [{ t: 'text', text: 'token ' }, { t: 'redacted', cat: 'secret' }, { t: 'text', text: ' done' }]);
  assert.ok(memo.bytes > 0);
});
