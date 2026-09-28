/**
 * Build steps of `scripts/build-release-generation.mjs` that touch the
 * filesystem or run npm (ADR-174 §9.2 step 5). Every npm call uses the npm
 * shipped inside the pinned official Node build, with install scripts off;
 * native work is an explicit allowlist:
 *   - better-sqlite3 compiled from source against the bundled Node headers
 *     (no prebuild download is trusted);
 *   - @vscode/ripgrep's downloaded `rg` checked against the committed sha256;
 *   - the reviewed codex-sdk image-only patch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareClientPublicationAssets } from '../client-publication-archive.mjs';
import { verifyAssetClosure } from '../client-publication-artifacts.mjs';
import { hashFile } from './release-digests.mjs';
import { listInstalledPackagePaths, packageNameFromPath } from './production-closure.mjs';

const GIT_IDENTITY = Object.freeze({
    GIT_AUTHOR_NAME: 'Nassaj Release Build', GIT_AUTHOR_EMAIL: 'release-build@invalid',
    GIT_COMMITTER_NAME: 'Nassaj Release Build', GIT_COMMITTER_EMAIL: 'release-build@invalid',
    GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
});
const SQLITE_ADDON = ['build', 'Release', 'better_sqlite3.node'];
/** Variables that redirect git to another repository, index or config. */
const GIT_REDIRECTS = new RegExp(`^GIT_(${['DIR', 'WORK_TREE', 'INDEX_FILE', 'OBJECT_DIRECTORY',
    'ALTERNATE_OBJECT_DIRECTORIES', 'COMMON_DIR', 'NAMESPACE', 'CEILING_DIRECTORIES'].join('|')}|CONFIG.*)$`);
/** git reads no system or user config inside a build (only the repository's own). */
const GIT_ISOLATION = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });

/**
 * The caller's environment without any variable that could point git at
 * another repository, index or config, plus system/global config isolation.
 * @param {NodeJS.ProcessEnv} base
 * @returns {Record<string, string>}
 */
export function gitEnvironment(base) {
    const env = {};
    for (const [key, value] of Object.entries(base)) if (!GIT_REDIRECTS.test(key)) env[key] = value;
    return { ...env, ...GIT_ISOLATION };
}

/**
 * A build environment derived from the caller's with the bundled Node first
 * on PATH and every variable that could redirect npm, git, the build or the
 * update mode removed. npm reads only `npmUserConfig` (an empty file) as its
 * user config; SOURCE_DATE_EPOCH (the source commit time) makes build
 * timestamps reproducible.
 * @param {NodeJS.ProcessEnv} base
 * @param {{nodeDir: string, tmpDir: string, npmUserConfig: string, sourceDateEpoch: number}} input
 * @returns {Record<string, string>}
 */
export function buildEnvironment(base, { nodeDir, tmpDir, npmUserConfig, sourceDateEpoch }) {
    if (!npmUserConfig) throw new TypeError('buildEnvironment needs npmUserConfig');
    if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new TypeError('sourceDateEpoch is invalid');
    const env = {};
    for (const [key, value] of Object.entries(gitEnvironment(base))) {
        if (/^(NASSAJ_|npm_|NPM_CONFIG_|NODE_)/i.test(key) || key === 'DATABASE_PATH' || key === 'SOURCE_DATE_EPOCH') continue;
        env[key] = value;
    }
    return { ...env, PATH: `${path.join(nodeDir, 'bin')}:${base.PATH || '/usr/bin:/bin'}`, TMPDIR: tmpDir, HUSKY: '0',
        NPM_CONFIG_USERCONFIG: npmUserConfig, SOURCE_DATE_EPOCH: String(sourceDateEpoch) };
}

function run(command, args, options, code) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
    if (result.status !== 0) {
        const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(-3000);
        throw new Error(`${code}: ${command} ${args.join(' ')} exited ${result.status}\n${detail || result.error?.message || ''}`);
    }
    return result;
}

/**
 * Copy the export tree and give it a git HEAD. An export without `.git`
 * (the local gate) gets a repository with a fixed identity and date, so the
 * same tree always yields the same commit id; the build provenance and
 * `/health` then report that commit. git never sees a caller GIT_DIR etc.
 * @param {string} exportDir
 * @param {string} destination
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {{root: string, commit: string, synthesized: boolean, commitTime: number}}
 */
export function prepareBuildTree(exportDir, destination, baseEnv = process.env) {
    fs.cpSync(exportDir, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    const synthesized = !fs.existsSync(path.join(destination, '.git'));
    const gitEnv = gitEnvironment(baseEnv);
    if (synthesized) {
        const env = { ...gitEnv, ...GIT_IDENTITY };
        run('git', ['init', '-q', '-b', 'main'], { cwd: destination, env }, 'build_tree_git_failed');
        run('git', ['add', '-A'], { cwd: destination, env }, 'build_tree_git_failed');
        run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'release generation source'],
            { cwd: destination, env }, 'build_tree_git_failed');
    }
    const git = args => run('git', args, { cwd: destination, env: gitEnv }, 'build_tree_git_failed').stdout.trim();
    const commit = git(['rev-parse', 'HEAD']);
    const commitTime = Number(git(['log', '-1', '--format=%ct', commit]));
    return { root: destination, commit, synthesized, commitTime };
}

/**
 * `npm ci` with the bundled npm and install scripts off.
 * @param {string} root directory holding package.json + package-lock.json
 * @param {{node: {node: string, npmCli: string}, env: object, omitDev: boolean}} input
 */
export function npmCi(root, { node, env, omitDev }) {
    const args = [node.npmCli, 'ci', omitDev ? '--omit=dev' : '--include=dev', '--ignore-scripts',
        '--no-audit', '--no-fund', '--loglevel=error'];
    run(node.node, args, { cwd: root, env }, 'npm_ci_failed');
}

/**
 * Compile better-sqlite3 from source against the bundled Node headers.
 * @param {string} root
 * @param {{node: {dir: string, node: string}, env: object}} input
 */
export function buildSqliteFromSource(root, { node, env }) {
    const packageDir = path.join(root, 'node_modules', 'better-sqlite3');
    fs.rmSync(path.join(packageDir, 'build'), { recursive: true, force: true });
    const gyp = path.join(node.dir, 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
    run(node.node, [gyp, 'rebuild', '--release', `--nodedir=${node.dir}`, '-j', '4'],
        { cwd: packageDir, env }, 'better_sqlite3_source_build_failed');
}

/**
 * Run @vscode/ripgrep's downloader, then require the committed sha256.
 * @param {string} root
 * @param {{node: {node: string}, env: object, pin: {file: string, sha256: string}}} input
 */
export function installPinnedRipgrep(root, { node, env, pin }) {
    const packageDir = path.join(root, 'node_modules', '@vscode', 'ripgrep');
    run(node.node, ['lib/postinstall.js'], { cwd: packageDir, env }, 'ripgrep_download_failed');
    assertRipgrepPin(root, pin);
}

/**
 * Fail unless the ripgrep binary matches the committed sha256.
 * @param {string} root
 * @param {{file: string, sha256: string}} pin
 */
export function assertRipgrepPin(root, pin) {
    const binary = path.join(root, 'node_modules', '@vscode', 'ripgrep', ...pin.file.split('/'));
    const observed = hashFile(binary).sha256;
    if (observed !== pin.sha256) throw new Error(`ripgrep_digest_mismatch: ${observed} != pinned ${pin.sha256}`);
}

/**
 * Apply and verify the reviewed codex-sdk patch in `root`.
 * @param {string} scriptsRoot tree holding scripts/patch-codex-sdk-image-only.mjs
 * @param {string} root installation root to patch
 * @param {{node: {node: string}, env: object}} input
 */
export function applyCodexPatch(scriptsRoot, root, { node, env }) {
    const script = path.join(scriptsRoot, 'scripts', 'patch-codex-sdk-image-only.mjs');
    run(node.node, [script, '--apply', '--root', root], { cwd: scriptsRoot, env }, 'codex_patch_failed');
}

/**
 * Copy the source-built sqlite addon and the pinned ripgrep binary from the
 * build tree into the production tree (same lockfile, same package versions).
 * @param {string} buildRoot
 * @param {string} productionRoot
 * @param {{file: string, sha256: string}} ripgrepPin
 */
export function copyNativeArtifacts(buildRoot, productionRoot, ripgrepPin) {
    for (const name of ['better-sqlite3', '@vscode/ripgrep']) {
        const version = dir => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'))).version;
        if (version(buildRoot) !== version(productionRoot)) throw new Error(`native_artifact_version_mismatch: ${name}`);
    }
    const sqlite = path.join(productionRoot, 'node_modules', 'better-sqlite3', ...SQLITE_ADDON);
    fs.mkdirSync(path.dirname(sqlite), { recursive: true });
    fs.copyFileSync(path.join(buildRoot, 'node_modules', 'better-sqlite3', ...SQLITE_ADDON), sqlite);
    const rg = ['node_modules', '@vscode', 'ripgrep', ...ripgrepPin.file.split('/')];
    fs.mkdirSync(path.dirname(path.join(productionRoot, ...rg)), { recursive: true });
    fs.copyFileSync(path.join(buildRoot, ...rg), path.join(productionRoot, ...rg));
    fs.chmodSync(path.join(productionRoot, ...rg), 0o755);
    assertRipgrepPin(productionRoot, ripgrepPin);
}

/**
 * Remove every installed excluded package (by install path, so npm aliases
 * are caught) and every `.bin` link farm. Returns the removed package paths.
 * @param {string} root production root
 * @param {{isExcluded: (name: string) => boolean}} exclusions
 * @returns {string[]}
 */
export function removeExcludedPackages(root, exclusions) {
    const removed = [];
    for (const lockPath of listInstalledPackagePaths(root)) {
        if (!exclusions.isExcluded(packageNameFromPath(lockPath))) continue;
        fs.rmSync(path.join(root, ...lockPath.split('/')), { recursive: true, force: true });
        removed.push(lockPath);
    }
    removeBinFarms(path.join(root, 'node_modules'));
    return removed;
}

function removeBinFarms(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.name === '.bin') fs.rmSync(absolute, { recursive: true, force: true });
        else if (entry.isDirectory()) removeBinFarms(absolute);
    }
}

/**
 * Build the client and server release candidate in the build tree.
 * @returns {{client: {buildId: string}, server: {buildId: string}}}
 */
export function buildCandidate(buildRoot, { node, env, version, commit, candidateRoot }) {
    const result = run(node.node, ['scripts/build-release-candidate.mjs', '--version', version, '--commit', commit,
        '--output', candidateRoot], { cwd: buildRoot, env }, 'release_candidate_build_failed');
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (summary.client?.releaseCommit !== commit || summary.server?.releaseCommit !== commit) {
        throw new Error('release_candidate_commit_mismatch');
    }
    return summary;
}

/** Where client-publication-static.js serves `/assets/generations/<id>/…` from. */
export const SERVED_CLIENT_GENERATIONS = '.nassaj-local-preview/client-assets/generations';

/**
 * Seed the served client archive inside the generation root from its sealed
 * dist, through the same contract as install-node's
 * prepareServedClientGeneration and the update path
 * (prepareClientPublicationAssets + verifyAssetClosure): the sealed
 * CLIENT_ASSET_MANIFEST is validated against dist and the expected identity,
 * then dist is copied (regular files, one link each) to
 * `<root>/.nassaj-local-preview/client-assets/generations/<generationId>/`.
 * Without it every generation-scoped asset URL in index.html is a 404.
 * @param {string} generationRoot staging root holding dist/
 * @param {{sourceOid: string, buildId: string}} expected client build identity
 * @returns {{generationId: string, destination: string}}
 */
export function seedServedClientGeneration(generationRoot, expected) {
    const destination = prepareClientPublicationAssets(generationRoot, path.join(generationRoot, 'dist'),
        { sourceOid: expected.sourceOid, buildId: expected.buildId }, verifyAssetClosure,
        { reserveBytes: 2 * 1024 ** 3 });
    return { generationId: path.basename(destination), destination };
}

/**
 * Run the public license gate against the production tree; on success it
 * writes THIRD_PARTY_NOTICES.
 * @param {string} buildRoot tree with package.json, lockfile, gate and policy files
 * @param {{node: {node: string}, env: object, productionRoot: string, target: string, noticesOut: string}} input
 */
export function runLicenseGate(buildRoot, { node, env, productionRoot, target, noticesOut }) {
    run(node.node, ['scripts/release-license-gate.mjs', '--root', buildRoot, '--tree', productionRoot,
        '--target', target, '--check-tree', '--notices-out', noticesOut], { cwd: buildRoot, env }, 'license_gate_failed');
    if (!fs.existsSync(noticesOut)) throw new Error('license_gate_failed: THIRD_PARTY_NOTICES was not written');
}

/**
 * Bundle the attestation verifier into one ESM file. The sigstore closure is
 * CommonJS, so the banner provides `require`; legal comments are kept at the
 * end of the file and the header names the Apache-2.0 closure and the
 * release notices.
 * @param {string} buildRoot tree holding the verifier source and esbuild
 * @param {string} outputFile
 * @param {{env: object}} input
 */
export function bundleVerifier(buildRoot, outputFile, { env }) {
    const banner = [
        '// Nassaj standalone release attestation verifier (ADR-174 §7.4). AGPL-3.0-only.',
        '// Bundles @sigstore/verify, @sigstore/bundle, @sigstore/core and @sigstore/protobuf-specs',
        '// (Apache-2.0, https://www.apache.org/licenses/LICENSE-2.0); their license texts and',
        '// notices are in THIRD_PARTY_NOTICES of the same release generation.',
        "import { createRequire as __nassajCreateRequire } from 'node:module';",
        'const require = __nassajCreateRequire(import.meta.url);',
    ].join('\n');
    run(path.join(buildRoot, 'node_modules', '.bin', 'esbuild'), [
        'scripts/lib/release-generation/standalone-verifier.mjs', '--bundle', '--platform=node', '--format=esm',
        '--target=node24', '--legal-comments=eof', `--banner:js=${banner}`, `--outfile=${outputFile}`, '--log-level=warning',
    ], { cwd: buildRoot, env }, 'verifier_bundle_failed');
}
