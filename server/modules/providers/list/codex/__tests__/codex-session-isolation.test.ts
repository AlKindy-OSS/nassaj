/**
 * codex-session-isolation.test.ts — B-152: proves the Codex session SYNCHRONIZER
 * indexes each user's transcripts from the CODEX_HOME the B-136 spawn path
 * actually wrote them to.
 *
 * The bug: CodexSessionSynchronizer hard-coded ~/.codex/sessions (the operator
 * home) with no userId, so an isolated user's sessions — written under
 * ~/.nassaj-users/<userId>/.codex/sessions by the B-136 isolated spawn — were
 * never indexed and thus never displayed. The fix routes the scan through
 * resolveCodexHomes() (which reuses resolveProviderEnv), scanning the operator
 * home plus every user's per-user home (codex is always isolated, ADR-152 A1).
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
// Bootstrap — MUST run before importing any project module: the DB connection
// singleton resolves DATABASE_PATH on first use, and userConfigDir/
// provisionUserDirs read os.homedir() (which honors $HOME on this platform).
// A sandboxed HOME + throwaway DB keep the real ~/.codex and the live app DB
// untouched.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-session-iso-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Now safe to import the modules under test (they pick up the tmp DB + HOME).
const { initializeDatabase, closeConnection, getConnection, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { operatorCodexHome } = await import('@/modules/providers/list/codex/codex-home.js');
const { CodexSessionSynchronizer } = await import(
  '@/modules/providers/list/codex/codex-session-synchronizer.provider.js'
);

await initializeDatabase();

// Seed the users whose per-user trees the scan resolves. Their id is a FK target
// for provisioning's audit row, so a real insert keeps that path clean.
const USER_ISOLATED = 8101;
const USER_SECOND = 8102;
{
  const db = getConnection();
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')",
  );
  insertUser.run(USER_ISOLATED, 'codex-sess-iso');
  insertUser.run(USER_SECOND, 'codex-sess-second');
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Writes a minimal but valid Codex rollout transcript under
 * <codexHome>/sessions/2026/07/09/rollout-<sessionId>.jsonl. The synchronizer
 * extracts payload.id (session id) and payload.cwd (project path) from the first
 * valid line, so one session_meta line is sufficient.
 */
function writeCodexSession(codexHome: string, sessionId: string, projectPath: string): string {
  const dir = path.join(codexHome, 'sessions', '2026', '07', '09');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${sessionId}.jsonl`);
  const line = JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: projectPath } });
  fs.writeFileSync(filePath, `${line}\n`, 'utf8');
  return filePath;
}

describe('Codex session synchronizer — per-user home indexing (B-152)', () => {
  it('indexes an isolated user session from THEIR CODEX_HOME, and still the operator home', async () => {
    const isolatedHome = userConfigDir(USER_ISOLATED, '.codex');
    const isolatedFile = writeCodexSession(isolatedHome, 'iso-sess-A', '/workspace/proj-iso-a');
    writeCodexSession(operatorCodexHome(), 'op-sess-A', '/workspace/proj-op-a');

    const processed = await new CodexSessionSynchronizer().synchronize();
    assert.ok(processed >= 2, 'both the isolated and operator sessions must be processed');

    // The load-bearing assertion: the isolated user's session is now in the DB,
    // and it was indexed from THEIR isolated tree (not ~/.codex).
    const isolatedRow = sessionsDb.getSessionById('iso-sess-A');
    assert.ok(isolatedRow, 'isolated user session must be indexed');
    assert.equal(isolatedRow?.provider, 'codex');
    assert.equal(isolatedRow?.jsonl_path, isolatedFile);
    assert.ok(
      String(isolatedRow?.jsonl_path).startsWith(
        path.join(sandboxHome, '.nassaj-users', String(USER_ISOLATED)),
      ),
      'the indexed transcript path must live under the per-user isolated root',
    );

    // The operator home is still scanned (backward compatibility / owner legacy).
    assert.ok(sessionsDb.getSessionById('op-sess-A'), 'operator session must still be indexed');
  });

  it('scans EVERY member\'s own home — there is no shared mode (ADR-152 A1)', async () => {
    writeCodexSession(userConfigDir(USER_SECOND, '.codex'), 'iso-sess-B', '/workspace/proj-iso-b');
    writeCodexSession(operatorCodexHome(), 'op-sess-B', '/workspace/proj-op-b');

    await new CodexSessionSynchronizer().synchronize();

    assert.ok(sessionsDb.getSessionById('iso-sess-B'), 'a second member\'s own session must be indexed');
    assert.ok(sessionsDb.getSessionById('op-sess-B'), 'the operator ~/.codex session must still be indexed');
  });

  it('single-file sync resolves the name index from the file’s OWN codex home', async () => {
    const isolatedHome = userConfigDir(USER_ISOLATED, '.codex');
    // Seed the isolated tree's session_index.jsonl so the name lookup is proven to
    // read from that tree (not the operator index).
    fs.writeFileSync(
      path.join(isolatedHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'iso-sess-C', thread_name: 'Isolated Thread C' })}\n`,
      'utf8',
    );
    const isolatedFile = writeCodexSession(isolatedHome, 'iso-sess-C', '/workspace/proj-iso-c');

    const indexedId = await new CodexSessionSynchronizer().synchronizeFile(isolatedFile);
    assert.equal(indexedId, 'iso-sess-C');

    const row = sessionsDb.getSessionById('iso-sess-C');
    assert.ok(row, 'single-file sync must index the isolated transcript');
    assert.equal(row?.custom_name, 'Isolated Thread C');
    assert.equal(row?.jsonl_path, isolatedFile);
  });
});
