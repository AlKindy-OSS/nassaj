/**
 * session-fork.service.test.ts — T-1090 (the `/btw` fork orchestration).
 *
 * The transcript rewrite itself is covered in claude-transcript-fork.test.ts.
 * What is pinned HERE is everything around the file, where a fork fails
 * silently rather than loudly:
 *
 *   - the participant row. A session with no participant and no message author
 *     fails the "native session" predicate and never appears in ANY listing —
 *     the fork would land on disk and look, to the user, like nothing happened;
 *   - immediate indexing, so the branch is openable at once instead of after the
 *     watcher's next poll;
 *   - the source-path fallback for a session row the run path created before the
 *     synchronizer stamped its jsonl_path;
 *   - error mapping: every failure reaches the client as a stable code, never a
 *     raw filesystem message;
 *   - best-effort steps (indexing, broadcast) never turn a SUCCESSFUL fork into
 *     a failure.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, beforeEach, after, mock } from 'node:test';

// The real error class is captured BEFORE the module is mocked, so the service's
// `instanceof` checks still see the class it was compiled against.
const { TranscriptForkError } = await import(
  '../../list/claude/claude-transcript-fork.js'
);

const OWNER_USER_ID = 7;
const PROJECT_PATH = '/workspace/demo';
const SESSION_ID = 'sess-claude-1';
const CLAUDE_PROJECTS_ROOT = path.join(os.tmpdir(), `nassaj-session-fork-${process.pid}`);
const PROJECT_DIR = path.join(CLAUDE_PROJECTS_ROOT, '-workspace-demo');
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);

type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
};

const sessionRows = new Map<string, SessionRow>();

const forkCalls: Array<Record<string, unknown>> = [];
const spawnCalls: Array<{ sessionId: string; userId: number; context?: unknown }> = [];
const indexedFiles: string[] = [];
const notified: Array<{ provider: string; sessionId: string | null }> = [];
const deletedSessions: string[] = [];
let authorized = true;

const forkState: {
  impl: (options: Record<string, unknown>) => Promise<unknown>;
} = {
  impl: async (options) => ({
    forkedSessionId: 'forked-1',
    filePath: path.join(path.dirname(String(options.sourceFilePath)), 'forked-1.jsonl'),
    entryCount: 12,
    cwd: PROJECT_PATH,
  }),
};

const indexState = { impl: async (_provider: string, filePath: string) => {
  indexedFiles.push(filePath);
} };

mock.module('@/modules/database/index.js', {
  namedExports: {
    // Link-only: execution-permissions/actor.ts imports these since ecfdc7db5; forks never call them.
    apiKeysDb: {}, deviceAccountSessionsDb: {}, userDb: {},
    sessionsDb: {
      getSessionById: (sessionId: string) => sessionRows.get(sessionId) ?? null,
      deleteSessionById: (sessionId: string) => { deletedSessions.push(sessionId); },
    },
    participantsDb: {
      isParticipant: (sessionId: string, userId: number) =>
        authorized && sessionRows.has(sessionId) && userId === OWNER_USER_ID,
      recordSpawn: (sessionId: string, userId: number, context?: unknown) => {
        spawnCalls.push({ sessionId, userId, context });
      },
    },
  },
});

mock.module('@/modules/providers/list/claude/claude-transcript-fork.js', {
  namedExports: {
    TranscriptForkError,
    forkClaudeTranscript: async (options: Record<string, unknown>) => {
      forkCalls.push(options);
      return forkState.impl(options);
    },
  },
});

mock.module('@/modules/providers/services/session-synchronizer.service.js', {
  namedExports: {
    sessionSynchronizerService: {
      synchronizeProviderFile: (provider: string, filePath: string) =>
        indexState.impl(provider, filePath),
    },
  },
});

mock.module('@/modules/providers/services/sessions-watcher.service.js', {
  namedExports: {
    notifySessionMetadataChanged: (provider: string, sessionId: string | null) => {
      notified.push({ provider, sessionId });
    },
  },
});

const { forkSessionAtMessage, forkSessionFromSideQuery, buildForkTitle, SessionForkError } = await import(
  '../session-fork.service.js'
);

function resetState(): void {
  rmSync(CLAUDE_PROJECTS_ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(JSONL_PATH, '{"type":"user"}\n', { mode: 0o600 });
  sessionRows.clear();
  sessionRows.set(SESSION_ID, {
    session_id: SESSION_ID,
    provider: 'claude',
    project_path: PROJECT_PATH,
    jsonl_path: JSONL_PATH,
  });
  forkCalls.length = 0;
  spawnCalls.length = 0;
  indexedFiles.length = 0;
  notified.length = 0;
  deletedSessions.length = 0;
  authorized = true;
  forkState.impl = async (options) => ({
    forkedSessionId: 'forked-1',
    filePath: path.join(path.dirname(String(options.sourceFilePath)), 'forked-1.jsonl'),
    entryCount: 12,
    cwd: PROJECT_PATH,
  });
  indexState.impl = async (_provider: string, filePath: string) => {
    indexedFiles.push(filePath);
  };
}

const PARAMS = {
  sessionId: SESSION_ID,
  question: 'why is the build slow?',
  answer: 'the docs symlink is re-bundled every time',
  userId: OWNER_USER_ID,
  claudeProjectsRoot: CLAUDE_PROJECTS_ROOT,
};

after(() => rmSync(CLAUDE_PROJECTS_ROOT, { recursive: true, force: true }));

describe('forkSessionFromSideQuery', () => {
  beforeEach(resetState);

  test('branches the transcript, indexes it, and records the FORKER as participant', async () => {
    const result = await forkSessionFromSideQuery(PARAMS);

    assert.equal(result.sessionId, 'forked-1');
    assert.equal(result.title, 'btw: why is the build slow?');
    assert.equal(result.projectPath, PROJECT_PATH);

    // The branch is cut from the session's own transcript, carrying the exchange.
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0].sourceFilePath, JSONL_PATH);
    assert.equal(forkCalls[0].sourceSessionId, SESSION_ID);
    assert.deepEqual(forkCalls[0].extraMessages, [
      { role: 'user', content: 'why is the build slow?' },
      { role: 'assistant', content: 'the docs symlink is re-bundled every time' },
    ]);
    assert.equal(forkCalls[0].title, 'btw: why is the build slow?');

    // Indexed at once — not left to the watcher's next poll.
    assert.deepEqual(indexedFiles, [
      path.join(PROJECT_DIR, 'forked-1.jsonl'),
    ]);

    // Without this row the branch fails the native-session predicate and is
    // invisible in every listing.
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].sessionId, 'forked-1');
    assert.equal(spawnCalls[0].userId, OWNER_USER_ID);
    assert.deepEqual(spawnCalls[0].context, { provider: 'claude', projectPath: PROJECT_PATH });

    assert.deepEqual(notified, [{ provider: 'claude', sessionId: 'forked-1' }]);
  });

  test('mode fresh asks for a history-less branch; mode full (the default) does not', async () => {
    const fresh = await forkSessionFromSideQuery({ ...PARAMS, mode: 'fresh' });
    assert.equal(forkCalls[0].includeHistory, false, 'fresh ⇒ carry no history');
    assert.equal(fresh.mode, 'fresh', 'the caller is told which shape it got');
    // The exchange is identical in both modes — only the inherited context differs.
    assert.deepEqual(forkCalls[0].extraMessages, [
      { role: 'user', content: PARAMS.question },
      { role: 'assistant', content: PARAMS.answer },
    ]);
    assert.equal(forkCalls[0].title, 'btw: why is the build slow?');

    forkCalls.length = 0;
    const full = await forkSessionFromSideQuery(PARAMS);
    assert.equal(forkCalls[0].includeHistory, true, 'default ⇒ the CLI-faithful full branch');
    assert.equal(full.mode, 'full');
  });

  test('derives the transcript path when the session row has no jsonl_path yet', async () => {
    sessionRows.set(SESSION_ID, {
      session_id: SESSION_ID,
      provider: 'claude',
      project_path: PROJECT_PATH,
      jsonl_path: null,
    });

    await forkSessionFromSideQuery(PARAMS);

    assert.equal(
      forkCalls[0].sourceFilePath,
      JSONL_PATH,
      'falls back to Claude\'s encoded project folder',
    );
  });

  test('refuses an unknown session and a non-claude session before touching disk', async () => {
    await assert.rejects(
      () => forkSessionFromSideQuery({ ...PARAMS, sessionId: 'nope' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionForkError);
        assert.equal(error.code, 'session_not_found');
        return true;
      },
    );

    sessionRows.set('sess-codex', {
      session_id: 'sess-codex',
      provider: 'codex',
      project_path: PROJECT_PATH,
      jsonl_path: null,
    });
    await assert.rejects(
      () => forkSessionFromSideQuery({ ...PARAMS, sessionId: 'sess-codex' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionForkError);
        assert.equal(error.code, 'unsupported_provider');
        return true;
      },
    );

    assert.equal(forkCalls.length, 0, 'no transcript was read for a refused session');
    assert.equal(spawnCalls.length, 0);
  });

  test('refuses a session with neither a transcript path nor a project path', async () => {
    sessionRows.set(SESSION_ID, {
      session_id: SESSION_ID,
      provider: 'claude',
      project_path: null,
      jsonl_path: null,
    });

    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => {
        assert.ok(error instanceof SessionForkError);
        assert.equal(error.code, 'transcript_not_found');
        return true;
      },
    );
  });

  test('maps transcript errors to stable codes and never leaks a raw fs message', async () => {
    forkState.impl = async () => {
      throw new TranscriptForkError('source_unreadable', 'EACCES: permission denied, open ...');
    };
    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => {
        assert.ok(error instanceof SessionForkError);
        assert.equal(error.code, 'transcript_not_found');
        assert.equal(
          /EACCES/.test((error as Error).message),
          false,
          'the raw filesystem message must not reach the client',
        );
        return true;
      },
    );

    forkState.impl = async () => {
      throw new TranscriptForkError('source_too_large', 'This conversation is too large to fork.');
    };
    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'source_too_large');
        return true;
      },
    );

    forkState.impl = async () => {
      throw new Error('disk on fire');
    };
    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'fork_failed');
        assert.equal(/disk on fire/.test((error as Error).message), false);
        return true;
      },
    );

    assert.equal(spawnCalls.length, 0, 'a failed fork records no participant');
  });

  test('a failing index removes the landed file and partial database row', async () => {
    writeFileSync(path.join(PROJECT_DIR, 'forked-1.jsonl'), 'orphan');
    indexState.impl = async () => {
      throw new Error('db locked');
    };

    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => error instanceof SessionForkError && error.code === 'fork_failed',
    );
    assert.equal(spawnCalls.length, 0);
    assert.deepEqual(deletedSessions, ['forked-1']);
  });

  test('an anonymous or non-participant requester is rejected before disk access', async () => {
    await assert.rejects(
      () => forkSessionFromSideQuery({ ...PARAMS, userId: null }),
      (error: unknown) => error instanceof SessionForkError && error.code === 'session_not_found',
    );
    authorized = false;
    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => error instanceof SessionForkError && error.code === 'session_not_found',
    );
    assert.equal(forkCalls.length, 0);
  });

  test('rejects a DB transcript symlink that escapes the canonical project directory', async () => {
    const outside = path.join(CLAUDE_PROJECTS_ROOT, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    rmSync(JSONL_PATH);
    symlinkSync(outside, JSONL_PATH);

    await assert.rejects(
      () => forkSessionFromSideQuery(PARAMS),
      (error: unknown) => error instanceof SessionForkError && error.code === 'transcript_not_found',
    );
    assert.equal(forkCalls.length, 0);
  });
});

describe('forkSessionAtMessage', () => {
  beforeEach(resetState);

  test('copies exactly through a canonical assistant UUID without appending an exchange', async () => {
    const result = await forkSessionAtMessage({
      sessionId: SESSION_ID,
      upToMessageId: 'assistant-uuid-7',
      userId: OWNER_USER_ID,
      claudeProjectsRoot: CLAUDE_PROJECTS_ROOT,
    });

    assert.equal(result.sessionId, 'forked-1');
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0].upToMessageId, 'assistant-uuid-7');
    assert.equal(forkCalls[0].includeHistory, true);
    assert.deepEqual(forkCalls[0].extraMessages, []);
    assert.equal(forkCalls[0].requireAssistantCutoff, true);
    assert.equal(spawnCalls.length, 1, 'the branch is attributed before success');
    assert.deepEqual(indexedFiles, [path.join(path.dirname(JSONL_PATH), 'forked-1.jsonl')]);
  });

  test('fails closed when the indexed transcript path is absent instead of constructing one', async () => {
    sessionRows.set(SESSION_ID, {
      session_id: SESSION_ID,
      provider: 'claude',
      project_path: PROJECT_PATH,
      jsonl_path: null,
    });
    await assert.rejects(
      () => forkSessionAtMessage({ sessionId: SESSION_ID, upToMessageId: 'a-1', userId: OWNER_USER_ID, claudeProjectsRoot: CLAUDE_PROJECTS_ROOT }),
      (error: unknown) => error instanceof SessionForkError && error.code === 'transcript_not_found',
    );
    assert.equal(forkCalls.length, 0);
  });

  test('does not report success when immediate indexing fails', async () => {
    indexState.impl = async () => { throw new Error('index offline'); };
    await assert.rejects(
      () => forkSessionAtMessage({ sessionId: SESSION_ID, upToMessageId: 'a-1', userId: OWNER_USER_ID, claudeProjectsRoot: CLAUDE_PROJECTS_ROOT }),
      (error: unknown) => error instanceof SessionForkError && error.code === 'fork_failed',
    );
    assert.equal(spawnCalls.length, 0, 'participant registration does not run after failed indexing');
  });
});

describe('buildForkTitle', () => {
  test('prefixes with btw: and collapses whitespace', () => {
    assert.equal(buildForkTitle('  why   is\nit slow? '), 'btw: why is it slow?');
  });

  test('clips at the upstream 80-character budget', () => {
    const title = buildForkTitle('x'.repeat(200));
    assert.equal(title.length, 80);
    assert.ok(title.startsWith('btw: '));
    assert.ok(title.endsWith('…'));
  });
});
