#!/usr/bin/env node
/** Build and atomically publish the self-hosted client without restarting Node. */
import { createClientAssetManifest, clientPublicationDigest, verifyAssetClosure, walkFiles } from './lib/client-publication-artifacts.mjs';
import { assertLegacyNodePublication, assertStandaloneNodePublication } from './lib/node-update-mode.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    constants,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { previewControlPaths, recordPreviewLedgerEvent, recordPublishBaseGuardDecision } from './local-preview-ledger.mjs';
import { readMutableWatcherInhibit } from './client-isolated-publish.mjs';
import { supportsAtomicExchange } from './lib/atomic-exchange-capability.mjs';

export { supportsAtomicExchange, verifyAssetClosure };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = path.join(ROOT, 'dist');
const GENERATIONS_DIR = ROOT;
const PREVIEW_GENERATIONS_DIR = path.join(ROOT, '.nassaj-local-preview', 'client');
const RUNTIME_PREFIX = 'dist.atomic.predeploy-';
const LOCK_FILE = path.join(ROOT, '.git', 'nassaj-client-build.lock');
export const CLIENT_SOURCE_ENTRIES = [
    'src', 'public', 'docs/team-wiki', 'index.html', 'package.json', 'package-lock.json',
    'vite.config.js', 'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'tsconfig.preview.json', 'shared',
];
export const CLIENT_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];
const DEFAULT_ASSET_MAX_BYTES = 1024 * 1024 * 1024;
// Cap on the dropped-commit list the base guard names in a refusal and audits.
const PUBLISH_BASE_DROPPED_CAP = 20;
// The watcher cgroup is capped at 3 GiB. Node derives an
// approximately 1 GiB default V8 heap from that cgroup, which is too small for
// the current Vite graph. This raises Vite's old-space headroom; total RSS may
// be higher, while the service's MemoryMax remains the final protection.
const VITE_HEAP_LIMIT_MB = 1536;

/** Build the fixed Node command used to run Vite with bounded heap headroom. */
export function viteBuildInvocation(root = ROOT) {
    return {
        command: process.execPath,
        args: [
            `--max-old-space-size=${VITE_HEAP_LIMIT_MB}`,
            path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
            'build',
            '--configLoader',
            'runner',
        ],
    };
}

function sha256File(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Test-only files never affect the production preview artefact. */
export function isIgnoredClientInput(relative) {
    const normalized = relative.split(path.sep).join('/');
    return /(?:^|\/)__tests__(?:\/|$)/.test(normalized)
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

function walk(entry, base, output, { metadataOnly = false } = {}) {
    if (!existsSync(entry)) return;
    const metadata = lstatSync(entry);
    const relative = path.relative(base, entry).split(path.sep).join('/');
    if (isIgnoredClientInput(relative)) return;
    if (metadata.isSymbolicLink()) {
        const target = path.resolve(path.dirname(entry), readlinkSync(entry));
        output.push([relative, metadataOnly ? `${metadata.dev}:${metadata.ino}:${metadata.ctimeMs}` : `link:${readlinkSync(entry)}`]);
        walk(target, base, output, { metadataOnly });
        return;
    }
    if (metadata.isDirectory()) {
        for (const child of readdirSync(entry).sort()) walk(path.join(entry, child), base, output, { metadataOnly });
        return;
    }
    if (metadata.isFile()) {
        output.push([relative, metadataOnly
            ? `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
            : sha256File(entry)]);
    }
}

function clientEnvironmentEntries(root) {
    return Object.entries(loadEnv('production', root, 'VITE_')).sort(([a], [b]) => a.localeCompare(b));
}

/** A stable SHA-256 over all inputs that can affect the client artefact. */
export function computeClientBuildId(root = ROOT) {
    return computeClientBuildIdWithEnvironment(root, clientEnvironmentEntries(root));
}

/** Stable client identity with an explicit, already-sanitized public environment. */
export function computeClientBuildIdWithEnvironment(root, environmentEntries) {
    const entries = [];
    for (const item of CLIENT_SOURCE_ENTRIES) walk(path.join(root, item), root, entries);
    for (const [name, value] of [...environmentEntries].sort(([a], [b]) => a.localeCompare(b))) {
        entries.push([`env:${name}`, createHash('sha256').update(value).digest('hex')]);
    }
    const hash = createHash('sha256');
    for (const [name, digest] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(name).update('\0').update(digest).update('\0');
    }
    return hash.digest('hex');
}

const RELEASE_VITE_KEYS = ['VITE_IS_PLATFORM', 'VITE_PUBLIC_SOURCE_URL'];

/** Fail closed unless release client inputs contain exactly the reviewed public Vite keys. */
export function normalizeReleaseViteEnvironment(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Release Vite environment is invalid.');
    const unknown = Object.keys(value).filter((key) => !RELEASE_VITE_KEYS.includes(key));
    if (unknown.length) throw new Error(`Release Vite environment contains an unapproved key: ${unknown[0]}`);
    return RELEASE_VITE_KEYS
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => {
            if (typeof value[key] !== 'string' || /[\0\r\n]/.test(value[key])) {
                throw new Error(`Release Vite environment value is invalid: ${key}`);
            }
            return [key, value[key]];
        });
}

/** Metadata epoch catches edit-then-revert races without exposing file contents. */
export function computeClientInputEpoch(root = ROOT) {
    const entries = [];
    for (const item of [...CLIENT_SOURCE_ENTRIES, ...CLIENT_ENV_FILES]) walk(path.join(root, item), root, entries, { metadataOnly: true });
    const hash = createHash('sha256');
    for (const [name, value] of entries.sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update('\0').update(value).update('\0');
    return hash.digest('hex');
}

function assertAssetPath(relative) {
    if (typeof relative !== 'string' || !relative.startsWith('assets/')
        || /[\\\x00-\x1f\x7f]/.test(relative)
        || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid prior asset path: ${relative}`);
    }
}

function assetInventory(directory) {
    if (!lstatSync(directory).isDirectory()) throw new Error(`Build assets reject unsafe directory: ${directory}`);
    const files = [];
    walkAllRegularFiles(path.join(directory, 'assets'), files);
    return new Map(files.map((file) => {
        const relative = path.relative(directory, file).split(path.sep).join('/');
        assertAssetPath(relative);
        return [relative, { path: relative, size: lstatSync(file).size, digest: sha256File(file) }];
    }));
}

function readAssetMetadata(directory) {
    const file = path.join(directory, 'ATOMIC_GENERATION.json');
    let metadata;
    try { metadata = lstatSync(file); } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
    if (!metadata.isFile()) throw new Error('Invalid asset metadata file.');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid asset metadata.');
    return value;
}

function priorAssetTimes(metadata, inventory) {
    const times = new Map();
    if (metadata.assets !== undefined && !Array.isArray(metadata.assets)) throw new Error('Invalid prior assets metadata.');
    for (const asset of metadata.assets ?? []) {
        assertAssetPath(asset?.path);
        const actual = inventory.get(asset.path);
        if (!actual) throw new Error(`Prior generation asset is missing: ${asset.path}`);
        if (times.has(asset.path) || !Number.isSafeInteger(asset.size) || asset.size !== actual.size
            || (asset.lastFreshAt !== null && (!Number.isFinite(asset.lastFreshAt) || asset.lastFreshAt < 0))) {
            throw new Error(`Invalid prior asset metadata: ${asset.path}`);
        }
        times.set(asset.path, asset.lastFreshAt);
    }
    if (metadata.emittedAssets !== undefined && !Array.isArray(metadata.emittedAssets)) throw new Error('Invalid emitted assets metadata.');
    const emitted = new Set();
    for (const relative of metadata.emittedAssets ?? []) {
        assertAssetPath(relative);
        if (!inventory.has(relative)) throw new Error(`Prior generation asset is missing: ${relative}`);
        if (emitted.has(relative)) throw new Error(`Duplicate emitted asset: ${relative}`);
        emitted.add(relative);
    }
    return times;
}

/** Independently pin a restoration witness without following links or renewing ages. */
export function inspectRestorationWitness(directory) {
    if (realpathSync(directory) !== directory) throw new Error('Restoration witness must be canonical.');
    const identity = lstatSync(directory), digest = createHash('sha256'), content = createHash('sha256');
    if (!identity.isDirectory()) throw new Error('Restoration witness directory invalid.');
    let bytes = 0;
    function visit(current) {
        const st = lstatSync(current);
        if (st.uid !== process.getuid() || st.mode & 0o022 || st.isSymbolicLink()
            || (!st.isDirectory() && !st.isFile())) throw new Error('Unsafe restoration witness.');
        const relative = path.relative(directory, current);
        content.update(JSON.stringify([relative, st.mode]));
        digest.update(JSON.stringify([relative, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs]));
        if (st.isDirectory()) for (const name of readdirSync(current).sort()) visit(path.join(current, name));
        else { const data = readFileSync(current); bytes += data.length; digest.update(data); content.update(data); }
    }
    visit(directory);
    const record = JSON.parse(readFileSync(path.join(directory, 'BUILD_PROVENANCE.json')));
    const version = JSON.parse(readFileSync(path.join(directory, 'version.json')));
    if (record.artifact !== 'client' || record.dirty !== false || !/^[a-f0-9]{64}$/.test(record.buildId)
        || !/^[a-f0-9]{40}$/.test(record.commit) || version.buildId !== record.buildId
        || !Number.isFinite(Date.parse(record.builtAt))) throw new Error('Restoration witness identity invalid.');
    return { directory, buildId: record.buildId, oid: record.commit, dirty: record.dirty, builtAt: record.builtAt,
        bytes, device: identity.dev, inode: identity.ino, contentSha256: content.digest('hex'), inventorySha256: digest.digest('hex') };
}

function restorationInputs(restoration, liveDir, stagedDir, prior, fresh) {
    if (restoration === undefined) return new Map();
    if (restoration?.schema !== 'nassaj-client-asset-restoration/v1' || !Array.isArray(restoration.assets)
        || !Array.isArray(restoration.survivors) || restoration.survivors.length !== 1) throw new Error('Invalid restoration input.');
    const witness = restoration.survivors[0];
    if (witness.directory === liveDir || witness.directory === stagedDir) throw new Error('Restoration witness aliases publication.');
    const actual = inspectRestorationWitness(witness.directory);
    for (const [key, value] of Object.entries(actual)) if (witness[key] !== value) throw new Error('Restoration witness drift.');
    const source = assetInventory(witness.directory), times = priorAssetTimes(readAssetMetadata(witness.directory), source);
    const restored = new Map();
    for (const record of restoration.assets) {
        assertAssetPath(record?.path);
        const asset = source.get(record.path);
        if (!asset || restored.has(record.path) || record.survivorDirectory !== witness.directory
            || record.size !== asset.size || record.sha256 !== asset.digest
            || record.lastFreshAt !== (times.get(record.path) ?? null)) throw new Error('Restoration asset pin mismatch.');
        if (prior.has(record.path)) throw new Error('Restoration requires genuinely absent live asset.');
        if (fresh.has(record.path) && fresh.get(record.path).digest !== asset.digest) throw new Error('Restoration candidate conflict.');
        restored.set(record.path, { ...asset, source: path.join(witness.directory, record.path), lastFreshAt: record.lastFreshAt });
    }
    return restored;
}

function copyMissingPreservedAssets(sourceDirectory, stagedDir, assets, fresh) {
    for (const [relative, asset] of assets) {
        if (fresh.has(relative)) continue;
        const destination = path.join(stagedDir, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(sourceDirectory ? path.join(sourceDirectory, relative) : asset.source,
            destination, constants.COPYFILE_EXCL);
        if (sha256File(destination) !== asset.digest) throw new Error(`Published asset changed during preservation: ${relative}`);
    }
}

/** Preserve every published asset, or refuse promotion at the existing byte ceiling. */
export function mergeLegacyAssets(liveDir, stagedDir, options = {}) {
    const now = options.now ?? Date.now();
    const maxBytes = options.maxBytes ?? Number(process.env.NASSAJ_CLIENT_ASSET_MAX_BYTES || DEFAULT_ASSET_MAX_BYTES);
    if (!Number.isFinite(now) || now < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new Error('Invalid asset preservation limits.');
    }
    const prior = assetInventory(liveDir);
    const fresh = assetInventory(stagedDir);
    const times = priorAssetTimes(readAssetMetadata(liveDir), prior);
    const stagedMetadata = readAssetMetadata(stagedDir);
    const union = new Map(prior);
    for (const [relative, asset] of fresh) {
        if (prior.has(relative) && prior.get(relative).digest !== asset.digest) {
            throw new Error(`Hashed asset conflict: ${relative}`);
        }
        union.set(relative, asset);
    }
    const stagedTimes = priorAssetTimes(stagedMetadata, fresh);
    const restored = restorationInputs(options.restoration, liveDir, stagedDir, prior, fresh);
    for (const [relative, asset] of restored) union.set(relative, asset);
    const retainedBytes = [...union.values()].reduce((total, asset) => total + asset.size, 0);
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes > maxBytes) {
        throw new Error(`Asset preservation capacity exceeded: ${retainedBytes} bytes required; limit ${maxBytes}. Promotion cancelled.`);
    }
    copyMissingPreservedAssets(liveDir, stagedDir, prior, fresh);
    copyMissingPreservedAssets(null, stagedDir, restored, fresh);
    const emittedAssets = [...union.keys()].sort();
    const assets = emittedAssets.map((relative) => ({
        path: relative, size: union.get(relative).size,
        // Missing historical metadata means unknown age, never a renewed lease.
        lastFreshAt: restored.has(relative) ? restored.get(relative).lastFreshAt
            : stagedTimes.has(relative) ? stagedTimes.get(relative)
            : prior.has(relative) ? times.get(relative) ?? null : now,
    }));
    writeFileSync(path.join(stagedDir, 'ATOMIC_GENERATION.json'), `${JSON.stringify({ ...stagedMetadata, emittedAssets, assets }, null, 2)}\n`);
}

function walkAllRegularFiles(directory, output) {
    if (!lstatSync(directory).isDirectory()) throw new Error(`Build assets reject unsafe directory: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Build assets reject symlink: ${full}`);
        if (entry.isDirectory()) walkAllRegularFiles(full, output);
        else if (entry.isFile()) output.push(full);
        else throw new Error(`Build assets reject non-regular file: ${full}`);
    }
}

export function readGeneration(file) {
    return Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
}

export function assertGenerationCurrent(file, expected) {
    if (file && readGeneration(file) !== expected) throw new Error('Source changed during build; generation promotion cancelled.');
}

export function assertExchangeSupport(liveDir = LIVE_DIR, generationsDir = GENERATIONS_DIR) {
    if (!supportsAtomicExchange()) {
        throw new Error('GNU mv with --exchange and --no-copy is required.');
    }
    if (!existsSync(liveDir) || !statSync(liveDir).isDirectory()) throw new Error(`Live directory is absent: ${liveDir}`);
    mkdirSync(generationsDir, { recursive: true });
    if (statSync(liveDir).dev !== statSync(generationsDir).dev) throw new Error('Staging and live dist must be on the same filesystem.');
}

/** Exchange two existing directories atomically. There is deliberately no copy fallback. */
export function promoteWithExchange(stagedDir, liveDir = LIVE_DIR) {
    assertLegacyNodePublication(path.dirname(liveDir));
    const result = spawnSync('mv', ['--exchange', '--no-copy', '-T', stagedDir, liveDir], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Atomic exchange failed: ${(result.stderr || result.stdout).trim()}`);
}

/** The source commit a freshly built candidate attests, read from its provenance. */
function candidateSourceCommit(stagedDir) {
    const file = path.join(stagedDir, 'BUILD_PROVENANCE.json');
    if (!existsSync(file)) throw new Error('Publish base guard: the candidate provenance records no source commit.');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(record?.commit || '')) {
        throw new Error('Publish base guard: the candidate provenance records no source commit.');
    }
    return record.commit;
}

/** Live base provenance, or null for an empty/legacy dist; unparseable fails closed. */
function liveBaseProvenance(liveDir) {
    const file = path.join(liveDir, 'BUILD_PROVENANCE.json');
    if (!existsSync(file)) return null;
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('Publish base guard: live dist provenance is unparseable; refusing to exchange.'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Publish base guard: live dist provenance is unparseable; refusing to exchange.');
    }
    return { commit: typeof record.commit === 'string' ? record.commit : null, dirty: record.dirty === true };
}

function gitStatus(root, args) {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Prove the live commit is an ancestor-or-equal of the candidate source, failing closed. */
function liveBaseIsAncestor(root, liveCommit, sourceOid) {
    if (liveCommit === sourceOid) return true;
    if (!/^[a-f0-9]{40}$/.test(liveCommit || '')
        || gitStatus(root, ['rev-parse', '--verify', '--quiet', `${liveCommit}^{commit}`]).status !== 0) {
        throw new Error(`Publish base guard: live commit ${liveCommit} is not present in the repository; refusing to exchange.`);
    }
    const result = gitStatus(root, ['merge-base', '--is-ancestor', liveCommit, sourceOid]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error('Publish base guard: could not compare live and candidate commits (missing object or git failure); refusing to exchange.');
}

/** Commits reachable from the live base but not the candidate, capped, newest first. */
function liveCommitsDropped(root, sourceOid, liveCommit, cap = PUBLISH_BASE_DROPPED_CAP) {
    const result = gitStatus(root, ['rev-list', `--max-count=${cap + 1}`, `${sourceOid}..${liveCommit}`]);
    if (result.status !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, cap);
}

function baseRegressionMessage(liveCommit, sourceOid, dropped) {
    const overflow = dropped.length >= PUBLISH_BASE_DROPPED_CAP ? '+' : '';
    const list = dropped.length ? dropped.join(', ') : '(none resolved)';
    return `Publish base guard: live client commit ${liveCommit} is not an ancestor of candidate source ${sourceOid}; `
        + `promotion would drop ${dropped.length}${overflow} live commit(s): ${list}. `
        + 'Merge the live commit into the candidate, or re-run with --allow-non-main and explicit owner permission.';
}

/**
 * Pure base-regression decision: never writes, never throws for a regression.
 * Integrity failures (unparseable provenance, a live commit absent from the
 * repository, an unprovable comparison) are returned as a `blocked` decision so
 * the caller audits them uniformly before failing closed. A candidate with no
 * provenance is our own precondition bug and still throws here.
 */
function evaluatePublishBase(root, stagedDir, liveDir, options) {
    const sourceOid = candidateSourceCommit(stagedDir);
    let live;
    try { live = liveBaseProvenance(liveDir); }
    catch (error) { return { result: 'blocked', liveCommit: null, sourceOid, dirty: false, dropped: [], message: error.message }; }
    if (!live || live.dirty) {
        return { result: 'allowed', liveCommit: live?.commit ?? null, sourceOid, dirty: live?.dirty === true, dropped: [] };
    }
    let ancestor;
    try { ancestor = liveBaseIsAncestor(root, live.commit, sourceOid); }
    catch (error) { return { result: 'blocked', liveCommit: live.commit, sourceOid, dirty: false, dropped: [], message: error.message }; }
    if (ancestor) return { result: 'allowed', liveCommit: live.commit, sourceOid, dirty: false, dropped: [] };
    const dropped = liveCommitsDropped(root, sourceOid, live.commit);
    if (options.allowNonMain) return { result: 'overridden', liveCommit: live.commit, sourceOid, dirty: false, dropped };
    return { result: 'blocked', liveCommit: live.commit, sourceOid, dirty: false, dropped, message: baseRegressionMessage(live.commit, sourceOid, dropped) };
}

/**
 * Audit one decision. A failed audit of an `allowed` exchange degrades to a
 * stderr warning so a ledger lock timeout or disk error never blocks a benign
 * fast-forward; `blocked` and `overridden` stay fail-closed — their audit must
 * succeed or the exchange is refused.
 */
function recordGuardDecision(root, decision) {
    const payload = {
        liveCommit: decision.liveCommit, sourceOid: decision.sourceOid,
        result: decision.result, dirty: decision.dirty, dropped: decision.dropped,
    };
    if (decision.result === 'allowed') {
        try { recordPublishBaseGuardDecision(root, payload); }
        catch (error) { process.stderr.write(`[publish-base-guard] audit of an allowed exchange failed (non-blocking): ${error.message}\n`); }
        return;
    }
    recordPublishBaseGuardDecision(root, payload);
}

/**
 * Shared base-regression guard for the single promote chokepoint. Re-reads the
 * live dist provenance immediately before the exchange and refuses to replace a
 * live generation built from a commit the candidate does not already contain,
 * unless `allowNonMain` overrides. Absent provenance or a dirty live base is
 * allowed. Every decision is audited before the verdict is enforced.
 *
 * Intended consequence for the mutable watcher: after an isolated `--allow-non-main`
 * publish pins the live base to an unmerged overlay commit, that commit is not an
 * ancestor of main HEAD, so every watcher rebuild stays `blocked` and the watcher
 * keeps retrying with backoff. The refusal clears only once the overlay commit is
 * merged into HEAD (making the live base an ancestor again); this is by design.
 */
export function assertLivePublishBaseCurrent(stagedDir, liveDir, options = {}) {
    const root = options.root;
    if (!root) throw new Error('Publish base guard requires a repository root.');
    const decision = evaluatePublishBase(root, stagedDir, liveDir, options);
    recordGuardDecision(root, decision);
    if (decision.result === 'blocked') throw new Error(decision.message);
    return decision;
}

/**
 * Publish, run an injected smoke probe, and restore the old directory on failure.
 * The shared base-regression guard is on by default (against `ROOT`); callers
 * pass `guardOptions` to supply the real repository root and `allowNonMain`. An
 * explicit `{ skipGuard: true }` is deliberately not supported: no caller needs
 * to promote past a base regression, so there is no opt-out.
 */
export async function promoteWithSmokeRollback(stagedDir, liveDir, smokeProbe, guardOptions = null) {
    assertLivePublishBaseCurrent(stagedDir, liveDir, guardOptions || { root: ROOT });
    promoteWithExchange(stagedDir, liveDir);
    try {
        await smokeProbe(liveDir);
    } catch (error) {
        promoteWithExchange(stagedDir, liveDir);
        throw error;
    }
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`);
}

function resourcesSafe() {
    let available = os.freemem();
    try {
        const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
        if (match) available = Number(match[1]) * 1024;
    } catch { /* non-Linux fallback */ }
    const memoryUsed = 1 - available / os.totalmem();
    const cpuLoad = os.loadavg()[0] / Math.max(1, os.cpus().length);
    return memoryUsed < 0.8 && cpuLoad < 0.8;
}

function parseArgs(argv) {
    const value = (flag) => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : null;
    };
    return {
        locked: argv.includes('--locked'),
        expectedBuildId: value('--expected-build-id'),
        expectedInputEpoch: value('--expected-input-epoch'),
        keepPreviousGenerations: argv.includes('--keep-previous-generations'),
        generationFile: value('--generation-file'),
        generation: Number.parseInt(value('--generation') || '', 10),
        smokeUrl: value('--smoke-url'),
        reconcileOnly: argv.includes('--reconcile-only'),
        localPreview: argv.includes('--local-preview'),
    };
}

function acquireFlock(argv, localPreview) {
    const lockFile = localPreview ? previewControlPaths(ROOT).buildLock : LOCK_FILE;
    return acquireBuildLock(lockFile, process.execPath, [fileURLToPath(import.meta.url), '--locked', ...argv], { cwd: ROOT, stdio: 'inherit' });
}

export function acquireBuildLock(lockFile, command, args, options = {}) {
    const result = runWithFlock(lockFile, command, args, options);
    if (result.status !== 0) {
        const error = new Error(result.status === 75 ? 'Another client build holds the lock.' : 'locked client build failed.');
        error.exitCode = result.status;
        throw error;
    }
    return result;
}

/** Execute exactly one command while holding a non-blocking kernel flock. */
export function runWithFlock(lockFile, command, args, options = {}) {
    return spawnSync('flock', ['-n', '-E', '75', '-F', lockFile, command, ...args], options);
}

export function verifyBuildIdentity(directory, buildId) {
    const version = JSON.parse(readFileSync(path.join(directory, 'version.json'), 'utf8'));
    const provenance = JSON.parse(readFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), 'utf8'));
    if (version.buildId !== buildId || provenance.buildId !== buildId) throw new Error('Bundle/version/provenance BUILD_ID mismatch.');
    const bundles = [];
    walkFiles(path.join(directory, 'assets'), bundles);
    if (!bundles.some((file) => readFileSync(file, 'utf8').includes(buildId))) throw new Error('BUILD_ID is absent from emitted bundles.');
}

async function smoke(directory, buildId, smokeUrl) {
    verifyAssetClosure(directory);
    verifyBuildIdentity(directory, buildId);
    if (!smokeUrl) return;
    const response = await fetch(new URL('/version.json', smokeUrl), { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || (await response.json()).buildId !== buildId) throw new Error(`Public smoke failed at ${smokeUrl}`);
}

export function retainPrevious(oldLiveDir, buildId, root = GENERATIONS_DIR, keepAll = false) {
    const retained = path.join(root, `${RUNTIME_PREFIX}previous-${Date.now()}-${buildId.slice(0, 12)}`);
    try {
        renameSync(oldLiveDir, retained);
    } catch (error) {
        console.warn(`[client-build] live generation is safe; old generation remains at ${oldLiveDir}: ${error.message}`);
        return oldLiveDir;
    }
    if (keepAll) return retained;
    const previous = readdirSync(root)
        .filter((name) => name.startsWith(`${RUNTIME_PREFIX}previous-`))
        .sort()
        .reverse();
    for (const expired of previous.slice(3)) {
        try { rmSync(path.join(root, expired), { recursive: true, force: true }); }
        catch (error) { console.warn(`[client-build] retained generation cleanup deferred: ${error.message}`); }
    }
    return retained;
}

/** Remove only staging directories whose recorded builder PID is no longer alive. */
export function reconcileRuntimeState(root = ROOT) {
    const removed = [];
    const directories = [root, path.join(root, '.nassaj-local-preview', 'client')];
    for (const directory of directories) {
        if (!existsSync(directory)) continue;
        for (const name of readdirSync(directory)) {
            const match = name.match(/^dist\.atomic\.predeploy-staging-[a-f0-9]{12}-(\d+)$/);
            if (!match) continue;
            let alive = true;
            try { process.kill(Number(match[1]), 0); } catch { alive = false; }
            if (!alive) {
                rmSync(path.join(directory, name), { recursive: true, force: true });
                removed.push(name);
            }
        }
    }
    return removed;
}

export function isLiveClientCurrent(root = ROOT, liveDir = path.join(root, 'dist')) {
    try {
        const liveBuildId = JSON.parse(readFileSync(path.join(liveDir, 'version.json'), 'utf8')).buildId;
        return liveBuildId === computeClientBuildId(root);
    } catch {
        return false;
    }
}

/** Build identity currently served from the live directory, or null. */
export function readLiveClientBuildId(root = ROOT, liveDir = path.join(root, 'dist')) {
    try {
        const value = JSON.parse(readFileSync(path.join(liveDir, 'version.json'), 'utf8')).buildId;
        return /^[a-f0-9]{64}$/.test(value) ? value : null;
    } catch {
        return null;
    }
}

/** Fail closed when the live server predates atomic client-generation support. */
export async function checkAtomicPublisherCapability(origin, fetchImpl = fetch) {
    try {
        const response = await fetchImpl(new URL('/health', origin), {
            cache: 'no-store',
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return false;
        const health = await response.json();
        return health?.clientAtomicPublisherReady === true;
    } catch {
        return false;
    }
}

export async function gateAtomicPublisherStartup(origin, options = {}) {
    const ready = await checkAtomicPublisherCapability(origin, options.fetchImpl || fetch);
    if (!ready) return { ready: false, removed: [] };
    const reconcile = options.reconcile || (() => reconcileRuntimeState());
    return { ready: true, removed: reconcile() };
}

/** Bind a reviewed request to the exact source observed inside the publisher. */
export function assertReviewedClientInput(options, buildId, inputEpoch) {
    if (options.expectedBuildId == null && options.expectedInputEpoch == null) return;
    if (!/^[a-f0-9]{64}$/.test(options.expectedBuildId || '')
        || !/^[a-f0-9]{64}$/.test(options.expectedInputEpoch || '')) {
        throw new Error('Reviewed client build ID and input epoch must be supplied together.');
    }
    if (buildId !== options.expectedBuildId || inputEpoch !== options.expectedInputEpoch) {
        throw new Error('Reviewed client source changed; promotion cancelled.');
    }
}

async function buildAndPromote(options) {
    assertStandaloneNodePublication(ROOT);
    // This runs only after acquireFlock() has taken the same lock as an
    // isolated publisher.  Checking before that lock is a TOCTOU bug: an
    // isolated promotion could complete while this mutable build was waiting.
    if (options.localPreview && readMutableWatcherInhibit(ROOT)) {
        throw new Error('Mutable-tree client publication is inhibited by an exact isolated commit publish.');
    }
    if (!resourcesSafe()) throw new Error('Build deferred: CPU or memory utilization is at least 80%.');
    const generationsDir = options.localPreview ? PREVIEW_GENERATIONS_DIR : GENERATIONS_DIR;
    assertExchangeSupport(LIVE_DIR, generationsDir);
    // Release/manual builds retain the complete source-maintenance gate. The
    // local watcher must never rewrite its own watched source tree.
    if (!options.localPreview) run(process.execPath, ['scripts/ensure-wiki-index.mjs']);
    if (options.generationFile) assertGenerationCurrent(options.generationFile, options.generation);
    const buildId = computeClientBuildId();
    const inputEpoch = computeClientInputEpoch();
    assertReviewedClientInput(options, buildId, inputEpoch);
    const previewEvent = (state, fields = {}) => {
        if (!options.localPreview) return;
        recordPreviewLedgerEvent(ROOT, {
            target: 'client', sourceGeneration: options.generation, state,
            sourceBuildId: buildId, candidateBuildId: buildId,
            runtimeBuildId: readLiveClientBuildId(), ...fields,
        });
    };
    previewEvent('building');
    const stagedDir = path.join(generationsDir, `${RUNTIME_PREFIX}staging-${buildId.slice(0, 12)}-${process.pid}`);
    mkdirSync(generationsDir, { recursive: true });
    rmSync(stagedDir, { recursive: true, force: true });
    mkdirSync(stagedDir, { recursive: true });
    let exchanged = false;
    try {
        run(path.join(ROOT, 'node_modules', '.bin', 'tsc'), [
            '--noEmit', '-p', options.localPreview ? 'tsconfig.preview.json' : 'tsconfig.json',
        ]);
        const vite = viteBuildInvocation();
        run(vite.command, vite.args, {
            env: {
                ...process.env,
                NASSAJ_ATOMIC_CLIENT_BUILD: '1',
                NASSAJ_LOCAL_PREVIEW: options.localPreview ? '1' : '0',
                NASSAJ_BUILD_ID: buildId,
                NASSAJ_CLIENT_OUT_DIR: stagedDir,
            },
        });
        run(process.execPath, ['scripts/build-provenance.mjs', '--artifact', 'client'], {
            env: { ...process.env, NASSAJ_BUILD_ID: buildId, NASSAJ_PROVENANCE_OUT_DIR: stagedDir },
        });
        mergeLegacyAssets(LIVE_DIR, stagedDir);
        // Record the post-merge union, not only this build's fresh files. An old
        // tab may defer a lazy import across many rapid local edits; retaining
        // every content-hashed asset keeps that request valid. Release cleanup
        // may garbage-collect these only after the operator closes live tabs.
        const metadata = JSON.parse(readFileSync(path.join(stagedDir, 'ATOMIC_GENERATION.json'), 'utf8'));
        writeFileSync(path.join(stagedDir, 'ATOMIC_GENERATION.json'), `${JSON.stringify({ ...metadata, buildId }, null, 2)}\n`);
        await smoke(stagedDir, buildId, null);
        previewEvent('built');
        if (computeClientBuildId() !== buildId) throw new Error('Source content changed during build; promotion cancelled.');
        if (computeClientInputEpoch() !== inputEpoch) throw new Error('Source metadata changed during build; promotion cancelled.');
        if (options.generationFile) assertGenerationCurrent(options.generationFile, options.generation);
        assertReviewedClientInput(options, computeClientBuildId(), computeClientInputEpoch());
        try {
            await promoteWithSmokeRollback(stagedDir, LIVE_DIR, (live) => smoke(live, buildId, options.smokeUrl), { root: ROOT });
            exchanged = true;
        } catch (error) {
            throw new Error(`Smoke failed; previous generation restored. ${error.message}`);
        }
        previewEvent('promoted', { promotedBuildId: buildId, runtimeBuildId: buildId });
        retainPrevious(stagedDir, buildId, generationsDir, options.keepPreviousGenerations);
        previewEvent('served', { promotedBuildId: buildId, runtimeBuildId: buildId });
        console.log(`[client-build] published ${buildId}; no server restart was requested.`);
    } catch (error) {
        const superseded = /Source (?:content |metadata )?changed during build|generation promotion cancelled/.test(error.message);
        try {
            previewEvent(superseded ? 'superseded' : 'failed', {
                error: { code: superseded ? 'source_superseded' : 'client_preview_failed', message: error.message },
            });
        } catch (ledgerError) {
            throw new AggregateError([error, ledgerError], 'Client preview failed and its ledger could not be updated.');
        }
        throw error;
    } finally {
        if (!exchanged && existsSync(stagedDir)) rmSync(stagedDir, { recursive: true, force: true });
    }
}

function releaseBuildEnvironment(publicVite) {
    const allowedRuntime = [
        'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT',
        'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ];
    return {
        ...Object.fromEntries(allowedRuntime.flatMap((key) => (
            typeof process.env[key] === 'string' && process.env[key] ? [[key, process.env[key]]] : []
        ))),
        NODE_ENV: 'production',
        ...Object.fromEntries(publicVite),
    };
}

function assertReleaseCandidatePath(sourceRoot, candidateRoot, outputRoot) {
    const source = realpathSync(sourceRoot);
    const candidate = realpathSync(candidateRoot);
    if (lstatSync(source).isSymbolicLink() || lstatSync(candidate).isSymbolicLink()) {
        throw new Error('Release candidate roots must be real directories.');
    }
    const target = path.resolve(outputRoot);
    if (path.dirname(target) !== candidate || path.basename(target) !== 'client') {
        throw new Error('Release client output must be the direct client child of candidateRoot.');
    }
    if (existsSync(target)) throw new Error('Release client candidate output already exists.');
    if (statSync(source).dev !== statSync(candidate).dev) {
        throw new Error('Release client source and candidate root must share a filesystem.');
    }
    for (const file of CLIENT_ENV_FILES) {
        if (existsSync(path.join(source, file))) {
            throw new Error(`Release source contains an ungoverned Vite environment file: ${file}`);
        }
    }
    return { source, candidate, target };
}

/** Build a verified release client candidate without touching the live dist tree. */
export async function buildClientReleaseCandidate(options, injected = {}) {
    const releaseCommit = String(options.releaseCommit || '');
    if (!/^[a-f0-9]{40}$/.test(releaseCommit)) throw new Error('Release client commit is invalid.');
    if (typeof options.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(options.version)) {
        throw new Error('Release client version is invalid.');
    }
    const paths = assertReleaseCandidatePath(options.sourceRoot, options.candidateRoot, options.outputRoot);
    const publicVite = normalizeReleaseViteEnvironment(options.publicVite);
    const buildId = computeClientBuildIdWithEnvironment(paths.source, publicVite);
    const generationId = clientPublicationDigest({ sourceOid: releaseCommit, buildId });
    const staging = path.join(paths.source, `${RUNTIME_PREFIX}staging-${buildId.slice(0, 12)}-${process.pid}`);
    const runCandidate = injected.run || run;
    mkdirSync(staging, { mode: 0o700 });
    try {
        runCandidate(path.join(paths.source, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], {
            cwd: paths.source,
            env: releaseBuildEnvironment(publicVite),
        });
        const vite = viteBuildInvocation(paths.source);
        runCandidate(vite.command, vite.args, {
            cwd: paths.source,
            env: {
                ...releaseBuildEnvironment(publicVite),
                NASSAJ_ATOMIC_CLIENT_BUILD: '1',
                NASSAJ_BUILD_ID: buildId,
                NASSAJ_CLIENT_CACHE_ROOT: paths.candidate,
                NASSAJ_CLIENT_OUT_DIR: staging, NASSAJ_CLIENT_GENERATION_ID: generationId,
            },
        });
        writeFileSync(path.join(staging, 'BUILD_PROVENANCE.json'), `${JSON.stringify({
            artifact: 'client', version: options.version, commit: releaseCommit,
            baseCommit: releaseCommit, commitShort: releaseCommit.slice(0, 8),
            branch: null, describe: options.version, dirty: false, dirtyFiles: 0,
            builtAt: new Date().toISOString(), buildId, generationId,
            publicVite: Object.fromEntries(publicVite),
        }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
        await smoke(staging, buildId, null);
        createClientAssetManifest(staging, { generationId, sourceOid: releaseCommit, buildId }, verifyAssetClosure);
        renameSync(staging, paths.target);
        verifyBuildIdentity(paths.target, buildId);
        return { artifact: 'client', buildId, outputRoot: paths.target, releaseCommit, version: options.version };
    } finally {
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const options = parseArgs(argv);
    if (!options.reconcileOnly) assertStandaloneNodePublication(ROOT);
    if (!options.locked) return acquireFlock(argv, options.localPreview);
    if (options.reconcileOnly) {
        reconcileRuntimeState();
        return;
    }
    await buildAndPromote(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[client-build] ${error.message}`);
        process.exitCode = error.exitCode || 1;
    });
}
