/**
 * kimi-agent-session-synchronizer.test.ts — KM-2 (ADR-062 §4.2, W4-C): proves the
 * Kimi native-agent session synchronizer
 *   (a) indexes a conversation from its <id>/agents/<agentId>/wire.jsonl tree,
 *   (b) folds subagent threads under ONE conversation row (B-172 dedup) —
 *       structurally, keyed on the `<id>` dir, both on full-scan and watcher paths,
 *   (c) keeps per-user isolation: an isolated user's KIMI_CODE_HOME sessions are
 *       indexed (no B-152 gap) and a file resolves to its OWN owning home,
 *   (d) path/primary parsing helpers are correct in isolation.
 *
 * Touches only the filesystem + a sandboxed SQLite DB (no kimi binary, no
 * network). HOME + DATABASE_PATH are sandboxed BEFORE importing any project module
 * so the DB singleton and userConfigDir never touch real state. Runner: node:test.
 *   npx tsx --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- Bootstrap: MUST precede any project import (DB + isolation read HOME lazily).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-kimi-sync-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection, sessionsDb, userDb } = await import(
  '@/modules/database/index.js'
);
const { setProviderSharingConfig, _resetProviderSharingCache } = await import(
  '@/services/provider-sharing.js'
);
const { operatorKimiHome, resolveKimiHomeForUser, kimiHomeForSessionFile } = await import(
  './kimi-agent-home.js'
);
const { KimiAgentSessionSynchronizer, parseKimiAgentSessionPath, resolvePrimaryAgentId } =
  await import('./kimi-agent-session-synchronizer.provider.js');

await initializeDatabase();

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Writes a wire.jsonl under <home>/sessions/<id>/agents/<agentId>/. */
function writeWire(
  home: string,
  sessionId: string,
  agentId: string,
  meta: { cwd: string; title?: string },
  mtimeMs?: number,
): string {
  const dir = path.join(home, 'sessions', sessionId, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'wire.jsonl');
  const first: Record<string, unknown> = { type: 'session', cwd: meta.cwd };
  if (meta.title !== undefined) first.title = meta.title;
  fs.writeFileSync(filePath, `${JSON.stringify(first)}\n`, 'utf8');
  if (typeof mtimeMs === 'number') {
    fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  }
  return filePath;
}

describe('parse/primary helpers (pure)', () => {
  it('parses <id>/agents/<agentId>/wire.jsonl and rejects non-transcripts', () => {
    const p = parseKimiAgentSessionPath(
      path.join('/root', '.kimi', 'sessions', 'conv-1', 'agents', 'main', 'wire.jsonl'),
    );
    assert.deepEqual(p, {
      home: path.join('/root', '.kimi'),
      sessionId: 'conv-1',
      agentId: 'main',
    });
    assert.equal(parseKimiAgentSessionPath('/root/.kimi/sessions/conv-1/agents/main/other.jsonl'), null);
    assert.equal(parseKimiAgentSessionPath('/root/.kimi/sessions/conv-1/wire.jsonl'), null);
    assert.equal(parseKimiAgentSessionPath('/nowhere/wire.jsonl'), null);
  });

  it('primary = MAIN_AGENT_ID when present, else lexicographically smallest', () => {
    assert.equal(resolvePrimaryAgentId(['sub-b', 'main', 'sub-a']), 'main');
    assert.equal(resolvePrimaryAgentId(['zzz', 'aaa', 'mmm']), 'aaa');
    assert.equal(resolvePrimaryAgentId(['solo']), 'solo');
    assert.equal(resolvePrimaryAgentId([]), null);
  });
});

describe('Kimi agent synchronizer — indexing + subagent folding (B-172)', () => {
  // kimi 'shared' → resolveKimiHomes collapses to the operator ~/.kimi, so the
  // fixtures live in a single tree.
  _resetProviderSharingCache();
  setProviderSharingConfig({ kimi: 'shared' });
  const HOME = operatorKimiHome();

  it('indexes a single-agent conversation as ONE row (keyed on <id>)', async () => {
    writeWire(HOME, 'conv-single', 'main', { cwd: '/tmp/proj-single', title: 'Single Agent Chat' });

    const processed = await new KimiAgentSessionSynchronizer().synchronize();
    assert.ok(processed >= 1, 'at least the single conversation is indexed');

    const row = sessionsDb.getSessionById('conv-single');
    assert.ok(row, 'the conversation must surface as a row');
    assert.equal(row?.provider, 'kimi');
    assert.equal(row?.custom_name, 'Single Agent Chat');
  });

  it('a conversation with a MAIN agent + N subagents surfaces exactly ONE row', async () => {
    writeWire(HOME, 'conv-multi', 'main', { cwd: '/tmp/proj-multi', title: 'Root Turn' });
    writeWire(HOME, 'conv-multi', 'sub-1', { cwd: '/tmp/proj-multi', title: 'Delegate 1' });
    writeWire(HOME, 'conv-multi', 'sub-2', { cwd: '/tmp/proj-multi', title: 'Delegate 2' });

    await new KimiAgentSessionSynchronizer().synchronize();

    // Exactly one row for the conversation id — subagents fold, they do NOT
    // become their own rows (the B-172 sidebar-duplication bug).
    const all = sessionsDb.getAllSessions().filter((s) => s.project_path?.includes('proj-multi'));
    assert.equal(all.length, 1, 'a multi-agent conversation must produce exactly one session row');
    assert.equal(all[0]?.session_id, 'conv-multi');
    assert.equal(all[0]?.custom_name, 'Root Turn', 'the MAIN agent names the row, not a subagent');
  });

  it('value-agnostic dedup: no "main" folder → smallest agentId is primary, still ONE row', async () => {
    writeWire(HOME, 'conv-nomain', 'zzz', { cwd: '/tmp/proj-nomain', title: 'Z agent' });
    writeWire(HOME, 'conv-nomain', 'aaa', { cwd: '/tmp/proj-nomain', title: 'A agent' });

    await new KimiAgentSessionSynchronizer().synchronize();

    const all = sessionsDb.getAllSessions().filter((s) => s.project_path?.includes('proj-nomain'));
    assert.equal(all.length, 1, 'still exactly one row even with no MAIN_AGENT_ID folder');
    assert.equal(all[0]?.custom_name, 'A agent', 'the lexicographically-smallest agent is primary');
  });

  it('watcher single-file path folds a subagent and bumps the parent (never a new row)', async () => {
    const rootMtime = Date.parse('2026-07-18T00:00:00.000Z');
    writeWire(HOME, 'conv-watch', 'main', { cwd: '/tmp/proj-watch', title: 'Watched' }, rootMtime);
    await new KimiAgentSessionSynchronizer().synchronize();
    const before = sessionsDb.getSessionById('conv-watch');
    assert.ok(before, 'parent must exist before the subagent spawn is watched');

    const childMtime = Date.parse('2026-07-18T02:00:00.000Z');
    const childPath = writeWire(
      HOME,
      'conv-watch',
      'sub-late',
      { cwd: '/tmp/proj-watch', title: 'Late Delegate' },
      childMtime,
    );
    const indexed = await new KimiAgentSessionSynchronizer().synchronizeFile(childPath);

    assert.equal(indexed, null, 'a subagent thread must NEVER become its own session row');
    assert.equal(sessionsDb.getSessionById('sub-late'), null, 'no standalone row for the subagent id');
    const afterRow = sessionsDb.getSessionById('conv-watch');
    assert.equal(
      new Date(afterRow!.updated_at).getTime(),
      new Date(childMtime).getTime(),
      'the parent updated_at is bumped forward to the folded child timestamp',
    );
  });

  it('an orphan subagent whose parent row is absent is a safe no-op (no row conjured)', async () => {
    // Only a subagent folder for a conversation whose primary was never indexed.
    const childPath = writeWire(HOME, 'conv-orphan', 'sub-only', { cwd: '/tmp/proj-orphan' });
    // Force a sibling "main" folder to exist so this file classifies as a subagent,
    // but never index the main (simulate an out-of-order/incremental miss).
    fs.mkdirSync(path.join(HOME, 'sessions', 'conv-orphan', 'agents', 'main'), { recursive: true });

    const indexed = await new KimiAgentSessionSynchronizer().synchronizeFile(childPath);
    assert.equal(indexed, null, 'the orphan subagent must not register itself');
    assert.equal(sessionsDb.getSessionById('conv-orphan'), null, 'the absent parent is not conjured');
  });

  it('a transcript with no resolvable projectPath is skipped (no malformed row)', async () => {
    const dir = path.join(HOME, 'sessions', 'conv-nopath', 'agents', 'main');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session', foo: 'bar' })}\n`, 'utf8');

    const indexed = await new KimiAgentSessionSynchronizer().synchronizeFile(filePath);
    assert.equal(indexed, null, 'no projectPath → skip');
    assert.equal(sessionsDb.getSessionById('conv-nopath'), null, 'no row for a metadata-less transcript');
  });
});

describe('Kimi agent synchronizer — per-user isolation (no B-152 gap)', () => {
  it('indexes BOTH isolated users’ trees and resolves each file to its OWN home', async () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ kimi: 'isolated' });

    const userA = userDb.createUser(`kimi_a_${Date.now()}`, 'hash', 'user').id;
    const userB = userDb.createUser(`kimi_b_${Date.now()}`, 'hash', 'user').id;
    const homeA = resolveKimiHomeForUser(userA);
    const homeB = resolveKimiHomeForUser(userB);

    assert.notEqual(homeA, homeB, 'each isolated user gets a distinct KIMI_CODE_HOME');
    assert.ok(homeA.includes(String(userA)), 'user A home lives under their isolated tree');

    const fileA = writeWire(homeA, 'conv-user-a', 'main', { cwd: '/tmp/proj-a', title: 'A conv' });
    writeWire(homeB, 'conv-user-b', 'main', { cwd: '/tmp/proj-b', title: 'B conv' });

    await new KimiAgentSessionSynchronizer().synchronize();

    assert.ok(sessionsDb.getSessionById('conv-user-a'), 'user A isolated session is indexed');
    assert.ok(sessionsDb.getSessionById('conv-user-b'), 'user B isolated session is indexed');

    // A file under A's tree resolves to A's home, never B's (owning-home derivation).
    assert.equal(kimiHomeForSessionFile(fileA), homeA);
    assert.notEqual(kimiHomeForSessionFile(fileA), homeB);
  });
});
