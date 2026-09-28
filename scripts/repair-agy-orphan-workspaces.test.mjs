/**
 * repair-agy-orphan-workspaces — against a fixture shaped like the reported
 * orphan (agy_1790531982349_26187fb5 -> e70cd70d-8a4f-4694-9304-37f6e440249e):
 * the spawn-key sessions row was adopted away while its overlay alias and
 * ledger row stayed behind.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
    bindSessionWorkspace,
    createSessionWorkspace,
    resolveSessionWorkspaceForLaunch,
} from '../server/modules/session-workspaces/session-workspace-overlay.js';

import { parseArguments, rollbackPlan, run } from './repair-agy-orphan-workspaces.mjs';

const SPAWN_KEY = 'agy_1790531982349_26187fb5';
const BRAIN = 'e70cd70d-8a4f-4694-9304-37f6e440249e';
const PRINCIPAL = '7';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function fixture({ mode = 'overlay', spawnKey = SPAWN_KEY, participants = [7], brainInRoot = true } = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'agy-orphan-')));
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    let overlayCwd = null;
    if (mode === 'overlay') {
        git(project, 'init', '-q', '-b', 'main');
        git(project, 'config', 'user.name', 'Orphan');
        git(project, 'config', 'user.email', 'orphan@example.test');
        fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
        git(project, 'add', 'a.txt');
        git(project, 'commit', '-q', '-m', 'chore: base');
        const launchKey = `cmid-${crypto.randomUUID()}`;
        overlayCwd = createSessionWorkspace({ projectPath: project, launchKey, principalId: PRINCIPAL }).cwd;
        bindSessionWorkspace({ projectPath: project, launchKey, sessionId: spawnKey, principalId: PRINCIPAL });
    }
    const brainRoot = path.join(base, 'home', '.gemini', 'antigravity-cli', 'brain');
    const otherRoot = path.join(base, 'other-user-brain');
    const jsonl = path.join(brainInRoot ? brainRoot : otherRoot, BRAIN, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.mkdirSync(path.join(brainRoot, BRAIN), { recursive: true });
    fs.writeFileSync(jsonl, '');
    const sessionsDir = path.join(base, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, `${spawnKey}.json`), JSON.stringify({ id: spawnKey, cliSessionId: BRAIN }));
    const dbPath = path.join(base, 'db.sqlite');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, provider TEXT, project_path TEXT, jsonl_path TEXT);
        CREATE TABLE session_workspace_modes (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL,
            project_path TEXT NOT NULL, provider TEXT NOT NULL, classified_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE session_participants (session_id TEXT, user_id INTEGER, role TEXT);
    `);
    db.prepare('INSERT INTO session_workspace_modes (session_id, mode, project_path, provider) VALUES (?, ?, ?, ?)')
        .run(spawnKey, mode === 'overlay' ? 'overlay' : 'legacy_shared', project, 'antigravity');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(BRAIN, 'antigravity', project, jsonl);
    for (const user of participants) {
        db.prepare("INSERT INTO session_participants VALUES (?, ?, 'owner')").run(BRAIN, user);
    }
    db.close();
    const options = { db: dbPath, brainRoots: [brainRoot], sessionsDir, apply: false };
    const ledger = () => {
        const reader = new Database(dbPath, { readonly: true });
        try {
            return reader.prepare('SELECT session_id, mode FROM session_workspace_modes').all();
        } finally {
            reader.close();
        }
    };
    const cleanup = () => {
        if (overlayCwd) git(project, 'worktree', 'remove', '--force', overlayCwd);
        fs.rmSync(base, { recursive: true, force: true });
    };
    return { project, overlayCwd, options, ledger, dbPath, cleanup };
}

const quiet = () => {};

test('dry-run (default) finds the orphan and changes nothing', () => {
    const f = fixture();
    try {
        const result = run(f.options, quiet);
        assert.deepEqual(result.candidates.map((c) => [c.spawnKey, c.to]), [[SPAWN_KEY, BRAIN]]);
        assert.deepEqual(result.applied, []);
        assert.deepEqual(f.ledger(), [{ session_id: SPAWN_KEY, mode: 'overlay' }]);
        assert.throws(() => resolveSessionWorkspaceForLaunch({ projectPath: f.project, sessionId: BRAIN, principalId: PRINCIPAL }));
    } finally {
        f.cleanup();
    }
});

test('--apply prints the rollback plan first, then re-keys so the brain UUID resumes its overlay', () => {
    const f = fixture();
    try {
        const lines = [];
        const result = run({ ...f.options, apply: true }, (line) => lines.push(line));
        assert.equal(result.applied.length, 1);
        const planIndex = lines.findIndex((line) => line.includes('"rollback_plan"'));
        const appliedIndex = lines.findIndex((line) => line.includes('"applied"'));
        assert.ok(planIndex >= 0 && planIndex < appliedIndex, 'the rollback plan precedes any write');
        assert.deepEqual(f.ledger(), [{ session_id: BRAIN, mode: 'overlay' }]);
        const resumed = resolveSessionWorkspaceForLaunch({ projectPath: f.project, sessionId: BRAIN, principalId: PRINCIPAL });
        assert.equal(resumed.cwd, f.overlayCwd);

        // The printed rollback plan really restores the previous state.
        const plan = JSON.parse(lines[planIndex]).entries[0];
        const db = new Database(f.dbPath);
        db.exec(plan.sql);
        db.close();
        for (const file of plan.restoreFiles) fs.writeFileSync(file.path, file.content);
        for (const file of plan.removeFiles) fs.rmSync(file, { force: true });
        assert.deepEqual(f.ledger(), [{ session_id: SPAWN_KEY, mode: 'overlay' }]);
        assert.equal(resolveSessionWorkspaceForLaunch({
            projectPath: f.project, sessionId: SPAWN_KEY, principalId: PRINCIPAL,
        }).cwd, f.overlayCwd);
    } finally {
        f.cleanup();
    }
});

test('shared (non-git) orphans are re-keyed in the ledger only', () => {
    const f = fixture({ mode: 'shared' });
    try {
        const result = run({ ...f.options, apply: true }, quiet);
        assert.equal(result.applied.length, 1);
        assert.deepEqual(f.ledger(), [{ session_id: BRAIN, mode: 'legacy_shared' }]);
        assert.equal(rollbackPlan(result.applied[0]).restoreFiles, undefined);
    } finally {
        f.cleanup();
    }
});

test('the C2 checks refuse every unsafe candidate', () => {
    const cases = [
        ['transcript in another user brain dir', { brainInRoot: false }, /outside every given brain root/],
        ['foreign participant', { participants: [7, 8] }, /another participant/],
        ['brain predates the spawn key', { spawnKey: `agy_${Date.now() + 3_600_000}_future1` }, /predates/],
    ];
    for (const [label, overrides, expected] of cases) {
        const f = fixture(overrides);
        try {
            const result = run({ ...f.options, apply: true }, quiet);
            assert.equal(result.candidates.length, 0, label);
            assert.match(result.skipped[0].skip, expected, label);
            assert.equal(f.ledger()[0].session_id, overrides.spawnKey ?? SPAWN_KEY, label);
        } finally {
            f.cleanup();
        }
    }
});

test('a brain already bound, or a spawn key that still has its own row, is left alone', () => {
    const f = fixture();
    try {
        const db = new Database(f.dbPath);
        db.prepare("INSERT INTO sessions VALUES (?, 'antigravity', ?, NULL)").run(SPAWN_KEY, f.project);
        db.close();
        assert.match(run(f.options, quiet).skipped[0].skip, /not orphaned/);
        const second = new Database(f.dbPath);
        second.prepare('DELETE FROM sessions WHERE session_id = ?').run(SPAWN_KEY);
        second.prepare("INSERT INTO session_workspace_modes (session_id, mode, project_path, provider) VALUES (?, 'overlay', ?, 'antigravity')")
            .run(BRAIN, f.project);
        second.close();
        assert.match(run(f.options, quiet).skipped[0].skip, /already has a workspace binding/);
    } finally {
        f.cleanup();
    }
});

test('arguments: no implicit database, at least one brain root', () => {
    assert.throws(() => parseArguments(['--brain-root', '/x']), /--db is required/);
    assert.throws(() => parseArguments(['--db', '/x.db']), /brain-root/);
    assert.throws(() => parseArguments(['--db', '/x.db', '--brain-root', '/b', '--force']), /unknown argument/);
    assert.equal(parseArguments(['--db', '/x.db', '--brain-root', '/b']).apply, false);
});
