/** Immutable, self-describing update runtime shared by normal and release builds. */
import { createHash } from 'node:crypto';
import {
    chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
    readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const UPDATE_RUNTIME_DIRECTORY = 'UPDATE_RUNTIME_BUNDLE';
export const UPDATE_RUNTIME_MANIFEST = 'UPDATE_RUNTIME_MANIFEST.json';
export const UPDATE_RUNTIME_CAPABILITY = 'UPDATE_RUNTIME_CAPABILITY.json';
export const UPDATE_RUNTIME_CAPABILITY_SCHEMA = 'nassaj-update-capability/v1';
const UPDATE_RUNTIME_BUNDLE_SCHEMA = 'nassaj-update-runtime-bundle/v2';

export const UPDATE_RUNTIME_BUNDLE_ENTRIES = Object.freeze([
    'scripts/nassaj-release-launcher.mjs',
    // The PM2 process entry ships *with* the release (ADR-156, WI-9/WI-16): a node
    // that installs this version gets the launcher-container fix in the same step
    // instead of depending on a hand-written wrapper nobody reviews.
    'scripts/pm2-entry.mjs',
    'scripts/lib/local-reviewed-build-identity.mjs',
    'scripts/lib/release-runtime-startup-admission.mjs',
    'scripts/lib/release-runtime-managed-admission.mjs',
    'scripts/build-provenance.mjs',
    'scripts/client-build-atomic.mjs',
    'scripts/client-preview-from-oid.mjs',
    'scripts/preview-oid-consumer.mjs',
    'scripts/client-publication-consumer-launcher.mjs',
    'scripts/lib/client-publication-executor.mjs',
    'scripts/lib/client-publication-artifacts.mjs',
    'scripts/lib/client-publication-isolation.mjs',
    'scripts/lib/client-publication-journal.mjs',
    'scripts/lib/client-publication-lineage.mjs',
    'scripts/lib/client-publication-archive.mjs',
    'scripts/lib/client-publication-baseline.mjs',
    'scripts/server-build-atomic.mjs',
    'scripts/patch-codex-sdk-image-only.mjs',
    'scripts/lib/codex-sdk-dependencies.json',
    'scripts/source-update-candidate.mjs',
    'scripts/oid-update-candidate.mjs',
    'scripts/lib/node-update-publication-guard.mjs',
    'scripts/lib/source-update-activation.mjs',
    'scripts/lib/local-source-recovery-mode.mjs',
    // Manual rollback deliberately does not import the candidate's compiled
    // repository: ship and fingerprint the standalone SQLite policy itself.
    'scripts/lib/source-update-manual-rollback-db.mjs',
    'scripts/lib/update-release-asset.mjs',
    'scripts/lib/update-release-layout-adapter.mjs',
    'scripts/lib/update-release-layout-activation.mjs',
    'scripts/lib/update-runtime-capability.mjs',
    'scripts/lib/update-runtime-janitor.mjs',
    'scripts/lib/update-runtime-orchestrator.mjs',
    'scripts/lib/release-database-contract.mjs',
    'scripts/lib/release-runtime-cutover.mjs',
    'scripts/lib/release-runtime-owner-adapter.mjs',
    'scripts/release-runtime-cutover.mjs',
    'scripts/release-runtime-host-dispatcher.mjs',
    'scripts/lib/release-runtime-host-operations.mjs',
    'scripts/local-preview-ledger.mjs',
    'scripts/local-preview-server-activation.mjs',
    // T-1803أ: the only writer for the external public-content contract
    // (`server/services/public-page-manifest.mjs` and friends) never shipped to
    // an installed node — its three `server/services/*.mjs` dependencies are
    // NOT `.js`/`.ts`, so `server/tsconfig.json`'s include globs never emit
    // them into dist-server. This entry's closure (below) pulls them in.
    'scripts/public-page-publish.mjs',
    'scripts/git-control-root.mjs',
    'scripts/oid-control-capsule.mjs',
    'scripts/oid-control-capsule.source.mjs',
    // The OID capsule reaches the vendored PM2 codec through esbuild aliases and
    // CommonJS require(), neither of which the ESM closure walker follows. List
    // them explicitly so the update runtime bundle (and, via the SERVER_BUILD_INPUTS
    // spread, the immutable input manifest) carries every capsule-closure byte.
    'scripts/lib/pm2-codec-builtins.mjs',
    'scripts/vendor/pm2-codec/amp/index.js',
    'scripts/vendor/pm2-codec/amp/lib/encode.js',
    'scripts/vendor/pm2-codec/amp/lib/decode.js',
    'scripts/vendor/pm2-codec/amp/lib/stream.js',
    'scripts/lib/local-update-control.mjs',
    'scripts/lib/local-update-policy.mjs',
    'scripts/lib/local-update-policy-write.mjs',
    'scripts/oid-control-journal.mjs',
    'scripts/preview-oid-capsule-launcher.mjs',
    'scripts/preview-oid-owner-action.mjs',
    'scripts/prepare-legacy-release-runtime.mjs',
    'scripts/run-release-database-rehearsal.sh',
    'scripts/safe-restart.sh',
    'scripts/managed-safe-restart-client.mjs',
]);

/** Root-only forward operator entries: never copied into the application update bundle. */
export const FORWARD_EXECUTABLE_ENTRIES = Object.freeze([
    'scripts/safe-restart.sh',
    'scripts/managed-safe-restart-client.mjs',
    'scripts/release-runtime-managed-child.mjs',
    'scripts/lib/release-runtime-managed-restart.mjs',
    'scripts/lib/release-runtime-managed-admission.mjs',
    'scripts/release-runtime-forward-parent.mjs',
    'scripts/release-runtime-forward-child.mjs',
    'scripts/lib/release-runtime-forward-child-protocol.mjs',
    'scripts/lib/release-runtime-forward-parent.mjs',
    'scripts/lib/release-runtime-forward-receipts.mjs',
    'scripts/lib/release-runtime-forward-retirement.mjs',
]);

const IMPORT_PATTERN = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\()(['"])(\.\.?\/[^'"]+)\1/g;

function portable(value) { return value.split(path.sep).join('/'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function assertRegularSource(root, relative) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Update runtime source escapes root: ${relative}`);
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Update runtime source must be a regular file: ${relative}`);
    return { absolute, metadata };
}

function resolveRelativeImport(root, importer, specifier) {
    const candidate = path.resolve(path.dirname(path.join(root, importer)), specifier);
    const attempts = [candidate, `${candidate}.mjs`, `${candidate}.js`];
    const resolved = attempts.find((item) => existsSync(item));
    if (!resolved) throw new Error(`Update runtime import is missing: ${importer} -> ${specifier}`);
    const relative = portable(path.relative(root, resolved));
    assertRegularSource(root, relative);
    return relative;
}

/** Recursively close every relative ESM dependency of the reviewed entry set. */
export function collectUpdateRuntimeClosure(root, entries = UPDATE_RUNTIME_BUNDLE_ENTRIES) {
    const sourceRoot = realpathSync(root);
    const pending = [...entries];
    const visited = new Set();
    while (pending.length) {
        const relative = portable(pending.pop());
        if (visited.has(relative)) continue;
        const { absolute } = assertRegularSource(sourceRoot, relative);
        visited.add(relative);
        if (!/\.[cm]?js$/.test(relative)) continue;
        const source = readFileSync(absolute, 'utf8');
        for (const match of source.matchAll(IMPORT_PATTERN)) {
            const dependency = resolveRelativeImport(sourceRoot, relative, match[2]);
            if (!visited.has(dependency)) pending.push(dependency);
        }
    }
    return [...visited].sort();
}

export function computeUpdateRuntimeBuildId(files) {
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(file.path).update('\0').update(String(file.mode)).update('\0')
            .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    }
    return hash.digest('hex');
}

export function createUpdateRuntimeManifest(root, entries = UPDATE_RUNTIME_BUNDLE_ENTRIES) {
    const files = collectUpdateRuntimeClosure(root, entries).map((relative) => {
        const { absolute, metadata } = assertRegularSource(realpathSync(root), relative);
        const bytes = readFileSync(absolute);
        // Git preserves only the executable bit. Canonicalize the remaining mode bits so
        // the embedded bundle identity is independent of the checkout's ambient umask and
        // matches the release archive's mode projection.
        const mode = metadata.mode & 0o111 ? 0o755 : 0o644;
        return { path: relative, mode, size: bytes.length, sha256: digest(bytes) };
    });
    return {
        schemaVersion: 2,
        buildIdMode: 'path-mode-size-content-sha256',
        buildId: computeUpdateRuntimeBuildId(files),
        entries: [...entries].sort(),
        files,
    };
}

/** Copy the exact closure and stamp a v2 marker; no source tree mutation. */
export function installUpdateRuntimeBundle(sourceRoot, artifactRoot, options = {}) {
    const manifest = createUpdateRuntimeManifest(sourceRoot, options.entries);
    const bundleRoot = path.join(artifactRoot, UPDATE_RUNTIME_DIRECTORY);
    if (existsSync(bundleRoot) || existsSync(path.join(artifactRoot, UPDATE_RUNTIME_MANIFEST))) {
        throw new Error('Update runtime bundle already exists in artefact.');
    }
    mkdirSync(bundleRoot, { recursive: false, mode: 0o755 });
    for (const file of manifest.files) {
        const source = path.join(sourceRoot, file.path);
        const destination = path.join(bundleRoot, file.path);
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
        copyFileSync(source, destination);
        chmodSync(destination, file.mode);
    }
    writeFileSync(path.join(artifactRoot, UPDATE_RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    const capability = { schema: UPDATE_RUNTIME_BUNDLE_SCHEMA, strategy: 'artifact-runtime-v2', protocol: 2,
        manifest: UPDATE_RUNTIME_MANIFEST, bundleDirectory: UPDATE_RUNTIME_DIRECTORY, bootstrapBuildId: manifest.buildId };
    writeFileSync(path.join(artifactRoot, UPDATE_RUNTIME_CAPABILITY), `${JSON.stringify(capability, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    verifyUpdateRuntimeBundle(artifactRoot);
    return Object.freeze({ manifest, capability, bundleRoot });
}

function walkBundle(directory, root, output) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(directory, entry.name);
        const relative = portable(path.relative(root, absolute));
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink()) throw new Error(`Update runtime bundle rejects symlink: ${relative}`);
        if (entry.isDirectory()) walkBundle(absolute, root, output);
        else if (entry.isFile()) output.push({ absolute, relative, metadata });
        else throw new Error(`Update runtime bundle rejects special file: ${relative}`);
    }
}

/** Verify exact path, mode, size and content closure; extra files fail closed. */
export function verifyUpdateRuntimeBundle(artifactRoot) {
    artifactRoot = path.resolve(artifactRoot);
    const manifest = JSON.parse(readFileSync(path.join(artifactRoot, UPDATE_RUNTIME_MANIFEST), 'utf8'));
    if (manifest.schemaVersion !== 2 || manifest.buildIdMode !== 'path-mode-size-content-sha256'
        || !/^[a-f0-9]{64}$/.test(manifest.buildId || '') || !Array.isArray(manifest.files)) {
        throw new Error('Update runtime manifest v2 is invalid.');
    }
    const bundleRoot = path.join(artifactRoot, UPDATE_RUNTIME_DIRECTORY);
    const metadata = lstatSync(bundleRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Update runtime bundle root is unsafe.');
    const actual = [];
    walkBundle(bundleRoot, bundleRoot, actual);
    if (actual.length !== manifest.files.length) throw new Error('Update runtime bundle closure has extra or missing files.');
    const records = actual.map(({ absolute, relative, metadata: item }) => {
        const bytes = readFileSync(absolute);
        return { path: relative, mode: item.mode & 0o777, size: bytes.length, sha256: digest(bytes) };
    // walkBundle yields a depth-first, per-directory order; the manifest stores
    // files in the flat code-point order of collectUpdateRuntimeClosure. Sibling
    // directories like pm2-codec/amp and pm2-codec/amp-message sort differently
    // between the two, so canonicalize records to the manifest order before the
    // identity comparison — the check stays a full path/mode/size/content match.
    }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (JSON.stringify(records) !== JSON.stringify(manifest.files)
        || computeUpdateRuntimeBuildId(records) !== manifest.buildId) throw new Error('Update runtime bundle fingerprint mismatch.');
    const declared = new Set(manifest.files.map((file) => file.path));
    for (const record of records) {
        if (!/\.[cm]?js$/.test(record.path)) continue;
        const source = readFileSync(path.join(bundleRoot, record.path), 'utf8');
        for (const match of source.matchAll(IMPORT_PATTERN)) {
            const candidate = path.resolve(path.dirname(path.join(bundleRoot, record.path)), match[2]);
            const attempts = [candidate, `${candidate}.mjs`, `${candidate}.js`];
            const resolved = attempts.find((item) => existsSync(item));
            if (!resolved || (resolved !== bundleRoot && !resolved.startsWith(`${bundleRoot}${path.sep}`))) {
                throw new Error(`Update runtime bundle import escapes closure: ${record.path} -> ${match[2]}`);
            }
            const dependency = portable(path.relative(bundleRoot, resolved));
            if (!declared.has(dependency)) throw new Error(`Update runtime bundle import is undeclared: ${record.path} -> ${dependency}`);
            const dependencyMetadata = lstatSync(resolved);
            if (!dependencyMetadata.isFile() || dependencyMetadata.isSymbolicLink()) {
                throw new Error(`Update runtime bundle import is unsafe: ${record.path} -> ${dependency}`);
            }
        }
    }
    const capability = JSON.parse(readFileSync(path.join(artifactRoot, UPDATE_RUNTIME_CAPABILITY), 'utf8'));
    if (capability.schema !== UPDATE_RUNTIME_BUNDLE_SCHEMA || capability.strategy !== 'artifact-runtime-v2' || capability.protocol !== 2
        || capability.manifest !== UPDATE_RUNTIME_MANIFEST || capability.bundleDirectory !== UPDATE_RUNTIME_DIRECTORY
        || capability.bootstrapBuildId !== manifest.buildId) throw new Error('Update runtime capability marker mismatch.');
    return Object.freeze({ manifest, capability, bundleRoot });
}
