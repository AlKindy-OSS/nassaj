#!/usr/bin/env node
/**
 * Build one release generation from a public export tree (ADR-174 §9.1–§9.2).
 *
 * Input:  the public export tree (`scripts/export-public.sh` output, or a
 *         checkout of the public repository at the release tag).
 * Output (in --output, all listed in digests.txt):
 *   nassaj-<version>-<target>.tar.gz   the generation archive (deterministic)
 *   release-manifest.json              canonical manifest (§7.3)
 *   GENERATION_FILES.json              per-file manifest (sha256 in the manifest)
 *   THIRD_PARTY_NOTICES                from the license gate (§6.5)
 *   attestation-verifier.mjs           standalone bundled verifier
 *   trusted_root.json                  Sigstore trusted root (sha256 in the manifest)
 *   <installer>                        installer asset (placeholder until built)
 * plus build-report.json (timings and sizes; not a release subject).
 *
 * The archive holds dist/, dist-server/, the production node_modules without
 * the excluded packages (§6.2), the official Node binary and its LICENSE under
 * runtime/, the AGPL text, SOURCE, the verifier and the trusted root. The Claude
 * Agent SDK is recorded in manifest.externalPackages with its lockfile
 * integrity; the node fetches it from registry.npmjs.org.
 *
 * --local-gate fills the publication identity with local placeholders (the
 * repository id and release sequence are only known to the public workflow),
 * uses the verifier's fixture trusted root and a refusing placeholder
 * installer. --boot-smoke then boots the archive (see generation-boot-smoke).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTreeEntries, writeDeterministicTarGz } from './lib/release-generation/deterministic-tar.mjs';
import {
    GENERATION_FILES_NAME, buildFileManifest, computeGlibcFloor, glibcExceeds,
} from './lib/release-generation/generation-files.mjs';
import * as steps from './lib/release-generation/generation-build-steps.mjs';
import { runBootSmoke } from './lib/release-generation/generation-boot-smoke.mjs';
import { ensureNodeTarball, nodePinFor, unpackNode } from './lib/release-generation/official-node.mjs';
import { excludedFileFindings, loadExclusionPolicy } from './lib/release-generation/production-closure.mjs';
import { hashFile } from './lib/release-generation/release-digests.mjs';
import {
    NPM_REGISTRY_ORIGIN, RELEASE_MANIFEST_NAME, RELEASE_MANIFEST_SCHEMA, serializeReleaseManifest,
} from './lib/release-generation/release-manifest.mjs';

export const BUILD_SCRIPT_PATH = 'scripts/build-release-generation.mjs';
export const DEFAULT_WORKFLOW_PATH = '.github/workflows/release-generation.yml';
export const PLACEHOLDER_INSTALLER_NAME = 'nassaj-install.mjs';
const FIXTURE_TRUSTED_ROOT = 'scripts/lib/release-generation/fixtures/attestation/trusted_root.json';
const LOCAL_GATE_IDENTITY = Object.freeze({ repository: 'local-gate/nassaj', repositoryId: '1', releaseSequence: 1 });
const MIN_VERIFIER_VERSION = 1;
const MIN_SHIM_VERSION = 1;

const VALUE_FLAGS = new Map([
    ['--export-dir', 'exportDir'], ['--output', 'output'], ['--work-root', 'workRoot'], ['--target', 'target'],
    ['--node-cache', 'nodeCache'], ['--repository', 'repository'], ['--repository-id', 'repositoryId'],
    ['--workflow-path', 'workflowPath'], ['--channel', 'channel'], ['--release-sequence', 'releaseSequence'],
    ['--min-upgrade-from', 'minUpgradeFrom'], ['--migration-class', 'migrationClass'], ['--installer', 'installer'],
    ['--sigstore-trusted-root', 'trustedRoot'], ['--max-glibc-floor', 'maxGlibcFloor'], ['--commit', 'commit'],
]);
const BOOLEAN_FLAGS = new Map([['--local-gate', 'localGate'], ['--boot-smoke', 'bootSmoke'], ['--keep-work', 'keepWork']]);

/**
 * Parse CLI arguments; unknown or incomplete flags throw.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object} options with defaults applied
 */
export function parseArguments(argv, env = process.env) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (BOOLEAN_FLAGS.has(flag)) { options[BOOLEAN_FLAGS.get(flag)] = true; continue; }
        if (!VALUE_FLAGS.has(flag) || index + 1 >= argv.length) throw new Error(`usage: unknown or incomplete option ${flag}`);
        options[VALUE_FLAGS.get(flag)] = argv[index += 1];
    }
    if (!options.exportDir || !options.output) throw new Error('usage: --export-dir DIR and --output DIR are required');
    const scratchParent = env.TMPDIR && !isMemoryBacked(env.TMPDIR) ? env.TMPDIR : '/var/tmp';
    return {
        target: 'linux-x64-glibc', channel: 'stable', workflowPath: DEFAULT_WORKFLOW_PATH,
        nodeCache: path.join(scratchParent, 'nassaj-node-dist-cache'), scratchParent, ...options,
    };
}

/**
 * True for paths under RAM-backed filesystems (build output must go to disk).
 * @param {string} directory
 * @returns {boolean}
 */
export function isMemoryBacked(directory) {
    const resolved = path.resolve(directory);
    return ['/tmp', '/dev/shm', '/run'].some(prefix => resolved === prefix || resolved.startsWith(`${prefix}/`));
}

/**
 * Publication identity: explicit flags, else local-gate placeholders; a
 * publishable build must name every field.
 * @param {object} options parsed options
 * @param {string} version package version
 * @returns {object}
 */
export function resolveIdentity(options, version) {
    const local = options.localGate ? LOCAL_GATE_IDENTITY : {};
    const identity = {
        repository: options.repository ?? local.repository,
        repositoryId: options.repositoryId ?? local.repositoryId,
        releaseSequence: options.releaseSequence === undefined ? local.releaseSequence : Number(options.releaseSequence),
        minUpgradeFrom: options.minUpgradeFrom ?? (options.localGate ? version : undefined),
        migrationClass: options.migrationClass ?? (options.localGate ? 'none' : undefined),
        channel: options.channel,
        workflowPath: options.workflowPath,
    };
    const missing = Object.entries(identity).filter(([, value]) => value === undefined).map(([key]) => key);
    if (missing.length) throw new Error(`usage: a publishable build needs ${missing.join(', ')} (or --local-gate)`);
    return identity;
}

/**
 * External packages = excluded packages the root package depends on
 * directly; each keeps its lockfile version, integrity and registry URL.
 * @param {object} lock parsed package-lock.json
 * @param {{isExcluded: (name: string) => boolean}} exclusions
 * @returns {object[]} manifest.externalPackages entries, sorted by name
 */
export function externalPackagesFromLock(lock, exclusions) {
    const root = lock.packages?.[''] ?? {};
    const direct = Object.keys({ ...root.dependencies, ...root.optionalDependencies }).filter(exclusions.isExcluded);
    return direct.sort().map(name => {
        const entry = lock.packages[`node_modules/${name}`];
        if (!entry?.version || !entry.integrity || !entry.resolved?.startsWith(`${NPM_REGISTRY_ORIGIN}/`)) {
            throw new Error(`external_package_unpinned: ${name} has no registry version/integrity in the lockfile`);
        }
        return { name, version: entry.version, integrity: entry.integrity, tarballUrl: entry.resolved,
            installPath: `node_modules/${name}` };
    });
}

/**
 * Compose the release manifest (validated when serialized).
 * @returns {object}
 */
export function composeReleaseManifest({ version, commit, identity, target, glibcFloor, node, archive,
    fileManifestSha256, installer, externalPackages, trustedRootSha256, buildScriptSha256 }) {
    return {
        schema: RELEASE_MANIFEST_SCHEMA, channel: identity.channel, version,
        releaseSequence: identity.releaseSequence, minUpgradeFrom: identity.minUpgradeFrom,
        minVerifierVersion: MIN_VERIFIER_VERSION, minShimVersion: MIN_SHIM_VERSION,
        source: { repository: identity.repository, repositoryId: identity.repositoryId, commit,
            ref: `refs/tags/v${version}`, workflowPath: identity.workflowPath,
            buildScript: { path: BUILD_SCRIPT_PATH, sha256: buildScriptSha256 } },
        targets: [{ target, glibcFloor, node, archive, fileManifestSha256 }],
        installer, externalPackages, sigstoreTrustedRootSha256: trustedRootSha256, revokedVersions: [],
        database: { migrationClass: identity.migrationClass, readableBy: [] },
    };
}

/**
 * `sha256sum`-compatible lines for the given files, sorted by name.
 * @param {{name: string, sha256: string}[]} files
 * @returns {string}
 */
export function digestsText(files) {
    return [...files].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map(file => `${file.sha256}  ${file.name}\n`).join('');
}

/** AGPL §6(d): where the corresponding source of this generation lives. */
export function sourceText({ repository, commit, version }) {
    return [
        'Nassaj — corresponding source (AGPL-3.0-only, section 6(d))',
        `version: ${version}`,
        `repository: https://github.com/${repository}`,
        `commit: ${commit}`,
        `source: https://github.com/${repository}/tree/${commit}`,
        '',
    ].join('\n');
}

/** A refusing stand-in until the ADR-174 installer exists. */
export function placeholderInstallerText() {
    return [
        '#!/usr/bin/env node',
        '// Placeholder: the ADR-174 installer is not built yet. This file only',
        '// fills the manifest installer slot of a local gate build and refuses to run.',
        "process.stderr.write('installer_not_built: this generation came from a local gate build\\n');",
        'process.exit(1);',
        '',
    ].join('\n');
}

function timed(report, name, action) {
    const started = Date.now();
    const result = action();
    report.timingsMs[name] = Date.now() - started;
    return result;
}

async function timedAsync(report, name, action) {
    const started = Date.now();
    const result = await action();
    report.timingsMs[name] = Date.now() - started;
    return result;
}

function prepareDirectories(options) {
    const output = path.resolve(options.output);
    if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error(`output_not_empty: ${output}`);
    fs.mkdirSync(output, { recursive: true, mode: 0o755 });
    const workParent = path.resolve(options.workRoot ?? options.scratchParent);
    for (const directory of [output, workParent]) {
        if (isMemoryBacked(directory)) throw new Error(`memory_backed_path_refused: ${directory} (use /var/tmp)`);
    }
    fs.mkdirSync(workParent, { recursive: true, mode: 0o700 });
    return { output, work: fs.mkdtempSync(path.join(workParent, 'nassaj-generation-')) };
}

async function prepareToolchain(build, work, options, report) {
    const buildRoot = build.root;
    const pins = JSON.parse(fs.readFileSync(path.join(buildRoot, 'scripts', 'release-generation-pins.json'), 'utf8'));
    const pin = nodePinFor(pins, options.target);
    const tarball = await timedAsync(report, 'nodeFetch', () => ensureNodeTarball({ pin, cacheDir: options.nodeCache }));
    const node = unpackNode(tarball, path.join(work, 'node'));
    const ripgrepPin = pins.ripgrep?.targets?.[options.target];
    if (!ripgrepPin) throw new Error(`ripgrep_pin_missing: ${options.target}`);
    const npmUserConfig = path.join(work, 'npmrc-empty');
    fs.writeFileSync(npmUserConfig, '', { flag: 'wx', mode: 0o600 });
    const env = steps.buildEnvironment(process.env, { nodeDir: node.dir, tmpDir: path.join(work, 'tmp'), npmUserConfig,
        sourceDateEpoch: build.commitTime });
    fs.mkdirSync(env.TMPDIR, { mode: 0o700 });
    return { pin, node, ripgrepPin, env };
}

function buildTreeStage(buildRoot, tools, report) {
    const { node, env, ripgrepPin } = tools;
    timed(report, 'npmCiBuild', () => steps.npmCi(buildRoot, { node, env, omitDev: false }));
    timed(report, 'sqliteSourceBuild', () => steps.buildSqliteFromSource(buildRoot, { node, env }));
    timed(report, 'ripgrep', () => steps.installPinnedRipgrep(buildRoot, { node, env, pin: ripgrepPin }));
    steps.applyCodexPatch(buildRoot, buildRoot, { node, env });
}

function productionTreeStage(buildRoot, work, tools, exclusions, report) {
    const productionRoot = path.join(work, 'production');
    fs.mkdirSync(productionRoot, { mode: 0o700 });
    for (const file of ['package.json', 'package-lock.json']) {
        fs.copyFileSync(path.join(buildRoot, file), path.join(productionRoot, file));
    }
    timed(report, 'npmCiProduction', () => steps.npmCi(productionRoot, { node: tools.node, env: tools.env, omitDev: true }));
    report.removedPackages = steps.removeExcludedPackages(productionRoot, exclusions);
    steps.copyNativeArtifacts(buildRoot, productionRoot, tools.ripgrepPin);
    steps.applyCodexPatch(buildRoot, productionRoot, { node: tools.node, env: tools.env });
    return productionRoot;
}

function resolveTrustedRoot(options, buildRoot, report) {
    if (options.trustedRoot) return path.resolve(options.trustedRoot);
    if (!options.localGate) throw new Error('usage: --sigstore-trusted-root is required (fetch it with @sigstore/tuf)');
    report.trustedRootSource = `fixture ${FIXTURE_TRUSTED_ROOT} (local gate only)`;
    return path.join(buildRoot, FIXTURE_TRUSTED_ROOT);
}

function resolveInstaller(options, work, report) {
    if (options.installer) return path.resolve(options.installer);
    if (!options.localGate) throw new Error('usage: --installer is required for a publishable build');
    const file = path.join(work, PLACEHOLDER_INSTALLER_NAME);
    fs.writeFileSync(file, placeholderInstallerText(), { mode: 0o755 });
    report.installerPlaceholder = true;
    return file;
}

function copyInto(source, destination, mode) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    if (mode !== undefined) fs.chmodSync(destination, mode);
}

function assembleStaging(staging, context) {
    const { buildRoot, candidateRoot, productionRoot, tools, trustedRoot, identity, commit, version, work } = context;
    fs.mkdirSync(staging, { mode: 0o755 });
    copyInto(path.join(candidateRoot, 'client'), path.join(staging, 'dist'));
    copyInto(path.join(candidateRoot, 'server'), path.join(staging, 'dist-server'));
    fs.renameSync(path.join(productionRoot, 'node_modules'), path.join(staging, 'node_modules'));
    for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE']) {
        if (fs.existsSync(path.join(buildRoot, file))) copyInto(path.join(buildRoot, file), path.join(staging, file));
    }
    copyInto(path.join(buildRoot, 'server', 'bin', 'claude'), path.join(staging, 'server', 'bin', 'claude'), 0o755);
    copyInto(tools.node.node, path.join(staging, 'runtime', 'node'), 0o755);
    copyInto(tools.node.license, path.join(staging, 'runtime', 'LICENSE'));
    copyInto(trustedRoot, path.join(staging, 'sigstore', 'trusted_root.json'));
    copyInto(path.join(work, 'THIRD_PARTY_NOTICES'), path.join(staging, 'THIRD_PARTY_NOTICES'));
    copyInto(path.join(work, 'attestation-verifier.mjs'), path.join(staging, 'verifier', 'attestation-verifier.mjs'));
    fs.writeFileSync(path.join(staging, 'SOURCE'), sourceText({ repository: identity.repository, commit, version }));
    steps.seedServedClientGeneration(staging, { sourceOid: commit, buildId: context.clientBuildId });
}

function sealStaging(staging, exclusions, options, report) {
    const findings = excludedFileFindings(collectTreeEntries(staging).map(entry => entry.path), exclusions);
    if (findings.length) throw new Error(`excluded_package_shipped: ${findings.map(item => item.subject).join(', ')}`);
    const entries = collectTreeEntries(staging);
    const glibc = computeGlibcFloor(entries, { target: options.target });
    if (!glibc.floor) throw new Error('glibc_floor_unknown: no ELF file references GLIBC_2.x');
    if (options.maxGlibcFloor && glibcExceeds(glibc.floor, options.maxGlibcFloor)) {
        throw new Error(`glibc_floor_exceeded: ${glibc.floor} > ${options.maxGlibcFloor}`);
    }
    const fileManifest = buildFileManifest(entries);
    fs.writeFileSync(path.join(staging, GENERATION_FILES_NAME), fileManifest.bytes, { flag: 'wx', mode: 0o644 });
    report.glibc = glibc;
    report.files = fileManifest.files.length;
    report.unpackedBytes = fileManifest.files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    return { glibcFloor: glibc.floor, fileManifest };
}

function writeOutputFile(output, name, bytesOrSource) {
    const destination = path.join(output, name);
    if (Buffer.isBuffer(bytesOrSource)) fs.writeFileSync(destination, bytesOrSource, { flag: 'wx', mode: 0o644 });
    else fs.copyFileSync(bytesOrSource, destination, fs.constants.COPYFILE_EXCL);
    return { name, ...hashFile(destination) };
}

function describeOutputs(output, sealed, context) {
    const { staging, installer, trustedRoot, work } = context;
    return {
        fileManifest: writeOutputFile(output, GENERATION_FILES_NAME, sealed.fileManifest.bytes),
        notices: writeOutputFile(output, 'THIRD_PARTY_NOTICES', path.join(staging, 'THIRD_PARTY_NOTICES')),
        verifier: writeOutputFile(output, 'attestation-verifier.mjs', path.join(work, 'attestation-verifier.mjs')),
        trustedRoot: writeOutputFile(output, 'trusted_root.json', trustedRoot),
        installer: writeOutputFile(output, path.basename(installer), installer),
    };
}

async function runStages(options, dirs, report) {
    const exportDir = path.resolve(options.exportDir);
    const exclusions = loadExclusionPolicy(JSON.parse(fs.readFileSync(
        path.join(exportDir, 'scripts', 'release-excluded-packages.json'), 'utf8')));
    const build = timed(report, 'copyExport', () => steps.prepareBuildTree(exportDir, path.join(dirs.work, 'build')));
    if (options.commit && options.commit !== build.commit) throw new Error(`source_commit_mismatch: tree HEAD is ${build.commit}`);
    const version = JSON.parse(fs.readFileSync(path.join(build.root, 'package.json'), 'utf8')).version;
    const identity = resolveIdentity(options, version);
    const tools = await prepareToolchain(build, dirs.work, options, report);
    buildTreeStage(build.root, tools, report);
    const candidateRoot = path.join(dirs.work, 'candidate');
    const candidate = timed(report, 'buildCandidate', () => steps.buildCandidate(build.root, { node: tools.node,
        env: tools.env, version, commit: build.commit, candidateRoot }));
    const productionRoot = productionTreeStage(build.root, dirs.work, tools, exclusions, report);
    timed(report, 'licenseGate', () => steps.runLicenseGate(build.root, { node: tools.node, env: tools.env, productionRoot,
        target: options.target, noticesOut: path.join(dirs.work, 'THIRD_PARTY_NOTICES') }));
    steps.bundleVerifier(build.root, path.join(dirs.work, 'attestation-verifier.mjs'), { env: tools.env });
    return { build, version, identity, tools, candidate, candidateRoot, productionRoot, exclusions };
}

async function packageGeneration(options, dirs, staged, report) {
    const { build, version, identity, tools, exclusions } = staged;
    const trustedRoot = resolveTrustedRoot(options, build.root, report);
    const installer = resolveInstaller(options, dirs.work, report);
    const staging = path.join(dirs.work, 'staging');
    assembleStaging(staging, { buildRoot: build.root, candidateRoot: staged.candidateRoot,
        productionRoot: staged.productionRoot, tools, trustedRoot, identity, commit: build.commit, version, work: dirs.work,
        clientBuildId: staged.candidate.client.buildId });
    const sealed = timed(report, 'seal', () => sealStaging(staging, exclusions, options, report));
    const archiveName = `nassaj-${version}-${options.target}.tar.gz`;
    await timedAsync(report, 'archive', () => writeDeterministicTarGz({ root: staging,
        outputFile: path.join(dirs.output, archiveName) }));
    const archive = { name: archiveName, ...hashFile(path.join(dirs.output, archiveName)) };
    const outputs = describeOutputs(dirs.output, sealed, { staging, installer, trustedRoot, work: dirs.work });
    const lock = JSON.parse(fs.readFileSync(path.join(build.root, 'package-lock.json'), 'utf8'));
    const manifest = composeReleaseManifest({ version, commit: build.commit, identity, target: options.target,
        glibcFloor: sealed.glibcFloor, node: { version: tools.pin.version, sha256: tools.pin.sha256 }, archive,
        fileManifestSha256: outputs.fileManifest.sha256, installer: { name: outputs.installer.name,
            size: outputs.installer.size, sha256: outputs.installer.sha256 },
        externalPackages: externalPackagesFromLock(lock, exclusions), trustedRootSha256: outputs.trustedRoot.sha256,
        buildScriptSha256: hashFile(path.join(build.root, BUILD_SCRIPT_PATH)).sha256 });
    const manifestOut = writeOutputFile(dirs.output, RELEASE_MANIFEST_NAME, serializeReleaseManifest(manifest));
    const subjects = [archive, manifestOut, ...Object.values(outputs)];
    fs.writeFileSync(path.join(dirs.output, 'digests.txt'), digestsText(subjects), { flag: 'wx', mode: 0o644 });
    report.archive = archive;
    return { manifest, archivePath: path.join(dirs.output, archiveName) };
}

/**
 * Build (and optionally boot-smoke) one generation.
 * @param {object} options output of parseArguments
 * @returns {Promise<object>} the build report
 */
export async function buildReleaseGeneration(options) {
    const report = { schema: 'nassaj-generation-build-report/v1', target: options.target, timingsMs: {} };
    const started = Date.now();
    const dirs = prepareDirectories(options);
    try {
        const staged = await runStages(options, dirs, report);
        const packaged = await packageGeneration(options, dirs, staged, report);
        report.buildMs = Date.now() - started;
        report.version = packaged.manifest.version;
        report.commit = packaged.manifest.source.commit;
        report.synthesizedCommit = staged.build.synthesized;
        if (options.bootSmoke) {
            report.bootSmoke = await timedAsync(report, 'bootSmoke', () => runBootSmoke({
                archive: packaged.archivePath, manifest: packaged.manifest, target: options.target,
                expected: { serverBuildId: staged.candidate.server.buildId, clientBuildId: staged.candidate.client.buildId },
                scratchRoot: path.join(dirs.work, 'smoke'), keep: options.keepWork }));
        }
        return report;
    } finally {
        report.totalMs = Date.now() - started;
        fs.writeFileSync(path.join(dirs.output, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
        if (!options.keepWork) fs.rmSync(dirs.work, { recursive: true, force: true });
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const report = await buildReleaseGeneration(options);
    const summary = { version: report.version, commit: report.commit, archive: report.archive,
        unpackedBytes: report.unpackedBytes, glibcFloor: report.glibc?.floor, buildMs: report.buildMs,
        bootMs: report.bootSmoke?.bootMs ?? null, installerPlaceholder: report.installerPlaceholder ?? false };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`[release-generation] ${error.message}\n`);
        process.exitCode = 1;
    });
}
