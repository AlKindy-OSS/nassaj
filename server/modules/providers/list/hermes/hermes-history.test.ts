/**
 * A hermes conversation reads back the way it was written (B-599).
 *
 * The bug: the sessions facet returned `[]` from `normalizeMessage` and threw
 * 501 from `fetchHistory`, so a hermes conversation opened blank — listed in the
 * sidebar, present in the DB, and empty on screen. Hermes' own `state.db` could
 * not fill the gap: `hermes -z` starts a fresh hermes session per TURN, so the
 * conversation the user sees exists only as nassaj's stitching of those turns.
 *
 * These tests therefore assert the ROUND TRIP over nassaj's own transcript —
 * write the turns the run seam writes, read them back through the provider —
 * because "fetchHistory no longer throws" would have passed on an empty file.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesProvider } from '@/modules/providers/list/hermes/hermes.provider.js';
import {
  appendVendorTranscriptTurn,
  writeVendorTranscriptMeta,
} from '@/modules/providers/shared/vendor/vendor-transcript.js';

const PROJECT_PATH = '/workspace/hermes-history';

/**
 * The transcript root is derived from `os.homedir()`, so the whole test runs
 * against a throwaway HOME — no write ever lands in the operator's tree.
 */
async function withTemporaryHome(runTest: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'hermes-history-home-'));
  process.env.HOME = temporaryHome;

  try {
    await runTest();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

test('B-599: both sides of a hermes turn survive a reload', async () => {
  await withTemporaryHome(async () => {
    const sessions = new HermesProvider().sessions;
    const sessionId = 'hermes-session-round-trip';

    await writeVendorTranscriptMeta('hermes', sessionId, PROJECT_PATH, 'اشرح لي الوضع');
    await appendVendorTranscriptTurn('hermes', sessionId, PROJECT_PATH, 'user', 'اشرح لي الوضع');
    await appendVendorTranscriptTurn('hermes', sessionId, PROJECT_PATH, 'assistant', 'السطر الأول\nالسطر الثاني');

    const history = await sessions.fetchHistory(sessionId, { projectPath: PROJECT_PATH });

    assert.equal(history.total, 2, 'a prompt and its reply are two renderable messages');
    assert.equal(history.messages[0].role, 'user');
    assert.equal(history.messages[0].content, 'اشرح لي الوضع');
    assert.equal(history.messages[1].role, 'assistant');
    assert.equal(
      history.messages[1].content,
      'السطر الأول\nالسطر الثاني',
      'a multi-line reply keeps its line breaks — hermes prints whole paragraphs',
    );
    assert.equal(
      history.messages[1].provider,
      'hermes',
      'the reply must be attributed to hermes, not to the vendor implementation it borrows',
    );
  });
});

test('B-599: a session with no transcript answers empty instead of throwing', async () => {
  await withTemporaryHome(async () => {
    const sessions = new HermesProvider().sessions;

    // A session created but never run: the old facet threw 501 here, which the
    // UI surfaced as a failed load rather than an empty conversation.
    const history = await sessions.fetchHistory('hermes-session-never-run', {
      projectPath: PROJECT_PATH,
    });

    assert.deepEqual(history.messages, []);
    assert.equal(history.total, 0);
    assert.equal(history.hasMore, false);
  });
});

test('B-599: several turns accumulate in order', async () => {
  await withTemporaryHome(async () => {
    const sessions = new HermesProvider().sessions;
    const sessionId = 'hermes-session-multi-turn';

    await writeVendorTranscriptMeta('hermes', sessionId, PROJECT_PATH, 'أولاً');
    for (const turn of ['أولاً', 'ثانياً', 'ثالثاً']) {
      await appendVendorTranscriptTurn('hermes', sessionId, PROJECT_PATH, 'user', turn);
      await appendVendorTranscriptTurn('hermes', sessionId, PROJECT_PATH, 'assistant', `ردّ ${turn}`);
    }

    const history = await sessions.fetchHistory(sessionId, { projectPath: PROJECT_PATH });

    assert.deepEqual(
      history.messages.map((message) => message.content),
      ['أولاً', 'ردّ أولاً', 'ثانياً', 'ردّ ثانياً', 'ثالثاً', 'ردّ ثالثاً'],
      'turn order is the reading order — hermes runs each turn as its own process',
    );
  });
});
