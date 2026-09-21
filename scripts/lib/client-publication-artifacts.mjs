/** Installed client artifact and cumulative compatibility contract; never imports candidate code. */
import fs, { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const CLIENT_ASSET_MANIFEST = 'CLIENT_ASSET_MANIFEST.json';
export const CLIENT_ASSET_SCHEMA = 'nassaj-client-assets/v1';
export const CLIENT_COMPATIBILITY_SCHEMA = 'nassaj-client-compatibility-proof/v1';
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1024 ** 3;

/** Stable JSON encoding shared by proofs, manifests, and immutable receipts. */
export function clientPublicationCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(clientPublicationCanonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${clientPublicationCanonical(value[key])}`).join(',')}}`;
    if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('client_publication_noncanonical_value');
    return JSON.stringify(value);
}

/** Hash bytes or a canonical contract object. */
export function clientPublicationDigest(value) {
    return createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : clientPublicationCanonical(value)).digest('hex');
}

/** Pin a regular, single-link file without following aliases or blocking on special files. */
export function readClientPublicationFile(file, maximum = MAX_BYTES) {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error('client_publication_file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        if (before.dev !== opened.dev || before.ino !== opened.ino || opened.ctimeMs !== after.ctimeMs
            || opened.size !== after.size || bytes.length !== after.size) throw new Error('client_publication_file_changed');
        return bytes;
    } finally { fs.closeSync(fd); }
}

/** Reject traversal and ambiguous URL encodings in generation-relative asset paths. */
export function assertClientAssetPath(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('/')
        || /[\\%?#\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('client_asset_path_invalid');
    return value;
}

/** Independently inventory a finished build, refusing links, devices, mount escapes and over-budget trees. */
export function inspectClientPublicationTree(directory, options = {}) {
    const root = path.resolve(directory), base = fs.lstatSync(root);
    if (!base.isDirectory() || fs.realpathSync(root) !== root) throw new Error('client_publication_directory_unsafe');
    const maximumBytes = options.maximumBytes ?? MAX_BYTES, maximumFiles = options.maximumFiles ?? 50000;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(maximumFiles) || maximumFiles < 1) throw new Error('client_publication_budget_invalid');
    const entries = [], pending = ['']; let totalBytes = 0, visited = 0;
    while (pending.length) {
        const relative = pending.pop(), current = path.join(root, relative);
        const stream = fs.opendirSync(current);
        try { for (let entry; (entry = stream.readSync()) !== null;) {
            if (++visited > maximumFiles) throw new Error('client_publication_capacity_exceeded');
            const name = entry.name;
            const next = relative ? `${relative}/${name}` : name, file = path.join(root, next), stat = fs.lstatSync(file);
            assertClientAssetPath(next);
            if (stat.dev !== base.dev || stat.isSymbolicLink()) throw new Error('client_publication_tree_alias');
            if (stat.isDirectory()) { pending.push(next); continue; }
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('client_publication_tree_special');
            if (next === CLIENT_ASSET_MANIFEST && !options.includeManifest) continue;
            totalBytes += stat.size;
            if (totalBytes > maximumBytes || entries.length >= maximumFiles) throw new Error('client_publication_capacity_exceeded');
            entries.push({ path: next, sha256: clientPublicationDigest(readClientPublicationFile(file, maximumBytes)), size: stat.size });
        } } finally { stream.closeSync(); }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return { entries, totalBytes, treeDigest: clientPublicationDigest(entries) };
}

/** Create the immutable manifest only after the installed closure verifier accepts output. */
export function createClientAssetManifest(directory, identity, verifyClosure) {
    if (!HEX64.test(identity?.generationId || '') || !HEX64.test(identity?.buildId || '') || !HEX40.test(identity?.sourceOid || '')) throw new Error('client_asset_identity_invalid');
    if (typeof verifyClosure !== 'function') throw new Error('client_asset_closure_verifier_required');
    verifyClosure(directory);
    const { entries } = inspectClientPublicationTree(directory);
    if (!entries.some(entry => entry.path === 'index.html') || !entries.some(entry => entry.path === 'BUILD_PROVENANCE.json')) throw new Error('client_asset_output_incomplete');
    const manifest = { schema: CLIENT_ASSET_SCHEMA, generationId: identity.generationId, sourceOid: identity.sourceOid, buildId: identity.buildId, entries };
    const bytes = `${clientPublicationCanonical(manifest)}\n`, file = path.join(directory, CLIENT_ASSET_MANIFEST);
    const fd = fs.openSync(file, 'wx', 0o444);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(directory, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { manifest, manifestDigest: clientPublicationDigest(Buffer.from(bytes)) };
}

const MANIFEST_DRIFT_SAMPLE_LIMIT = 20;

/**
 * Bound a set of drifted relative paths to a sample the operator can act on
 * without flooding the error: every path here is already dist-relative
 * (never absolute), so nothing outside the generation tree can leak through it.
 */
function summarizeManifestDrift(paths) {
    const sorted = [...paths].sort();
    return { total: sorted.length, sample: sorted.slice(0, MANIFEST_DRIFT_SAMPLE_LIMIT) };
}

/** Three-way diff between the sealed manifest and the disk inventory, by relative path. */
function diffManifestEntries(manifestEntries, inventoryEntries) {
    const sealed = new Map(manifestEntries.map((entry) => [entry.path, entry]));
    const actual = new Map(inventoryEntries.map((entry) => [entry.path, entry]));
    const unexpected = [], changed = [];
    for (const [relativePath, entry] of actual) {
        const before = sealed.get(relativePath);
        if (!before) { unexpected.push(relativePath); continue; }
        if (before.sha256 !== entry.sha256 || before.size !== entry.size) changed.push(relativePath);
    }
    const missing = [...sealed.keys()].filter((relativePath) => !actual.has(relativePath));
    return {
        unexpected: summarizeManifestDrift(unexpected),
        missing: summarizeManifestDrift(missing),
        changed: summarizeManifestDrift(changed),
    };
}

/**
 * Compose the operator-facing `client_asset_manifest_changed` error.
 *
 * The MESSAGE carries counts only — no path, no command. It is sanitized on its
 * way to the browser (`sanitizeUpdateJobMessage`), and that sanitizer folds every
 * `a/b/c` to `c`: `uqud-t7k9/lifetrip/logo.svg` used to arrive as `uqud-t7k9logo.svg`,
 * a filename that exists nowhere, and the 300-char cap then truncated the advice.
 * A message built to survive that filter states the counts and stops.
 *
 * The PATHS ride `error.details` structurally instead (bounded lists of
 * dist-relative paths), which the update-job snapshot revalidates and the client
 * renders as a list. Whether the publisher is installed is decided by the server
 * when it reads the receipt: this module is inlined into the OID control capsule,
 * which must never resolve its own location.
 */
function manifestChangedError(manifestEntries, inventoryEntries) {
    const details = diffManifestEntries(manifestEntries, inventoryEntries);
    const parts = [];
    if (details.unexpected.total) parts.push(`${details.unexpected.total} unexpected file(s) on disk`);
    if (details.missing.total) parts.push(`${details.missing.total} manifest file(s) missing`);
    if (details.changed.total) parts.push(`${details.changed.total} file(s) changed since sealing`);
    const summary = parts.length ? parts.join('; ') : 'the sealed manifest digest no longer matches, though every entry is identical';
    const error = new Error(`client_asset_manifest_changed: ${summary}. See the listed files in the update details.`);
    error.code = 'client_asset_manifest_changed';
    error.details = details;
    return error;
}

/** Validate a sealed manifest and its exact complete tree without mutating the generation. */
export function validateClientAssetManifest(directory, expected = {}, verifyClosure) {
    const bytes = readClientPublicationFile(path.join(directory, CLIENT_ASSET_MANIFEST), 16 * 1024 ** 2), manifest = JSON.parse(bytes);
    if (manifest.schema !== CLIENT_ASSET_SCHEMA || !HEX64.test(manifest.generationId || '') || !HEX64.test(manifest.buildId || '')
        || !HEX40.test(manifest.sourceOid || '') || !Array.isArray(manifest.entries)) throw new Error('client_asset_manifest_invalid');
    for (const key of ['generationId', 'sourceOid', 'buildId']) if (expected[key] !== undefined && manifest[key] !== expected[key]) throw new Error('client_asset_manifest_identity_mismatch');
    const inventory = inspectClientPublicationTree(directory);
    if (clientPublicationCanonical(manifest.entries) !== clientPublicationCanonical(inventory.entries)
        || expected.manifestDigest && clientPublicationDigest(bytes) !== expected.manifestDigest) {
        throw manifestChangedError(manifest.entries, inventory.entries);
    }
    if (typeof verifyClosure !== 'function') throw new Error('client_asset_closure_verifier_required');
    verifyClosure(directory);
    return { manifest, ...inventory, manifestDigest: clientPublicationDigest(bytes) };
}

/** Conservative cumulative classifier: only styles and inert public image/font assets qualify. */
export function isIndependentClientInput(file) {
    return /^(?:src\/[^\x00]*\.(?:css|scss)|public\/[^\x00]*\.(?:png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf))$/i.test(file)
        && !file.split('/').some(part => part === '..' || part === '.') && !file.includes('\\');
}

/** Prove a target against the actual loaded full baseline, never just its preceding commit. */
export function proveClientCompatibility(options, injected = {}) {
    const { root, sourceOid, baselineOid, baseReceiptDigest, serverIdentity, dependencyIdentity, installedControlDigest } = options;
    if (!HEX40.test(sourceOid || '') || !HEX40.test(baselineOid || '') || !HEX64.test(baseReceiptDigest || '')
        || !HEX64.test(dependencyIdentity || '') || !HEX64.test(installedControlDigest || '')
        || serverIdentity?.sourceOid !== baselineOid || !HEX64.test(serverIdentity?.buildId || '')
        || !Number.isSafeInteger(serverIdentity?.pid) || serverIdentity.pid < 1 || !/^\d+$/.test(serverIdentity?.startTime || '')) throw new Error('client_compatibility_baseline_unproven');
    const run = injected.git || ((args) => {
        const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' } });
        if (result.status !== 0) throw new Error('client_compatibility_git_failed');
        return result.stdout;
    });
    run(['merge-base', '--is-ancestor', baselineOid, sourceOid]);
    const changed = run(['diff', '--name-only', '-z', '--no-renames', baselineOid, sourceOid, '--']).split('\0').filter(Boolean).sort();
    const protectedInputs = changed.filter(file => !isIndependentClientInput(file));
    if (protectedInputs.length) throw Object.assign(new Error('client_publication_full_update_required'), { protectedInputs });
    const proof = { schema: CLIENT_COMPATIBILITY_SCHEMA, classifierVersion: 1, sourceOid, baselineOid, baseReceiptDigest,
        serverIdentity, dependencyIdentity, installedControlDigest, changedInputs: changed, protectedInputs,
        candidateManifestDigest: options.candidateManifestDigest, assetManifestDigest: options.assetManifestDigest };
    if (!HEX64.test(proof.candidateManifestDigest || '') || !HEX64.test(proof.assetManifestDigest || '')) throw new Error('client_compatibility_output_unproven');
    return { proof, proofDigest: clientPublicationDigest(proof) };
}

/** Bind every readonly snapshot byte and mode to the exact Git tree, rejecting named-but-forged snapshots. */
export function assertClientPublicationSnapshot(root, sourceRoot, sourceOid) {
    if (!HEX40.test(sourceOid || '') || path.resolve(sourceRoot) !== path.join(path.resolve(root), '.nassaj-local-preview/oid-snapshots', sourceOid)) throw new Error('client_snapshot_identity_invalid');
    const listed = spawnSync('/usr/bin/git', ['ls-tree', '-rz', '--full-tree', sourceOid], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
    if (listed.status !== 0) throw new Error('client_snapshot_git_failed');
    const records = listed.stdout.split('\0').filter(Boolean).map(line => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
        if (!match) throw new Error('client_snapshot_entry_unsupported');
        return { mode: match[1], oid: match[2], path: match[3] };
    });
    const tree = inspectClientPublicationTree(sourceRoot, { includeManifest: true });
    if (tree.entries.length !== records.length) throw new Error('client_snapshot_tree_mismatch');
    for (const record of records) {
        assertClientAssetPath(record.path);
        const file = path.join(sourceRoot, record.path), bytes = readClientPublicationFile(file);
        const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (actual !== record.oid || (fs.statSync(file).mode & 0o777) !== (record.mode === '100755' ? 0o555 : 0o444)) throw new Error('client_snapshot_tree_mismatch');
        let parent = path.dirname(file);
        while (parent.startsWith(sourceRoot)) {
            if (fs.lstatSync(parent).mode & 0o222) throw new Error('client_snapshot_tree_writable');
            if (parent === sourceRoot) break;
            parent = path.dirname(parent);
        }
    }
    return tree.treeDigest;
}

/** Verify every referenced asset stays inside the complete client generation. */
export function verifyAssetClosure(directory) {
    const missing = new Set();
    const files = [];
    walkFiles(directory, files);
    const root = realpathSync(directory);
    let generationId = null;
    const provenanceFile = path.join(root, 'BUILD_PROVENANCE.json');
    if (existsSync(provenanceFile)) {
        const record = JSON.parse(readFileSync(provenanceFile, 'utf8'));
        if (record.generationId !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(record.generationId)) throw new Error('Client generation URL identity is invalid.');
            generationId = record.generationId;
        }
    }
    for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const clean of extractAssetReferences(file, content)) {
            const prefix = generationId ? `/assets/generations/${generationId}/` : null;
            const local = prefix && clean.startsWith(prefix) ? clean.slice(prefix.length) : null;
            const target = local !== null ? path.resolve(directory, local) : clean.startsWith('/')
                ? path.resolve(directory, clean.slice(1))
                : path.resolve(path.dirname(file), clean);
            if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
                missing.add(`${path.relative(directory, file)} -> unsafe ${clean}`);
            } else if (!existsSync(target)) {
                missing.add(`${path.relative(directory, file)} -> ${clean}`);
            } else {
                const realTarget = realpathSync(target);
                if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) {
                    missing.add(`${path.relative(directory, file)} -> symlink escape ${clean}`);
                }
            }
        }
    }
    if (missing.size) throw new Error(`Asset closure failed:\n${[...missing].join('\n')}`);
}

function extractAssetReferences(file, content) {
    const suffix = String.raw`[^"'\x60()\s?#]+\.(?:js|css|json|webmanifest|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico)`;
    const query = String.raw`(?:[?#][^"'\x60()\s]*)?`;
    const boundary = String.raw`(?=["'\x60()\s]|$)`;
    const relativeOrRoot = String.raw`(?:\/(?!\/)|\.\.?\/)`;
    const pattern = new RegExp(String.raw`["'\x60(](${relativeOrRoot}${suffix})${query}${boundary}`, 'g');
    return [...content.matchAll(pattern)]
        .filter((match) => path.extname(file) !== '.js' || !isEsbuildWrapperModuleKey(content, match))
        .map((match) => match[1]);
}

function isEsbuildWrapperModuleKey(content, match) {
    const reference = match[1];
    const openingQuote = content[match.index];
    if (!['"', "'"].includes(openingQuote)) return false;
    if (!reference.startsWith('../../node_modules/') || !reference.endsWith('.js')) return false;
    if (match[0] !== `${openingQuote}${reference}`) return false;
    const closingQuoteIndex = match.index + match[0].length;
    if (content[closingQuoteIndex] !== openingQuote) return false;
    const identifier = String.raw`[$A-Z_a-z][$\w]*`;
    const methodParameters = new RegExp(String.raw`^\(\s*(?:${identifier}(?:\s*,\s*${identifier})*)?\s*\)\s*\{`);
    return methodParameters.test(content.slice(closingQuoteIndex + 1));
}

/** Collect regular client text assets, rejecting symlinks. */
export function walkFiles(directory, output) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Asset closure rejects symlink: ${full}`);
        if (entry.isDirectory()) walkFiles(full, output);
        else if (entry.isFile() && /\.(?:html|css|js|json)$/.test(entry.name)) output.push(full);
    }
}
