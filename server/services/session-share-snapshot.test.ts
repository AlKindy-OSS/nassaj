/**
 * ADR-196 / T-1970 stage 3: snapshot assembly, the strict author model, the
 * TOCTOU/hash contract and the size caps. Dependencies are injected so each
 * failure mode (author table, owner, participants) is exercised directly.
 */
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

import {
  HISTORY_MEMORY_SINK_MAX_BYTES,
  HistoryMemorySink,
} from '@/modules/providers/services/history-memory-sink.js';
import type { NormalizedMessage } from '@/shared/types.js';

import {
  assembleShareSnapshot,
  buildSessionShareSnapshot,
  canonicalJson,
  evaluateAuthorBlockers,
  providerLabelFor,
  sanitizeTitle,
  SHARE_SNAPSHOT_LIMITS,
  type AssembleOptions,
  type SnapshotDeps,
} from './session-share-snapshot.js';

const OWNER = 7;
const ADMIN = 1;
const MEMBER = 9;

let seq = 0;
function msg(fields: Partial<NormalizedMessage>): NormalizedMessage {
  seq += 1;
  return {
    id: `m${seq}`, sessionId: 's1', timestamp: `2026-10-01T10:00:${String(seq % 60).padStart(2, '0')}Z`,
    provider: 'claude', kind: 'text', ...fields,
  } as NormalizedMessage;
}
const user = (content: string, extra: Partial<NormalizedMessage> = {}) => msg({ role: 'user', content, userId: OWNER, ...extra });
const assistant = (content: string, extra: Partial<NormalizedMessage> = {}) => msg({ role: 'assistant', content, ...extra });

const ownerOnly: AssembleOptions = {
  sessionOwnerUserId: OWNER, provider: 'claude', participantUserIds: [OWNER], confirmUnattributed: false,
};

test('allow-list keeps only top-level user/assistant text and counts every dropped kind', () => {
  const rows = [
    user('hi'),
    msg({ kind: 'thinking', content: 'private reasoning' }),
    msg({ kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'cat .env' } }),
    msg({ kind: 'tool_result', toolResult: { content: 'SECRET=1' } }),
    msg({ kind: 'tool_use', toolName: 'Read' }),
    msg({ kind: 'permission_request', requestId: 'r' }),
    msg({ kind: 'status', text: 'working' }),
    msg({ kind: 'error', content: 'boom' }),
    msg({ kind: 'complete' }),
    msg({ kind: 'stream_delta', content: 'x' }),
    msg({ kind: 'task_notification' }),
    msg({ kind: 'session_created', newSessionId: 'n' }),
    msg({ kind: 'interactive_prompt' }),
    msg({ kind: 'text', role: 'user', content: 'to subagent', originKind: 'coordinator' }),
    msg({ kind: 'text', role: 'assistant', content: 'subagent says', parentToolUseId: 't1' }),
    msg({ kind: 'text', role: 'user', content: 'side', isSidechain: true }),
    msg({ kind: 'text', role: 'user', content: 'agent', agentId: 'a1' }),
    msg({ kind: 'text', role: 'assistant', content: 'summary', isCompactSummary: true }),
    assistant('hello back', { model: 'claude-opus-5-5', coordinatorId: OWNER, toolId: 'x' }),
  ];
  const result = assembleShareSnapshot(rows, ownerOnly);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.snapshot?.messages.map((m) => [m.role, m.author, m.parts]), [
    ['user', 'owner', [{ t: 'text', text: 'hi' }]],
    ['assistant', 'assistant', [{ t: 'text', text: 'hello back' }]],
  ]);
  assert.equal(result.counts.toolCount, 2);
  assert.equal(result.snapshot?.toolCount, 2);
  assert.equal(result.counts.thinking, 1);
  assert.equal(result.counts.system, 5, 'machine-routed text rows count as system');
  assert.equal(result.counts.other, 8);
  const json = JSON.stringify(result.snapshot);
  const ids = rows.map((row) => `"${row.id}"`);
  for (const leaked of ['private reasoning', 'cat .env', 'SECRET=1', 'claude-opus', 'subagent', '"id"', 'userId', ...ids]) {
    assert.ok(!json.includes(leaked), `snapshot leaks ${leaked}`);
  }
  assert.equal(result.snapshot?.providerLabel, 'Claude');
  assert.equal(result.possibleSecretsNote, true);
});

test('message objects are built fresh: unknown fields never pass through', () => {
  const result = assembleShareSnapshot([user('a', { projectPath: '/srv/x', email: 'a@b.c' } as never)], ownerOnly);
  assert.deepEqual(Object.keys(result.snapshot!.messages[0]).sort(), ['at', 'author', 'parts', 'role']);
  assert.deepEqual(Object.keys(result.snapshot!).sort(), ['messages', 'providerLabel', 'title', 'toolCount', 'v']);
});

test('text cleanup and redaction counts flow into the result', () => {
  const key = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
  const rows = [
    user(`<system-reminder>x</system-reminder>look ${key} at /srv/p/a ![i](/api/chat-images/1.png)`),
    assistant('```bash nassaj-run\nls\n```'),
  ];
  const result = assembleShareSnapshot(rows, { ...ownerOnly, projectRoot: '/srv/p', home: '/home/owner' });
  assert.equal(result.counts.system, 1);
  assert.equal(result.counts.secret, 1);
  assert.equal(result.counts.path, 1);
  assert.equal(result.counts.image, 1);
  const json = JSON.stringify(result.snapshot);
  assert.ok(!json.includes(key) && !json.includes('/srv/p') && !json.includes('nassaj-run'));
  assert.ok(!json.includes('"rule"'), 'internal rule ids never reach the snapshot');
});

test('author matrix: owner only passes', () => {
  assert.deepEqual(evaluateAuthorBlockers([OWNER, OWNER], ownerOnly), []);
});

test('author matrix: any other author blocks', () => {
  assert.deepEqual(evaluateAuthorBlockers([OWNER, MEMBER], { ...ownerOnly, participantUserIds: [OWNER, MEMBER] }),
    [{ code: 'FOREIGN_AUTHOR', count: 1 }]);
});

test('author matrix: unknown with one participant passes for Claude without confirmation', () => {
  assert.deepEqual(evaluateAuthorBlockers([null], ownerOnly), []);
});

test('author matrix: unknown with more than one participant blocks even when confirmed', () => {
  const ctx = { ...ownerOnly, participantUserIds: [OWNER, MEMBER], confirmUnattributed: true };
  assert.deepEqual(evaluateAuthorBlockers([null, OWNER], ctx), [{ code: 'UNATTRIBUTED_MULTI_PARTICIPANT', count: 1 }]);
});

test('author matrix: non-Claude unknown needs the sole-owner confirmation', () => {
  const ctx = { ...ownerOnly, provider: 'codex' };
  assert.deepEqual(evaluateAuthorBlockers([null], ctx), [{ code: 'UNATTRIBUTED_NEEDS_CONFIRMATION', count: 1 }]);
  assert.deepEqual(evaluateAuthorBlockers([null], { ...ctx, confirmUnattributed: true }), []);
});

test('author matrix: unknown with a participant list that is not exactly the owner blocks', () => {
  for (const participantUserIds of [[], [MEMBER]]) {
    const ctx = { ...ownerOnly, participantUserIds, confirmUnattributed: true };
    assert.deepEqual(evaluateAuthorBlockers([null], ctx), [{ code: 'UNATTRIBUTED_PARTICIPANTS_UNVERIFIED', count: 1 }]);
  }
});

test('a blocked result carries counts and blockers but no snapshot, hash or blob', () => {
  const result = assembleShareSnapshot([user('mine'), user('theirs', { userId: MEMBER })],
    { ...ownerOnly, participantUserIds: [OWNER, MEMBER] });
  assert.equal(result.snapshot, null);
  assert.equal(result.sha256, null);
  assert.equal(result.blob, null);
  assert.deepEqual(result.blockers, [{ code: 'FOREIGN_AUTHOR', count: 1 }]);
});

test('only included human rows are classified: a foreign row that sanitizes to nothing does not block', () => {
  const result = assembleShareSnapshot(
    [user('mine'), user('<system-reminder>x</system-reminder>', { userId: MEMBER })],
    { ...ownerOnly, participantUserIds: [OWNER, MEMBER] },
  );
  assert.deepEqual(result.blockers, []);
});

test('truncation is inclusive, reports the last included text id, and a missing id is 409', () => {
  const a = user('one');
  const b = assistant('two');
  const tool = msg({ kind: 'tool_use' });
  const c = user('three');
  const result = assembleShareSnapshot([a, b, tool, c], { ...ownerOnly, upToMessageId: tool.id });
  assert.equal(result.snapshot?.messages.length, 2);
  assert.equal(result.upToMessageId, b.id);
  assert.equal(result.counts.toolCount, 1);
  assert.throws(() => assembleShareSnapshot([a], { ...ownerOnly, upToMessageId: 'gone' }),
    (error: { code?: string; statusCode?: number }) => error.code === 'SNAPSHOT_CHANGED' && error.statusCode === 409);
});

test('hash is deterministic and covers content; the blob is the gzip of the canonical JSON', () => {
  const rows = [user('one'), assistant('two')];
  const first = assembleShareSnapshot(rows, ownerOnly);
  const second = assembleShareSnapshot(JSON.parse(JSON.stringify(rows)), ownerOnly);
  assert.match(first.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(first.sha256, second.sha256);
  assert.equal(gunzipSync(first.blob!).toString('utf8'), canonicalJson(first.snapshot));
  const changed = assembleShareSnapshot([user('one'), assistant('two!')], ownerOnly);
  assert.notEqual(changed.sha256, first.sha256);
});

test('canonicalJson sorts keys at every depth and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, b: null }] }), '{"a":[{"b":null,"d":2}],"b":1}');
});

test('titles are sanitized, flattened and capped; generic provider labels only', () => {
  assert.equal(sanitizeTitle(undefined), 'Shared conversation');
  assert.equal(sanitizeTitle('<system-reminder>x</system-reminder>'), 'Shared conversation');
  assert.equal(sanitizeTitle('fix /srv/p/a <coordination>x</coordination>'), 'fix /srv/p/a [redacted]');
  assert.equal(sanitizeTitle('a'.repeat(500)).length, 200);
  assert.equal(providerLabelFor('opencode'), 'OpenCode');
  assert.equal(providerLabelFor('something-new'), 'Assistant');
});

const isTooLarge = (error: { code?: string; statusCode?: number }) =>
  error.code === 'SNAPSHOT_TOO_LARGE' && error.statusCode === 413;

test('413 caps: message count, sanitized text bytes and gzip blob', () => {
  const many = Array.from({ length: SHARE_SNAPSHOT_LIMITS.messages + 1 }, (_, i) => user(`m${i}`));
  assert.throws(() => assembleShareSnapshot(many, ownerOnly), isTooLarge);
  const big = 'x '.repeat(1024 * 1024);
  assert.throws(() => assembleShareSnapshot([user(big), user(big), user(big)], ownerOnly), isTooLarge);
  const word = () => Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const noisy = Array.from({ length: 1000 }, () => user(Array.from({ length: 330 }, word).join(' ')));
  assert.throws(() => assembleShareSnapshot(noisy, ownerOnly), isTooLarge);
});

test('raw caps reject oversized input BEFORE sanitization, even when it would sanitize to nothing', () => {
  const hidden = (bytes: number) => `<system-reminder>${'x'.repeat(bytes)}</system-reminder>`;
  const oneMessage = hidden(SHARE_SNAPSHOT_LIMITS.rawMessageBytes);
  assert.throws(() => assembleShareSnapshot([user(oneMessage)], ownerOnly), isTooLarge, 'per message');
  const half = hidden(2 * 1024 * 1024);
  assert.equal(SHARE_SNAPSHOT_LIMITS.rawTotalBytes, 4 * 1024 * 1024);
  assert.throws(() => assembleShareSnapshot([user(half), assistant(half)], ownerOnly), isTooLarge, 'total');
  const fits = assembleShareSnapshot([user(hidden(1024)), assistant('ok')], ownerOnly);
  assert.equal(fits.snapshot?.messages.length, 1, 'under the caps the hidden row is dropped as usual');
  assert.equal(sanitizeTitle('a'.repeat(SHARE_SNAPSHOT_LIMITS.rawTitleChars + 1)), 'Shared conversation',
    'an oversized raw title is replaced, never cut');
});

test('memory sink: pages are detached, chronological, and the hard cap throws 413', () => {
  const sink = new HistoryMemorySink(4096);
  const newer = [user('newer')];
  sink.acceptOlderPage(newer);
  sink.acceptOlderPage([user('older')]);
  newer[0].content = 'mutated after accept';
  assert.deepEqual(sink.messages().map((m) => m.content), ['older', 'newer']);
  assert.throws(() => sink.acceptOlderPage([user('z'.repeat(5000))]), isTooLarge);
  assert.equal(sink.signal.aborted, true);
  assert.deepEqual(sink.messages(), []);
  assert.equal(HISTORY_MEMORY_SINK_MAX_BYTES, 8 * 1024 * 1024);
});

function fakeDeps(overrides: Partial<SnapshotDeps> & { rows?: NormalizedMessage[] } = {}): SnapshotDeps & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    loadHistory: async (_sessionId, readerUserId, sink) => {
      reads.push(readerUserId);
      sink.acceptOlderPage(overrides.rows ?? [user('mine'), assistant('reply')]);
    },
    stampAuthors: () => {},
    resolveSessionOwner: () => OWNER,
    listParticipantIds: () => [OWNER],
    getSession: () => ({ provider: 'claude', project_path: '/srv/p' }),
    home: () => '/home/owner',
    ...overrides,
  };
}

test('an admin creator on a member session reads as the admin but judges authorship by the session owner', async () => {
  const deps = fakeDeps();
  const result = await buildSessionShareSnapshot({ sessionId: 's1', readerUserId: ADMIN }, deps);
  assert.deepEqual(deps.reads, [ADMIN]);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.snapshot?.messages[0].author, 'owner');
});

test('the creator\'s own prompts are foreign when they are not the session owner', async () => {
  const deps = fakeDeps({ rows: [user('admin wrote this', { userId: ADMIN })], listParticipantIds: () => [OWNER, ADMIN] });
  const result = await buildSessionShareSnapshot({ sessionId: 's1', readerUserId: ADMIN }, deps);
  assert.deepEqual(result.blockers, [{ code: 'FOREIGN_AUTHOR', count: 1 }]);
});

test('author table failure is 409 AUTHOR_UNVERIFIABLE (strict stamper and participant list)', async () => {
  const failing = () => { throw Object.assign(new Error('x'), { code: 'AUTHOR_UNVERIFIABLE', statusCode: 409 }); };
  await assert.rejects(buildSessionShareSnapshot({ sessionId: 's1', readerUserId: OWNER }, fakeDeps({ stampAuthors: failing })),
    (error: { code?: string }) => error.code === 'AUTHOR_UNVERIFIABLE');
  const deps = fakeDeps({ listParticipantIds: () => { throw new Error('db down'); } });
  await assert.rejects(buildSessionShareSnapshot({ sessionId: 's1', readerUserId: OWNER }, deps),
    (error: { code?: string; statusCode?: number }) => error.code === 'AUTHOR_UNVERIFIABLE' && error.statusCode === 409);
});

test('unresolved session owner is 409 OWNER_UNRESOLVED; a vanished session is 404', async () => {
  await assert.rejects(
    buildSessionShareSnapshot({ sessionId: 's1', readerUserId: OWNER }, fakeDeps({ resolveSessionOwner: () => null })),
    (error: { code?: string; statusCode?: number }) => error.code === 'OWNER_UNRESOLVED' && error.statusCode === 409,
  );
  await assert.rejects(
    buildSessionShareSnapshot({ sessionId: 's1', readerUserId: OWNER }, fakeDeps({ getSession: () => null })),
    (error: { statusCode?: number }) => error.statusCode === 404,
  );
});

test('confirmUnattributed only counts when it is exactly true', async () => {
  const rows = [user('legacy', { userId: undefined })];
  const getSession = () => ({ provider: 'kimi', project_path: null });
  const loose = await buildSessionShareSnapshot(
    { sessionId: 's1', readerUserId: OWNER, confirmUnattributed: 'yes' as unknown as boolean },
    fakeDeps({ rows, getSession }),
  );
  assert.deepEqual(loose.blockers, [{ code: 'UNATTRIBUTED_NEEDS_CONFIRMATION', count: 1 }]);
  const confirmed = await buildSessionShareSnapshot(
    { sessionId: 's1', readerUserId: OWNER, confirmUnattributed: true }, fakeDeps({ rows, getSession }),
  );
  assert.deepEqual(confirmed.blockers, []);
  assert.equal(confirmed.snapshot?.providerLabel, 'Kimi');
});

test('preview then create with the returned upToMessageId reproduces the same hash', async () => {
  const rows = [user('one'), assistant('two')];
  const preview = await buildSessionShareSnapshot({ sessionId: 's1', readerUserId: OWNER }, fakeDeps({ rows }));
  const grown = [...rows, user('three, sent after the preview')];
  const create = await buildSessionShareSnapshot(
    { sessionId: 's1', readerUserId: OWNER, upToMessageId: preview.upToMessageId ?? undefined },
    fakeDeps({ rows: grown }),
  );
  assert.equal(create.sha256, preview.sha256);
});
