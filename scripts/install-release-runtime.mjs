#!/usr/bin/env node
/** Discover, download and prepare the latest governed release without activating it. */
import { randomUUID } from 'node:crypto';
import {
    closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
    readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchSealedRelease, readReleaseRunStatus, readGitMaintenanceStatus, releaseFailureCode, readReceipt } from './nassaj-release-launcher.mjs';

import { resolveReleaseSource } from '../server/services/release-source-config.js';

const HEX40 = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
/** Ceiling for GitHub API JSON responses and a pinned release descriptor. */
const MAX_JSON_BYTES = 512 * 1024;
/**
 * The detached manifest is NOT an API payload: it enumerates every shipped file, so it
 * grows with the tree (3.58 MiB at v1.46.0.6) and MAX_JSON_BYTES rejected every real
 * release. The fixtures never caught it because they publish `files: []`.
 */

function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function privateDirectory(directory) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: false, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error(`Installer directory is unsafe: ${directory}`);
    }
    return realpathSync(directory);
}
function ensureDeployControl(deployRoot, expected, hooks = {}) {
    if (!path.isAbsolute(deployRoot || '')) throw new Error('Installer deploy root must be absolute.');
    if (realpathSync(path.dirname(deployRoot)) !== path.resolve(path.dirname(deployRoot))) throw new Error('Installer parent path contains a symbolic link.');
    if (!existsSync(deployRoot)) mkdirSync(deployRoot, { recursive: false, mode: 0o755 });
    const deployMetadata = lstatSync(deployRoot);
    if (!deployMetadata.isDirectory() || deployMetadata.isSymbolicLink()
        || (deployMetadata.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && deployMetadata.uid !== process.getuid())) {
        throw new Error('Installer deploy root is unsafe.');
    }
    const deploy = realpathSync(deployRoot);
    if (deploy !== path.resolve(deployRoot)) throw new Error('Installer path contains a symbolic link.');
    const selection = path.join(deploy, 'initial-selection.json');
    if (readdirSync(deploy).length && !existsSync(selection)) throw new Error('Existing deployment is not an installer-owned fresh root.');
    if (existsSync(selection)) {
        const stat = lstatSync(selection);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES || (stat.mode & 0o077)
            || stat.uid !== process.getuid() || readFileSync(selection, 'utf8') !== JSON.stringify(expected)) {
            throw new Error('Installer resume identity conflicts with the pinned release.');
        }
    }
    const allowed = new Set(['initial-selection.json','control','releases','launcher','config','data','current']);
    if (readdirSync(deploy).some(name => !allowed.has(name))) throw new Error('Installer root contains foreign files.');
    if (!existsSync(selection)) writeExclusive(selection, JSON.stringify(expected));
    hooks.beforeControlCreation?.();
    const control = privateDirectory(path.join(deploy, 'control'));
    hooks.afterControlCreation?.();
    const controlSelection = path.join(control, 'installer-selection.json');
    if (!existsSync(controlSelection)) writeExclusive(controlSelection, JSON.stringify(expected));
    else if (JSON.stringify(readReceipt(controlSelection)) !== JSON.stringify(expected)) throw new Error('Installer control selection mismatch.');
    return { deploy, control };
}
function writeExclusive(file, bytes, mode = 0o600) {
    const fd = openSync(file, 'wx', mode);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(path.dirname(file));
}
function loadOrCreateNodeInstanceId(controlRoot) {
    const file = path.join(controlRoot, 'node-instance-id');
    if (!existsSync(file)) {
        const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
        const value = `node-${randomUUID()}`;
        writeExclusive(temporary, `${value}\n`);
        try { linkSync(temporary, file); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        finally { unlinkSync(temporary); }
        syncDirectory(controlRoot);
    }
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('Persisted node instance id is unsafe.');
    }
    const value = readFileSync(file, 'utf8').trim();
    if (!/^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        throw new Error('Persisted node instance id is invalid.');
    }
    return { file, value };
}
async function githubJson(fetchImpl, url) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'nassaj-release-installer', 'X-GitHub-Api-Version': '2022-11-28' };
    const response = await fetchImpl(url, { redirect: 'manual', headers });
    if (!response.ok || (response.status >= 300 && response.status < 400)) throw new Error('GitHub release discovery failed.');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error('GitHub release response is oversized.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_JSON_BYTES) throw new Error('GitHub release response is oversized.');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('GitHub release response is invalid.');
    return value;
}
function exactAsset(release, name) {
    const matches = (release.assets || []).filter((asset) => asset?.name === name && asset.state === 'uploaded');
    if (matches.length !== 1) throw new Error(`Release asset is absent or duplicated: ${name}`);
    const asset = matches[0]; const digest = DIGEST.exec(asset.digest || '');
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !digest) {
        throw new Error(`Release asset identity is incomplete: ${name}`);
    }
    return Object.freeze({ id: asset.id, name, size: asset.size, sha256: digest[1] });
}

export async function installLatestReleaseRuntime(options, injected = {}) {
    if (options.profile && options.profile !== 'default') {
        throw new Error('Forward assets require the independently approved operator bootstrap.');
    }
    const mode = options.mode || 'prepare';
    if (mode === 'status') return options.controlRoot ? readGitMaintenanceStatus({ controlRoot: options.controlRoot }) : readReleaseRunStatus({ deployRoot: options.deployRoot });
    if (mode === 'run') return launchSealedRelease({ deployRoot: options.deployRoot, mode: 'run', port: options.port, args: [] });
    if (mode !== 'prepare') throw new Error('Unknown installer mode.');
    const { RELEASE_ASSET_LIMITS, downloadExactGithubAsset, validateReleaseAssetManifest } = await import('./lib/update-release-asset.mjs');
    const { prepareInitialReleaseRuntime } = await import('./bootstrap-release-runtime.mjs');
    const env = options?.env || process.env; const source = resolveReleaseSource(env); const repo = `${source.owner}/${source.repo}`;
    const fetchImpl = injected.fetchImpl || fetch; const download = injected.downloadAsset || downloadExactGithubAsset;
    const prepare = injected.prepare || prepareInitialReleaseRuntime;
    const apiRoot = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
    let release; let resolvedCommit;
    if (options.releaseFile || options.releaseCommit) {
        if (!options.releaseFile || !HEX40.test(options.releaseCommit || '')) throw new Error('Pinned release file and commit must be provided together.');
        const metadata = lstatSync(options.releaseFile);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) throw new Error('Pinned release file is unsafe.');
        release = JSON.parse(readFileSync(options.releaseFile, 'utf8')); resolvedCommit = options.releaseCommit;
    } else {
        release = await githubJson(fetchImpl, `${apiRoot}/releases/latest`);
    }
    if (release.draft !== false || release.prerelease !== false || !Number.isSafeInteger(release.id) || release.id <= 0) {
        throw new Error('Latest GitHub release is not a published stable release.');
    }
    const tag = release.tag_name; const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
    if (!VERSION.test(version) || tag !== `v${version}`) throw new Error('Latest GitHub release tag is invalid.');
    if (!resolvedCommit) {
        const commitResponse = await githubJson(fetchImpl, `${apiRoot}/commits/${encodeURIComponent(tag)}`);
        resolvedCommit = commitResponse.sha;
    }
    if (!HEX40.test(resolvedCommit || '')) throw new Error('GitHub release tag did not resolve to an exact commit.');
    const runtime = exactAsset(release, `nassaj-runtime-v${version}.tar.gz`);
    const detached = exactAsset(release, 'RELEASE_ASSET_MANIFEST.json');
    if (runtime.id === detached.id) throw new Error('Runtime and manifest assets have conflicting identities.');
    const expected = { repo, releaseId: release.id, assetId: runtime.id, tag, version, commit: resolvedCommit,
        assetSize: runtime.size, assetSha256: runtime.sha256 };
    const { deploy, control } = ensureDeployControl(options.deployRoot, expected, injected.testHooks);
    const stagingRoot = privateDirectory(path.join(control, 'staging'));
    const temporary = mkdtempSync(path.join(stagingRoot, 'install-'));
    try {
        const [runtimeBytes, manifestBytes] = await Promise.all([
            download({ repo, assetId: runtime.id, expectedSha256: runtime.sha256,
                expectedSize: runtime.size, fetchImpl }),
            download({ repo, assetId: detached.id, expectedSha256: detached.sha256,
                expectedSize: detached.size, fetchImpl, maxBytes: RELEASE_ASSET_LIMITS.manifestBytes }),
        ]);
        const runtimeFile = path.join(temporary, runtime.name); const manifestFile = path.join(temporary, detached.name);
        writeExclusive(runtimeFile, runtimeBytes); writeExclusive(manifestFile, manifestBytes);
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        validateReleaseAssetManifest(manifest, expected);
        const node = loadOrCreateNodeInstanceId(control);
        const prepared = prepare({ deployRoot: deploy, assetFile: runtimeFile, manifestFile,
            nodeInstanceId: node.value, expected });
        if (prepared.state !== 'prepared_not_activated' || prepared.healthVerified !== false
            || prepared.serviceActivated !== false) throw new Error('Bootstrap returned an unsafe activation claim.');
        return Object.freeze({ ...prepared, nodeInstanceIdFile: node.file,
            activationRequired: true,
            ownerNextSteps: Object.freeze([
                `Run the pinned generation: node ${prepared.launcher} --mode run --deploy-root ${deploy}`,
                `Review node configuration at ${prepared.configFile}`,
                'This foreground launcher owns its child; stop it with SIGINT or SIGTERM.',
                'Verify /health and updateReady only after the service starts; neither is claimed by this installer.',
            ]) });
    } finally {
        rmSync(temporary, { recursive: true, force: true }); syncDirectory(stagingRoot);
    }
}

function argument(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node scripts/install-release-runtime.mjs --mode prepare|run|status --deploy-root ABS [--port 3001] [--release-file JSON --release-commit SHA]\n');
        return;
    }
    const result = await installLatestReleaseRuntime({ controlRoot: argument(argv, '--control-root'), mode: argument(argv, '--mode') || 'prepare', port: argument(argv, '--port'), deployRoot: argument(argv, '--deploy-root'),
        releaseFile: argument(argv, '--release-file'), releaseCommit: argument(argv, '--release-commit') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`${JSON.stringify({ failureCode: releaseFailureCode(error) })}\n`); process.exitCode = 1; });
}

export { loadOrCreateNodeInstanceId };
