/**
 * Real opencode.db rows (fixture `opencode-injected-prefix.real.json`):
 *
 * - B-1750: `opencode run` wraps an argument holding a space as `"…"` and turns
 *   each inner `"` into `\"`. The stored first prompt is that wrapped text, so
 *   the runtime prefix was never stripped and showed in the user bubble.
 * - B-1756: compaction turns (OpenCode's own summaries and its synthetic
 *   "media attachments" continue prompt) are not conversation messages.
 * - B-1757: OpenCode's title agent names the session after the injected prefix;
 *   the user's question names it instead.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { hashMessageAuthorContent } from '@/modules/database/index.js';
import { applyMessageCoordination } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { OpenCodeSessionSynchronizer } from './opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider, unwrapOpenCodeRunArgument } from './opencode-sessions.provider.js';

type AnyRecord = Record<string, any>;
type FixtureSession = {
  session: { id: string; title: string };
  rows: AnyRecord[];
  canonicalUserText: string;
};

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'opencode-injected-prefix.real.json'), 'utf8')) as {
  promptPrefix: FixtureSession; compaction: FixtureSession;
};

const provider = new OpenCodeSessionsProvider();

const historyOf = (fx: FixtureSession): NormalizedMessage[] => (provider as any).normalizeHistoryRows(
  fx.rows.map((row) => ({
    ...row,
    message_data: JSON.stringify(row.message_data),
    part_data: row.part_data ? JSON.stringify(row.part_data) : null,
  })),
  fx.session.id,
);

/** fetchHistory output after the sessions service re-attaches the stored canonical prompt. */
const coordinatedHistory = (fx: FixtureSession): NormalizedMessage[] => {
  const messages = historyOf(fx);
  const createdAt = new Date(fx.rows[0].message_time_created).toISOString();
  applyMessageCoordination(messages, [{
    clientMsgId: 'client-1', sessionId: fx.session.id, userId: 1, provider: 'opencode',
    canonicalContent: fx.canonicalUserText, contentHash: hashMessageAuthorContent(fx.canonicalUserText),
    coordinationLevel: 'delegate', createdAt,
  }]);
  return messages;
};

const userTexts = (messages: NormalizedMessage[]) => messages
  .filter((m) => m.kind === 'text' && m.role === 'user').map((m) => m.content);

describe('B-1750: inverse of the opencode run argument quoting', () => {
  it('restores the real multi-line prompt that holds \\"help\\"', () => {
    const stored = fixture.promptPrefix.rows[0].part_data.text as string;
    assert.ok(stored.startsWith('"<nassaj_document_sharing>') && stored.includes('\\"help\\"'));
    const restored = unwrapOpenCodeRunArgument(stored);
    assert.ok(restored.startsWith('<nassaj_document_sharing>\n'));
    assert.ok(restored.includes('equal to "help"'));
    assert.ok(restored.endsWith('هل تمتلك الان ادوات اوبن كود ؟'));
  });

  it('keeps a user backslash exactly and leaves unwrapped text alone', () => {
    const original = 'path C:\\dir\\ and a \\"quoted\\" "word" here';
    const wrapped = `"${original.replace(/"/g, '\\"')}"`;
    assert.equal(unwrapOpenCodeRunArgument(wrapped), original);
    assert.equal(unwrapOpenCodeRunArgument('"no-space"'), '"no-space"');
    assert.equal(unwrapOpenCodeRunArgument('"a "b" c"'), '"a "b" c"');
    assert.equal(unwrapOpenCodeRunArgument('plain text'), 'plain text');
  });

  it('shows only the canonical user text after fetchHistory + coordination', () => {
    const messages = coordinatedHistory(fixture.promptPrefix);
    assert.deepEqual(userTexts(messages), ['هل تمتلك الان ادوات اوبن كود ؟']);
    assert.ok(!messages.some((m) => m.content?.includes('nassaj_document_sharing')));
  });
});

describe('B-1756: compaction turns are not conversation messages', () => {
  it('keeps one user row and drops the synthetic prompt and the summaries', () => {
    const messages = coordinatedHistory(fixture.compaction);
    assert.deepEqual(userTexts(messages), ['ايش اسمك ؟']);
    assert.ok(!messages.some((m) => m.content?.includes('media attachments')));
    assert.ok(!messages.some((m) => m.content?.includes('## Objective')));
    assert.ok(!messages.some((m) => m.kind === 'text' && m.role === 'assistant'));
  });

  it('still surfaces an error recorded on a compaction message', () => {
    const rows = [{
      message_id: 'msg_c', message_time_created: 1,
      message_data: JSON.stringify({ role: 'assistant', mode: 'compaction', summary: true,
        error: { name: 'APIError', data: { message: 'context overflow' } } }),
      part_id: 'prt_c', part_time_created: 1, part_data: JSON.stringify({ type: 'text', text: '## Objective\n- x' }),
    }];
    const messages = (provider as any).normalizeHistoryRows(rows, 'ses_x') as NormalizedMessage[];
    assert.deepEqual(messages.map((m) => m.kind), ['error']);
  });
});

const sessionDb = (fx: FixtureSession): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  const messages = new Map<string, AnyRecord>();
  for (const row of fx.rows) messages.set(row.message_id, row);
  for (const row of messages.values()) {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run(row.message_id, fx.session.id, row.message_time_created, JSON.stringify(row.message_data));
  }
  for (const row of fx.rows.filter((r) => r.part_id)) {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run(row.part_id, row.message_id, fx.session.id, row.part_time_created, JSON.stringify(row.part_data));
  }
  return db;
};

const resolveName = (fx: FixtureSession, title: string | null, existing?: string) => {
  const db = sessionDb(fx);
  try {
    return (new OpenCodeSessionSynchronizer() as any)
      .resolveSessionName(db, fx.session.id, title, existing, (text: string | undefined) => text) as string | undefined;
  } finally {
    db.close();
  }
};

describe('B-1757: the session name comes from the question, not the injected prefix', () => {
  const fx = fixture.compaction;

  it('ignores the OpenCode title written from the runtime prefix', () => {
    assert.equal(fx.session.title, 'Nassaj document sharing and public page publishing');
    assert.equal(resolveName(fx, fx.session.title), 'ايش اسمك ؟');
  });

  it('replaces a stored name that is only that title', () => {
    assert.equal(resolveName(fx, fx.session.title, fx.session.title), 'ايش اسمك ؟');
  });

  it('keeps a rename', () => {
    assert.equal(resolveName(fx, fx.session.title, 'my own name'), 'my own name');
  });

  it('names the placeholder-titled session from its question', () => {
    const other = fixture.promptPrefix;
    assert.equal(resolveName(other, other.session.title), 'هل تمتلك الان ادوات اوبن كود ؟');
  });

  it('strips injected blocks from an OpenCode title', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);'
      + 'CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);');
    try {
      const name = (new OpenCodeSessionSynchronizer() as any).resolveSessionName(
        db, 'ses_y', '<nassaj_quick_replies>\nx\n</nassaj_quick_replies> Real title', undefined,
        (text: string | undefined) => text,
      );
      assert.equal(name, 'Real title');
    } finally {
      db.close();
    }
  });
});
