/**
 * Fetch and unpack the official Node.js build that a generation bundles
 * (ADR-174 §6.1, §9.1). The tarball comes from nodejs.org only and must match
 * the sha256 committed in `scripts/release-generation-pins.json`; a cached
 * copy is reused only after the same check. The unpacked tree provides the
 * bundled `bin/node`, its unmodified `LICENSE`, the npm that installs the
 * generation (so npm is pinned with Node) and the headers for source builds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashFile } from './release-digests.mjs';

export const NODE_DIST_ORIGIN = 'https://nodejs.org/dist';
const NODE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const TARBALL = /^node-v[0-9.]+-linux-(x64|arm64)\.tar\.xz$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Read and check the Node pin for one target.
 * @param {object} pins parsed release-generation-pins.json
 * @param {string} target release target
 * @returns {{version: string, file: string, sha256: string, url: string}}
 */
export function nodePinFor(pins, target) {
    const version = pins?.node?.version;
    const entry = pins?.node?.targets?.[target];
    if (!NODE_VERSION.test(version ?? '') || !entry || !TARBALL.test(entry.file ?? '') || !HEX64.test(entry.sha256 ?? '')
        || !entry.file.startsWith(`node-v${version}-`)) {
        throw new Error(`node_pin_invalid: no valid Node pin for ${target}`);
    }
    return { version, file: entry.file, sha256: entry.sha256, url: `${NODE_DIST_ORIGIN}/v${version}/${entry.file}` };
}

async function download(url, destination, fetchImpl) {
    const response = await fetchImpl(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`node_download_failed: HTTP ${response.status} for ${url}`);
    const part = `${destination}.part`;
    fs.rmSync(part, { force: true });
    await fs.promises.writeFile(part, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o644 });
    return part;
}

/**
 * Ensure the pinned tarball is in `cacheDir`, verified, and return its path.
 * @param {object} input
 * @param {{file: string, sha256: string, url: string}} input.pin
 * @param {string} input.cacheDir
 * @param {typeof fetch} [input.fetchImpl]
 * @returns {Promise<string>} verified tarball path
 */
export async function ensureNodeTarball({ pin, cacheDir, fetchImpl = fetch }) {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const file = path.join(cacheDir, pin.file);
    if (fs.existsSync(file) && hashFile(file).sha256 === pin.sha256) return file;
    fs.rmSync(file, { force: true });
    const part = await download(pin.url, file, fetchImpl);
    const observed = hashFile(part).sha256;
    if (observed !== pin.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`node_tarball_digest_mismatch: ${pin.file} sha256 ${observed} != pinned ${pin.sha256}`);
    }
    fs.renameSync(part, file);
    return file;
}

/**
 * Unpack a verified Node tarball into a fresh directory.
 * @param {string} tarball verified tarball path
 * @param {string} destination directory to create
 * @param {typeof spawnSync} [run]
 * @returns {{dir: string, node: string, npmCli: string, license: string}}
 */
export function unpackNode(tarball, destination, run = spawnSync) {
    fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
    const result = run('tar', ['-xJf', tarball, '-C', destination, '--strip-components=1', '--no-same-owner'],
        { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`node_unpack_failed: ${(result.stderr || '').trim()}`);
    const layout = {
        dir: destination,
        node: path.join(destination, 'bin', 'node'),
        npmCli: path.join(destination, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        license: path.join(destination, 'LICENSE'),
    };
    for (const file of [layout.node, layout.npmCli, layout.license]) {
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`node_unpack_incomplete: ${file}`);
    }
    return layout;
}
