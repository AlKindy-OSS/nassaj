#!/usr/bin/env node
/**
 * Re-keys orphaned antigravity workspace bindings from their spawn key
 * (`agy_<ms>_<rand>`) to the brain UUID the conversation actually lives under.
 *
 * Before the declared-handover fix, a fresh agy chat under session isolation
 * adopted its spawn-key sessions row into the brain UUID while the overlay
 * alias and the session_workspace_modes row stayed keyed to the spawn key, so
 * every turn 2 failed with "The resumed session has no trusted project
 * workspace". This moves the binding with the same evidence the live handover
 * requires (qa C2), and nothing else:
 *   - the spawn key has a ledger row and NO sessions row (it was adopted);
 *   - `<sessions-dir>/<spawnKey>.json` names the brain UUID (cliSessionId);
 *   - the brain has no ledger row and no overlay alias;
 *   - the brain's sessions row is antigravity, in the same project, with a
 *     jsonl_path inside one of the given brain roots;
 *   - the brain dir is a plain directory born at/after the spawn key's clock;
 *   - at most one principal participates in the brain (the overlay owner).
 *
 * Dry-run by default: prints the plan and changes nothing. `--apply` prints a
 * rollback plan first, then applies each candidate additively (to-alias and
 * manifest, DB transaction, then remove the from-alias) under the overlay lock.
 *
 * Usage:
 *   node scripts/repair-agy-orphan-workspaces.mjs --db <db.sqlite> \
 *     --brain-root <dir> [--brain-root <dir> ...] [--sessions-dir <dir>] [--apply]
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const SPAWN_KEY = /^agy_(\d+)_[a-z0-9]+$/;
const BRAIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OVERLAY_SCHEMA = 1;
const CLOCK_TOLERANCE_MS = 20;

/** Parses argv into options; throws on anything unknown or missing. */
export function parseArguments(argv) {
    const options = { db: '', brainRoots: [], sessionsDir: path.join(os.homedir(), '.gemini', 'sessions'), apply: false };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
            index += 1;
            return next;
        };
        if (flag === '--db') options.db = value();
        else if (flag === '--brain-root') options.brainRoots.push(path.resolve(value()));
        else if (flag === '--sessions-dir') options.sessionsDir = path.resolve(value());
        else if (flag === '--apply') options.apply = true;
        else throw new Error(`unknown argument: ${flag}`);
    }
    if (!options.db) throw new Error('--db is required (no default database path)');
    if (options.brainRoots.length === 0) throw new Error('at least one --brain-root is required');
    return options;
}

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readRegularJson(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular file: ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exists(file) {
    try {
        fs.lstatSync(file);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function overlayStateRoot(projectPath) {
    const result = spawnSync('git', ['-C', projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    if (result.status !== 0) throw new Error('project is not a git repository');
    return path.join(fs.realpathSync(result.stdout.trim()), 'nassaj-session-overlays');
}

const aliasPath = (root, sessionId) => path.join(root, 'aliases', 'session', `${digest(sessionId)}.json`);

function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** C2 evidence against one brain root; returns the brain dir or throws. */
function brainEvidence(row, to, spawnedAtMs, brainRoots) {
    const jsonl = typeof row.jsonl_path === 'string' ? path.resolve(row.jsonl_path) : '';
    for (const brainRoot of brainRoots) {
        const bases = [brainRoot];
        try { bases.push(fs.realpathSync(brainRoot)); } catch { /* lexical only */ }
        if (!jsonl || !bases.some((base) => isWithin(path.join(base, to), jsonl))) continue;
        const brainDir = path.join(brainRoot, to);
        const stat = fs.lstatSync(brainDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('brain is not a plain directory');
        const bornAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
        if (bornAtMs + CLOCK_TOLERANCE_MS < spawnedAtMs) throw new Error('brain predates the spawn key');
        return brainDir;
    }
    throw new Error('transcript is outside every given brain root');
}

function readOverlay(row, spawnKey, to) {
    const root = overlayStateRoot(row.project_path);
    const fromAlias = aliasPath(root, spawnKey);
    const alias = readRegularJson(fromAlias);
    if (alias?.schema !== OVERLAY_SCHEMA || typeof alias.overlayId !== 'string') throw new Error('malformed alias');
    const manifestPath = path.join(root, 'instances', alias.overlayId, 'manifest.json');
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    if (manifest.schema !== OVERLAY_SCHEMA || manifest.overlayId !== alias.overlayId
        || manifest.sessionId !== spawnKey || manifest.state !== 'active'
        || manifest.logicalProjectPath !== row.project_path) {
        throw new Error('overlay manifest does not match the spawn key');
    }
    const toAlias = aliasPath(root, to);
    if (exists(toAlias)) throw new Error('brain already has an overlay alias');
    return { root, fromAlias, toAlias, aliasText: fs.readFileSync(fromAlias, 'utf8'), manifestPath, manifestText, manifest };
}

/** Evaluates one spawn-key ledger row; returns a candidate or `{ skip }`. */
export function evaluate(db, row, options) {
    const spawnKey = row.session_id;
    const match = SPAWN_KEY.exec(spawnKey);
    if (!match) return { spawnKey, skip: 'not a spawn key' };
    if (db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(spawnKey)) {
        return { spawnKey, skip: 'spawn key still has its own sessions row (not orphaned)' };
    }
    try {
        const to = readRegularJson(path.join(options.sessionsDir, `${spawnKey}.json`))?.cliSessionId;
        if (typeof to !== 'string' || !BRAIN_ID.test(to)) throw new Error('session file names no brain UUID');
        if (db.prepare('SELECT 1 FROM session_workspace_modes WHERE session_id = ?').get(to)) {
            throw new Error('brain already has a workspace binding');
        }
        const target = db.prepare('SELECT provider, project_path, jsonl_path FROM sessions WHERE session_id = ?').get(to);
        if (!target || target.provider !== 'antigravity' || target.project_path !== row.project_path) {
            throw new Error('brain sessions row does not match the binding');
        }
        brainEvidence(target, to, Number(match[1]), options.brainRoots);
        const overlay = row.mode === 'overlay' ? readOverlay(row, spawnKey, to) : null;
        const users = db.prepare('SELECT DISTINCT user_id FROM session_participants WHERE session_id = ?')
            .all(to).map((participant) => String(participant.user_id));
        const owner = overlay?.manifest.ownerPrincipalId;
        if (users.length > 1 || (owner != null && users.some((user) => user !== String(owner)))) {
            throw new Error('brain has another participant');
        }
        return { spawnKey, to, mode: row.mode, projectPath: row.project_path, overlay };
    } catch (error) {
        return { spawnKey, skip: error instanceof Error ? error.message : String(error) };
    }
}

/** How to undo one applied candidate, printed before anything is written. */
export function rollbackPlan(candidate) {
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const plan = {
        spawnKey: candidate.spawnKey,
        brainUUID: candidate.to,
        sql: `UPDATE session_workspace_modes SET session_id = ${quote(candidate.spawnKey)} `
            + `WHERE session_id = ${quote(candidate.to)};`,
    };
    if (candidate.overlay) {
        plan.restoreFiles = [
            { path: candidate.overlay.manifestPath, content: candidate.overlay.manifestText },
            { path: candidate.overlay.fromAlias, content: candidate.overlay.aliasText },
        ];
        plan.removeFiles = [candidate.overlay.toAlias];
    }
    return plan;
}

function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

/** Same mkdir lock protocol as session-workspace-overlay.js, so a live server waits. */
function withOverlayLock(root, operation, timeoutMs = 15_000) {
    const lock = path.join(root, '.lock');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            fs.mkdirSync(lock);
            fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
            break;
        } catch (error) {
            if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('overlay lock timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
    }
    try {
        return operation();
    } finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}

function rekey(db, candidate) {
    db.transaction(() => {
        if (db.prepare('SELECT 1 FROM session_workspace_modes WHERE session_id = ?').get(candidate.to)) {
            throw new Error('brain gained a workspace binding');
        }
        const moved = db.prepare('UPDATE session_workspace_modes SET session_id = ? WHERE session_id = ? AND mode = ?')
            .run(candidate.to, candidate.spawnKey, candidate.mode);
        if (moved.changes !== 1) throw new Error('spawn-key binding changed');
    })();
}

/** Applies one candidate additively; reverts the files if the DB step refuses. */
export function applyCandidate(db, candidate) {
    const { overlay } = candidate;
    if (!overlay) {
        rekey(db, candidate);
        return;
    }
    withOverlayLock(overlay.root, () => {
        if (exists(overlay.toAlias)) throw new Error('brain gained an overlay alias');
        if (fs.readFileSync(overlay.manifestPath, 'utf8') !== overlay.manifestText) {
            throw new Error('overlay manifest changed since the plan');
        }
        atomicWrite(overlay.toAlias, fs.readFileSync(overlay.fromAlias, 'utf8'));
        const rebound = { ...overlay.manifest, sessionId: candidate.to, lastUsedAt: new Date().toISOString() };
        atomicWrite(overlay.manifestPath, `${JSON.stringify(rebound, null, 2)}\n`);
        try {
            rekey(db, candidate);
        } catch (error) {
            atomicWrite(overlay.manifestPath, overlay.manifestText);
            fs.rmSync(overlay.toAlias, { force: true });
            throw error;
        }
        fs.rmSync(overlay.fromAlias, { force: true });
    });
}

/** Runs the repair; returns { candidates, skipped, applied, failed }. */
export function run(options, log = console.log) {
    const db = new Database(options.db, { fileMustExist: true });
    try {
        const rows = db.prepare(`
            SELECT session_id, mode, project_path, provider FROM session_workspace_modes
            WHERE provider = 'antigravity' AND session_id LIKE 'agy\\_%' ESCAPE '\\'
        `).all();
        const results = rows.map((row) => evaluate(db, row, options));
        const candidates = results.filter((result) => !result.skip);
        const skipped = results.filter((result) => result.skip);
        for (const skip of skipped) log(JSON.stringify({ event: 'skip', spawnKey: skip.spawnKey, reason: skip.skip }));
        for (const candidate of candidates) {
            log(JSON.stringify({ event: 'candidate', spawnKey: candidate.spawnKey, brainUUID: candidate.to, mode: candidate.mode }));
        }
        if (!options.apply) return { candidates, skipped, applied: [], failed: [] };
        log(JSON.stringify({ event: 'rollback_plan', entries: candidates.map(rollbackPlan) }, null, 2));
        const applied = [];
        const failed = [];
        for (const candidate of candidates) {
            try {
                applyCandidate(db, candidate);
                applied.push(candidate);
                log(JSON.stringify({ event: 'applied', spawnKey: candidate.spawnKey, brainUUID: candidate.to }));
            } catch (error) {
                failed.push(candidate);
                log(JSON.stringify({ event: 'failed', spawnKey: candidate.spawnKey, reason: String(error?.message || error) }));
            }
        }
        return { candidates, skipped, applied, failed };
    } finally {
        db.close();
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const result = run(parseArguments(process.argv.slice(2)));
        process.exitCode = result.failed.length > 0 ? 1 : 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
