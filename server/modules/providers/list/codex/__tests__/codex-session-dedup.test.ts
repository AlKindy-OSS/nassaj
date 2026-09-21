/**
 * codex-session-dedup.test.ts — B-CODEX-DEDUP: proves the Codex session
 * SYNCHRONIZER folds CHILD threads (subagent spawns / forks) under their parent
 * conversation instead of registering each rollout as its own sidebar row.
 *
 * The bug: a single Codex conversation whose root turn spawned N coordinator
 * delegate subagents (each writing its OWN rollout .jsonl with a distinct
 * payload.id but the SAME payload.cwd + payload.session_id == root) surfaced as
 * N+1 near-identical rows in the conversations list, because processSessionFile
 * keyed a session purely off payload.id and ignored thread_source /
 * forked_from_id / parent_thread_id. The fix classifies each rollout and skips
 * standalone registration for derivatives, bumping the parent's freshness.
 *
 * Touches only the filesystem + the DB (no codex binary, no network), so it runs
 * against a sandboxed $HOME and a throwaway SQLite file. Runner: node:test.
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Bootstrap — MUST precede any project import (DB + isolation read HOME lazily).
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-dedup-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { setProviderSharingConfig, _resetProviderSharingCache } = await import(
  '@/services/provider-sharing.js'
);
const { operatorCodexHome } = await import('@/modules/providers/list/codex/codex-home.js');
const { CodexSessionSynchronizer } = await import(
  '@/modules/providers/list/codex/codex-session-synchronizer.provider.js'
);

await initializeDatabase();

// Codex shared → the scan reads only the operator ~/.codex, keeping the fixture
// tree a single directory.
_resetProviderSharingCache();
setProviderSharingConfig({
  claude: 'isolated',
  gemini: 'isolated',
  codex: 'shared',
  agy: 'shared',
  cursor: 'shared',
});

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const DAY_DIR = ['sessions', '2026', '07', '16'];

type MetaOverrides = {
  threadSource?: string;
  /** When true, writes payload.source as an object keyed by "subagent" (283b5586 marker). */
  sourceSubagent?: boolean;
  forkedFromId?: string;
  parentThreadId?: string;
  rootSessionId?: string;
};

/**
 * Writes a minimal Codex rollout. `overrides` model the session_meta fields that
 * distinguish a root conversation from a subagent/fork thread. `mtimeMs` lets a
 * case order files in time so the parent-freshness bump is observable.
 */
function writeRollout(
  sessionId: string,
  projectPath: string,
  overrides: MetaOverrides = {},
  mtimeMs?: number,
): string {
  const dir = path.join(operatorCodexHome(), ...DAY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${sessionId}.jsonl`);
  const payload: Record<string, unknown> = {
    id: sessionId,
    cwd: projectPath,
    session_id: overrides.rootSessionId ?? sessionId,
  };
  if (overrides.threadSource !== undefined) payload.thread_source = overrides.threadSource;
  if (overrides.sourceSubagent) {
    payload.source = { subagent: { thread_spawn: { parent_thread_id: overrides.parentThreadId ?? overrides.rootSessionId, depth: 1 } } };
  }
  if (overrides.forkedFromId !== undefined) payload.forked_from_id = overrides.forkedFromId;
  if (overrides.parentThreadId !== undefined) payload.parent_thread_id = overrides.parentThreadId;
  fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session_meta', payload })}\n`, 'utf8');
  if (typeof mtimeMs === 'number') {
    fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  }
  return filePath;
}

describe('Codex session synchronizer — fold subagent/fork threads (B-CODEX-DEDUP)', () => {
  it('a real new conversation (thread_source user, no fork) IS registered as a row', async () => {
    const PROJECT = '/tmp/dedup-proj-a';
    writeRollout('root-A', PROJECT, { threadSource: 'user' });

    await new CodexSessionSynchronizer().synchronize();

    const row = sessionsDb.getSessionById('root-A');
    assert.ok(row, 'a genuine root conversation must be indexed');
    assert.equal(row?.provider, 'codex');
  });

  it('a subagent thread (thread_source subagent + parent/fork = root) is NOT registered, and bumps the parent', async () => {
    const PROJECT = '/tmp/dedup-proj-b';
    const rootMtime = Date.parse('2026-07-16T00:00:00.000Z');
    writeRollout('root-B', PROJECT, { threadSource: 'user' }, rootMtime);
    await new CodexSessionSynchronizer().synchronize();

    const before = sessionsDb.getSessionById('root-B');
    assert.ok(before, 'parent must exist before the subagent spawn is scanned');

    // Subagent rollout: distinct id, but session_id/forked_from_id/parent = root,
    // and a strictly-later mtime so the freshness bump is observable. Driven
    // through the watcher's single-file path (the real hot path fired per new
    // rollout) so the assertion isolates the fold+bump from a full re-scan, which
    // would independently re-stamp the root from its OWN unchanged mtime.
    const childMtime = Date.parse('2026-07-16T02:00:00.000Z');
    const childPath = writeRollout(
      'child-B',
      PROJECT,
      { threadSource: 'subagent', forkedFromId: 'root-B', parentThreadId: 'root-B', rootSessionId: 'root-B' },
      childMtime,
    );
    await new CodexSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(
      sessionsDb.getSessionById('child-B'),
      null,
      'a subagent thread must NEVER become its own session row',
    );

    const after = sessionsDb.getSessionById('root-B');
    assert.ok(after, 'parent row must still exist');
    assert.equal(
      new Date(after!.updated_at).getTime(),
      new Date(childMtime).getTime(),
      'the parent updated_at must be bumped forward to the folded child’s timestamp',
    );
  });

  it('a MANUAL user fork (thread_source user + forked_from_id) surfaces as its OWN row, never folded', async () => {
    const PROJECT = '/tmp/dedup-proj-c';
    writeRollout('root-C', PROJECT, { threadSource: 'user' });
    await new CodexSessionSynchronizer().synchronize();
    assert.ok(sessionsDb.getSessionById('root-C'), 'root of a fork chain must exist');

    // A user-chosen branch: thread_source stays 'user'. thread_source is
    // authoritative (qa-critic 2026-07-16), so the back-reference does NOT fold
    // it — a manual fork is a real, resumable conversation and MUST get a row.
    const forkPath = writeRollout(
      'fork-C',
      PROJECT,
      { threadSource: 'user', forkedFromId: 'root-C', rootSessionId: 'root-C' },
    );
    const indexed = await new CodexSessionSynchronizer().synchronizeFile(forkPath);

    assert.equal(indexed, 'fork-C', 'a manual user fork must be indexed under its own id');
    assert.ok(
      sessionsDb.getSessionById('fork-C'),
      'a user fork must surface as its own root row (never silently hidden)',
    );
  });

  it('LEGACY fallback: an old rollout with NO thread_source but a back-reference is folded (no row)', async () => {
    const PROJECT = '/tmp/dedup-proj-legacy';
    writeRollout('root-L', PROJECT, { threadSource: 'user' });
    await new CodexSessionSynchronizer().synchronize();
    assert.ok(sessionsDb.getSessionById('root-L'), 'legacy chain root must exist');

    // No thread_source at all (pre-field format): only THEN do the back-references
    // decide, and they mark this as a child → folded.
    const childPath = writeRollout(
      'legacy-child-L',
      PROJECT,
      { forkedFromId: 'root-L', parentThreadId: 'root-L', rootSessionId: 'root-L' },
    );
    const indexed = await new CodexSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(indexed, null, 'a legacy back-referenced child must be folded');
    assert.equal(
      sessionsDb.getSessionById('legacy-child-L'),
      null,
      'no standalone row for a legacy child inferred purely from back-references',
    );
  });

  it('METADATA signal: a source-object subagent (no thread_source) is folded (283b5586)', async () => {
    const PROJECT = '/tmp/dedup-proj-src';
    writeRollout('root-S', PROJECT, { threadSource: 'user' });
    await new CodexSessionSynchronizer().synchronize();
    assert.ok(sessionsDb.getSessionById('root-S'), 'parent root must exist');

    // A collaboration spawn that carries the object `source: { subagent: {...} }`
    // marker but NO thread_source field: the metadata signal alone must fold it —
    // it must NOT fall through to (or depend on) the legacy back-reference path.
    const childPath = writeRollout(
      'child-S',
      PROJECT,
      { sourceSubagent: true, parentThreadId: 'root-S', rootSessionId: 'root-S' },
    );
    const indexed = await new CodexSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(indexed, null, 'a source-object subagent must be folded via metadata alone');
    assert.equal(
      sessionsDb.getSessionById('child-S'),
      null,
      'no standalone row for a source-object subagent thread',
    );
  });

  it('METADATA over back-ref: thread_source user WITH source subagent is still folded', async () => {
    const PROJECT = '/tmp/dedup-proj-srcuser';
    writeRollout('root-SU', PROJECT, { threadSource: 'user' });
    await new CodexSessionSynchronizer().synchronize();
    assert.ok(sessionsDb.getSessionById('root-SU'), 'parent root must exist');

    // Defensive: a source-object subagent marker is a definitive subagent signal
    // and folds even if thread_source happened to read 'user' — the two metadata
    // fields are OR-ed, matching upstream 283b5586.
    const childPath = writeRollout(
      'child-SU',
      PROJECT,
      { threadSource: 'user', sourceSubagent: true, parentThreadId: 'root-SU', rootSessionId: 'root-SU' },
    );
    const indexed = await new CodexSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(indexed, null, 'source-object subagent folds regardless of thread_source string');
    assert.equal(sessionsDb.getSessionById('child-SU'), null, 'no row for the source-object subagent');
  });

  it('single-file sync (watcher path) folds a subagent thread and returns null', async () => {
    const PROJECT = '/tmp/dedup-proj-d';
    writeRollout('root-D', PROJECT, { threadSource: 'user' });
    await new CodexSessionSynchronizer().synchronize();
    assert.ok(sessionsDb.getSessionById('root-D'));

    const childPath = writeRollout(
      'child-D',
      PROJECT,
      { threadSource: 'subagent', parentThreadId: 'root-D', rootSessionId: 'root-D' },
    );
    const indexed = await new CodexSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(indexed, null, 'watcher single-file sync must return null for a subagent thread');
    assert.equal(sessionsDb.getSessionById('child-D'), null, 'no standalone row for the subagent');
  });

  it('a folded child whose parent is not yet indexed is a safe no-op (no orphan row, no create)', async () => {
    const PROJECT = '/tmp/dedup-proj-e';
    // No root written for this id: the bump target is absent → must not create it.
    const childPath = writeRollout(
      'child-E',
      PROJECT,
      { threadSource: 'subagent', parentThreadId: 'missing-root-E', rootSessionId: 'missing-root-E' },
    );
    const indexed = await new CodexSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(indexed, null, 'orphan subagent must not register itself');
    assert.equal(sessionsDb.getSessionById('child-E'), null, 'the child must not become a row');
    assert.equal(
      sessionsDb.getSessionById('missing-root-E'),
      null,
      'the absent parent must NOT be conjured into existence by the bump',
    );
  });

  it('child arrives at the watcher BEFORE its parent, THEN the parent arrives and IS registered', async () => {
    const PROJECT = '/tmp/dedup-proj-f';

    // 1) Out-of-order: the subagent rollout is written+seen first. Its parent is
    //    not indexed yet → folded, no row, and the parent is NOT conjured.
    const childPath = writeRollout(
      'child-F',
      PROJECT,
      { threadSource: 'subagent', parentThreadId: 'root-F', rootSessionId: 'root-F' },
    );
    const childIndexed = await new CodexSessionSynchronizer().synchronizeFile(childPath);
    assert.equal(childIndexed, null, 'early subagent must be folded, not indexed');
    assert.equal(sessionsDb.getSessionById('child-F'), null, 'no row for the early subagent');
    assert.equal(
      sessionsDb.getSessionById('root-F'),
      null,
      'the not-yet-seen parent must not exist merely because its child was scanned',
    );

    // 2) The parent conversation rollout arrives afterwards → it is a real root
    //    (thread_source user, no fork) → registered as its own row.
    const parentPath = writeRollout('root-F', PROJECT, { threadSource: 'user' });
    const parentIndexed = await new CodexSessionSynchronizer().synchronizeFile(parentPath);
    assert.equal(parentIndexed, 'root-F', 'the parent must be indexed under its own id');
    assert.ok(
      sessionsDb.getSessionById('root-F'),
      'the parent conversation must surface as a row once its own rollout is seen',
    );
    // The child still never gets a row even after the parent exists.
    assert.equal(
      sessionsDb.getSessionById('child-F'),
      null,
      'the earlier subagent stays folded — a late parent does not resurrect it as a row',
    );
  });
});
