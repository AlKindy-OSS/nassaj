import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT_PATH = '/__antigravity__';

/**
 * Sets up an isolated SQLite DB, writes a transcript.jsonl with the supplied
 * lines, and registers a session row so AntigravitySessionsProvider.fetchHistory
 * can resolve the transcript path through the database.
 *
 * `node:test` does not isolate state automatically, so each scenario gets its
 * own DB and temp directory to avoid cross-test pollution.
 */
async function withTranscriptFixture(
  rawLines: unknown[],
  runTest: (provider: AntigravitySessionsProvider, transcriptPath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'agy-transcript-'));
  const databasePath = path.join(tempRoot, 'auth.db');
  const transcriptDir = path.join(tempRoot, 'brain', SESSION_ID, '.system_generated', 'logs');
  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  await mkdir(transcriptDir, { recursive: true });
  const body = rawLines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  await writeFile(transcriptPath, body + '\n', 'utf8');

  sessionsDb.createSession(SESSION_ID, 'antigravity', PROJECT_PATH, undefined, undefined, undefined, transcriptPath);

  const provider = new AntigravitySessionsProvider();

  try {
    await runTest(provider, transcriptPath);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * The live websocket path is not wired for agy yet, so the normalizer must stay
 * a no-op rather than fabricate fake messages from arbitrary input.
 */
test('normalizeMessage returns no messages because agy has no live stream', () => {
  const provider = new AntigravitySessionsProvider();
  assert.deepEqual(provider.normalizeMessage({ anything: 'goes' }, 'session-x'), []);
  assert.deepEqual(provider.normalizeMessage(null, null), []);
});

test('fetchHistory normalizes USER_INPUT into a single user text turn', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nhello world\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime</ADDITIONAL_METADATA>',
      },
    ],
    async (provider) => {
      const { messages, total } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.role, 'user');
      assert.equal(messages[0]?.kind, 'text');
      assert.equal(messages[0]?.content, 'hello world');
      assert.equal(messages[0]?.provider, 'antigravity');
      assert.equal(total, 1);
    },
  );
});

test('fetchHistory strips out <instructions> tags from USER_INPUT content', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n<instructions>\nIMPORTANT: Arabic only\n</instructions>\n\nhello world\n</USER_REQUEST>',
      },
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.content, 'hello world');
    },
  );
});

test('fetchHistory strips every <instructions> block when several are present', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content:
          '<USER_REQUEST>\n<instructions>\nArabic only\n</instructions>\nhello world\n<instructions>\nbe concise\n</instructions>\n</USER_REQUEST>',
      },
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.content, 'hello world');
    },
  );
});

test('fetchHistory drops a USER_INPUT that is nothing but an <instructions> block', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n<instructions>\nIMPORTANT: Arabic only\n</instructions>\n</USER_REQUEST>',
      },
    ],
    async (provider) => {
      // The whole turn is injected system instructions; once stripped nothing
      // user-authored remains, so extractUserRequest returns '' and the message
      // is dropped rather than rendered as an empty user bubble.
      const { messages, total } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 0);
      assert.equal(total, 0);
    },
  );
});

test('fetchHistory falls back to raw content when USER_REQUEST wrapper is missing', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '   bare prompt without wrapper   ',
      },
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.content, 'bare prompt without wrapper');
    },
  );
});

test('fetchHistory skips USER_INPUT lines whose extracted body is empty', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n   \n</USER_REQUEST>',
      },
    ],
    async (provider) => {
      const { messages, total } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 0);
      assert.equal(total, 0);
    },
  );
});

test('fetchHistory emits assistant text for a plain PLANNER_RESPONSE', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:01Z',
        content: 'Hello there!',
      },
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      const textMsg = messages.find((m) => m.kind === 'text' && m.role === 'assistant');
      assert.ok(textMsg, 'expected an assistant text message');
      assert.equal(textMsg?.content, 'Hello there!');
    },
  );
});

test('fetchHistory emits both thinking and text for a reasoning PLANNER_RESPONSE', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:02Z',
        content: 'Final answer.',
        thinking: 'Let me think...',
      },
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 2);
      const thinking = messages.find((m) => m.kind === 'thinking');
      const text = messages.find((m) => m.kind === 'text' && m.role === 'assistant');
      assert.ok(thinking, 'expected a thinking message');
      assert.equal(thinking?.content, 'Let me think...');
      assert.equal(thinking?.role, 'assistant');
      assert.ok(text, 'expected an assistant text message');
      assert.equal(text?.content, 'Final answer.');
    },
  );
});

test('fetchHistory renders RUN_COMMAND as a Task tool_use', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 3,
        source: 'MODEL',
        type: 'RUN_COMMAND',
        status: 'RUNNING',
        created_at: '2026-01-01T00:00:03Z',
        content: 'Task id: abc/task-1',
      },
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.kind, 'tool_use');
      assert.equal(messages[0]?.toolName, 'Task');
      assert.deepEqual(messages[0]?.toolInput, { description: 'Task id: abc/task-1' });
      assert.ok(typeof messages[0]?.toolId === 'string' && messages[0]!.toolId.length > 0);
    },
  );
});

test('fetchHistory extracts the TASK_RESULT body from a SYSTEM_MESSAGE', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:04Z',
        content: 'prelude <TASK_RESULT>\nfinal result\n</TASK_RESULT> trailing noise',
      },
    ],
    async (provider) => {
      const { messages, total } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.kind, 'tool_result');
      assert.equal(messages[0]?.content, 'final result');
      // tool_result rows are excluded from the public total so the UI count
      // stays focused on user-visible turns.
      assert.equal(total, 0);
    },
  );
});

test('fetchHistory skips CONVERSATION_HISTORY events entirely', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'CONVERSATION_HISTORY',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    async (provider) => {
      const { messages, total } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 0);
      assert.equal(total, 0);
    },
  );
});

test('fetchHistory tolerates malformed JSON lines without aborting the stream', async () => {
  await withTranscriptFixture(
    [
      '{not valid json',
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nstill counted\n</USER_REQUEST>',
      },
      '',
      'not even an object',
    ],
    async (provider) => {
      const { messages } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.content, 'still counted');
    },
  );
});

test('fetchHistory ignores unknown event types instead of throwing', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 99,
        source: 'SYSTEM',
        type: 'UNKNOWN_FUTURE_TYPE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    async (provider) => {
      const { messages, total } = await provider.fetchHistory(SESSION_ID);
      assert.equal(messages.length, 0);
      assert.equal(total, 0);
    },
  );
});

test('fetchHistory returns an empty page when the DB has no session row', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'agy-empty-'));
  const databasePath = path.join(tempRoot, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const provider = new AntigravitySessionsProvider();
    const result = await provider.fetchHistory('does-not-exist');
    assert.deepEqual(result, { messages: [], total: 0, hasMore: false, offset: 0, limit: null });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('fetchHistory honours offset/limit and reports hasMore based on the slice', async () => {
  await withTranscriptFixture(
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>one</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:01Z',
        content: '<USER_REQUEST>two</USER_REQUEST>',
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:02Z',
        content: '<USER_REQUEST>three</USER_REQUEST>',
      },
    ],
    async (provider) => {
      const firstPage = await provider.fetchHistory(SESSION_ID, { offset: 0, limit: 2 });
      assert.equal(firstPage.messages.length, 2);
      assert.equal(firstPage.messages[0]?.content, 'one');
      assert.equal(firstPage.messages[1]?.content, 'two');
      assert.equal(firstPage.offset, 0);
      assert.equal(firstPage.limit, 2);
      assert.equal(firstPage.hasMore, true);
      assert.equal(firstPage.total, 3);

      const secondPage = await provider.fetchHistory(SESSION_ID, { offset: 2, limit: 2 });
      assert.equal(secondPage.messages.length, 1);
      assert.equal(secondPage.messages[0]?.content, 'three');
      assert.equal(secondPage.hasMore, false);
    },
  );
});
