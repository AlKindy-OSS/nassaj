#!/usr/bin/env node
/**
 * Drive one acceptance scenario (S1..S11) of ADR-156 §ح.2 against the
 * laboratory node, end to end, through the real HTTP surface. S11 is the
 * installer scenario: it provisions the node through scripts/install-node.mjs
 * and boots it from the ecosystem that installer generated (qa-critic C3).
 *
 * Each scenario is reset to zero (`provision-node.mjs restore`), given its own
 * setup, then driven exactly as the update button drives a real node:
 *
 *   POST /api/system/update/jobs   (owner token, Idempotency-Key)
 *     → poll GET /api/system/update/jobs/:id until a terminal state
 *     → GET  /api/system/pending   to find the governed safe-restart row
 *     → POST /api/system/pending/:id/execute   (the single governed confirmation)
 *     → wait for the replacement process and read /health
 *
 * The verdict distinguishes three outcomes deliberately:
 *   pass             — observed behaviour equals the ADR-156 contract
 *   defect-confirmed — observed behaviour equals the KNOWN defect the scenario
 *                      exists to pin (the harness caught it exactly)
 *   inconclusive     — the run never reached the state under test, so it is
 *                      evidence for neither the contract nor the defect
 *   fail             — neither; the scenario found something unexpected
 *   deferred         — the scenario needs a private remote that does not exist
 *
 * Usage:
 *   node scripts/update-lab/run-scenario.mjs S1 [--keep] [--timeout-ms 1800000]
 *   node scripts/update-lab/run-scenario.mjs --list
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    FIXTURE_META, FIXTURE_REPO, NODE_APP, NODE_DATA, NODE_META, NODE_ROOT, RESULTS_ROOT, SSH_SHIM,
    assertLabSafety, fail, git, log, mustGit, parseArgs, readJson, run, writeJson,
} from './lab-common.mjs';
import { ECOSYSTEM, PM2_HOME, PROC_NAME, labEnvironment } from './provision-node.mjs';

const PROVISION = path.join(path.dirname(new URL(import.meta.url).pathname), 'provision-node.mjs');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_STATES = new Set(['activated', 'rolled_back', 'failed', 'superseded', 'manual_recovery_required']);

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function provision(args) {
    const result = run(process.execPath, [PROVISION, ...args], { stdio: 'inherit' });
    if (result.code !== 0) fail(`provision-node.mjs ${args.join(' ')} failed`);
}

function labUrl(meta, pathname) {
    return `http://127.0.0.1:${meta.port}${pathname}`;
}

async function api(meta, pathname, { method = 'GET', token = null, body = null, headers = {} } = {}) {
    const response = await fetch(labUrl(meta, pathname), {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
}

/** The release identity /health actually publishes. */
function healthVersion(health) {
    return health?.sourceVersion ?? health?.version ?? null;
}

const BUILD_ID = /^[a-f0-9]{64}$/;
const buildIdOf = (value) => (typeof value === 'string' && BUILD_ID.test(value) ? value : null);

/**
 * The PREPARED state as the client itself derives it — the same predicate as
 * `resolveUpdatePrepared` in `src/hooks/useVersionCheck.ts` (B-1055, WI-5) plus
 * the server's own `restartRequired` ledger, which WI-5 treats as a fail-safe.
 *
 * Asserting `restartRequired` ALONE (what this harness did before P1) tests a
 * signal the fix deliberately does not rely on: `restartRequired` compares the
 * LOADED build id against the PROMOTED one, and a staged candidate has not been
 * promoted yet, so it is false by design while the update is genuinely owed.
 */
function updatePrepared(health) {
    if (!health) return false;
    if (health.restartRequired === true) return true;
    const loaded = buildIdOf(health.serverLoadedBuildId);
    if (!loaded) return false;
    const onDisk = buildIdOf(health.serverBuildIdOnDisk) ?? buildIdOf(health.serverPromotedBuildId);
    if (onDisk && onDisk !== loaded) return true;
    const candidate = buildIdOf(health.serverCandidateBuildId);
    return Boolean(candidate && candidate !== loaded && candidate !== onDisk
        && health.hasPendingActions === true);
}

/** The /health fields a prepared-state verdict rests on, for the evidence file. */
function preparedSignals(health) {
    if (!health) return null;
    return {
        sourceVersion: health.sourceVersion ?? null,
        runtimeVersion: health.runtimeVersion ?? null,
        restartRequired: health.restartRequired ?? null,
        hasPendingActions: health.hasPendingActions ?? null,
        serverLoadedBuildId: health.serverLoadedBuildId ?? null,
        serverBuildIdOnDisk: health.serverBuildIdOnDisk ?? null,
        serverCandidateBuildId: health.serverCandidateBuildId ?? null,
        updatePrepared: updatePrepared(health),
    };
}

async function waitForHealth(meta, { timeoutMs = 120_000, expectVersion = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(labUrl(meta, '/health'));
            if (response.ok) {
                last = await response.json();
                // /health reports `sourceVersion` (the working tree's
                // package.json), not `version`.
                if (!expectVersion || healthVersion(last) === expectVersion) return last;
            }
        } catch { /* not listening yet */ }
        await sleep(1000);
    }
    return last;
}

/**
 * Mint an owner token the way the fleet operator tool does: log in with the
 * bootstrap owner credentials, and fall back to signing a token locally from
 * the node's own JWT_SECRET and its owner row when the login surface refuses.
 */
async function ownerToken(meta) {
    const login = await api(meta, '/api/auth/login', {
        method: 'POST', body: { username: meta.ownerUsername, password: meta.ownerPassword },
    });
    if (login.status === 200 && login.json?.token) return login.json.token;
    const require = createRequire(path.join(NODE_APP, 'package.json'));
    const jwt = require('jsonwebtoken');
    const Database = require('better-sqlite3');
    const database = new Database(path.join(meta.dataRoot, 'auth.db'), { readonly: true });
    const user = database.prepare("SELECT id, username, role, password_changed_at FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
    database.close();
    if (!user) fail('no owner row in the laboratory database');
    return jwt.sign({
        userId: user.id, username: user.username, role: user.role, pwd_iat: user.password_changed_at ?? 0,
    }, meta.jwtSecret, { expiresIn: '2h' });
}

async function createJob(meta, token, expectedVersion) {
    return api(meta, '/api/system/update/jobs', {
        method: 'POST', token, body: { expectedVersion },
        headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
}

async function pollJob(meta, token, jobId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const response = await api(meta, `/api/system/update/jobs/${jobId}`, { token });
        if (response.status !== 200) return { ...last, pollError: response };
        last = response.json;
        if (TERMINAL_STATES.has(last.state) || last.state === 'restart_queued') return last;
        await sleep(2000);
    }
    return { ...last, timedOut: true };
}

async function findPendingRestart(meta, token) {
    const response = await api(meta, '/api/system/pending', { token });
    const rows = response.json?.actions || response.json?.pending || response.json || [];
    const list = Array.isArray(rows) ? rows : [];
    return list.find((row) => row?.actionType === 'safe-restart' && row?.status === 'pending') || null;
}

/** Snapshot the node's git identity so a scenario can prove nothing was rewritten. */
function gitIdentity() {
    return {
        head: git(['rev-parse', 'HEAD'], NODE_APP).stdout.trim(),
        branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD'], NODE_APP).stdout.trim(),
        tags: git(['for-each-ref', '--format=%(refname)', 'refs/tags'], NODE_APP).stdout.trim().split('\n').filter(Boolean),
        status: git(['status', '--porcelain=v1', '--untracked-files=all'], NODE_APP).stdout.trim(),
    };
}

/* ------------------------------------------------ S12-S20 helpers */

const S13_IDENTITY = Object.freeze({
    GIT_AUTHOR_NAME: 'Nassaj Update Lab',
    GIT_AUTHOR_EMAIL: 'update-lab@localhost',
    GIT_COMMITTER_NAME: 'Nassaj Update Lab',
    GIT_COMMITTER_EMAIL: 'update-lab@localhost',
});

/**
 * Hash a raw buffer/string as a blob into the fixture bare repo.
 * Returns the 40-hex object id.
 */
function hashBlobInFixture(content) {
    const result = git(['hash-object', '-w', '--stdin'], FIXTURE_REPO, { input: content });
    if (result.code !== 0) fail(`hash-object in fixture failed: ${result.stderr}`);
    return result.stdout.trim();
}

/**
 * Add an annotated release tag `v<version>` to the fixture repo that carries
 * the given extra files (on top of the current HEAD of main). Idempotent: if
 * the tag already exists the call returns without doing anything.
 *
 * Also advances `refs/heads/main` to the new release commit (required: the
 * worker verifies the tag is reachable from the branch HEAD) and updates
 * `fixture.json` so subsequent scenarios target the new version.
 *
 * @param {string} version   Four-part Nassaj version, e.g. '9.0.0.10'
 * @param {Array<{path: string, content: string}>} extraFiles
 */
function ensureFixtureRelease(version, extraFiles) {
    const tag = `v${version}`;
    if (git(['rev-parse', '--verify', `refs/tags/${tag}`], FIXTURE_REPO).code === 0) return;
    const indexFile = path.join(path.dirname(FIXTURE_REPO), `lab-idx-${version}`);
    fs.rmSync(indexFile, { force: true });
    const env = { GIT_INDEX_FILE: indexFile, ...S13_IDENTITY };
    const baseCommit = mustGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], FIXTURE_REPO).trim();
    mustGit(['read-tree', baseCommit], FIXTURE_REPO, { env });
    // Bump package.json version
    const manifestText = git(['show', `${baseCommit}:package.json`], FIXTURE_REPO).stdout;
    if (manifestText) {
        const manifest = JSON.parse(manifestText);
        manifest.version = version;
        const blobId = hashBlobInFixture(`${JSON.stringify(manifest, null, 2)}\n`);
        mustGit(['update-index', '--cacheinfo', `100644,${blobId},package.json`], FIXTURE_REPO, { env });
    }
    // Add extra files
    for (const { path: filePath, content } of extraFiles) {
        const blobId = hashBlobInFixture(content);
        mustGit(['update-index', '--add', '--cacheinfo', `100644,${blobId},${filePath}`], FIXTURE_REPO, { env });
    }
    const tree = mustGit(['write-tree'], FIXTURE_REPO, { env }).trim();
    const message = `chore(release): update-lab fixture ${version}`;
    const releaseCommit = mustGit(['commit-tree', tree, '-p', baseCommit, '-m', message], FIXTURE_REPO, { env }).trim();
    // Advance main to the release commit so the worker's onReleaseBranch check passes
    // (it verifies the tag is reachable from the configured release branch HEAD).
    mustGit(['update-ref', 'refs/heads/main', releaseCommit], FIXTURE_REPO, { env });
    mustGit(['tag', '-a', '-m', message, tag, releaseCommit], FIXTURE_REPO, { env });
    fs.rmSync(indexFile, { force: true });
    // Update fixture.json so subsequent scenarios use this version as their target.
    const existing = readJson(FIXTURE_META, null);
    if (existing) {
        const releases = [...(existing.releases || []), { version, tag, releaseCommit, baseCommit }];
        writeJson(FIXTURE_META, {
            ...existing,
            updatedAt: new Date().toISOString(),
            latest: { version, tag, releaseCommit },
            releases,
        });
    }
}

/**
 * Seed a `source_update_jobs` row in state `awaiting_sessions` directly into
 * the lab SQLite database. The server must already be running (auth.db exists).
 *
 * @param {object} meta  node metadata (from node.json)
 * @param {{ expectedVersion: string, deferralDeadlineAt: number }} opts
 * @returns {string} the new job id
 */
function seedDeferralJob(meta, { expectedVersion, deferralDeadlineAt }) {
    const database = labDatabase(meta);
    const user = database.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
    if (!user) { database.close(); fail('no owner row in the lab database — did the server start?'); }
    const jobId = crypto.randomUUID();
    const columns = database.prepare('PRAGMA table_info(source_update_jobs)').all().map((r) => r.name);
    const row = {
        id: jobId,
        expected_version: expectedVersion,
        owner_id: user.id,
        idempotency_key_hash: crypto.randomBytes(32).toString('hex'),
        request_fingerprint: crypto.randomBytes(32).toString('hex'),
        strategy: 'git-checkout-v2',
        state: 'awaiting_sessions',
        auto_activate: 0,
        defer_until_idle: 1,
        deferral_deadline_at: deferralDeadlineAt,
    };
    const usable = Object.keys(row).filter((k) => columns.includes(k));
    database.prepare(
        `INSERT INTO source_update_jobs (${usable.join(',')}) VALUES (${usable.map((k) => `@${k}`).join(',')})`,
    ).run(Object.fromEntries(usable.map((k) => [k, row[k]])));
    database.close();
    return jobId;
}

/* --------------------------------------------------------------- scenarios */

const OUTSIDE_FILE = 'update-lab-untracked-outside.txt';

const SCENARIOS = {
    S1: {
        maps: 'B-1050',
        setup: 'an UNTRACKED file outside the paths the release changes',
        contract: 'the update succeeds and never touches the file',
        knownDefect: { code: 'dirty_worktree', note: 'source-updater.js:416-417 rejects any untracked file, however far from the release paths (WI-10, P2)' },
        async prepare(context) {
            fs.writeFileSync(path.join(NODE_APP, OUTSIDE_FILE), 'laboratory scratch file — must survive the update\n');
            context.plantedFile = path.join(NODE_APP, OUTSIDE_FILE);
        },
        async verdict(context) {
            const survived = fs.existsSync(context.plantedFile);
            // `context.job` is the snapshot polled BEFORE the governed activation
            // (restart_queued); the outcome needs the job after the replacement
            // process came back, exactly as S10 waits for it.
            if (context.job?.state === 'restart_queued' && context.activation?.status === 200) {
                const health = await waitForHealth(context.meta, { timeoutMs: 180_000, expectVersion: context.expectedVersion });
                context.job = await pollJob(context.meta, await ownerToken(context.meta), context.jobCreate.body.jobId, 120_000);
                context.healthAfterActivation = health ? healthVersion(health) : null;
            }
            if (context.job?.state === 'activated' && survived) return { verdict: 'pass', why: `update activated (serves ${context.healthAfterActivation}) and the untracked file survived` };
            if (context.job?.error?.code === 'dirty_worktree') {
                return {
                    verdict: survived ? 'defect-confirmed' : 'fail',
                    why: survived
                        ? 'blocked with dirty_worktree for a file the release never touches — exactly B-1050; the file was left alone'
                        : 'blocked with dirty_worktree AND the planted file disappeared',
                };
            }
            return { verdict: 'fail', why: `unexpected outcome: state=${context.job?.state} code=${context.job?.error?.code}` };
        },
    },
    S2: {
        maps: 'B-1050',
        setup: 'an UNTRACKED file at exactly a path the release adds',
        contract: 'one blocker that names the colliding file; the file is not touched',
        knownDefect: { code: 'dirty_worktree', note: 'the blocker is generic — it does not name the file (WI-10, P2)' },
        async prepare(context) {
            const fixture = readJson(FIXTURE_META);
            const target = path.join(NODE_APP, fixture.releaseNotePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, 'local note that collides with the release path\n');
            context.plantedFile = target;
            context.plantedRelative = fixture.releaseNotePath;
        },
        verdict(context) {
            const survived = fs.existsSync(context.plantedFile);
            const message = `${context.job?.error?.message || ''}`;
            if (context.job?.error?.code !== 'dirty_worktree') {
                return { verdict: 'fail', why: `expected a dirty_worktree blocker, got state=${context.job?.state} code=${context.job?.error?.code}` };
            }
            if (!survived) return { verdict: 'fail', why: 'the colliding file was modified or removed by a blocked update' };
            return message.includes(context.plantedRelative)
                ? { verdict: 'pass', why: 'blocked with a single blocker that names the colliding file' }
                : { verdict: 'defect-confirmed', why: `blocked correctly but the message does not name ${context.plantedRelative}: "${message}"` };
        },
    },
    S3: {
        maps: 'B-1051',
        setup: 'a local commit on main (node customization)',
        contract: 'a blocker that points at the configuration overlay; no reset, no rescue tag',
        knownDefect: { code: 'non_fast_forward', note: 'the blocker is correct but names no overlay remedy (WI-15, P3)' },
        async prepare(context) {
            const marker = path.join(NODE_APP, 'CHANGELOG.md');
            fs.appendFileSync(marker, '\n<!-- update-lab local customization -->\n');
            const add = git(['add', 'CHANGELOG.md'], NODE_APP);
            if (add.code !== 0) fail(`git add failed: ${add.stderr}`);
            const commit = git(['commit', '-m', 'chore(lab): local node customization'], NODE_APP, {
                env: {
                    GIT_AUTHOR_NAME: 'Nassaj Update Lab', GIT_AUTHOR_EMAIL: 'update-lab@localhost',
                    GIT_COMMITTER_NAME: 'Nassaj Update Lab', GIT_COMMITTER_EMAIL: 'update-lab@localhost',
                },
            });
            if (commit.code !== 0) fail(`git commit failed: ${commit.stdout}${commit.stderr}`);
            context.identityBefore = gitIdentity();
        },
        verdict(context) {
            const after = gitIdentity();
            const untouched = after.head === context.identityBefore.head
                && after.tags.length === context.identityBefore.tags.length;
            if (context.job?.error?.code !== 'non_fast_forward') {
                return { verdict: 'fail', why: `expected non_fast_forward, got state=${context.job?.state} code=${context.job?.error?.code}` };
            }
            if (!untouched) return { verdict: 'fail', why: 'the updater rewrote the node history (reset or rescue tag) — forbidden by ADR-156 §د.2' };
            const message = `${context.job?.error?.message || ''}`;
            return /overlay|config/i.test(message)
                ? { verdict: 'pass', why: 'blocked with non_fast_forward and referred to the overlay' }
                : { verdict: 'defect-confirmed', why: `blocked with non_fast_forward and left history intact, but the message names no overlay remedy: "${message}"` };
        },
    },
    S4: {
        maps: 'B-1052',
        deferred: 'needs a PRIVATE remote release repository: the release-source lock is proved by changing `origin` to a second real repository and watching `remote_mismatch` stop the update. ADR-156 §3 puts your-org/nassaj-update-fixtures behind a separate owner creation permission, so this scenario is out of scope for the local fixture (a file:// or shim-backed remote cannot demonstrate credential authority).',
    },
    S5: {
        maps: 'B-1053',
        deferred: 'needs a PRIVATE HTTPS remote with no credentials, so that discovery succeeds while the credential-free fetch fails. The local ssh shim always succeeds, and the /preflight endpoint that this scenario targets does not exist yet (WI-7, P1). Deferred until both exist.',
    },
    S6: {
        maps: 'B-1054',
        setup: 'a release that adds a gitlink (submodule entry)',
        contract: 'G1 blocks it at release time; if forced through, the gate ends OPEN or degraded with a way out and the site stays up',
        knownDefect: { code: 'candidate_checkout_failed|activation', note: 'pre-P2 the gitlink assertion lives inside the shared apply path, so activation AND rollback fail together (B-1054)' },
        requiresFixture: { gitlinkOp: 'add' },
        async prepare(context) {
            const fixture = readJson(FIXTURE_META);
            const release = [...fixture.releases].reverse().find((entry) => entry.gitlinkOp === 'add');
            if (!release) {
                fail('S6 needs a gitlink release; create one first:\n'
                    + '  node scripts/update-lab/create-fixture-repo.mjs --append --version 9.0.0.2 --gitlink-op add');
            }
            context.expectedVersion = release.version;
        },
        async verdict(context) {
            const health = await waitForHealth(context.meta, { timeoutMs: 60_000 });
            const alive = Boolean(health);
            if (context.job?.state === 'activated' && alive) return { verdict: 'fail', why: 'a gitlink release activated — G1 did not hold' };
            if (!alive) return { verdict: 'fail', why: 'the node is not serving after the gitlink release was refused (the B-1054 outage shape)' };
            // G1 (ADR-156 decision 8, WI-11): the refusal belongs BEFORE any
            // activation, under its own code. That is the contract, not the
            // defect; B-1054's shape is a refusal found by activation/rollback.
            if (context.job?.state === 'failed' && context.job?.error?.code === 'gitlink_change_unsupported' && !context.activation) {
                return { verdict: 'pass', why: 'G1 refused the gitlink release before activation (gitlink_change_unsupported) and the node kept serving' };
            }
            return { verdict: 'defect-confirmed', why: `gitlink release refused (${context.job?.error?.code || context.job?.state}) and the node kept serving` };
        },
    },
    S7: {
        maps: 'B-1055',
        setup: 'a staged candidate awaiting activation (live build one release behind the source)',
        contract: '/health publishes the prepared state so the button reads "prepared, awaiting activation" instead of vanishing',
        // Settled by WI-5 (4bbec272) and WI-6 (93ac74d7): the prepared state is
        // derived from the build identities plus the queue, and /health carries
        // `runtimeVersion` so "which build is running" no longer comes from a
        // package.json that `git checkout` has already moved.
        knownDefect: null,
        stopBeforeActivation: true,
        async verdict(context) {
            if (context.job?.state !== 'restart_queued') {
                return { verdict: 'fail', why: `staging did not reach restart_queued (state=${context.job?.state} code=${context.job?.error?.code})` };
            }
            const health = await waitForHealth(context.meta, { timeoutMs: 30_000 });
            context.preparedSignals = preparedSignals(health);
            if (!health) return { verdict: 'fail', why: 'the node stopped serving /health while the candidate was staged' };
            if (!health.runtimeVersion) {
                return { verdict: 'defect-confirmed', why: '/health publishes no runtimeVersion, so the running build cannot be told from the staged source (B-1055)' };
            }
            if (updatePrepared(health)) {
                return { verdict: 'pass', why: `/health publishes the prepared state (runtimeVersion=${health.runtimeVersion} source=${health.sourceVersion} restartRequired=${health.restartRequired})` };
            }
            // Measured on the P1 tree: on git-checkout-v2 the worktree is NOT
            // checked out at `restart_queued` (HEAD is still the base commit and
            // sourceVersion still the old release), so the comparison the B-1055
            // symptom depends on has not collapsed yet and the entry point has
            // not vanished. This state is therefore not evidence either way.
            return healthVersion(health) === context.fixture.baseVersion
                ? {
                    verdict: 'inconclusive',
                    why: `the B-1055 window was never entered: at restart_queued the source is still ${healthVersion(health)}`
                        + ' (git-checkout-v2 defers the checkout to activation), so the version comparison still offers the update',
                }
                : { verdict: 'defect-confirmed', why: '/health carries no prepared-state signal while the source is already at the release: the update entry point vanishes' };
        },
    },
    S8: {
        maps: 'B-1056',
        setup: 'a queued restart row left behind by an ABANDONED earlier job on the same build fingerprint',
        contract: 'the abandoned row is superseded with a declared reason, a new row is queued, and the update proceeds',
        // Settled by WI-2 (21c9970d). The pre-P1 defect was `restart_queue_failed`:
        // queueSourceUpdateRestart accepted only a row already bound to this job
        // and refused everything else, so a retry after an aborted job could
        // never queue its own restart.
        knownDefect: null,
        stopBeforeActivation: true,
        // The fingerprint must MATCH — getQueuedByActionType keys on
        // expected_server_build_id, and supersedeOtherGenerations clears every
        // other generation first, so a row seeded with an invented build id can
        // never reach the branch this scenario exists to test. The only way to
        // hold the right fingerprint is to let a real job produce it and then
        // abandon that job.
        staleFromPriorJob: true,
        verdict(context) {
            if (!context.priorJob) return { verdict: 'fail', why: `the first job never staged a restart row (state=${context.priorJob?.state})` };
            if (context.job?.error?.code === 'restart_queue_failed') {
                return { verdict: 'defect-confirmed', why: 'a row from the abandoned job blocked the queue on the same build fingerprint — exactly B-1056' };
            }
            if (context.job?.state !== 'restart_queued') {
                return { verdict: 'fail', why: `unexpected outcome: state=${context.job?.state} code=${context.job?.error?.code}` };
            }
            const supersededBy = context.priorRowAfter?.error || '';
            return supersededBy === `superseded_by_job:${context.job.jobId}`
                ? { verdict: 'pass', why: `the abandoned row was superseded as "${supersededBy}" and the retry queued its own restart` }
                : { verdict: 'fail', why: `the retry queued a restart but the abandoned row was not settled with a declared reason (status=${context.priorRowAfter?.status} error=${supersededBy || 'none'})` };
        },
    },
    S9: {
        maps: 'B-1057',
        setup: 'a pending restart row, bound to the RUNNING build, whose execution_attempt_nonce is not NULL',
        contract: 'boot settles the row; no button appears for a build that is already running',
        // Settled by WI-1 (2c0148c1): moveToPending clears the nonce and
        // clearSatisfiedBefore no longer requires it to be NULL.
        knownDefect: null,
        // No update job: B-1057 is a BOOT reconciliation defect, and the row
        // must carry the build id this process actually loaded — boot settles
        // only rows bound to the running generation.
        skipUpdateJob: true,
        seedBootRow: true,
        rebootBeforeVerdict: true,
        verdict(context) {
            if (!context.seededRow?.expected_server_build_id) {
                return { verdict: 'fail', why: '/health published no loaded server build id, so no row could be bound to the running build' };
            }
            if (!context.rebootHealth) return { verdict: 'fail', why: 'the node never came back after the reboot' };
            const rows = context.pendingAfterBoot || [];
            const stuck = rows.filter((row) => row?.actionType === 'safe-restart' && row?.status === 'pending');
            return stuck.length === 0
                ? { verdict: 'pass', why: 'the nonce-bearing pending row was settled at boot' }
                : { verdict: 'defect-confirmed', why: `${stuck.length} safe-restart row(s) remained pending after boot — exactly B-1057` };
        },
    },
    S10: {
        maps: 'the pm2 ESM entry obstacle (memory §4)',
        setup: 'pm2 launches the entry the release itself ships',
        contract: 'after the governed restart the replacement process listens, with no hand-written wrapper',
        async verdict(context) {
            const health = await waitForHealth(context.meta, { timeoutMs: 180_000, expectVersion: context.expectedVersion });
            if (!health) return { verdict: 'fail', why: 'the replacement process never started listening (the pm2 ESM-entry obstacle)' };
            return healthVersion(health) === context.expectedVersion
                ? { verdict: 'pass', why: `the replacement process serves ${healthVersion(health)} after the governed restart` }
                : { verdict: 'fail', why: `the node is listening but still serves ${healthVersion(health)}` };
        },
    },
    S11: {
        maps: 'qa-critic C3 (the node installer produced a node that cannot boot)',
        setup: 'the node is installed THROUGH scripts/install-node.mjs and pm2 starts the ecosystem that installer generated',
        contract: 'pm2 runs <appRoot>/dist-server/server/index.js from the app root, /health answers,'
            + ' the pre-flight pm2_entry code is clear and the doctor verifies the pm2 service account',
        knownDefect: {
            code: 'runtime_root_invalid',
            note: 'pre-fix the generated ecosystem inherited <deployRoot>/launcher/pm2-entry.mjs, which exits'
                + ' without a sealed release store; with no cwd pm2 ran from config/ and the doctor stayed "unverified"',
        },
        installThroughInstaller: true,
        verdict(context) {
            const install = context.install;
            if (!install?.ok) return { verdict: 'fail', why: `the installer stopped: ${install?.error}` };
            const expectedScript = path.join(NODE_APP, 'dist-server', 'server', 'index.js');
            const pm2 = context.pm2Process;
            if (!context.bootHealth) {
                return pm2?.script && path.basename(pm2.script) === 'pm2-entry.mjs'
                    ? { verdict: 'defect-confirmed', why: `pm2 runs ${pm2.script} and the node never answered /health — exactly C3` }
                    : { verdict: 'fail', why: `the installed node never answered /health (pm2 script=${pm2?.script} cwd=${pm2?.cwd} status=${pm2?.status})` };
            }
            const problems = [];
            if (install.ecosystem?.script !== expectedScript) problems.push(`generated script ${install.ecosystem?.script}`);
            if (pm2?.script !== expectedScript) problems.push(`pm2 script ${pm2?.script}`);
            if (pm2?.cwd !== NODE_APP) problems.push(`pm2 cwd ${pm2?.cwd}`);
            if (context.pm2EntryCheck?.ok !== true) problems.push(`pm2_entry ${context.pm2EntryCheck?.severity}: ${context.pm2EntryCheck?.reason_en}`);
            if (!context.doctor?.serviceAccountVerified) problems.push('the doctor could not verify the pm2 service account');
            return problems.length
                ? { verdict: 'fail', why: `booted, but: ${problems.join('; ')}` }
                : { verdict: 'pass', why: `installed by install-node.mjs, pm2 runs ${expectedScript} from the app root, /health serves ${healthVersion(context.bootHealth)}, pm2_entry clear, doctor verified the service account` };
        },
    },
    /* -------------------------------------------- S12: E1 serving */
    S12: {
        maps: 'ADR-156 §3 E1',
        setup: 'E1 static overlay with real hub content, ownership check, CSP',
        contract: '/hub served before/after/after-rollback; zero console errors; ACAO:*; no dirty_worktree',
        async verdict() {
            // The lab node runs as the nassaj uid (non-root).
            // defaultManifestOwnershipOk requires stat.uid !== euid, which fails for
            // a user-owned config/node-overlay.json. Mounting E1 is therefore
            // impossible in the lab without sudo, so the serving path is not reached.
            // E1 HTTP behaviour is covered by W3 unit tests (node-overlay-static.test.js).
            return {
                verdict: 'inconclusive',
                why: 'E1 serving requires a root-owned (stat.uid !== euid) config/node-overlay.json.'
                    + ' Lab runs as the nassaj user — cannot create root-owned files without sudo.'
                    + ' E1 serving is covered by W3 unit tests with an injectable ownership verifier.',
            };
        },
    },

    /* -------------------------------------------- S13: mount conflict blocks update */
    S13: {
        maps: 'ADR-156 §3.1 E1 + §6 node_overlay_mount_conflict',
        setup: 'config/node-overlay.json with /hub mount; release 9.0.0.10 adds public/hub/index.html',
        contract: 'node_overlay_mount_conflict fires in the worker before npm ci; job fails; no candidate, no restart row',
        async prepare(context) {
            // Add release 9.0.0.10 to the bare fixture with the conflicting file (idempotent).
            ensureFixtureRelease('9.0.0.10', [
                { path: 'public/hub/index.html', content: '<!DOCTYPE html><html><body>hub</body></html>\n' },
            ]);
            // Plant a valid overlay config in the lab node (restored tree, before start).
            const configDir = path.join(NODE_APP, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'node-overlay.json'), JSON.stringify({
                schema: 1,
                static: [{ mount: '/hub', dir: 'hub' }],
            }, null, 2) + '\n');
            // Override the target version for this scenario.
            context.expectedVersion = '9.0.0.10';
        },
        verdict(context) {
            const { job } = context;
            if (!job) return { verdict: 'fail', why: 'no job was created or polled' };
            if (job.state === 'failed' && job.error?.code === 'node_overlay_mount_conflict') {
                return {
                    verdict: 'pass',
                    why: `job ${context.jobCreate?.body?.jobId} failed with node_overlay_mount_conflict before npm ci — ADR-156 §3.1/§6 confirmed`,
                };
            }
            return {
                verdict: 'fail',
                why: `expected failed/node_overlay_mount_conflict; got state=${job.state} error=${job.error?.code ?? 'none'} (${job.error?.message ?? ''})`,
            };
        },
    },

    /* -------------------------------------------- S14: non_fast_forward + dependency class */
    S14: {
        maps: 'ADR-156 §3.2 non_fast_forward + W2 divergence classification',
        setup: 'lab node has a local package.json commit → divergence category=dependency',
        contract: 'update job fails with non_fast_forward; divergence.category=dependency; no reset, no rewrite',
        async prepare(context) {
            // Add a local commit to NODE_APP that modifies package.json.
            // This makes HEAD not an ancestor of the 9.0.0.1 release commit → non_fast_forward.
            const pkgPath = path.join(NODE_APP, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            // A field that classifyDivergence categorises as 'dependency' (package.json is in DEPENDENCY_PATHS).
            pkg._labAllowScripts = { 'test-dep': true };
            fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
            const addResult = spawnSync('git', ['add', 'package.json'], {
                cwd: NODE_APP, encoding: 'utf8',
                env: { ...process.env, ...S13_IDENTITY },
            });
            if (addResult.status !== 0) fail(`git add failed in NODE_APP: ${addResult.stderr}`);
            const commitResult = spawnSync(
                'git', ['commit', '-m', 'test(S14): local allowScripts divergence fixture', '--no-verify'],
                {
                    cwd: NODE_APP, encoding: 'utf8',
                    env: {
                        ...process.env,
                        GIT_AUTHOR_NAME: S13_IDENTITY.GIT_AUTHOR_NAME,
                        GIT_AUTHOR_EMAIL: S13_IDENTITY.GIT_AUTHOR_EMAIL,
                        GIT_COMMITTER_NAME: S13_IDENTITY.GIT_COMMITTER_NAME,
                        GIT_COMMITTER_EMAIL: S13_IDENTITY.GIT_COMMITTER_EMAIL,
                    },
                },
            );
            if (commitResult.status !== 0) fail(`git commit failed in NODE_APP: ${commitResult.stderr}`);
            log('S14: planted a local package.json commit in NODE_APP');
        },
        verdict(context) {
            const { job } = context;
            if (!job) return { verdict: 'fail', why: 'no job was created or polled' };
            // The update guard also checks for a dirty worktree; ensure it's the right error.
            if (job.state === 'failed' && job.error?.code === 'non_fast_forward') {
                return {
                    verdict: 'pass',
                    why: `job ${job.id} failed with non_fast_forward (local package.json commit = dependency class) — ADR-156 §3.2 confirmed`,
                };
            }
            return {
                verdict: 'fail',
                why: `expected failed/non_fast_forward; got state=${job.state} error=${job.error?.code ?? 'none'}`,
            };
        },
    },

    /* -------------------------------------------- S15: awaiting_sessions → accepted (deferral happy path) */
    S15: {
        maps: 'ADR-156 §3.3 deferral happy path — M2 two-sample promotion',
        setup: 'job seeded in awaiting_sessions; sessions=0 throughout; scheduler promotes after two idle samples',
        contract: 'job transitions from awaiting_sessions to accepted (then further) within 2 scheduler intervals',
        skipUpdateJob: true,
        async verdict(context) {
            const token = await ownerToken(context.meta);
            // Seed a deferred job directly — the HTTP path would put it in accepted (0 sessions in lab).
            const jobId = seedDeferralJob(context.meta, {
                expectedVersion: context.fixture.latest.version,
                deferralDeadlineAt: Date.now() + 10 * 60_000,
            });
            log(`S15: seeded awaiting_sessions job ${jobId}; waiting for scheduler promotion (≤90s)`);
            // The scheduler runs every 30s with a 30s debounce → first sample stamps idle_observed_at,
            // second sample (≥30s later) promotes to accepted. Allow 90s total.
            const deadline = Date.now() + 90_000;
            let jobRow = null;
            while (Date.now() < deadline) {
                const r = await api(context.meta, `/api/system/update/jobs/${jobId}`, { token });
                if (r.status === 200 && r.json) {
                    jobRow = r.json;
                    if (jobRow.state !== 'awaiting_sessions') break;
                }
                await sleep(3000);
            }
            if (!jobRow || jobRow.state === 'awaiting_sessions') {
                return {
                    verdict: 'fail',
                    why: `job never promoted from awaiting_sessions within 90s; last state: ${jobRow?.state ?? 'unknown'}`,
                };
            }
            return {
                verdict: 'pass',
                why: `awaiting_sessions job promoted to ${jobRow.state} after scheduler debounce — ADR-156 §3.3 M2 two-sample promotion confirmed`,
            };
        },
    },

    /* -------------------------------------------- S16: deferral_expired when deadline past */
    S16: {
        maps: 'ADR-156 §3.3 deferral expiry path',
        setup: 'job seeded in awaiting_sessions with a deadline 60s in the past; scheduler expires it',
        contract: 'job transitions to failed/deferral_expired on the next scheduler tick (≤35s)',
        skipUpdateJob: true,
        async verdict(context) {
            const token = await ownerToken(context.meta);
            // Seed with a past deadline — scheduler expires it on the next tick.
            const jobId = seedDeferralJob(context.meta, {
                expectedVersion: context.fixture.latest.version,
                deferralDeadlineAt: Date.now() - 60_000,
            });
            log(`S16: seeded past-deadline awaiting_sessions job ${jobId}; waiting for expiry (≤35s)`);
            const deadline = Date.now() + 35_000;
            let jobRow = null;
            while (Date.now() < deadline) {
                const r = await api(context.meta, `/api/system/update/jobs/${jobId}`, { token });
                if (r.status === 200 && r.json) {
                    jobRow = r.json;
                    if (jobRow.state === 'failed') break;
                }
                await sleep(2000);
            }
            if (jobRow?.state === 'failed' && jobRow?.error?.code === 'deferral_expired') {
                return {
                    verdict: 'pass',
                    why: `past-deadline awaiting_sessions job expired to failed/deferral_expired — ADR-156 §3.3 expiry contract confirmed`,
                };
            }
            return {
                verdict: 'fail',
                why: `expected failed/deferral_expired; got state=${jobRow?.state ?? 'unknown'} error=${jobRow?.error?.code ?? 'none'}`,
            };
        },
    },

    /* -------------------------------------------- S17: node_env_not_loaded */
    S17: {
        maps: 'ADR-156 §3.4 E3 node_env_not_loaded — M12',
        setup: 'config/node.env declares TMPDIR=/var/tmp; process launched without TMPDIR in ecosystem env',
        contract: 'node_env_not_loaded fires as a blocker in the preflight despite serviceEnv showing TMPDIR',
        skipUpdateJob: true,
        async prepare() {
            // Plant config/node.env declaring TMPDIR=/var/tmp (the correct value the operator intends).
            // Set the ecosystem to use TMPDIR=/tmp instead — a different value, simulating a node
            // whose pm2 state predates the config/node.env addition.
            // When the live process starts with TMPDIR=/tmp but config/node.env declares /var/tmp,
            // checkNodeEnvLoaded sees a mismatch → node_env_not_loaded blocker.
            const configDir = path.join(NODE_APP, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'node.env'), 'TMPDIR=/var/tmp\n');
            // Override ecosystem TMPDIR to a different value (/tmp) so the live /proc env mismatches.
            const ecoText = fs.readFileSync(ECOSYSTEM, 'utf8');
            const modified = ecoText.replace('"TMPDIR": "/var/tmp"', '"TMPDIR": "/tmp"');
            if (modified === ecoText) fail('S17: could not find TMPDIR value in ecosystem');
            fs.writeFileSync(ECOSYSTEM, modified);
            log('S17: ecosystem TMPDIR=/tmp, config/node.env TMPDIR=/var/tmp → mismatch test');
        },
        async verdict(context) {
            const token = await ownerToken(context.meta);
            const r = await api(context.meta, '/api/system/update/preflight', { token });
            if (r.status !== 200) {
                return { verdict: 'fail', why: `preflight returned HTTP ${r.status}: ${r.text?.slice(0, 200)}` };
            }
            const checks = r.json?.checks || [];
            const envCheck = checks.find((c) => c.code === 'node_env_not_loaded');
            if (!envCheck) {
                return { verdict: 'fail', why: 'node_env_not_loaded check missing from preflight response' };
            }
            if (envCheck.severity === 'blocker') {
                return {
                    verdict: 'pass',
                    why: `node_env_not_loaded is a blocker (TMPDIR declared in config/node.env=/var/tmp but live process has different value — reads from /proc/<pid>/environ, not serviceEnv) — ADR-156 §3.4 M12 confirmed`,
                };
            }
            return {
                verdict: 'fail',
                why: `expected node_env_not_loaded=blocker; got severity=${envCheck.severity} reason=${envCheck.reason_en}`,
            };
        },
    },

    /* -------------------------------------------- S18: PTY session gate */
    S18: {
        maps: 'ADR-156 §3.3 M2 PTY gate — readGateSessionCount /proc walk',
        setup: 'live PTY shell with no governed session; scheduler should NOT promote',
        contract: 'the readGate /proc scanner counts the PTY as a session and blocks promotion',
        async verdict() {
            // The /proc gate in safe-restart.sh matches specific Claude CLI process patterns.
            // Creating a convincing fake PTY process that passes the pattern match without a
            // real Claude session is unreliable in the lab environment.
            return {
                verdict: 'inconclusive',
                why: 'Simulating a PTY shell that matches the safe-restart.sh /proc pattern requires a real'
                    + ' Claude CLI process or precise /proc tree faking — not reliable in the lab.'
                    + ' The PTY gate is covered by W7 unit tests (update-deferral-scheduler.test.js).',
            };
        },
    },

    /* -------------------------------------------- S19: pm2_entry blocker */
    S19: {
        maps: 'ADR-156 §6 pm2_entry — fleet node layout',
        setup: 'ecosystem script points to pm2-entry.mjs wrapper; server boots normally but pm2 records pm2-entry.mjs',
        contract: 'pm2_entry check fires as a blocker with the pm2-entry.mjs path',
        skipUpdateJob: true,
        async prepare() {
            // Create a pm2-entry.mjs wrapper that imports the real server entry.
            const entryPath = path.join(NODE_APP, 'pm2-entry.mjs');
            fs.writeFileSync(entryPath,
                '// S19 test fixture: pm2-entry.mjs wrapper\n'
                + "import './dist-server/server/index.js';\n");
            // Modify the ecosystem to run via pm2-entry.mjs (script basename triggers the check).
            const ecoText = fs.readFileSync(ECOSYSTEM, 'utf8');
            const modified = ecoText.replace("'dist-server/server/index.js'", "'pm2-entry.mjs'");
            if (modified === ecoText) fail('S19: could not find dist-server/server/index.js in ecosystem');
            fs.writeFileSync(ECOSYSTEM, modified);
            log('S19: ecosystem script changed to pm2-entry.mjs');
        },
        async verdict(context) {
            const token = await ownerToken(context.meta);
            const r = await api(context.meta, '/api/system/update/preflight', { token });
            if (r.status !== 200) {
                return { verdict: 'fail', why: `preflight returned HTTP ${r.status}: ${r.text?.slice(0, 200)}` };
            }
            const checks = r.json?.checks || [];
            const pm2Check = checks.find((c) => c.code === 'pm2_entry');
            if (!pm2Check) {
                return { verdict: 'fail', why: 'pm2_entry check missing from preflight response' };
            }
            if (pm2Check.severity === 'blocker') {
                return {
                    verdict: 'pass',
                    why: `pm2_entry is a blocker (pm2 running from pm2-entry.mjs basename) — ADR-156 §6 pm2_entry gate confirmed`,
                };
            }
            return {
                verdict: 'fail',
                why: `expected pm2_entry=blocker; got severity=${pm2Check.severity} reason=${pm2Check.reason_en}`,
            };
        },
    },

    /* -------------------------------------------- S20: npm 12 allowScripts behaviour */
    S20: {
        maps: 'ADR-156 §3 W14 pending — npm 12 script-blocking behaviour',
        setup: 'candidate build under npm 12 with/without allowScripts',
        contract: 'proves whether npm 12 blocks lifecycle scripts by default (informs owner decision 2 and W14)',
        deferred: 'Requires npm ≥ 12. System has npm 11.x (run `npm --version` to confirm). Re-run once npm 12 is available.',
    },
};

/* ------------------------------------------------ S11: install through the installer */

/**
 * Syntactically valid stand-ins for GitHub's published keys. They land only in
 * the laboratory's own known_hosts: the laboratory has no network by design, so
 * the installer's real ssh probe is simulated below and never uses them.
 */
const LAB_HOST_KEYS = Object.freeze([
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUpdateLabOnlyNotAKey',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIUpdateLabOnly',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQUpdateLabOnly',
]);

const labMetaFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ssh_keys: LAB_HOST_KEYS }) });

/** The environment of every laboratory child that must reach the lab pm2 daemon and the shim. */
function labChildEnvironment(meta) {
    return { ...process.env, ...labEnvironment(meta), PM2_HOME, GIT_SSH_COMMAND: SSH_SHIM };
}

/**
 * The installer's own `spawnSync`, with exactly the two network edges replaced:
 * GitHub's ssh greeting is simulated, and `git ls-remote` is routed through the
 * fetch-only shim to the local bare fixture. Every write the installer makes is
 * real; so is its closing doctor run, pointed at the laboratory pm2 daemon.
 */
function labInstallerSpawn(meta) {
    return (command, args, options = {}) => {
        if (command === 'ssh') {
            return { status: 1, stdout: '', stderr: "Hi update-lab! You've successfully authenticated, but GitHub does not provide shell access." };
        }
        let env = options.env;
        if (command === 'git' && args.includes('ls-remote')) env = { ...(env || process.env), GIT_SSH_COMMAND: SSH_SHIM };
        if (command === process.execPath) env = labChildEnvironment(meta);
        return spawnSync(command, args, { ...options, env });
    };
}

/** Run the node's OWN installer — the release under test — against the node's own tree. */
async function installThroughInstaller(meta) {
    const installer = await import(pathToFileURL(path.join(NODE_APP, 'scripts', 'install-node.mjs')).href);
    const home = path.join(NODE_ROOT, 'installer-home');
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const output = [];
    try {
        const result = await installer.installNode({
            appRoot: NODE_APP, node: 'lab', port: String(meta.port), processName: PROC_NAME,
            databasePath: path.join(NODE_DATA, 'auth.db'), assumeYes: true, homeDir: home,
            env: { ...process.env, USER: process.env.USER || 'update-lab' },
            spawn: labInstallerSpawn(meta), fetch: labMetaFetch,
            output: { write: (text) => { output.push(String(text)); } },
        });
        return {
            ok: true, steps: result.steps.map((entry) => entry.step), ecosystem: result.ecosystem,
            preflightStatus: result.preflight.status,
        };
    } catch (error) {
        return { ok: false, error: `${error.code || 'error'}: ${error.message}`, action: error.action || null, output: output.join('') };
    }
}

function labPm2(args, meta) {
    return run('/usr/bin/pm2', args, {
        env: labChildEnvironment(meta), cwd: NODE_APP, timeout: 20_000, killSignal: 'SIGKILL',
    });
}

/** The laboratory process as pm2 itself records it: script, cwd, status, restarts. */
function labPm2Process(meta) {
    const list = labPm2(['jlist'], meta);
    try {
        const app = JSON.parse(list.stdout.slice(list.stdout.indexOf('['))).find((entry) => entry?.name === PROC_NAME);
        return app ? {
            script: app.pm2_env?.pm_exec_path ?? null, cwd: app.pm2_env?.pm_cwd ?? null,
            status: app.pm2_env?.status ?? null, restarts: app.pm2_env?.restart_time ?? null,
        } : null;
    } catch { return null; }
}

/** The node's own pre-flight, in-process, against the laboratory pm2 daemon. */
async function labPreflight(meta) {
    const checks = await import(pathToFileURL(path.join(NODE_APP, 'scripts', 'lib', 'update-preflight-checks.mjs')).href);
    const result = await checks.runUpdatePreflightChecks({
        appRoot: NODE_APP, env: labChildEnvironment(meta), activeSessionCount: () => 0,
    });
    return {
        pm2Entry: result.checks.find((check) => check.code === 'pm2_entry') || null,
        summary: result.checks.map((check) => `${check.code}=${check.severity}`),
    };
}

/** `doctor.mjs --update-preflight` as the operator would run it on this node. */
function labDoctor(meta) {
    const result = spawnSync(process.execPath, [path.join(NODE_APP, 'scripts', 'doctor.mjs'), '--update-preflight'], {
        cwd: NODE_APP, env: labChildEnvironment(meta), encoding: 'utf8', timeout: 180_000,
    });
    // eslint-disable-next-line no-control-regex
    const stdout = (result.stdout || '').replace(/\[[0-9;]*m/g, '');
    return {
        status: result.status,
        serviceAccountVerified: !/cannot be verified|UNTRUSTED|FALSE GREEN/.test(stdout),
        tail: stdout.split('\n').slice(-40).join('\n'),
    };
}

async function runInstallerScenario(id, scenario, { meta, startedAt, options }) {
    const context = { meta, id };
    log(`${id}: installing the node through ${path.join(NODE_APP, 'scripts', 'install-node.mjs')}`);
    context.install = await installThroughInstaller(meta);
    if (context.install.ok) {
        log(`${id}: pm2 start ${context.install.ecosystem.path}`);
        const started = labPm2(['start', context.install.ecosystem.path], meta);
        context.pm2Start = { code: started.code, stderr: started.stderr.slice(-2000) };
        context.bootHealth = await waitForHealth(meta, { timeoutMs: 180_000 });
        context.pm2Process = labPm2Process(meta);
        const preflight = await labPreflight(meta);
        context.pm2EntryCheck = preflight.pm2Entry;
        context.preflightSummary = preflight.summary;
        context.doctor = labDoctor(meta);
    }
    const verdict = scenario.verdict(context);
    const result = {
        scenario: id, maps: scenario.maps, setup: scenario.setup, contract: scenario.contract,
        knownDefect: scenario.knownDefect || null, startedAt, finishedAt: new Date(),
        install: context.install, pm2Start: context.pm2Start, pm2Process: context.pm2Process,
        bootHealth: context.bootHealth ? { version: healthVersion(context.bootHealth) } : null,
        pm2EntryCheck: context.pm2EntryCheck, preflightSummary: context.preflightSummary,
        doctor: context.doctor, gitAfter: gitIdentity(),
        ...verdict,
    };
    const file = path.join(RESULTS_ROOT, `${id}-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    writeJson(file, result);
    log(`${id} ${verdict.verdict.toUpperCase()} — ${verdict.why}`);
    log(`${id} evidence: ${file}`);
    if (options.keep !== true) provision(['stop']);
    return result;
}

/* ----------------------------------------------------------------- driver */

/** Open the laboratory node's database with the node's own better-sqlite3. */
function labDatabase(meta, { readonly = false } = {}) {
    const require = createRequire(path.join(NODE_APP, 'package.json'));
    const Database = require('better-sqlite3');
    return new Database(path.join(meta.dataRoot, 'auth.db'), { readonly });
}

/**
 * Seed a pending restart row bound to `expectedServerBuildId` (S9).
 *
 * `requested_at` is backdated: boot reconciliation settles only rows requested
 * no later than the process start it is reconciling against.
 */
function seedRestartRow(meta, { withNonce, expectedServerBuildId }) {
    const database = labDatabase(meta);
    const columns = database.prepare('PRAGMA table_info(pending_server_actions)').all().map((row) => row.name);
    const values = {
        id: crypto.randomUUID(), action_type: 'safe-restart', status: 'pending',
        expected_server_build_id: expectedServerBuildId,
        reason: 'update-lab seeded row for the running build',
        requested_at: new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19),
        ...(withNonce && columns.includes('execution_attempt_nonce') ? { execution_attempt_nonce: crypto.randomUUID() } : {}),
    };
    const usable = Object.keys(values).filter((key) => columns.includes(key) && values[key] != null);
    database.prepare(
        `INSERT INTO pending_server_actions (${usable.join(',')}) VALUES (${usable.map((key) => `@${key}`).join(',')})`,
    ).run(Object.fromEntries(usable.map((key) => [key, values[key]])));
    database.close();
    return values;
}

/**
 * Abandon the job that owns the queued restart row (S8): drive its update job
 * to a terminal state so the row becomes exactly what B-1056 is about — consent
 * granted for a package nobody will activate any more, sitting on the build
 * fingerprint the next job is about to compute.
 */
function abandonQueuedRestartOwner(meta) {
    const database = labDatabase(meta);
    const row = database.prepare(
        "SELECT id, source_update_job_id, expected_server_build_id FROM pending_server_actions"
        + " WHERE action_type = 'safe-restart' AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    ).get();
    if (row?.source_update_job_id) {
        database.prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = ?").run(row.source_update_job_id);
    }
    database.close();
    return row || null;
}

/** Read one pending_server_actions row by id (S8 evidence). */
function readRestartRow(meta, id) {
    const database = labDatabase(meta, { readonly: true });
    const row = database.prepare('SELECT id, status, error, source_update_job_id FROM pending_server_actions WHERE id = ?').get(id);
    database.close();
    return row || null;
}

async function runScenario(id, options) {
    const scenario = SCENARIOS[id];
    if (!scenario) fail(`unknown scenario ${id}; known: ${Object.keys(SCENARIOS).join(', ')}`);
    const startedAt = new Date();
    if (scenario.deferred) {
        const result = { scenario: id, maps: scenario.maps, verdict: 'deferred', why: scenario.deferred, startedAt };
        log(`S-${id} DEFERRED — ${scenario.deferred}`);
        writeJson(path.join(RESULTS_ROOT, `${id}-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`), result);
        return result;
    }

    const fixture = readJson(FIXTURE_META);
    if (!fixture) fail('no fixture; run scripts/update-lab/create-fixture-repo.mjs');
    const timeoutMs = Number(options['timeout-ms']) || DEFAULT_TIMEOUT_MS;

    log(`${id}: resetting the laboratory node to zero`);
    provision(['restore', '--name', String(options.snapshot || 'base')]);
    const meta = readJson(NODE_META);
    if (!meta) fail('no node metadata after restore');
    assertLabSafety({ port: meta.port });
    if (scenario.installThroughInstaller) return runInstallerScenario(id, scenario, { meta, startedAt, options });

    const context = { meta, fixture, expectedVersion: fixture.latest.version, id };
    if (scenario.prepare) await scenario.prepare(context);

    log(`${id}: starting the node on port ${meta.port}`);
    provision(['start']);
    const boot = await waitForHealth(meta, { timeoutMs: 180_000 });
    if (!boot) fail(`${id}: the laboratory node never became healthy; see .artifacts/update-lab/node/logs/`);
    context.bootHealth = boot;

    const token = await ownerToken(meta);
    if (scenario.seedBootRow) {
        context.seededRow = seedRestartRow(meta, {
            withNonce: true, expectedServerBuildId: boot.serverLoadedBuildId ?? null,
        });
        log(`${id}: seeded a nonce-bearing restart row on the RUNNING build ${String(context.seededRow.expected_server_build_id).slice(0, 12)}`);
    }

    const runJob = async () => {
        log(`${id}: creating the update job for ${context.expectedVersion}`);
        const created = await createJob(meta, token, context.expectedVersion);
        context.jobCreate = { status: created.status, body: created.json };
        if (created.status !== 202) {
            return { state: 'not_created', error: { code: created.json?.code, message: created.json?.error } };
        }
        const job = await pollJob(meta, token, created.json.jobId, timeoutMs);
        log(`${id}: job ${created.json.jobId} → ${job?.state}${job?.error ? ` (${job.error.code})` : ''}`);
        return job;
    };

    if (scenario.skipUpdateJob) context.job = null;
    else context.job = await runJob();

    if (scenario.staleFromPriorJob) {
        context.priorJob = context.job;
        if (context.job?.state === 'restart_queued') {
            const abandoned = abandonQueuedRestartOwner(meta);
            context.priorRow = abandoned;
            log(`${id}: abandoned job ${abandoned?.source_update_job_id} leaving row ${abandoned?.id} queued`);
            context.job = await runJob();
            if (abandoned?.id) context.priorRowAfter = readRestartRow(meta, abandoned.id);
        }
    }

    if (context.job?.state === 'restart_queued' && !scenario.stopBeforeActivation) {
        const row = await findPendingRestart(meta, token);
        context.pendingRow = row;
        if (row) {
            log(`${id}: executing the governed activation (pending row ${row.id})`);
            const executed = await api(meta, `/api/system/pending/${row.id}/execute`, { method: 'POST', token, body: {} });
            context.activation = { status: executed.status, body: executed.json };
            await sleep(3000);
        } else {
            context.activation = { status: null, body: { error: 'no pending safe-restart row found' } };
        }
    }
    if (scenario.rebootBeforeVerdict) {
        // A PLAIN process restart, not an activation: B-1057 is about what boot
        // reconciliation does with a row the previous process left behind.
        log(`${id}: restarting the node to exercise boot reconciliation`);
        provision(['stop']);
        provision(['start']);
        context.rebootHealth = await waitForHealth(meta, { timeoutMs: 180_000 });
        if (context.rebootHealth) {
            const pending = await api(meta, '/api/system/pending', { token: await ownerToken(meta) });
            context.pendingAfterBoot = Array.isArray(pending.json) ? pending.json : (pending.json?.actions || []);
        }
    }

    const verdict = await scenario.verdict(context);
    const result = {
        scenario: id, maps: scenario.maps, setup: scenario.setup, contract: scenario.contract,
        knownDefect: scenario.knownDefect || null,
        startedAt, finishedAt: new Date(),
        expectedVersion: context.expectedVersion,
        jobCreate: context.jobCreate, job: context.job,
        priorJob: context.priorJob ? { jobId: context.priorJob.jobId, state: context.priorJob.state } : undefined,
        priorRow: context.priorRow || undefined,
        priorRowAfter: context.priorRowAfter || undefined,
        seededRow: context.seededRow || undefined,
        pendingAfterBoot: context.pendingAfterBoot || undefined,
        preparedSignals: context.preparedSignals || undefined,
        activation: context.activation || null,
        bootHealth: context.bootHealth ? { version: healthVersion(context.bootHealth), restartRequired: context.bootHealth.restartRequired } : null,
        gitAfter: gitIdentity(),
        ...verdict,
    };
    const file = path.join(RESULTS_ROOT, `${id}-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    writeJson(file, result);
    log(`${id} ${verdict.verdict.toUpperCase()} — ${verdict.why}`);
    log(`${id} evidence: ${file}`);
    if (options.keep !== true) provision(['stop']);
    return result;
}

async function main() {
    const { options, positional } = parseArgs(process.argv.slice(2));
    assertLabSafety();
    if (options.list === true || positional.length === 0) {
        for (const [id, scenario] of Object.entries(SCENARIOS)) {
            log(`${id} (${scenario.maps}) — ${scenario.deferred ? 'DEFERRED: needs a private remote' : scenario.setup}`);
        }
        return;
    }
    const results = [];
    for (const id of positional) results.push(await runScenario(id.toUpperCase(), options));
    const failed = results.filter((result) => result.verdict === 'fail');
    process.exitCode = failed.length ? 1 : 0;
    for (const result of results.filter((entry) => entry.verdict === 'inconclusive')) {
        log(`${result.scenario} INCONCLUSIVE — ${result.why}`);
    }
}

await main();
