/**
 * Discovery of already-published release generations for the public workflow
 * (ADR-174 §9.2 steps 4 and 7b). Used by `plan` (sequence must grow) and by the
 * `verify` fleet simulation (the latest published generation per channel).
 *
 * Output here is a pipeline hint only: the node-side verifier (§7.4) is the
 * control. Every network call goes through an injected `fetchImpl`, so the
 * logic is testable offline.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseManifest, RELEASE_MANIFEST_NAME } from '../lib/release-generation/release-manifest.mjs';

export const IDENTITY_FILE = fileURLToPath(new URL('./release-generation-identity.json', import.meta.url));
const API = 'https://api.github.com';
const PAGE_SIZE = 30;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

/**
 * Read and validate the committed public identity pin.
 * @param {string} [file]
 * @returns {Readonly<{repository: string, repositoryId: string, ownerId: string,
 *   workflowPath: string, workflowSource: string}>}
 */
export function loadIdentity(file = IDENTITY_FILE) {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const ok = value?.schema === 'nassaj-release-generation-identity/v1'
        && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value.repository ?? '')
        && /^[1-9]\d{0,19}$/.test(value.repositoryId ?? '') && /^[1-9]\d{0,19}$/.test(value.ownerId ?? '')
        && value.workflowPath === '.github/workflows/release-generation.yml'
        && value.workflowSource === 'scripts/release-workflow/release-generation.yml';
    if (!ok) throw new Error(`identity_invalid: ${path.basename(file)}`);
    return Object.freeze({ ...value });
}

/**
 * Derived download URL (§7.3): GitHub releases only, no mirror.
 * @param {string} repository owner/name
 * @param {string} tag release tag
 * @param {string} name asset name
 */
export function assetUrl(repository, tag, name) {
    return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function headers(token, accept) {
    const result = { accept, 'user-agent': 'nassaj-release-generation', 'x-github-api-version': '2022-11-28' };
    if (token) result.authorization = `Bearer ${token}`;
    return result;
}

/**
 * Fetch bytes with a size cap; non-2xx throws with the status.
 * @returns {Promise<Buffer>}
 */
export async function fetchBytes(fetchImpl, url, { token, accept = 'application/octet-stream' } = {}) {
    const response = await fetchImpl(url, { headers: headers(token, accept), redirect: 'follow' });
    if (!response.ok) throw new Error(`download_failed: ${response.status} ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`download_oversize: ${url}`);
    return bytes;
}

/**
 * Published (non-draft) releases that carry a release manifest, newest first,
 * each with its parsed manifest. Releases without a manifest (pre-ADR-174
 * git-source releases) are skipped; a present but invalid manifest throws.
 * @param {{repository: string, fetchImpl: typeof fetch, token?: string, pages?: number}} options
 * @returns {Promise<Array<{tag: string, manifest: object, manifestSha256: string, assets: Map<string, string>}>>}
 */
export async function listPublishedGenerations({ repository, fetchImpl, token, pages = 1 }) {
    const found = [];
    for (let page = 1; page <= pages; page += 1) {
        const url = `${API}/repos/${repository}/releases?per_page=${PAGE_SIZE}&page=${page}`;
        const list = JSON.parse((await fetchBytes(fetchImpl, url, { token, accept: 'application/vnd.github+json' }))
            .toString('utf8'));
        if (!Array.isArray(list)) throw new Error('release_list_invalid');
        for (const release of list) {
            if (release?.draft) continue;
            const assets = new Map((release?.assets ?? []).map(entry => [entry.name, entry.browser_download_url]));
            if (!assets.has(RELEASE_MANIFEST_NAME)) continue;
            const bytes = await fetchBytes(fetchImpl, assetUrl(repository, release.tag_name, RELEASE_MANIFEST_NAME));
            const parsed = parseReleaseManifest(new Uint8Array(bytes));
            found.push({ tag: release.tag_name, manifest: parsed.manifest, manifestSha256: parsed.sha256,
                manifestBytes: bytes, assets });
        }
        if (list.length < PAGE_SIZE) break;
    }
    return found;
}

/**
 * The latest published generation per channel, excluding the tag being built.
 * "Latest" = highest releaseSequence (not list order, which follows dates).
 * @param {Array<{tag: string, manifest: object}>} generations
 * @param {string} currentTag
 * @returns {Map<string, object>} channel -> generation
 */
export function latestPerChannel(generations, currentTag) {
    const latest = new Map();
    for (const generation of generations) {
        if (generation.tag === currentTag) continue;
        const channel = generation.manifest.channel;
        const held = latest.get(channel);
        if (!held || generation.manifest.releaseSequence > held.manifest.releaseSequence) latest.set(channel, generation);
    }
    return latest;
}

/**
 * Highest published releaseSequence across all channels (0 when none).
 * @param {Array<{manifest: object}>} generations
 */
export function highestSequence(generations) {
    return generations.reduce((max, generation) => Math.max(max, generation.manifest.releaseSequence), 0);
}
