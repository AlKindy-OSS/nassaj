// upgrade-path-gate.mjs — the previous-release → candidate upgrade-path gate (B-1584).
//
// B-1583 shipped because no gate ran the PREVIOUS release's update code against
// the candidate: v2.3.1.0's writer added `previousRuntimeOid` to
// activation-action.json, its own command-board reader required exactly eight
// keys, and every button update from it failed at the governed safe restart.
//
// This gate builds one disk-backed sandbox and drives the real update code of
// two installed trees (the previous tag and the candidate) across the seam that
// separates them:
//
//   previous-writer                   previous tree's worker + updater stage the
//                                     candidate (see upgrade-path-probe.mjs)
//   previous-reader-before-restart    previous tree resolves the queued
//                                     safe-restart row (the old process executes it)
//   candidate-reader-after-restart    candidate tree resolves the same row
//   candidate-bootstrap-after-restart candidate's boot-time action read and
//                                     validateCandidate (the replacement process)
//   candidate-writer                  candidate tree stages the NEXT update
//   candidate-reader-next-update      candidate tree resolves its own action
//   candidate-bootstrap-next-update   candidate's boot-time read of its own action
//   previous-reader-of-candidate-action (advisory) the previous tree reads the
//                                     candidate writer's action: forward compat
//                                     for a manual downgrade, never blocking
//
// The sandbox: a bare "release remote" whose objects are borrowed read-only
// from the source repository (alternates), node clones on branch main whose
// `origin` is a credential-free GitHub SSH URL and whose core.sshCommand is a
// local transport shim (the updater composes a node's own sshCommand, so the
// previous release's code runs unmodified), private HOME/TMPDIR/database per
// leg, and no process manager, port, network or live path. Nothing outside the
// sandbox is written; the source repository is only read.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync,
    writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEUTRAL_GIT_ENV, git } from './upgrade-path-gate-git.mjs';
import { ensurePrivateDirectory, verifyTreeRoot } from './upgrade-path-trees.mjs';

export { git };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_FILE = path.join(HERE, 'upgrade-path-probe.mjs');
export const CANDIDATE_BUILD_WRAPPER = path.join(HERE, 'upgrade-path-candidate-build.mjs');
export const KNOWN_INCOMPATIBLE_FILE = path.join(HERE, '..', 'release-upgrade-path-known-incompatible.json');
const KNOWN_INCOMPATIBLE_SCHEMA = 'nassaj-upgrade-path-known-incompatible/v1';
const TMPFS_MAGIC = 0x01021994;
const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
// A neutral, non-existent release source: the transport shim serves it locally.
export const GATE_REMOTE = Object.freeze({ host: 'github.com', path: 'nassaj-upgrade-gate/nassaj.git' });
const GATE_REMOTE_URL = `git@${GATE_REMOTE.host}:${GATE_REMOTE.path}`;

/** The legs, in execution order. `blocking: false` is reported, never fails the gate. */
export const LEGS = Object.freeze([
    { id: 'previous-writer', blocking: true },
    { id: 'previous-reader-before-restart', blocking: true },
    { id: 'candidate-reader-after-restart', blocking: true },
    { id: 'candidate-bootstrap-after-restart', blocking: true },
    { id: 'candidate-writer', blocking: true },
    { id: 'candidate-reader-next-update', blocking: true },
    { id: 'candidate-bootstrap-next-update', blocking: true },
    { id: 'previous-reader-of-candidate-action', blocking: false },
]);

/** Legs a known-incompatible entry may name: a blocking reader, never a writer. */
const EXCUSABLE_LEGS = new Set(LEGS.filter((leg) => leg.blocking && !leg.id.endsWith('-writer')).map((leg) => leg.id));

/** Bump the last numeric segment of a four-part version (2.3.1.3 -> 2.3.1.4). */
export function nextVersion(version) {
    if (!VERSION_PATTERN.test(version)) throw new Error(`not a four-part version: ${version}`);
    const parts = version.split('.');
    parts[3] = String(Number(parts[3]) + 1);
    return parts.join('.');
}

/** Refuse a tmpfs parent: the updater's own storage gate refuses it too (ADR-141). */
export function assertDiskBacked(directory) {
    if (Number(statfsSync(directory).type) === TMPFS_MAGIC) {
        throw new Error(`upgrade-path gate: ${directory} is tmpfs; use a disk-backed TMPDIR such as /var/tmp`);
    }
}

/** Create the private sandbox root (0700, realpath, disk-backed). */
export function createSandbox(parent) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertDiskBacked(parent);
    const root = realpathSync(mkdtempSync(path.join(parent, 'upgrade-path-')));
    chmodSync(root, 0o700);
    for (const name of ['home', 'tmp', 'results', 'bin']) mkdirSync(path.join(root, name), { mode: 0o700 });
    // First on PATH: any ssh that bypasses the node's core.sshCommand shim is refused.
    writeFileSync(path.join(root, 'bin', 'ssh'), '#!/bin/sh\necho "upgrade-path gate: network ssh refused" >&2\nexit 255\n',
        { mode: 0o700 });
    // Likewise npm: the candidate build fakes npm in-process, so any real npm call is a leak.
    writeFileSync(path.join(root, 'bin', 'npm'), '#!/bin/sh\necho "upgrade-path gate: npm refused" >&2\nexit 1\n',
        { mode: 0o700 });
    return root;
}

/**
 * The ssh transport shim: serves only the gate's remote path from the local bare
 * repository, so git's real upload-pack protocol runs end to end with no network.
 */
export function sshShimScript(barePath) {
    const quoted = `'${barePath.replace(/'/g, `'\\''`)}'`;
    return `#!/bin/sh
# upgrade-path gate transport shim: never reaches a network.
for last in "$@"; do :; done
case "$last" in
  "git-upload-pack '${GATE_REMOTE.path}'"|"git-upload-pack '/${GATE_REMOTE.path}'") exec git-upload-pack ${quoted} ;;
esac
echo "upgrade-path gate shim refused: $last" >&2
exit 1
`;
}

/** Read the package.json version of a commit in the source repository. */
function versionAt(sourceRepo, commit) {
    return JSON.parse(git(sourceRepo, ['show', `${commit}:package.json`])).version;
}

/**
 * Commit the synthetic NEXT release in the bare remote: the candidate tree with
 * only package.json's version bumped. Built with plumbing, no checkout.
 */
function commitNextRelease({ bare, candidateCommit, version }) {
    const manifest = JSON.parse(git(bare, ['show', `${candidateCommit}:package.json`]));
    manifest.version = version;
    const blob = git(bare, ['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(manifest, null, 2)}\n` });
    const index = path.join(bare, 'gate-index');
    const env = { GIT_INDEX_FILE: index };
    git(bare, ['read-tree', candidateCommit], { env });
    git(bare, ['update-index', '--cacheinfo', `100644,${blob},package.json`], { env });
    const tree = git(bare, ['write-tree'], { env });
    rmSync(index, { force: true });
    return git(bare, ['commit-tree', tree, '-p', candidateCommit, '-m', `chore(release): synthetic ${version}`]);
}

/** Point a ref of the bare remote at a commit, as an annotated release tag when asked. */
function publish(bare, { branchCommit, tag, tagCommit }) {
    git(bare, ['update-ref', 'refs/heads/main', branchCommit]);
    git(bare, ['tag', '-a', '-f', tag, tagCommit, '-m', `upgrade-path gate ${tag}`]);
}

/**
 * Build the bare release remote, borrowing the source repository's objects
 * read-only, and publish the candidate tag on main.
 */
export function prepareReleaseRemote({ sandbox, sourceRepo, candidateCommit, candidateVersion }) {
    const bare = path.join(sandbox, 'release-remote.git');
    git(sandbox, ['init', '-q', '--bare', bare]);
    const objects = path.resolve(sourceRepo, git(sourceRepo, ['rev-parse', '--git-common-dir']), 'objects');
    writeFileSync(path.join(bare, 'objects', 'info', 'alternates'), `${objects}\n`);
    publish(bare, { branchCommit: candidateCommit, tag: `v${candidateVersion}`, tagCommit: candidateCommit });
    return bare;
}

/**
 * Seed the three live generations an installed node serves (git-ignored), each
 * stamped with the running release, so the readers' candidate validation sees
 * the same layout as on a real node. Their content is a stand-in, not a build.
 */
function seedLiveGenerations(node, { commit, version }) {
    for (const [directory, buildId] of [['dist', 'client'], ['dist-server', 'server'], ['node_modules', null]]) {
        const target = path.join(node, directory);
        mkdirSync(target, { recursive: true, mode: 0o700 });
        const provenance = { commit, version, buildId: buildId ? `${buildId}-${commit}` : null };
        writeFileSync(path.join(target, 'BUILD_PROVENANCE.json'), `${JSON.stringify(provenance)}\n`);
    }
}

/** Clone one sandbox node on branch main at `commit`, with the gate remote and shim. */
export function cloneNode({ sandbox, bare, name, commit }) {
    const node = path.join(sandbox, name);
    git(sandbox, ['clone', '-q', '--shared', '--no-checkout', bare, node]);
    git(node, ['checkout', '-q', '-B', 'main', commit]);
    seedLiveGenerations(node, { commit, version: JSON.parse(readFileSync(path.join(node, 'package.json'), 'utf8')).version });
    const shim = path.join(sandbox, 'ssh-shim.sh');
    if (!existsSync(shim)) writeFileSync(shim, sshShimScript(bare), { mode: 0o700 });
    git(node, ['remote', 'set-url', 'origin', GATE_REMOTE_URL]);
    git(node, ['config', 'core.sshCommand', shim]);
    git(node, ['config', 'ssh.variant', 'simple']);
    return node;
}

/** The allowlisted environment of one probe process (nothing operator-specific leaks). */
export function probeEnvironment({ sandbox, tree, database }) {
    const home = path.join(sandbox, 'home');
    const env = {
        PATH: `${path.join(sandbox, 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        LANG: process.env.LANG || 'C.UTF-8',
        HOME: home, USERPROFILE: home, TMPDIR: path.join(sandbox, 'tmp'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), NASSAJ_HARNESS_DATA_HOME: path.join(sandbox, 'harness'),
        DATABASE_PATH: database, JWT_SECRET: randomBytes(32).toString('hex'),
        TSX_TSCONFIG_PATH: path.join(tree, 'server', 'tsconfig.json'),
        NASSAJ_RELEASE_SOURCE: `https://${GATE_REMOTE.host}/${GATE_REMOTE.path.replace(/\.git$/, '')}`,
        ...NEUTRAL_GIT_ENV,
    };
    return env;
}

/** Spawn the probe inside `tree` and return its JSON verdict (crash → a failed verdict). */
export function runProbe({ sandbox, tree, database, spec, label, spawn = spawnSync }) {
    const specFile = path.join(sandbox, 'results', `${label}.spec.json`);
    const resultFile = path.join(sandbox, 'results', `${label}.result.json`);
    const full = { ...spec, treeRoot: tree, resultFile, candidateBuildWrapper: CANDIDATE_BUILD_WRAPPER };
    writeFileSync(specFile, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    const run = spawn(process.execPath, ['--import', 'tsx', PROBE_FILE, specFile], {
        cwd: tree, env: probeEnvironment({ sandbox, tree, database }), encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(path.join(sandbox, 'results', `${label}.log`), `${run.stdout || ''}${run.stderr || ''}`, { mode: 0o600 });
    if (existsSync(resultFile)) return JSON.parse(readFileSync(resultFile, 'utf8'));
    return { ok: false, code: run.signal ? 'upgrade_gate_probe_killed' : 'upgrade_gate_probe_crashed',
        detail: `exit ${run.status ?? run.signal}; log ${label}.log` };
}

/** Skip a leg whose prerequisite failed. */
const skipped = (because) => ({ ok: false, skipped: true, code: 'skipped', detail: `prerequisite ${because} failed` });

/**
 * One update across a node: `writerTree` stages `target` on a node clone at
 * `fromCommit`; the reader legs then run against that node and database.
 * @returns {Record<string, object>} the leg results keyed by leg id
 */
function updateLegs(ctx, { name, fromCommit, writerTree, writerLeg, target, readers }) {
    const node = cloneNode({ sandbox: ctx.sandbox, bare: ctx.bare, name, commit: fromCommit });
    const database = path.join(ctx.sandbox, `data-${name}`, 'db.sqlite');
    mkdirSync(path.dirname(database), { mode: 0o700 });
    const write = ctx.probe({ tree: writerTree, database, label: writerLeg, spec: {
        role: 'write', nodeRoot: node, targetVersion: target.version, loadedRuntimeCommit: fromCommit } });
    const legs = { [writerLeg]: write };
    for (const { leg, tree, role } of readers) {
        legs[leg] = write.ok ? ctx.probe({ tree, database, label: leg, spec: {
            role, nodeRoot: node, rowId: write.rowId, transactionId: write.transactionId, expectedCommit: target.commit } })
            : skipped(writerLeg);
    }
    return legs;
}

/**
 * Forward direction: the previous tree stages the candidate; the old process
 * reads the queued row before the restart, the candidate after it and at boot.
 */
function forwardLegs(ctx) {
    return updateLegs(ctx, {
        name: 'node-previous', fromCommit: ctx.previousCommit, writerTree: ctx.previousRoot, writerLeg: 'previous-writer',
        target: { version: ctx.candidateVersion, commit: ctx.candidateCommit },
        readers: [
            { leg: 'previous-reader-before-restart', tree: ctx.previousRoot, role: 'read' },
            { leg: 'candidate-reader-after-restart', tree: ctx.candidateRoot, role: 'read' },
            { leg: 'candidate-bootstrap-after-restart', tree: ctx.candidateRoot, role: 'bootstrap' },
        ],
    });
}

/**
 * Next-update direction: the candidate, once installed, stages a synthetic next
 * release and must read its own action; the previous tree's reading is reported
 * for forward compatibility only.
 */
function nextUpdateLegs(ctx) {
    const version = nextVersion(ctx.candidateVersion);
    const nextCommit = commitNextRelease({ bare: ctx.bare, candidateCommit: ctx.candidateCommit, version });
    publish(ctx.bare, { branchCommit: nextCommit, tag: `v${version}`, tagCommit: nextCommit });
    return updateLegs(ctx, {
        name: 'node-candidate', fromCommit: ctx.candidateCommit, writerTree: ctx.candidateRoot, writerLeg: 'candidate-writer',
        target: { version, commit: nextCommit },
        readers: [
            { leg: 'candidate-reader-next-update', tree: ctx.candidateRoot, role: 'read' },
            { leg: 'candidate-bootstrap-next-update', tree: ctx.candidateRoot, role: 'bootstrap' },
            { leg: 'previous-reader-of-candidate-action', tree: ctx.previousRoot, role: 'read' },
        ],
    });
}

/**
 * Validate the gate inputs before any sandbox work: both trees installed and
 * PROVEN to be their declared commits (clean checkout at HEAD, or a marked and
 * re-hashed archive tree), the candidate's version and the ancestry.
 */
function resolveInputs(options) {
    const { sourceRepo, previousTag, previousRoot, candidateRoot } = options;
    const previousCommit = git(sourceRepo, ['rev-parse', '--verify', `${previousTag}^{commit}`]);
    const candidateCommit = options.candidateCommit;
    if (!SHA40.test(previousCommit) || !SHA40.test(candidateCommit || '')) {
        throw new Error('upgrade-path gate: the candidate commit must be a full 40-hex commit id');
    }
    for (const [label, root, commit] of [['previous', previousRoot, previousCommit], ['candidate', candidateRoot, candidateCommit]]) {
        if (!existsSync(path.join(root, 'node_modules', 'tsx'))) {
            throw new Error(`upgrade-path gate: the ${label} tree ${root} is not installed (npm ci --include=dev)`);
        }
        verifyTreeRoot({ root, sourceRepo, commit });
    }
    const candidateVersion = options.candidateVersion || versionAt(sourceRepo, candidateCommit);
    if (versionAt(sourceRepo, candidateCommit) !== candidateVersion) {
        throw new Error(`upgrade-path gate: ${candidateCommit} is not version ${candidateVersion}`);
    }
    git(sourceRepo, ['merge-base', '--is-ancestor', previousCommit, candidateCommit]);
    return { previousCommit, candidateCommit, candidateVersion };
}

/**
 * Run every leg and return the raw report (no verdict). The sandbox is removed
 * only when every leg passed and `keep` is unset; a failed leg or a thrown error
 * keeps it (its logs are the evidence) and names its path.
 * @returns {{sandbox:string, kept:boolean, previousTag:string, previousCommit:string,
 *   candidateCommit:string, candidateVersion:string, legs:Record<string, object>}}
 */
export function runUpgradePathLegs(options) {
    const inputs = resolveInputs(options);
    ensurePrivateDirectory(options.workParent);
    const sandbox = createSandbox(options.workParent);
    let legs = null;
    try {
        const ctx = { ...options, ...inputs, sandbox };
        ctx.bare = prepareReleaseRemote({ sandbox, sourceRepo: options.sourceRepo, ...inputs });
        ctx.probe = ({ tree, database, label, spec }) => runProbe({ sandbox, tree, database, spec, label,
            spawn: options.spawn });
        legs = { ...forwardLegs(ctx), ...nextUpdateLegs(ctx) };
    } catch (error) {
        error.message = `${error.message} (sandbox kept: ${sandbox})`;
        throw error;
    }
    const kept = Boolean(options.keep || LEGS.some((leg) => !legs[leg.id]?.ok));
    if (!kept) rmSync(sandbox, { recursive: true, force: true });
    return { sandbox, kept, previousTag: options.previousTag, ...inputs, legs };
}

/** Load and validate the recorded known-incompatible baselines. */
export function loadKnownIncompatible(file = KNOWN_INCOMPATIBLE_FILE) {
    const policy = JSON.parse(readFileSync(file, 'utf8'));
    if (policy?.schema !== KNOWN_INCOMPATIBLE_SCHEMA || !Array.isArray(policy.entries)) {
        throw new Error('upgrade-path gate: invalid known-incompatible policy file');
    }
    for (const entry of policy.entries) {
        if (!/^v\d+\.\d+\.\d+\.\d+$/.test(entry.baseline || '') || !SHA40.test(entry.baselineCommit || '')
            || !EXCUSABLE_LEGS.has(entry.leg) || !/^[a-z][a-z0-9_]{0,63}$/.test(entry.code || '')
            || typeof entry.bug !== 'string' || typeof entry.reason !== 'string') {
            throw new Error('upgrade-path gate: invalid known-incompatible entry');
        }
    }
    return policy.entries;
}

/**
 * Decide the gate. A blocking failure is excused only when it EXACTLY matches a
 * recorded known-incompatible entry (baseline tag, baseline commit, leg, code)
 * AND the owner acknowledged that baseline for this run. Anything else fails.
 * @returns {{verdict:'pass'|'known-incompatible-acknowledged'|'fail', failures:object[],
 *   excused:object[], unacknowledged:object[], advisories:object[], staleEntries:object[]}}
 */
export function decideUpgradePath(report, { knownIncompatible = [], acknowledged = [] } = {}) {
    const matches = (leg, result) => knownIncompatible.find((entry) => entry.baseline === report.previousTag
        && entry.baselineCommit === report.previousCommit && entry.leg === leg && entry.code === result.code);
    const failures = [];
    const excused = [];
    const unacknowledged = [];
    const advisories = [];
    for (const { id, blocking } of LEGS) {
        const result = report.legs[id];
        if (result?.ok) continue;
        const finding = { leg: id, code: result?.code ?? 'missing', detail: result?.detail ?? null };
        if (!blocking) { advisories.push(finding); continue; }
        if (result?.skipped) continue;
        const entry = matches(id, result || {});
        if (!entry) failures.push(finding);
        else if (acknowledged.includes(report.previousTag)) excused.push({ ...finding, bug: entry.bug });
        else unacknowledged.push({ ...finding, bug: entry.bug });
    }
    const staleEntries = knownIncompatible.filter((entry) => entry.baseline === report.previousTag
        && report.legs[entry.leg]?.ok);
    const verdict = failures.length || unacknowledged.length ? 'fail'
        : excused.length ? 'known-incompatible-acknowledged' : 'pass';
    return { verdict, failures, excused, unacknowledged, advisories, staleEntries };
}

/** Human-readable report lines for the release log. */
export function formatUpgradePathReport(report, decision) {
    const lines = [`upgrade-path gate: ${report.previousTag} (${report.previousCommit.slice(0, 12)}) -> `
        + `${report.candidateVersion} (${report.candidateCommit.slice(0, 12)})`];
    for (const { id, blocking } of LEGS) {
        const result = report.legs[id] || {};
        const state = result.ok ? 'ok' : result.skipped ? 'skipped' : `FAIL ${result.code}`;
        const facts = [result.actionKeys ? `keys=${result.actionKeys.length}` : null,
            Number.isSafeInteger(result.registeredEffects) ? `effects=${result.registeredEffects}` : null,
            result.candidateBuilds ? `builder=${result.builder}` : null].filter(Boolean).join(' ');
        lines.push(`  ${blocking ? '' : '(advisory) '}${id}: ${state}${facts ? ` ${facts}` : ''}`);
    }
    for (const item of decision.excused) {
        lines.push(`  KNOWN-INCOMPATIBLE (owner acknowledged): ${item.leg} ${item.code} — ${item.bug}`);
    }
    for (const item of decision.unacknowledged) {
        lines.push(`  KNOWN-INCOMPATIBLE baseline ${report.previousTag}: ${item.leg} ${item.code} — ${item.bug}; `
            + `requires --acknowledge-upgrade-incompatible ${report.previousTag}`);
    }
    for (const entry of decision.staleEntries) lines.push(`  note: known-incompatible entry ${entry.leg} now passes`);
    lines.push(`  verdict: ${decision.verdict}${report.kept ? `; sandbox kept: ${report.sandbox}` : ''}`);
    return lines;
}
