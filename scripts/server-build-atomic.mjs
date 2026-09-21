#!/usr/bin/env node
import { assertLegacyNodePublication, assertStandaloneNodePublication } from './lib/node-update-mode.mjs';
import { hashOidPairDependencyTree } from './oid-control-capsule.mjs';
import { bundleOidControlCapsule, OID_CONTROL_COMPAT_ENTRY } from './lib/oid-control-bundle.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
import { computeDependencyContractV2 } from './lib/oid-dependency-candidate.mjs';
/** Build and atomically publish the local server artefact without touching PM2. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { verifyCodexSdkImageOnlySync } from './patch-codex-sdk-image-only.mjs';
import { previewControlPaths, recordPreviewLedgerEvent } from './local-preview-ledger.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import {
    installUpdateRuntimeBundle, verifyUpdateRuntimeBundle, UPDATE_RUNTIME_BUNDLE_ENTRIES,
} from './lib/update-runtime-bundle.mjs';
import { supportsAtomicExchange } from './lib/atomic-exchange-capability.mjs';

export { supportsAtomicExchange };

import { FORWARD_PROFILE_ID, forwardBuildInput, materializeForwardProfile, collectForwardStartupMaterial,
    canonicalForward, forwardSha256 } from './lib/compatible-forward-release-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = path.join(ROOT, 'dist-server');
const STAGING_DIR = path.join(ROOT, 'dist-server.bak-staging');
const PREVIOUS_DIR = path.join(ROOT, 'dist-server.bak-previous');
const LOCK_FILE = path.join(ROOT, '.git', 'nassaj-server-build.lock');
export const BUNDLED_UPDATE_CONTROL_SCRIPTS = [
    'local-preview-ledger.mjs',
    'local-preview-server-activation.mjs',
    'safe-restart.sh',
];

function runtimeImportTarget(artifactRoot, relative) {
    const root = path.resolve(artifactRoot);
    const rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        throw new Error('Server artefact root must be a real directory.');
    }
    if (typeof relative !== 'string' || path.isAbsolute(relative)) {
        throw new Error(`Server runtime import escapes artefact: ${String(relative)}`);
    }
    const target = path.resolve(root, relative);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Server runtime import escapes artefact: ${relative}`);
    }
    let parent = root;
    for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
        parent = path.join(parent, part);
        let metadata = lstatSync(parent, { throwIfNoEntry: false });
        if (!metadata) {
            mkdirSync(parent, { mode: 0o755 });
            metadata = lstatSync(parent);
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error(`Server runtime import parent is unsafe: ${relative}`);
        }
    }
    return target;
}

export function materializeUpdateRuntimeImports(artifactRoot, installed) {
    for (const file of installed.manifest.files) {
        const source = path.join(installed.bundleRoot, file.path);
        const target = runtimeImportTarget(artifactRoot, file.path);
        const metadata = lstatSync(target, { throwIfNoEntry: false });
        if (metadata) {
            if (!metadata.isFile() || metadata.isSymbolicLink()) {
                throw new Error(`Server artefact runtime import target is unsafe: ${file.path}`);
            }
            if (!readFileSync(target).equals(readFileSync(source))) copyFileSync(source, target);
        }
        else copyFileSync(source, target);
        chmodSync(target, file.mode);
    }
}

/** Install, verify and expose the immutable update runtime inside one server artefact. */
export function installServerUpdateRuntime(sourceRoot, artifactRoot) {
    const installed = installUpdateRuntimeBundle(sourceRoot, artifactRoot);
    const installedPaths = new Set(installed.manifest.files.map((file) => file.path));
    const missing = SERVER_BUILD_INPUTS.filter((entry) => entry.startsWith('scripts/') && !installedPaths.has(entry));
    if (missing.length) {
        throw new Error(`Update runtime bundle does not cover server script inputs: ${missing.join(', ')}`);
    }
    materializeUpdateRuntimeImports(artifactRoot, installed);
    return installed;
}
export const SERVER_BUILD_INPUTS = [...new Set([
    'server',
    'shared',
    'scripts/build-provenance.mjs',
    'scripts/local-preview-ledger.mjs',
    'scripts/local-preview-server-activation.mjs',
    'scripts/git-control-root.mjs',
    'scripts/oid-control-capsule.mjs',
    // OID control-capsule closure modules added by the pinned PM2 singleton
    // transport series (caac8feae). The capsule bundles them, so their bytes
    // must be bound to the immutable input manifest or verifyServerArtefact's
    // control-closure check rejects the artefact. These reach the update-runtime
    // bundle through relative imports; the alias-only vendor codec files are
    // added to UPDATE_RUNTIME_BUNDLE_ENTRIES instead (and enter here via spread).
    'scripts/lib/client-publication-policy.mjs',
    'scripts/lib/local-source-bootstrap-ticket.mjs',
    'scripts/lib/pm2-existing-transport.mjs',
    'scripts/lib/pm2-service-owner.mjs',
    'scripts/lib/release-runtime-forward-child-protocol.mjs',
    'scripts/vendor/pm2-codec/amp-message/index.js',
    'scripts/oid-control-journal.mjs',
    'scripts/preview-oid-capsule-launcher.mjs',
    'scripts/preview-oid-owner-action.mjs',
    'scripts/safe-restart.sh',
    ...UPDATE_RUNTIME_BUNDLE_ENTRIES,
    'scripts/lib/source-update-tree-identity.mjs',
    'scripts/lib/dependency-tree-identity-v2.mjs',
    'scripts/lib/node-update-mode.mjs',
    'scripts/lib/node-update-publication-guard.mjs',
    'scripts/lib/oid-triple-target.mjs',
    'scripts/lib/candidate-build-steps.mjs',
    'scripts/lib/oid-control-bundle.mjs',
    'scripts/lib/oid-dependency-candidate.mjs',
    'scripts/lib/update-generation-reconciliation.mjs',
    'scripts/lib/candidate-install-policy.mjs',
    'scripts/lib/oid-candidate-source.mjs',
    'scripts/oid-update-candidate.mjs',
    'scripts/lib/update-runtime-bundle.mjs',
    'scripts/lib/update-runtime-capability.mjs',
    'scripts/lib/update-release-asset.mjs',
    'scripts/lib/update-release-layout-adapter.mjs',
    'scripts/lib/update-release-layout-activation.mjs',
    'scripts/lib/update-runtime-janitor.mjs',
    'scripts/lib/update-runtime-orchestrator.mjs',
    'package.json',
    'package-lock.json',
])];

export const OID_CONTROL_MANIFEST = 'OID_CONTROL_MANIFEST.json';
export const OID_CONTROL_CAPSULE = 'OID_CONTROL_CAPSULE.mjs';

/** Prove the capsule closure contains static Node built-ins and no runtime loader escape. */
export function verifyOidCapsuleModuleClosure(bytes) {
    const source = bytes.toString('utf8');
    const file = ts.createSourceFile('OID_CONTROL_CAPSULE.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let invalid = null;
    function visit(node) {
        if (invalid) return;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            const specifier = ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
            if (!specifier.startsWith('node:') || !isBuiltin(specifier)) invalid = specifier || 'dynamic';
        }
        if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && ['require','__require'].includes(node.expression.text))) invalid = 'runtime-loader';
            if (ts.isIdentifier(node.expression) && node.expression.text === 'getBuiltinModule') {
                const specifier = node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
                    ? node.arguments[0].text : '';
                if (specifier !== 'node:sqlite' || !isBuiltin(specifier)) invalid = 'runtime-loader';
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
    if (invalid || file.parseDiagnostics.length) throw new Error(`OID capsule module closure is invalid: ${invalid || 'syntax'}`);
    return true;
}

/** Permit only the launcher's existing captured-capsule data import; all other loaders remain forbidden. */
export function verifyOidLauncherModuleClosure(bytes) {
    const source = bytes.toString('utf8');
    const ast = ts.createSourceFile('preview-oid-capsule-launcher.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const replacements = [];
    function visit(node) {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            let owner = node.parent;
            while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
            if (owner?.name?.text !== 'launchOidCapsule' || node.arguments.length !== 1
                || node.arguments[0].getText(ast) !== "`data:text/javascript;base64,${capsule.toString('base64')}`") {
                throw new Error('OID launcher module closure contains an unapproved loader.');
            }
            replacements.push([node.getStart(ast), node.end]);
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    if (replacements.length > 2) throw new Error('OID launcher contains multiple captured-capsule imports.');
    let checked = source;
    for (const [start, end] of replacements.reverse()) checked = `${checked.slice(0, start)}null${checked.slice(end)}`;
    return verifyOidCapsuleModuleClosure(Buffer.from(checked));
}

/** Seal the standalone built-ins-only capsule and bind it to this artefact. */
export function installOidControlRuntime(sourceRoot, artifactRoot, identity) {
    const bundle = bundleOidControlCapsule(sourceRoot, verifyOidCapsuleModuleClosure);
    const capsuleBytes = bundle.bytes;
    const compatibilityBytes = readFileSync(path.join(sourceRoot, OID_CONTROL_COMPAT_ENTRY));
    if (!capsuleBytes.equals(compatibilityBytes)) {
        throw new Error('Committed OID compatibility capsule is stale; run scripts/generate-oid-control-capsule.mjs.');
    }
    const capsulePath = path.join(artifactRoot, OID_CONTROL_CAPSULE);
    writeFileSync(capsulePath, capsuleBytes, { flag: 'wx', mode: 0o444 });
    chmodSync(capsulePath, 0o444);
    const safePath = path.join(artifactRoot, 'scripts', 'safe-restart.sh');
    chmodSync(safePath, 0o555);
    const safeBytes = readFileSync(safePath);
    const updateRuntime = JSON.parse(readFileSync(path.join(artifactRoot, 'UPDATE_RUNTIME_MANIFEST.json'), 'utf8'));
    const launcherBytes = bundle.sources ? readFileSync(path.join(sourceRoot, 'scripts', 'preview-oid-capsule-launcher.mjs')) : null;
    if (launcherBytes) verifyOidLauncherModuleClosure(launcherBytes);
    const manifest = {
        schema: 'nassaj-oid-control-runtime/v1',
        protocol: 1,
        oid: identity.oid,
        serverBuildId: identity.buildId,
        capsuleSha256: createHash('sha256').update(capsuleBytes).digest('hex'),
        capsuleSize: capsuleBytes.length,
        capsuleMode: 0o444,
        safeRestartSha256: createHash('sha256').update(safeBytes).digest('hex'),
        safeRestartSize: safeBytes.length,
        safeRestartMode: 0o555,
        launcherAbi: 'nassaj-oid-launcher/v1',
        capsuleModeAbi: 'nassaj-capsule-roots/v1',
        capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1', oidPairAdmissionV1: true, ...(bundle.sources ? { oidTripleAdmissionV2: true, oidDevFullPolicyV1: 'nassaj-dev-full-policy/v1' } : {}) },
        ...(bundle.sources ? { controlSources: bundle.sources,
            launcherSha256: createHash('sha256').update(launcherBytes).digest('hex'),
            launcherSize: launcherBytes.length, launcherMode: lstatSync(path.join(artifactRoot, 'scripts', 'preview-oid-capsule-launcher.mjs')).mode & 0o777 } : {}),
        updateRuntimeBuildId: updateRuntime.buildId,
        runtimeDependenciesSha256: existsSync(path.join(identity.dependenciesRoot ?? sourceRoot, 'node_modules'))
            ? hashOidPairDependencyTree(path.join(identity.dependenciesRoot ?? sourceRoot, 'node_modules')) : null,
    };
    const manifestPath = path.join(artifactRoot, OID_CONTROL_MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
    chmodSync(manifestPath, 0o444);
    return manifest;
}

/** Bind the final sealed dependency generation after all lifecycle and build effects finish. */
export function sealOidTripleServerDependencies(artifactRoot, dependencies, evidence) {
    const tree = hashDependencyTreeV2(dependencies, { requireSealed: true });
    if (tree.sha256 !== evidence.nodeModulesTreeSha256
        || computeDependencyContractV2(evidence) !== evidence.dependencyContractSha256) {
        throw new Error('OID triple dependency evidence does not match its sealed generation.');
    }
    const file = path.join(artifactRoot, OID_CONTROL_MANIFEST);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('OID triple manifest is unsafe.');
    const manifest = JSON.parse(readFileSync(file));
    const dependencyGenerationV2 = {
        schema: 'nassaj-oid-dependency-generation/v2', nodeModulesTreeSha256: tree.sha256,
        dependencyContractSha256: evidence.dependencyContractSha256,
        packageJsonSha256: evidence.packageJsonSha256, packageLockSha256: evidence.packageLockSha256,
        installPolicySha256: evidence.installPolicySha256, installRuntime: evidence.installRuntime,
    };
    // Capability remains off until actual-entry and crash-matrix acceptance; identity alone is not authority.
    const next = { ...manifest, dependencyGenerationV2,
        runtimeDependenciesSha256: hashOidPairDependencyTree(dependencies) };
    chmodSync(file, 0o600);
    try { writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`); } finally { chmodSync(file, 0o444); }
    return next;
}

export function isIgnoredServerInput(relative) {
    return /(?:^|\/)__tests__(?:\/|$)/.test(relative)
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);
}

function command(commandName, args, options = {}) {
    const result = spawnSync(commandName, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...options });
    if (result.status !== 0) {
        throw new Error(`${commandName} ${args.join(' ')} failed (${result.status ?? result.signal})`);
    }
    return result;
}

/** Report whether GNU mv exposes the required no-copy directory exchange. */
/** Refuse builds when either CPU or memory utilization reaches the system ceiling. */
export function resourcesSafe() {
    let available = os.freemem();
    try {
        const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
        if (match) available = Number(match[1]) * 1024;
    } catch { /* portable fallback */ }
    return 1 - available / os.totalmem() < 0.8
        && os.loadavg()[0] / Math.max(1, os.cpus().length) < 0.8;
}

function assertDirectory(directory, label) {
    if (!existsSync(directory)) throw new Error(`${label} directory is absent: ${directory}`);
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`${label} must be a real directory: ${directory}`);
    }
}

function walkInputs(entry, root, records, metadataOnly) {
    if (!existsSync(entry)) {
        records.push([path.relative(root, entry).split(path.sep).join('/'), 'missing', 0]);
        return;
    }
    const metadata = lstatSync(entry);
    const relative = path.relative(root, entry).split(path.sep).join('/');
    if (isIgnoredServerInput(relative)) return;
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(`Server build input must be a regular file or directory: ${relative}`);
    }
    if (metadata.isDirectory()) {
        for (const child of readdirSync(entry).sort()) {
            walkInputs(path.join(entry, child), root, records, metadataOnly);
        }
        return;
    }
    const value = metadataOnly
        ? `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
        : createHash('sha256').update(readFileSync(entry)).digest('hex');
    records.push([relative, value, metadata.mode & 0o777]);
}

function compareInputPaths(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function hashInputRecords(root, metadataOnly) {
    const records = [];
    for (const entry of SERVER_BUILD_INPUTS) walkInputs(path.join(root, entry), root, records, metadataOnly);
    const hash = createHash('sha256');
    for (const [name, value, mode] of records.sort(([left], [right]) => compareInputPaths(left, right))) {
        hash.update(name).update('\0').update(String(mode)).update('\0').update(value).update('\0');
    }
    return hash.digest('hex');
}

/** Stable content fingerprint of every server build input. */
export function computeServerBuildFingerprint(root = ROOT) {
    return hashInputRecords(root, false);
}

/** Metadata epoch detects edit-then-revert races that preserve file bytes. */
export function computeServerInputEpoch(root = ROOT) {
    return hashInputRecords(root, true);
}

export function computeServerManifestBuildId(inputs) {
    const hash = createHash('sha256');
    for (const entry of inputs) {
        hash.update(entry.path).update('\0').update(String(entry.mode ?? '')).update('\0').update(entry.sha256).update('\0');
    }
    return hash.digest('hex');
}

/** Deterministic per-file input manifest used by the activation classifier. */
export function createServerInputManifest(root = ROOT, buildId = computeServerBuildFingerprint(root)) {
    if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error('Server input manifest build id is invalid.');
    const records = [];
    for (const entry of SERVER_BUILD_INPUTS) walkInputs(path.join(root, entry), root, records, false);
    const inputs = records
        .sort(([left], [right]) => compareInputPaths(left, right))
        .map(([inputPath, sha256, mode]) => {
            if (!/^[a-f0-9]{64}$/.test(sha256)) {
                throw new Error(`Server input manifest cannot record missing input: ${inputPath}`);
            }
            return { path: inputPath, mode, sha256 };
        });
    if (computeServerManifestBuildId(inputs) !== buildId) {
        throw new Error('Server input manifest entries do not reproduce the build id.');
    }
    return { schemaVersion: 2, buildIdMode: 'path-mode-content-sha256', buildId, inputs };
}

function writeServerInputManifest(directory, manifest) {
    const target = path.join(directory, 'SERVER_INPUT_MANIFEST.json');
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o644,
        flag: 'wx',
    });
}

/** Build identity currently promoted on disk, or null. */
export function readServerBuildIdOnDisk(root = ROOT, liveDir = path.join(root, 'dist-server')) {
    try {
        const value = JSON.parse(readFileSync(path.join(liveDir, 'BUILD_PROVENANCE.json'), 'utf8')).buildId;
        return /^[a-f0-9]{64}$/.test(value) ? value : null;
    } catch {
        return null;
    }
}

/** Identity of the exact live directory approved before compilation starts. */
export function captureLiveIdentity(liveDir) {
    const metadata = lstatSync(liveDir);
    return { dev: metadata.dev, ino: metadata.ino, ctimeMs: metadata.ctimeMs };
}

export function assertLiveIdentityCurrent(liveDir, expected) {
    const current = captureLiveIdentity(liveDir);
    if (current.dev !== expected.dev || current.ino !== expected.ino || current.ctimeMs !== expected.ctimeMs) {
        throw new Error('Live server generation changed during build; promotion cancelled.');
    }
}

function assertNodeIdentity(directory, expected, label) {
    const current = captureLiveIdentity(directory);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error(`${label} identity changed during atomic promotion.`);
    }
}

export function readHeadCommit(root = ROOT) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    const commit = result.status === 0 ? result.stdout.trim() : '';
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Cannot establish the source HEAD for server provenance.');
    return commit;
}

export function readServerGeneration(file) {
    return Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
}

export function assertServerGenerationCurrent(file, expected) {
    if (file && readServerGeneration(file) !== expected) {
        throw new Error('Server source generation changed during build; promotion cancelled.');
    }
}

/**
 * tsc-alias resolves --outDir relative to the tsconfig directory, unlike tsc.
 * Keep the accepted layout exact so a future path refactor cannot redirect it
 * outside the one reviewed sibling staging directory.
 */
export function serverAliasOutDir(root = ROOT, stagingDir = path.join(root, 'dist-server.bak-staging')) {
    const configDirectory = path.join(root, 'server');
    const resolvedStaging = path.resolve(stagingDir);
    const expectedStaging = path.join(root, 'dist-server.bak-staging');
    if (resolvedStaging !== expectedStaging) {
        throw new Error('tsc-alias staging path is outside the fixed server build layout.');
    }
    const relative = path.relative(configDirectory, resolvedStaging);
    const expectedRelative = path.join('..', 'dist-server.bak-staging');
    if (relative !== expectedRelative) {
        throw new Error('tsc-alias output path escapes its expected config-relative location.');
    }
    return relative;
}

/** Validate paths before creating or deleting any generation. */
export function assertPublishPreconditions(paths, capabilities = {}) {
    const exchangeSupported = capabilities.exchangeSupported ?? supportsAtomicExchange();
    const resourceCapacity = capabilities.resourcesSafe ?? resourcesSafe();
    if (!resourceCapacity) throw new Error('Build deferred: CPU or memory utilization is at least 80%.');
    const generationParent = path.dirname(paths.liveDir);
    if (path.dirname(paths.stagingDir) !== generationParent || path.dirname(paths.previousDir) !== generationParent
        || path.basename(paths.liveDir) !== 'dist-server'
        || path.basename(paths.stagingDir) !== 'dist-server.bak-staging'
        || path.basename(paths.previousDir) !== 'dist-server.bak-previous') {
        throw new Error('Server generation paths do not match the fixed atomic layout.');
    }
    const liveExists = existsSync(paths.liveDir);
    if (liveExists && !capabilities.candidateOnly && !exchangeSupported) {
        throw new Error('GNU mv with --exchange and --no-copy is required.');
    }
    if (liveExists) assertDirectory(paths.liveDir, 'Live server');
    if (existsSync(paths.stagingDir)) throw new Error(`Server staging path already exists: ${paths.stagingDir}`);
    const parent = path.dirname(paths.stagingDir);
    assertDirectory(parent, 'Server generation parent');
    const readStat = capabilities.stat || statSync;
    if (liveExists && readStat(paths.liveDir).dev !== readStat(parent).dev) {
        throw new Error('Staging and live server artefacts must be on the same filesystem.');
    }
}

function ensureRealDirectory(directory, label) {
    if (!existsSync(directory)) mkdirSync(directory);
    assertDirectory(directory, label);
}

/** Fixed content-addressed store; preview builders never write the live tree. */
export function previewServerCandidatePath(root, buildId) {
    if (!/^[a-f0-9]{64}$/.test(buildId || '')) throw new Error('Preview server candidate id is invalid.');
    return path.join(root, '.nassaj-local-preview', 'server-candidates', buildId);
}

function storePreviewCandidate(root, stagingDir, buildId) {
    const previewRoot = path.join(root, '.nassaj-local-preview');
    const candidateRoot = path.join(previewRoot, 'server-candidates');
    ensureRealDirectory(previewRoot, 'Preview runtime root');
    ensureRealDirectory(candidateRoot, 'Preview server candidate root');
    const candidate = previewServerCandidatePath(root, buildId);
    if (existsSync(candidate)) {
        assertDirectory(candidate, 'Existing preview server candidate');
        if (readServerBuildIdOnDisk(root, candidate) !== buildId) {
            throw new Error('Existing preview server candidate has a conflicting identity.');
        }
        rmSync(stagingDir, { recursive: true, force: false });
        return candidate;
    }
    renameSync(stagingDir, candidate);
    assertDirectory(candidate, 'Stored preview server candidate');
    if (readServerBuildIdOnDisk(root, candidate) !== buildId) {
        throw new Error('Stored preview server candidate identity verification failed.');
    }
    return candidate;
}

function walkArtefact(directory, files = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Server artefact rejects symlink: ${full}`);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__') throw new Error(`Server artefact contains tests: ${full}`);
            walkArtefact(full, files);
        } else if (entry.isFile()) {
            if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) throw new Error(`Server artefact contains tests: ${full}`);
            files.push(full);
        } else {
            throw new Error(`Server artefact rejects special file: ${full}`);
        }
    }
    return files;
}

function moduleSpecifierPrefix(node) {
    if (!node) return null;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text;
    return null;
}

function isRequireCall(expression) {
    if (ts.isIdentifier(expression) && expression.text === 'require') return true;
    return ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'require'
        && expression.name.text === 'resolve';
}

/** Parse executable syntax so comments cannot masquerade as unresolved imports. */
export function hasUnresolvedServerAlias(source, fileName = 'artefact.js') {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let unresolved = false;
    function visit(node) {
        if (unresolved) return;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && moduleSpecifierPrefix(node.moduleSpecifier)?.startsWith('@/')) {
            unresolved = true;
            return;
        }
        if (ts.isCallExpression(node)) {
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            if ((isDynamicImport || isRequireCall(node.expression))
                && moduleSpecifierPrefix(node.arguments[0])?.startsWith('@/')) {
                unresolved = true;
                return;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return unresolved;
}

/** Validate the complete staged server generation before it can become live. */
export function verifyServerArtefact(directory, options = {}) {
    assertDirectory(directory, 'Staged server');
    const required = ['server/index.js', 'server/cli.js', 'shared'];
    for (const relative of required) {
        const target = path.join(directory, relative);
        if (!existsSync(target)) throw new Error(`Server artefact is missing ${relative}`);
        const metadata = lstatSync(target);
        if (metadata.isSymbolicLink()) throw new Error(`Server artefact rejects symlink: ${target}`);
        if (relative === 'shared' ? !metadata.isDirectory() : !metadata.isFile()) {
            throw new Error(`Server artefact has invalid ${relative}`);
        }
    }
    const files = walkArtefact(directory);
    const run = options.run || command;
    for (const file of files.filter((item) => item.endsWith('.js'))) {
        const source = readFileSync(file, 'utf8');
        if (hasUnresolvedServerAlias(source, file)) {
            throw new Error(`Unresolved @/ alias in ${path.relative(directory, file)}`);
        }
        run(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
    const provenancePath = path.join(directory, 'BUILD_PROVENANCE.json');
    if (!existsSync(provenancePath)) throw new Error('Server artefact is missing BUILD_PROVENANCE.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    const expectedVersion = options.version
        ?? JSON.parse(readFileSync(path.join(options.root || ROOT, 'package.json'), 'utf8')).version;
    if (provenance.artifact !== 'server') throw new Error('Server provenance artifact mismatch.');
    if (provenance.version !== expectedVersion) throw new Error('Server provenance version mismatch.');
    if (!/^[0-9a-f]{40}$/.test(provenance.commit || '')) throw new Error('Server provenance commit is invalid.');
    if (options.expectedCommit && provenance.commit !== options.expectedCommit) {
        throw new Error('Server provenance commit does not match the pre-build HEAD.');
    }
    if (options.expectedBuildId && provenance.buildId !== options.expectedBuildId) {
        throw new Error('Server provenance BUILD_ID does not match the source fingerprint.');
    }
    if (Number.isNaN(Date.parse(provenance.builtAt))) throw new Error('Server provenance timestamp is invalid.');
    const manifestPath = path.join(directory, 'SERVER_INPUT_MANIFEST.json');
    if (!existsSync(manifestPath)) throw new Error('Server artefact is missing SERVER_INPUT_MANIFEST.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 2 || !['path-mode-content-sha256', 'forward-profile-sha256'].includes(manifest.buildIdMode)
        || manifest.buildId !== provenance.buildId || !Array.isArray(manifest.inputs)) {
        throw new Error('Server input manifest identity is invalid.');
    }
    let previousPath = null;
    for (const entry of manifest.inputs) {
        if (typeof entry?.path !== 'string' || entry.path <= (previousPath ?? '')
            || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
            || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
            throw new Error('Server input manifest entries are invalid or unsorted.');
        }
        previousPath = entry.path;
    }
    const baseBuildId = computeServerManifestBuildId(manifest.inputs);
    const actualBuildId = manifest.buildIdMode === 'forward-profile-sha256'
        ? forwardSha256(canonicalForward(manifest.forwardBuildInput)) : baseBuildId;
    if (manifest.buildIdMode === 'forward-profile-sha256') {
        const expectedForward = forwardBuildInput(options.root || ROOT, baseBuildId);
        if (canonicalForward(expectedForward.material) !== canonicalForward(manifest.forwardBuildInput)
            || forwardSha256(readFileSync(path.join(directory, 'server/bootstrap-release-profile.js')))
                !== expectedForward.material.profileModuleSha256) {
            throw new Error('Server forward profile input mismatch.');
        }
    }
    if (actualBuildId !== manifest.buildId) {
        throw new Error('Server input manifest entries do not reproduce its build id.');
    }
    for (const scriptName of BUNDLED_UPDATE_CONTROL_SCRIPTS) {
        const inputPath = `scripts/${scriptName}`;
        const declared = manifest.inputs.find((entry) => entry.path === inputPath)?.sha256;
        const bundledPath = path.join(directory, 'scripts', scriptName);
        if (!declared || !existsSync(bundledPath)
            || createHash('sha256').update(readFileSync(bundledPath)).digest('hex') !== declared) {
            throw new Error(`Server artefact immutable control script mismatch: ${inputPath}`);
        }
    }
    const controlManifestPath = path.join(directory, OID_CONTROL_MANIFEST);
    const capsulePath = path.join(directory, OID_CONTROL_CAPSULE);
    if (!existsSync(controlManifestPath) || !existsSync(capsulePath)) {
        throw new Error('Server artefact is missing its OID control capsule.');
    }
    const controlManifestMetadata = lstatSync(controlManifestPath);
    const capsuleMetadata = lstatSync(capsulePath);
    const safeMetadata = lstatSync(path.join(directory, 'scripts', 'safe-restart.sh'));
    const control = JSON.parse(readFileSync(controlManifestPath, 'utf8'));
    if (control.capabilities?.oidPairAdmissionV1 === true) {
        const bootstrap = path.join(directory, 'server', 'bootstrap.js');
        const application = path.join(directory, 'server', 'application.js');
        if (!existsSync(application) || !existsSync(bootstrap)
            || !readFileSync(path.join(directory, 'server', 'index.js')).equals(readFileSync(bootstrap))) {
            throw new Error('OID pair capability requires the bootstrap at the PM2 index entry.');
        }
    }
    if (control.controlSources) {
        if (!Array.isArray(control.controlSources) || control.controlSources.length < 2) throw new Error('OID control closure evidence is invalid.');
        for (const source of control.controlSources) {
            if (manifest.inputs.find(entry => entry.path === source.path)?.sha256 !== source.sha256) {
                throw new Error('OID control closure source differs from the immutable input manifest.');
            }
        }
        const launcherFile = path.join(directory, 'scripts', 'preview-oid-capsule-launcher.mjs');
        const launcher = readFileSync(launcherFile);
        verifyOidLauncherModuleClosure(launcher);
        if (control.launcherSha256 !== createHash('sha256').update(launcher).digest('hex')
            || control.launcherSize !== launcher.length || control.launcherMode !== (lstatSync(launcherFile).mode & 0o777)) {
            throw new Error('OID retained launcher identity is invalid.');
        }
    }
    const capsuleBytes = readFileSync(capsulePath);
    verifyOidCapsuleModuleClosure(capsuleBytes);
    const safeBytes = readFileSync(path.join(directory, 'scripts', 'safe-restart.sh'));
    const updateRuntime = JSON.parse(readFileSync(path.join(directory, 'UPDATE_RUNTIME_MANIFEST.json'), 'utf8'));
    if (control.schema !== 'nassaj-oid-control-runtime/v1' || control.protocol !== 1
        || control.oid !== provenance.commit || control.serverBuildId !== provenance.buildId
        || control.capsuleSha256 !== createHash('sha256').update(capsuleBytes).digest('hex')
        || control.capsuleSize !== capsuleBytes.length || control.capsuleMode !== 0o444
        || control.safeRestartSha256 !== createHash('sha256').update(safeBytes).digest('hex')
        || control.safeRestartSize !== safeBytes.length || control.safeRestartMode !== 0o555
        || control.launcherAbi !== 'nassaj-oid-launcher/v1'
        || control.capsuleModeAbi !== 'nassaj-capsule-roots/v1'
        || control.updateRuntimeBuildId !== updateRuntime.buildId
        || controlManifestMetadata.isSymbolicLink() || capsuleMetadata.isSymbolicLink()
        || (controlManifestMetadata.mode & 0o777) !== 0o444 || (capsuleMetadata.mode & 0o777) !== 0o444
        || (safeMetadata.mode & 0o777) !== 0o555) {
        throw new Error('Server artefact OID control capsule identity mismatch.');
    }
    verifyUpdateRuntimeBundle(directory);
}

/** Exchange two existing directories atomically, with no copy fallback. */
export function exchangeDirectories(left, right) {
    const result = spawnSync('mv', ['--exchange', '--no-copy', '-T', left, right], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Atomic server exchange failed: ${(result.stderr || result.stdout).trim()}`);
}

/** Atomically install the first generation without replacing a concurrent live path. */
export function bootstrapWithoutClobber(stagedDir, liveDir) {
    const result = spawnSync('mv', ['--no-clobber', '--no-copy', '-T', stagedDir, liveDir], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Atomic server bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
}

function removePreviousSafely(previousDir, liveDir) {
    if (!existsSync(previousDir)) return;
    const metadata = lstatSync(previousDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Previous server generation is not a real directory: ${previousDir}`);
    }
    if (statSync(previousDir).dev !== statSync(liveDir).dev) {
        throw new Error('Previous and live server generations are on different filesystems.');
    }
    rmSync(previousDir, { recursive: true, force: false });
}

/** Build, verify and publish one server generation. Exported for fixture tests. */
export function buildAndPublishServer(options = {}, injected = {}) {
    const root = options.root || ROOT;
    if (!options.localPreview) assertStandaloneNodePublication(root);
    const paths = {
        liveDir: options.liveDir || path.join(root, 'dist-server'),
        stagingDir: options.stagingDir || path.join(root, 'dist-server.bak-staging'),
        previousDir: options.previousDir || path.join(root, 'dist-server.bak-previous'),
    };
    const run = injected.run || command;
    const exchange = injected.exchange || exchangeDirectories;
    const rename = injected.rename || renameSync;
    const bootstrapMove = injected.bootstrapMove || bootstrapWithoutClobber;
    const assertNoOidTransaction = injected.assertNoOidTransaction || assertNoNonterminalOidTransaction;
    assertPublishPreconditions(paths, {
        exchangeSupported: injected.exchangeSupported,
        resourcesSafe: injected.resourcesSafe,
        candidateOnly: options.localPreview,
    });
    verifyCodexSdkImageOnlySync(root);
    const getHead = injected.getHead || readHeadCommit;
    const expectedCommit = getHead(root);
    const sourceFingerprint = computeServerBuildFingerprint(root);
    const sourceManifest = createServerInputManifest(root, sourceFingerprint);
    const inputEpoch = computeServerInputEpoch(root);
    const previewEvent = (state, fields = {}) => {
        if (!options.localPreview) return;
        recordPreviewLedgerEvent(root, {
            target: 'server', sourceGeneration: options.generation, state,
            sourceBuildId: sourceFingerprint, candidateBuildId: sourceFingerprint,
            ...fields,
        });
    };
    assertServerGenerationCurrent(options.generationFile, options.generation);
    previewEvent('building');
    const liveIdentity = !options.localPreview && existsSync(paths.liveDir)
        ? captureLiveIdentity(paths.liveDir)
        : null;
    let exchanged = false;
    mkdirSync(paths.stagingDir);
    try {
        run(path.join(root, 'node_modules', '.bin', 'tsc'), [
            '-p', path.join(root, 'server', 'tsconfig.json'), '--outDir', paths.stagingDir,
        ]);
        const serverConfig = path.join(root, 'server', 'tsconfig.json');
        run(path.join(root, 'node_modules', '.bin', 'tsc-alias'), [
            '-p', serverConfig, '--outDir', serverAliasOutDir(root, paths.stagingDir),
        ], { cwd: path.dirname(serverConfig) });
        installReleaseBootstrapEntry(paths.stagingDir);
        installServerUpdateRuntime(root, paths.stagingDir);
        run(process.execPath, [path.join(root, 'scripts', 'build-provenance.mjs'), '--artifact', 'server'], {
            env: {
                ...process.env,
                NASSAJ_BUILD_ID: sourceFingerprint,
                NASSAJ_BASE_COMMIT: expectedCommit,
                NASSAJ_PROVENANCE_OUT_DIR: paths.stagingDir,
            },
        });
        writeServerInputManifest(paths.stagingDir, sourceManifest);
        installOidControlRuntime(root, paths.stagingDir, { oid: expectedCommit, buildId: sourceFingerprint });
        verifyServerArtefact(paths.stagingDir, {
            root,
            run,
            ...(!options.localPreview && { expectedCommit }),
            expectedBuildId: sourceFingerprint,
        });
        if (!options.localPreview) previewEvent('built');
        if (computeServerBuildFingerprint(root) !== sourceFingerprint) {
            throw new Error('Server source content changed during build; promotion cancelled.');
        }
        if (computeServerInputEpoch(root) !== inputEpoch) {
            throw new Error('Server source metadata changed during build; promotion cancelled.');
        }
        assertServerGenerationCurrent(options.generationFile, options.generation);
        if (!options.localPreview && getHead(root) !== expectedCommit) {
            throw new Error('Source HEAD changed during server build; promotion cancelled.');
        }
        if (options.localPreview) {
            const candidatePath = storePreviewCandidate(root, paths.stagingDir, sourceFingerprint);
            previewEvent('built', { candidateBuildId: sourceFingerprint });
            console.log(`[server-build] stored local server candidate ${sourceFingerprint}; live runtime was not changed.`);
            return {
                sourceBuildId: sourceFingerprint,
                baseCommit: expectedCommit,
                candidatePath,
                promoted: false,
            };
        }
        // T-1683: the live directory belongs to the OID control capsule while a
        // transaction is open; rotating it underneath one corrupts recovery.
        assertNoOidTransaction(root);
        assertLegacyNodePublication(root);
        const candidateIdentity = captureLiveIdentity(paths.stagingDir);
        if (!liveIdentity) {
            if (existsSync(paths.liveDir)) {
                throw new Error('Live server generation appeared during bootstrap build; promotion cancelled.');
            }
            bootstrapMove(paths.stagingDir, paths.liveDir);
            if (existsSync(paths.stagingDir) || !existsSync(paths.liveDir)) {
                throw new Error('Atomic server bootstrap did not install the candidate; promotion cancelled.');
            }
            assertNodeIdentity(paths.liveDir, candidateIdentity, 'Bootstrapped server generation');
            exchanged = true;
        } else {
            assertLiveIdentityCurrent(paths.liveDir, liveIdentity);
            removePreviousSafely(paths.previousDir, paths.liveDir);
            exchange(paths.stagingDir, paths.liveDir);
            exchanged = true;
            try {
                assertNodeIdentity(paths.stagingDir, liveIdentity, 'Exchanged previous server generation');
                assertNodeIdentity(paths.liveDir, candidateIdentity, 'Exchanged candidate server generation');
            } catch (error) {
                try {
                    exchange(paths.stagingDir, paths.liveDir);
                } catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], 'Atomic exchange identity failed and rollback also failed.');
                }
                throw new Error(`Atomic exchange identity verification failed; live generation restored. ${error.message}`);
            }
            try {
                rename(paths.stagingDir, paths.previousDir);
            } catch (error) {
                try {
                    exchange(paths.stagingDir, paths.liveDir);
                } catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], 'Retaining the old server generation failed and rollback also failed.');
                }
                throw new Error(`Retaining the old server generation failed; live generation restored. ${error.message}`);
            }
        }
        previewEvent('promoted', { promotedBuildId: sourceFingerprint });
        console.log('[server-build] published local server artefact; no restart was requested.');
        return { sourceBuildId: sourceFingerprint, baseCommit: expectedCommit, promoted: true };
    } catch (error) {
        const superseded = /source (?:content|metadata|generation) changed during build/i.test(error.message);
        try {
            previewEvent(superseded ? 'superseded' : 'failed', {
                error: { code: superseded ? 'source_superseded' : 'server_preview_failed', message: error.message },
            });
        } catch (ledgerError) {
            throw new AggregateError([error, ledgerError], 'Server preview failed and its ledger could not be updated.');
        }
        throw error;
    } finally {
        // Once exchange happened, never guess which generation a leftover path
        // contains. Operators retain it for recovery and inspect it explicitly.
        if (!exchanged && existsSync(paths.stagingDir)) {
            rmSync(paths.stagingDir, { recursive: true, force: true });
        }
    }
}

function assertReleaseServerCandidatePath(sourceRoot, candidateRoot, outputRoot) {
    const source = path.resolve(sourceRoot);
    const candidate = path.resolve(candidateRoot);
    assertDirectory(source, 'Release source');
    assertDirectory(candidate, 'Release candidate root');
    const target = path.resolve(outputRoot);
    if (path.dirname(target) !== candidate || path.basename(target) !== 'server') {
        throw new Error('Release server output must be the direct server child of candidateRoot.');
    }
    if (existsSync(target)) throw new Error('Release server candidate output already exists.');
    if (statSync(source).dev !== statSync(candidate).dev) {
        throw new Error('Release server source and candidate root must share a filesystem.');
    }
    return { source, candidate, target };
}

/** Install the bootstrap at the legacy PM2 entry while retaining application bytes. */
export function installReleaseBootstrapEntry(staging) {
    const compiledServer = path.join(staging, 'server');
    const compiledIndex = path.join(compiledServer, 'index.js');
    const compiledApplication = path.join(compiledServer, 'application.js');
    const compiledBootstrap = path.join(compiledServer, 'bootstrap.js');
    if (!existsSync(compiledIndex) || !existsSync(compiledBootstrap) || existsSync(compiledApplication)) {
        throw new Error('Release server build has an invalid application/bootstrap entry layout.');
    }
    renameSync(compiledIndex, compiledApplication);
    copyFileSync(compiledBootstrap, compiledIndex);
}

/** Compile and verify a release server candidate without publishing or restarting it. */
export function buildServerReleaseCandidate(options, injected = {}) {
    const releaseCommit = String(options.releaseCommit || '');
    if (!/^[a-f0-9]{40}$/.test(releaseCommit)) throw new Error('Release server commit is invalid.');
    if (typeof options.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(options.version)) {
        throw new Error('Release server version is invalid.');
    }
    const paths = assertReleaseServerCandidatePath(options.sourceRoot, options.candidateRoot, options.outputRoot);
    verifyCodexSdkImageOnlySync(paths.source);
    const runCandidate = injected.run || command;
    const profile = options.profile ?? 'default';
    if (!['default', FORWARD_PROFILE_ID].includes(profile)) throw new Error('Release server profile is invalid.');
    const baseBuildId = computeServerBuildFingerprint(paths.source);
    const forwardInput = profile === FORWARD_PROFILE_ID ? forwardBuildInput(paths.source, baseBuildId) : null;
    const buildId = forwardInput?.buildId || baseBuildId;
    const manifest = createServerInputManifest(paths.source, baseBuildId);
    if (forwardInput) Object.assign(manifest, { buildId, buildIdMode: 'forward-profile-sha256', forwardBuildInput: forwardInput.material });
    const staging = path.join(paths.source, 'dist-server.bak-staging');
    if (existsSync(staging)) throw new Error('Release server staging path already exists.');
    mkdirSync(staging, { mode: 0o700 });
    try {
        runCandidate(path.join(paths.source, 'node_modules', '.bin', 'tsc'), [
            '-p', path.join(paths.source, 'server', 'tsconfig.json'), '--outDir', staging,
        ], { cwd: paths.source });
        const config = path.join(paths.source, 'server', 'tsconfig.json');
        runCandidate(path.join(paths.source, 'node_modules', '.bin', 'tsc-alias'), [
            '-p', config, '--outDir', serverAliasOutDir(paths.source, staging),
        ], { cwd: path.dirname(config) });
        // Preserve compatibility with existing PM2 configs that launch
        // dist-server/server/index.js. The real application moves aside and
        // index becomes the pre-import bootstrap; no host config rewrite or FD
        // inheritance is needed during activation.
        installReleaseBootstrapEntry(staging);
        if (forwardInput) materializeForwardProfile(staging);
        installServerUpdateRuntime(paths.source, staging);
        if (forwardInput) {
            const startup = collectForwardStartupMaterial(staging, {
                nodeModulesRoot: path.join(paths.source, 'node_modules'),
                packageLockFile: path.join(paths.source, 'package-lock.json'),
            });
            writeFileSync(path.join(staging, 'STARTUP_CLOSURE.json'), `${JSON.stringify(startup.material)}\n`, { flag: 'wx', mode: 0o644 });
        }
        writeFileSync(path.join(staging, 'BUILD_PROVENANCE.json'), `${JSON.stringify({
            artifact: 'server', version: options.version, commit: releaseCommit,
            baseCommit: releaseCommit, commitShort: releaseCommit.slice(0, 8),
            branch: null, describe: options.version, dirty: false, dirtyFiles: 0,
            builtAt: new Date().toISOString(), buildId,
        }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
        writeServerInputManifest(staging, manifest);
        installOidControlRuntime(paths.source, staging, { oid: releaseCommit, buildId });
        verifyServerArtefact(staging, {
            root: paths.source, run: runCandidate, version: options.version,
            expectedCommit: releaseCommit, expectedBuildId: buildId,
        });
        renameSync(staging, paths.target);
        verifyServerArtefact(paths.target, {
            root: paths.source, run: runCandidate, version: options.version,
            expectedCommit: releaseCommit, expectedBuildId: buildId,
        });
        return { artifact: 'server', buildId, outputRoot: paths.target, releaseCommit, version: options.version };
    } finally {
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
}

export function runWithFlock(lockFile, commandName, args, options = {}) {
    return spawnSync('flock', ['-n', '-E', '75', '-F', lockFile, commandName, ...args], options);
}

function main() {
    const argv = process.argv.slice(2);
    const value = (flag) => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : null;
    };
    const localPreview = argv.includes('--local-preview');
    if (!localPreview) assertStandaloneNodePublication(ROOT);
    if (!argv.includes('--locked')) {
        const lockFile = localPreview ? previewControlPaths(ROOT).buildLock : LOCK_FILE;
        const result = runWithFlock(lockFile, process.execPath, [fileURLToPath(import.meta.url), '--locked', ...argv], {
            cwd: ROOT,
            stdio: 'inherit',
        });
        if (result.status !== 0) {
            const message = result.status === 75 ? 'Another server build holds the lock.' : 'Locked server build failed.';
            const error = new Error(message);
            error.exitCode = result.status;
            throw error;
        }
        return;
    }
    buildAndPublishServer({
        liveDir: LIVE_DIR, stagingDir: STAGING_DIR, previousDir: PREVIOUS_DIR,
        localPreview,
        generationFile: value('--generation-file'),
        generation: Number.parseInt(value('--generation') || '', 10),
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); }
    catch (error) {
        console.error(`[server-build] ${error.message}`);
        process.exitCode = error.exitCode || 1;
    }
}
