/**
 * Real fixtures for the activation-path injection tests (ADR-156 WI-13, T-1728).
 *
 * One fixture = a git repository with an original and a target commit, the three
 * live generations, a sealed candidate under the gate's OWN control root, the
 * activation action the recovery runner reads, and a private SQLite database.
 * Nothing is stubbed here; each test decides what to inject and where.
 *
 * `driveOwner` runs in a REAL child process: it performs the forward activation
 * for real up to a chosen phase and parks, so the parent can SIGKILL it and the
 * gate must prove it dead through /proc — never through an injected ownerAlive.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { hashTree } from '../../../scripts/lib/source-update-tree-identity.mjs';
import { createUpdateMaintenanceGate } from '../update-maintenance-gate.js';

export const VERSION = '1.47.0.11';
export const GENERATIONS = Object.freeze({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' });

const TMPFS_MAGIC = 0x01021994;
const DEFAULT_ORIGINAL = Object.freeze({
    '.gitignore': 'dist/\ndist-server/\nnode_modules/\n',
    'shipped.txt': 'original\n',
    'removed.txt': 'removed by the target release\n',
});
const DEFAULT_TARGET = Object.freeze({ 'shipped.txt': 'target\n', 'removed.txt': null, 'added.txt': 'added\n' });

/** A disk-backed scratch parent: the database snapshot refuses tmpfs. */
export function diskTempRoot() {
    const candidate = process.env.TMPDIR || '/var/tmp';
    try {
        if (Number(fs.statfsSync(candidate).type) !== TMPFS_MAGIC) return candidate;
    } catch { /* fall through to the documented disk-backed default */ }
    return '/var/tmp';
}

export function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeFiles(root, files) {
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        if (content === null) { fs.rmSync(file, { force: true }); continue; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
}

function writeGeneration(directory, label, provenance) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'marker.txt'), `${label}\n`);
    if (provenance) fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), `${JSON.stringify(provenance)}\n`);
}

function writePrivateJson(file, value) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return bytes;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Build one fixture. `original`/`target` map a path to its content, `null`
 * meaning absent; the defaults modify, delete and add one file each.
 */
export function createActivationFixture({ original = DEFAULT_ORIGINAL, target = DEFAULT_TARGET } = {}) {
    const base = fs.mkdtempSync(path.join(diskTempRoot(), 'nassaj-activation-inject-'));
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'test');
    writeFiles(root, original);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'original');
    const originalHead = git(root, 'rev-parse', 'HEAD');
    writeFiles(root, target);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'target');
    const targetCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', 'release-target');
    git(root, 'reset', '-q', '--hard', originalHead);

    const transactionId = `update-inject-${crypto.randomBytes(8).toString('hex')}`;
    const clientBuildId = sha256(`client-${transactionId}`);
    const serverBuildId = sha256(`server-${transactionId}`);
    const previous = { commit: originalHead, version: '1.47.0.10', buildId: sha256('previous') };
    writeGeneration(path.join(root, GENERATIONS.client), 'previous-client', { ...previous });
    writeGeneration(path.join(root, GENERATIONS.server), 'previous-server', { ...previous });
    writeGeneration(path.join(root, GENERATIONS.nodeModules), 'previous-node-modules');

    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', transactionId);
    fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
    const provenance = (buildId) => ({ commit: targetCommit, version: VERSION, buildId });
    writeGeneration(path.join(candidateRoot, 'client'), 'target-client', provenance(clientBuildId));
    writeGeneration(path.join(candidateRoot, 'server'), 'target-server', provenance(serverBuildId));
    writeGeneration(path.join(candidateRoot, 'node_modules'), 'target-node-modules');
    const manifestPath = path.join(candidateRoot, 'candidate-manifest.json');
    const manifestBytes = writePrivateJson(manifestPath, {
        schemaVersion: 1, txId: transactionId, releaseCommit: targetCommit, version: VERSION,
        clientBuildId, serverBuildId,
        sourceProvenance: { kind: 'git-worktree', commit: targetCommit, clean: true },
        artifacts: {
            client: { commit: targetCommit, buildId: clientBuildId },
            server: { commit: targetCommit, buildId: serverBuildId },
            nodeModules: { commit: targetCommit },
        },
        trees: {
            client: hashTree(path.join(candidateRoot, 'client')),
            server: hashTree(path.join(candidateRoot, 'server')),
            nodeModules: hashTree(path.join(candidateRoot, 'node_modules')),
        },
    });
    const manifestSha256 = sha256(manifestBytes);
    const action = {
        schema: 'nassaj-source-update-activation/v1', transactionId, originalHead, targetCommit,
        version: VERSION, manifestPath, manifestSha256, expectedServerBuildId: serverBuildId,
    };
    writePrivateJson(path.join(candidateRoot, 'activation-action.json'), action);

    const databaseDirectory = path.join(base, 'data');
    fs.mkdirSync(databaseDirectory, { mode: 0o700 });
    const databasePath = path.join(databaseDirectory, 'db.sqlite');
    execFileSync('/usr/bin/sqlite3', [databasePath, 'CREATE TABLE rows(id INTEGER); INSERT INTO rows VALUES (1);']);
    fs.chmodSync(databasePath, 0o600);

    return {
        base, root, gate, transactionId, originalHead, targetCommit, candidateRoot, manifestPath,
        manifestSha256, serverBuildId, databasePath, action,
        identity: { transactionId, originalHead, targetCommit, expectedVersion: VERSION, manifestSha256 },
        cleanup() {
            // A test may leave a read-only directory behind; restore write access first.
            try { execFileSync('chmod', ['-R', 'u+w', base]); } catch { /* best effort */ }
            fs.rmSync(base, { recursive: true, force: true });
        },
    };
}

/** The durable journal exactly as the next process would read it. */
export function readJournal(fixture) {
    return JSON.parse(fs.readFileSync(fixture.gate.paths.journal, 'utf8'));
}

/** Where HEAD and the release's own paths sit, from git itself. */
export function sourceState(fixture) {
    const head = git(fixture.root, 'rev-parse', 'HEAD');
    const at = (commit) => {
        try { execFileSync('git', ['diff', '--quiet', commit, '--', '.'], { cwd: fixture.root }); return true; } catch { return false; }
    };
    return { head, atOriginal: head === fixture.originalHead && at(fixture.originalHead), atTarget: head === fixture.targetCommit && at(fixture.targetCommit) };
}

/** Whether every live generation equals the named side of the candidate. */
export function generationsAt(fixture) {
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    return Object.entries(GENERATIONS).every(([name, directory]) => {
        const live = hashTree(path.join(fixture.root, directory));
        return live.sha256 === manifest.trees[name].sha256;
    }) ? 'target' : 'previous-or-mixed';
}

/**
 * Child-process body: activate for real up to `stopAt`, then park until killed.
 * `HANDOFF_TORN` reproduces the crash window between the journal's
 * RESTARTING_HANDOFF transition and the descriptor's rename.
 */
export async function driveOwner({ root, identity, stopAt, databasePath, candidateRoot, manifestPath, releaseLeases = false }) {
    const activation = await import('../../../scripts/lib/source-update-activation.mjs');
    const { captureDatabaseSnapshot } = await import('../../../scripts/lib/source-update-database-snapshot.mjs');
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const update = await gate.beginUpdate(identity, { waitMs: 5_000 });
    const park = () => {
        // `releaseLeases` drops the flock leases while the journal still names
        // this living process, so a reader reaches the liveness check itself.
        if (releaseLeases) update.release();
        process.stdout.write('owned\n');
        setInterval(() => {}, 1_000);
        return new Promise(() => {});
    };
    const { originalHead, targetCommit, transactionId } = identity;
    if (stopAt === 'PREPARED') return park();
    update.transition(['PREPARED'], 'SOURCE_APPLYING');
    activation.applySourceManifest({ projectRoot: root, originalHead, targetCommit });
    update.transition(['SOURCE_APPLYING'], 'SOURCE_APPLIED');
    if (stopAt === 'SOURCE_APPLIED') return park();
    update.transition(['SOURCE_APPLIED'], 'INSTALLING');
    captureDatabaseSnapshot({
        databasePath, snapshotRoot: path.join(path.dirname(databasePath), 'nassaj-update-db-snapshots'),
        transactionId, targetCommit,
    });
    const validation = activation.validateCandidate({
        projectRoot: root, candidateRoot, transactionId, releaseCommit: targetCommit,
        version: identity.expectedVersion, manifestPath, manifestSha256: identity.manifestSha256,
    });
    activation.exchangeGenerations(validation, { names: ['nodeModules', 'server', 'client'] });
    activation.verifyRuntimeIdentities(validation);
    update.transition(['INSTALLING'], 'VERIFIED');
    if (stopAt === 'VERIFIED') return park();
    update.transition(['VERIFIED'], 'ACTIVATION_QUEUED');
    if (stopAt === 'HANDOFF_TORN') {
        fs.writeFileSync(path.join(gate.paths.controlRoot, `.bootstrap-handoff.${process.pid}.tmp`), '');
        try { update.prepareBootstrapHandoff(); } catch { /* the journal moved; the descriptor did not */ }
        return park();
    }
    update.prepareBootstrapHandoff();
    return park();
}

/** Run `driveOwner` in a real child and resolve once it owns the gate at `stopAt`. */
export async function startOwnerAt(fixture, stopAt, { releaseLeases = false } = {}) {
    const helper = new URL(import.meta.url).href;
    const spec = {
        root: fixture.root, identity: fixture.identity, stopAt, databasePath: fixture.databasePath,
        candidateRoot: fixture.candidateRoot, manifestPath: fixture.manifestPath, releaseLeases,
    };
    const code = `import { driveOwner } from ${JSON.stringify(helper)};
        await driveOwner(JSON.parse(process.env.NASSAJ_OWNER_SPEC));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, NASSAJ_OWNER_SPEC: JSON.stringify(spec) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (String(chunk).includes('owned')) resolve(); });
        child.once('exit', (status) => reject(new Error(`owner exited early (${status}): ${stderr}`)));
    });
    return {
        pid: child.pid,
        async kill() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
        },
    };
}

/** Start a real owner, SIGKILL it once it owns the gate, and return its pid. */
export async function killedOwnerAt(fixture, stopAt) {
    const owner = await startOwnerAt(fixture, stopAt);
    await owner.kill();
    return owner.pid;
}
