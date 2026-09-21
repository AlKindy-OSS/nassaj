import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  clearAntigravityProjectPath,
  registerAntigravityProjectPath,
} from '@/modules/providers/list/antigravity/antigravity-project-registry.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import { normalizeSessionName } from '@/shared/utils.js';

const SESSION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as { homedir: () => string }).homedir = original;
  };
};

/**
 * Sets up an isolated DB plus a fake `$HOME` so the synchronizer reads from a
 * disposable brain directory. The DB is required because synchronize() writes
 * session rows through sessionsDb.createSession (FK → projects).
 */
async function withSyncFixture(
  populate: (brainDir: string) => Promise<void> | void,
  runTest: (sync: AntigravitySessionSynchronizer, brainDir: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'agy-sync-'));
  const databasePath = path.join(tempHome, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const restoreHomeDir = patchHomeDir(tempHome);
  const brainDir = path.join(tempHome, '.gemini', 'antigravity-cli', 'brain');

  try {
    await populate(brainDir);
    const sync = new AntigravitySessionSynchronizer();
    await runTest(sync, brainDir);
  } finally {
    restoreHomeDir();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function writeTranscript(brainDir: string, uuid: string, firstLine: unknown): Promise<string> {
  const transcriptDir = path.join(brainDir, uuid, '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
  await writeFile(transcriptPath, JSON.stringify(firstLine) + '\n', 'utf8');
  return transcriptPath;
}

/**
 * Writes a transcript made of several JSONL records so tests can exercise the
 * leading-line scan (e.g. a system line before the first USER_INPUT). The
 * synchronizer reads only the first TITLE_SCAN_LINE_LIMIT lines, so order
 * matters here.
 */
async function writeTranscriptLines(brainDir: string, uuid: string, lines: unknown[]): Promise<string> {
  const transcriptDir = path.join(brainDir, uuid, '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  await writeFile(transcriptPath, body, 'utf8');
  return transcriptPath;
}

test('synchronize returns 0 when the brain directory does not exist yet', async () => {
  await withSyncFixture(
    () => {
      /* deliberately do not create the brain directory */
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(typeof processed, 'number');
      assert.equal(processed, 0);
    },
  );
});

test('synchronize indexes a brain UUID and writes a session row with the transcript path', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nWrite me a poem\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.ok(row, 'expected the synchronizer to upsert a session row');
      assert.equal(row?.provider, 'antigravity');
      assert.equal(row?.project_path, ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH);
      assert.equal(row?.custom_name, 'Write me a poem');
      assert.match(row?.jsonl_path ?? '', /transcript\.jsonl$/);
    },
  );
});

test('synchronize strips out <instructions> tags from the session title', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n<instructions>\nIMPORTANT: Arabic only\n</instructions>\n\nWrite me a poem\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'Write me a poem');
    },
  );
});

test('synchronize strips every <instructions> block from the title when several are present', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content:
          '<USER_REQUEST>\n<instructions>\nArabic only\n</instructions>\nWrite me a poem\n<instructions>\nbe concise\n</instructions>\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'Write me a poem');
    },
  );
});

test('synchronize falls back to the default title when the request is only an <instructions> block', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\n<instructions>\nIMPORTANT: Arabic only\n</instructions>\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      // Stripping the injected instructions leaves no user text, so
      // extractTitleFromFirstLine returns undefined and the synchronizer falls
      // back to the default title rather than naming the chat after machine input.
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

test('synchronize preserves an existing real project_path instead of clobbering it with the placeholder', async () => {
  // Regression: agy-cli.js registers a freshly created session under its real
  // workspace cwd on process close. A subsequent full sync must NOT relocate
  // that session into the phantom /__antigravity__ workspace, or it disappears
  // from the owning project's sidebar.
  const REAL_PROJECT_PATH = '/home/dev/workspace/nassaj';

  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nhello from a real project\n</USER_REQUEST>',
      });
    },
    async (sync) => {
      // Simulate agy-cli.js close handler having already filed the session
      // under the real project path.
      sessionsDb.createSession(SESSION_UUID, 'antigravity', REAL_PROJECT_PATH);

      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.project_path, REAL_PROJECT_PATH);
      assert.notEqual(row?.project_path, ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH);
    },
  );
});

test('synchronize uses the in-process registry path when the DB row does not exist yet', async () => {
  // Regression: a synchronize() (boot / sidebar refresh / watcher) can reach a
  // brand-new brain UUID *before* agy-cli.js has written its DB row. Without the
  // registry fallback the first sync files the /__antigravity__ placeholder and
  // nothing ever corrects it — the conversation vanishes from its project folder.
  const REAL_PROJECT_PATH = '/home/dev/workspace/nassaj';

  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>raced against the close handler</USER_REQUEST>',
      });
    },
    async (sync) => {
      // The spawn adapter publishes the binding the instant it discovers the UUID,
      // before any DB row exists for it.
      registerAntigravityProjectPath(SESSION_UUID, REAL_PROJECT_PATH);
      try {
        const processed = await sync.synchronize();
        assert.equal(processed, 1);

        const row = sessionsDb.getSessionById(SESSION_UUID);
        assert.equal(row?.project_path, REAL_PROJECT_PATH);
        assert.notEqual(row?.project_path, ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH);
      } finally {
        clearAntigravityProjectPath(SESSION_UUID);
      }
    },
  );
});

test('synchronize ignores non-UUID directory names inside the brain folder', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await mkdir(path.join(brainDir, 'not-a-uuid'), { recursive: true });
      await mkdir(path.join(brainDir, '.hidden'), { recursive: true });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 0);
    },
  );
});

test('synchronize skips brain UUIDs that have no transcript file yet', async () => {
  await withSyncFixture(
    async (brainDir) => {
      // Create the UUID folder but no transcript inside
      await mkdir(path.join(brainDir, SESSION_UUID), { recursive: true });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 0);
    },
  );
});

test('synchronize falls back to "New Antigravity Chat" when no USER_REQUEST is present', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: 'system warmup',
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);
      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

test('synchronize honours the `since` filter via transcript mtime', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>filtered out</USER_REQUEST>',
      });
    },
    async (sync) => {
      // mtime is "just now"; passing a future cutoff should skip everything
      const future = new Date(Date.now() + 60_000);
      const processed = await sync.synchronize(future);
      assert.equal(processed, 0);
    },
  );
});

test('synchronizeFile rejects paths that do not end in transcript.jsonl', async () => {
  await withSyncFixture(
    () => undefined,
    async (sync) => {
      const result = await sync.synchronizeFile('/tmp/not-a-transcript.txt');
      assert.equal(result, null);
    },
  );
});

test('synchronizeFile returns null when the UUID segment is not a valid UUID', async () => {
  await withSyncFixture(
    () => undefined,
    async (sync) => {
      const result = await sync.synchronizeFile(
        '/home/x/.gemini/antigravity-cli/brain/not-a-uuid/.system_generated/logs/transcript.jsonl',
      );
      assert.equal(result, null);
    },
  );
});

test('synchronizeFile indexes a single transcript path and returns its session id', async () => {
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>single file ingest</USER_REQUEST>',
      });
    },
    async (sync, brainDir) => {
      const transcriptPath = path.join(brainDir, SESSION_UUID, '.system_generated', 'logs', 'transcript.jsonl');
      const result = await sync.synchronizeFile(transcriptPath);
      assert.equal(result, SESSION_UUID);
      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'single file ingest');
    },
  );
});

// --------------------------------------------------------------------------
// Edge cases: title extraction from leading transcript lines
// --------------------------------------------------------------------------

test('synchronize reads the title from the first USER_INPUT even when a system line precedes it', async () => {
  // agy can emit a CONVERSATION_HISTORY (or other system) line before the human's
  // first turn. The scan must look past line 0 and capture the USER_INPUT title
  // instead of falling back to the default name.
  await withSyncFixture(
    async (brainDir) => {
      await writeTranscriptLines(brainDir, SESSION_UUID, [
        {
          step_index: 0,
          source: 'SYSTEM',
          type: 'CONVERSATION_HISTORY',
          status: 'DONE',
          created_at: '2026-01-01T00:00:00Z',
          content: 'restored prior conversation context',
        },
        {
          step_index: 1,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-01-01T00:00:05Z',
          content: '<USER_REQUEST>\nSummarize the meeting notes\n</USER_REQUEST>',
        },
      ]);
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'Summarize the meeting notes');
      assert.notEqual(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

test('synchronize truncates a long Arabic title on a word boundary and appends an ellipsis', async () => {
  // A single Arabic word repeated past the 120 code-point bound. normalizeSessionName
  // must cut inside the first 117 code points, break on the last space so no word is
  // split, and mark the cut with "…".
  const ARABIC_WORD = 'مرحبا'; // 5 code points
  // 25 words * (5 + 1 space) = 150 code points -> well over the 120 bound.
  const longArabic = Array.from({ length: 25 }, () => ARABIC_WORD).join(' ');

  await withSyncFixture(
    async (brainDir) => {
      await writeTranscript(brainDir, SESSION_UUID, {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: `<USER_REQUEST>\n${longArabic}\n</USER_REQUEST>`,
      });
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      const name = row?.custom_name ?? '';

      assert.ok(name.endsWith('…'), 'expected the truncated title to end with an ellipsis');
      assert.ok(name.length < longArabic.length, 'expected the title to be shorter than the source');

      // The kept text (without the ellipsis) must be a clean word boundary: it
      // is a whole number of ARABIC_WORD tokens joined by spaces, never a partial word.
      const kept = name.slice(0, -1).trimEnd();
      const tokens = kept.split(' ');
      for (const token of tokens) {
        assert.equal(token, ARABIC_WORD, 'expected every kept token to be a whole word');
      }

      // Code-point length of the kept portion must respect the 117-window bound.
      assert.ok(Array.from(kept).length <= 117, 'kept portion must stay within the 117 code-point window');
    },
  );
});

test('synchronize falls back to the default title when no USER_INPUT appears in the first 10 lines', async () => {
  // The scan window is bounded to TITLE_SCAN_LINE_LIMIT (10). A USER_INPUT that
  // only shows up on line 11 must not be reached, so the title falls back.
  await withSyncFixture(
    async (brainDir) => {
      const systemLines = Array.from({ length: 10 }, (_, index) => ({
        step_index: index,
        source: 'SYSTEM',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-01T00:00:00Z',
        content: `system warmup ${index}`,
      }));
      const lateUserInput = {
        step_index: 10,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-01-01T00:00:11Z',
        content: '<USER_REQUEST>too late to be the title</USER_REQUEST>',
      };
      await writeTranscriptLines(brainDir, SESSION_UUID, [...systemLines, lateUserInput]);
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

test('synchronize falls back to the default title for a completely empty transcript file', async () => {
  await withSyncFixture(
    async (brainDir) => {
      const transcriptDir = path.join(brainDir, SESSION_UUID, '.system_generated', 'logs');
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(path.join(transcriptDir, 'transcript.jsonl'), '', 'utf8');
    },
    async (sync) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.equal(row?.custom_name, 'New Antigravity Chat');
    },
  );
});

// --------------------------------------------------------------------------
// Unit: normalizeSessionName (title bounding helper)
// --------------------------------------------------------------------------

test('normalizeSessionName returns input unchanged when at or below 120 code points', () => {
  const exactly120 = 'a'.repeat(120);
  assert.equal(Array.from(exactly120).length, 120);
  assert.equal(normalizeSessionName(exactly120, 'fallback'), exactly120);

  const short = 'a short title';
  assert.equal(normalizeSessionName(short, 'fallback'), short);
});

test('normalizeSessionName collapses internal whitespace before bounding', () => {
  assert.equal(normalizeSessionName('  hello\t\nworld  ', 'fallback'), 'hello world');
});

test('normalizeSessionName returns the fallback for empty or whitespace-only input', () => {
  assert.equal(normalizeSessionName('', 'New Antigravity Chat'), 'New Antigravity Chat');
  assert.equal(normalizeSessionName('   \n\t ', 'New Antigravity Chat'), 'New Antigravity Chat');
  assert.equal(normalizeSessionName(undefined, 'New Antigravity Chat'), 'New Antigravity Chat');
});

test('normalizeSessionName truncates long Arabic text on a word boundary with an ellipsis', () => {
  const word = 'مرحبا'; // 5 code points
  const source = Array.from({ length: 25 }, () => word).join(' '); // 150 code points
  assert.ok(Array.from(source).length > 120);

  const result = normalizeSessionName(source, 'fallback');

  assert.ok(result.endsWith('…'), 'expected an ellipsis suffix');
  const kept = result.slice(0, -1).trimEnd();

  // Word boundary: every kept token is a whole word, never split mid-glyph.
  for (const token of kept.split(' ')) {
    assert.equal(token, word);
  }
  assert.ok(Array.from(kept).length <= 117, 'kept portion must respect the 117 code-point window');
});

test('normalizeSessionName counts composed glyphs as single code points (emoji not split)', () => {
  // 60 two-emoji-wide tokens far exceed 120 code points but must still cut on a
  // space boundary, never inside a surrogate pair.
  const token = '🌟a'; // 2 code points
  const source = Array.from({ length: 80 }, () => token).join(' ');
  const result = normalizeSessionName(source, 'fallback');

  assert.ok(result.endsWith('…'));
  const kept = result.slice(0, -1).trimEnd();
  for (const t of kept.split(' ')) {
    assert.equal(t, token, 'expected each kept token to be intact (no split surrogate)');
  }
});
