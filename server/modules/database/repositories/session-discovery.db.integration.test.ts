import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  credentialGrantsDb,
  getConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
} from '@/modules/database/index.js';

/**
 * ADR-201 A2 — repository-level no-rebind rules, in a sandbox with members /1
 * and /10 (prefix trap) plus the operator home.
 */

const PROJECT_A = '/workspace/adr201-project-a';
const PROJECT_B = '/workspace/adr201-project-b';
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';

type Sandbox = { home: string; file: (tree: string, name: string) => string };

async function withSandbox(run: (box: Sandbox) => Promise<void> | void): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const home = mkdtempSync(path.join(os.tmpdir(), 'adr201-a2-'));
  const originalHomedir = os.homedir;
  (os as { homedir: () => string }).homedir = () => home;
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await initializeDatabase();
  const insertUser = getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
  for (const id of [1, 10, 2]) insertUser.run(id, `member-${id}`, 'x');
  const file = (tree: string, name: string): string => {
    const base = tree === 'operator' ? home : path.join(home, '.nassaj-users', tree);
    const dir = path.join(base, '.claude', 'projects', '-workspace');
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    writeFileSync(target, '{}\n');
    return target;
  };
  try {
    await run({ home, file });
  } finally {
    (os as { homedir: () => string }).homedir = originalHomedir;
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
}

function row(sessionId = SID) {
  return sessionsDb.getSessionById(sessionId);
}

function captureWarnings(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { calls.push(args); };
  return { calls, restore: () => { console.warn = original; } };
}

test('insertDiscoveredSession creates a new id and never touches an existing row', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('1', `${SID}.jsonl`);
    assert.equal(sessionsDb.insertDiscoveredSession({
      sessionId: SID, provider: 'claude', projectPath: PROJECT_A, customName: 'first', jsonlPath: recorded,
    }), 'inserted');
    assert.equal(sessionsDb.insertDiscoveredSession({
      sessionId: SID, provider: 'codex', projectPath: PROJECT_B, customName: 'second', jsonlPath: null,
    }), 'exists');
    assert.equal(row()?.provider, 'claude');
    assert.equal(row()?.project_path, PROJECT_A);
    assert.equal(row()?.jsonl_path, recorded);
    assert.equal(row()?.custom_name, 'first');
  });
});

test('refreshDiscoveredSession never creates a row', async () => {
  await withSandbox(() => {
    assert.equal(sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A }), 'missing');
    assert.equal(row(), null);
  });
});

test('provider relabel is refused and writes nothing', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('1', `${SID}.jsonl`);
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, customName: 'mine', jsonlPath: recorded });
    const warnings = captureWarnings();
    try {
      const outcome = sessionsDb.refreshDiscoveredSession({
        sessionId: SID, provider: 'codex', projectPath: PROJECT_A, customName: 'forged', jsonlPath: recorded,
      });
      assert.equal(outcome, 'refused');
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.provider, 'claude');
    assert.equal(row()?.custom_name, 'mine');
    assert.equal(warnings.calls.length, 1);
  });
});

test('cwd forgery from the same tree keeps project_path but refreshes name and timestamps', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('1', `${SID}.jsonl`);
    sessionsDb.insertDiscoveredSession({
      sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: recorded, updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const warnings = captureWarnings();
    try {
      assert.equal(sessionsDb.refreshDiscoveredSession({
        sessionId: SID, provider: 'claude', projectPath: PROJECT_B, customName: 'renamed',
        updatedAt: '2026-02-01T00:00:00.000Z', jsonlPath: recorded,
      }), 'refreshed');
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.project_path, PROJECT_A);
    assert.equal(row()?.custom_name, 'renamed');
    assert.equal(row()?.updated_at, '2026-02-01T00:00:00.000Z');
    assert.equal(warnings.calls.length, 1);
  });
});

test('jsonl_path never moves into another member tree (/1 vs /10 prefix trap, both ways)', async () => {
  await withSandbox(({ file }) => {
    for (const [from, to] of [['1', '10'], ['10', '1']]) {
      const sessionId = `${SID.slice(0, -2)}${from.padStart(2, '0')}`;
      const recorded = file(from, `${sessionId}.jsonl`);
      const forged = file(to, `${sessionId}.jsonl`);
      sessionsDb.insertDiscoveredSession({ sessionId, provider: 'claude', projectPath: PROJECT_A, customName: 'mine', jsonlPath: recorded });
      const warnings = captureWarnings();
      try {
        assert.equal(sessionsDb.refreshDiscoveredSession({
          sessionId, provider: 'claude', projectPath: PROJECT_B, customName: 'forged', jsonlPath: forged,
        }), 'refused');
      } finally {
        warnings.restore();
      }
      assert.equal(row(sessionId)?.jsonl_path, recorded);
      assert.equal(row(sessionId)?.project_path, PROJECT_A);
      assert.equal(row(sessionId)?.custom_name, 'mine');
    }
  });
});

test('jsonl_path may move within the same member tree (legacy spelling / relocation)', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('10', `${SID}.jsonl`);
    const moved = file('10', `moved-${SID}.jsonl`);
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: recorded });
    assert.equal(sessionsDb.refreshDiscoveredSession({
      sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: moved,
    }), 'refreshed');
    assert.equal(row()?.jsonl_path, moved);
  });
});

test('a symlink planted in /10 pointing at /1 does not pass as /1', async () => {
  await withSandbox(({ file, home }) => {
    const recorded = file('1', `${SID}.jsonl`);
    const linkDir = path.join(home, '.nassaj-users', '10', '.claude', 'projects', '-workspace');
    mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, `${SID}.jsonl`);
    symlinkSync(recorded, link);
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: recorded });
    const warnings = captureWarnings();
    try {
      assert.equal(sessionsDb.refreshDiscoveredSession({
        sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: link,
      }), 'refused');
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.jsonl_path, recorded);
  });
});

test('NULL jsonl_path is filled only from a participant credential tree or the operator root', async () => {
  await withSandbox(({ file }) => {
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A });
    participantsDb.recordSpawn(SID, 1, { provider: 'claude', projectPath: PROJECT_A });
    const warnings = captureWarnings();
    try {
      assert.equal(sessionsDb.refreshDiscoveredSession({
        sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: file('10', `${SID}.jsonl`),
      }), 'refused');
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.jsonl_path, null);
    const own = file('1', `${SID}.jsonl`);
    assert.equal(sessionsDb.refreshDiscoveredSession({
      sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: own,
    }), 'refreshed');
    assert.equal(row()?.jsonl_path, own);

    const operatorSid = `${SID.slice(0, -1)}9`;
    sessionsDb.insertDiscoveredSession({ sessionId: operatorSid, provider: 'claude', projectPath: PROJECT_A });
    const operatorFile = file('operator', `${operatorSid}.jsonl`);
    sessionsDb.refreshDiscoveredSession({ sessionId: operatorSid, provider: 'claude', projectPath: PROJECT_A, jsonlPath: operatorFile });
    assert.equal(row(operatorSid)?.jsonl_path, operatorFile);
  });
});

test('NULL jsonl_path is filled from the grantor tree when the participant runs on a grant', async () => {
  await withSandbox(({ file }) => {
    credentialGrantsDb.grant(10, 2, 'claude');
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A });
    participantsDb.recordSpawn(SID, 2, { provider: 'claude', projectPath: PROJECT_A });
    const grantorFile = file('10', `${SID}.jsonl`);
    assert.equal(sessionsDb.refreshDiscoveredSession({
      sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: grantorFile,
    }), 'refreshed');
    assert.equal(row()?.jsonl_path, grantorFile);
  });
});

test('agy placeholder → real workspace is allowed; real → other real or placeholder is not', async () => {
  await withSandbox(() => {
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'antigravity', projectPath: '/__antigravity__' });
    sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'antigravity', projectPath: PROJECT_A });
    assert.equal(row()?.project_path, PROJECT_A);
    const warnings = captureWarnings();
    try {
      sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'antigravity', projectPath: PROJECT_B });
      sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'antigravity', projectPath: '/__antigravity__' });
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.project_path, PROJECT_A);
  });
});

test('the placeholder exception is agy-only', async () => {
  await withSandbox(() => {
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: '/__antigravity__' });
    const warnings = captureWarnings();
    try {
      sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A });
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.project_path, '/__antigravity__');
  });
});

test('a stored non-canonical spelling may move to its canonical form', async () => {
  await withSandbox(() => {
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A });
    const raw = `${PROJECT_A}/./`;
    getConnection().prepare('INSERT OR IGNORE INTO projects (project_id, project_path) VALUES (?, ?)').run('adr201-raw', raw);
    getConnection().prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run(raw, SID);
    assert.equal(sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A }), 'refreshed');
    assert.equal(row()?.project_path, PROJECT_A);
  });
});

test('a refresh with no transcript keeps the stored jsonl_path', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('1', `${SID}.jsonl`);
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: recorded });
    sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: null });
    assert.equal(row()?.jsonl_path, recorded);
  });
});

test('a conflict warns once per (session, candidate) and logs no path', async () => {
  await withSandbox(({ file, home }) => {
    const recorded = file('1', `${SID}.jsonl`);
    const forged = file('10', `${SID}.jsonl`);
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: recorded });
    const warnings = captureWarnings();
    try {
      for (let i = 0; i < 3; i += 1) {
        sessionsDb.refreshDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: forged });
      }
    } finally {
      warnings.restore();
    }
    assert.equal(warnings.calls.length, 1);
    const logged = JSON.stringify(warnings.calls[0]);
    assert.ok(!logged.includes(home), 'warning must not carry any member path');
    assert.match(logged, /jsonl_path_other_tree/);
    assert.match(logged, new RegExp(SID));
  });
});

test('recordDiscoveredSession dispatches insert then refresh under the same rules', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('1', `${SID}.jsonl`);
    sessionsDb.recordDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_A, jsonlPath: recorded });
    const warnings = captureWarnings();
    try {
      sessionsDb.recordDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_B, jsonlPath: file('10', `${SID}.jsonl`) });
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.jsonl_path, recorded);
    assert.equal(row()?.project_path, PROJECT_A);
  });
});

test('bumpSessionUpdatedAtFromChild applies only to a child in the parent tree', async () => {
  await withSandbox(({ file }) => {
    const recorded = file('1', `${SID}.jsonl`);
    sessionsDb.insertDiscoveredSession({
      sessionId: SID, provider: 'codex', projectPath: PROJECT_A, jsonlPath: recorded, updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const warnings = captureWarnings();
    try {
      sessionsDb.bumpSessionUpdatedAtFromChild(SID, '2026-03-01T00:00:00.000Z', file('10', 'child.jsonl'));
    } finally {
      warnings.restore();
    }
    assert.equal(row()?.updated_at, '2026-01-01T00:00:00.000Z');
    sessionsDb.bumpSessionUpdatedAtFromChild(SID, '2026-03-01T00:00:00.000Z', file('1', 'child.jsonl'));
    assert.equal(row()?.updated_at, '2026-03-01T00:00:00.000Z');
  });
});
