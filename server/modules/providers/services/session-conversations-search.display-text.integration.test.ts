/**
 * B-1668 item 9: search snippets and summaries are built on code-point
 * boundaries from display text (injected blocks out, masked, markdown out), so
 * they never show "�", raw markdown or a known secret — and searching a prefix
 * of a stored secret still finds nothing (ADR-210).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, participantsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
import { configureDisplayMaskForTests } from '@/services/display-secret-mask.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeProjectsSandbox } from '@/shared/__tests__/provider-root-sandbox.js';

const MARKER = 'zebrafjordmarker';
const LITERAL = ['abc__def*ghi', 'jkl-0123456789ABCDEFGHIJ'].join('_');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// The emoji sits exactly where a 150-unit snippet window would cut a UTF-16 pair.
const EMOJI_AT_CUTS = `${'a'.repeat(10)}😀${'b'.repeat(73)} **${MARKER}** ${'c'.repeat(73)}😀 tail`;

async function withTranscript(messages: string[], title: string | null, runTest: (userId: number) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b1668-search-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  try {
    const userId = userDb.createUser('bob', 'hash-b', 'user').id;
    const sessionId = 'display-text-search-1';
    const transcriptPath = path.join(claudeProjectsSandbox('b1668-search-'), `${sessionId}.jsonl`);
    const lines = messages.map((content, index) => JSON.stringify({
      type: 'user', sessionId, uuid: `${sessionId}-u${index}`, timestamp: '2026-10-16T10:00:00.000Z',
      message: { role: 'user', content },
    }));
    await fs.writeFile(transcriptPath, `${lines.join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'claude', '/work/b1668-search', title ?? (null as unknown as undefined), undefined, undefined, transcriptPath);
    participantsDb.recordSpawn(sessionId, userId);
    configureDisplayMaskForTests({
      env: () => undefined, readSetting: () => null, serviceLiterals: () => [],
      allUserIds: () => [userId], vendorLiterals: () => [LITERAL], sharedVendorLiterals: () => [],
    });
    await runTest(userId);
  } finally {
    configureDisplayMaskForTests(null);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

type Match = { snippet: string; highlights: Array<{ start: number; end: number }> };
type Result = { sessionSummary: string; matches: Match[] };

async function firstSession(query: string, userId: number): Promise<{ total: number; session: Result | null; raw: string }> {
  const result = await searchConversations(query, userId, 50, () => {});
  const session = (result.results[0] as unknown as { sessions: Result[] } | undefined)?.sessions[0] ?? null;
  return { total: result.totalMatches, session, raw: JSON.stringify(result.results) };
}

test('snippets never split an emoji and lose their markdown; highlights point at the query', async () => {
  await withTranscript([EMOJI_AT_CUTS], null, async (userId) => {
    const { total, session } = await firstSession(MARKER, userId);
    assert.equal(total, 1);
    const match = session!.matches[0];
    assert.equal(LONE_SURROGATE.test(match.snippet), false, match.snippet);
    // Both window edges fell inside an emoji: the start kept it whole, the end dropped it.
    assert.ok(match.snippet.startsWith('...😀b') && match.snippet.endsWith('c...'), match.snippet);
    assert.equal(match.snippet.includes('**'), false, match.snippet);
    const [highlight] = match.highlights;
    assert.equal(match.snippet.slice(highlight.start, highlight.end), MARKER);
  });
});

test('a fallback summary is cut on code points and cleaned of the image list', async () => {
  const prompt = `${'😀'.repeat(60)} ${MARKER}\n\n[Images provided at the following paths:]\n1. /x/chat-images/a.png`;
  await withTranscript([prompt], null, async (userId) => {
    const { session } = await firstSession(MARKER, userId);
    assert.equal(LONE_SURROGATE.test(session!.sessionSummary), false);
    assert.equal(session!.sessionSummary.includes('Images provided'), false);
  });
});

test('highlights stay aligned after a character whose lower case is longer (İ)', async () => {
  await withTranscript([`İİİ prefix ${MARKER} suffix`], null, async (userId) => {
    const { session } = await firstSession(MARKER, userId);
    const match = session!.matches[0];
    const [highlight] = match.highlights;
    assert.equal(match.snippet.slice(highlight.start, highlight.end), MARKER);
  });
});

test('a known secret spelled with __ and * never surfaces in a snippet or a title, and is no oracle', async () => {
  await withTranscript([`${MARKER} key **${LITERAL}** end`], `title ${LITERAL}`, async (userId) => {
    const { total, raw } = await firstSession(MARKER, userId);
    assert.equal(total, 1);
    assert.equal(raw.includes('0123456789'), false, raw);
    assert.equal(raw.includes('abc__def'), false, raw);
    assert.ok(raw.includes('[masked:'), raw);
    assert.equal((await firstSession(LITERAL.slice(0, 16), userId)).total, 0);
  });
});
