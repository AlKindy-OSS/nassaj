import { isNassajReleaseVersion } from '../../shared/release-version-policy.js';

import { resolveReleaseSource } from './release-source-config.js';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const OUTPUT_LIMIT = 8 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class ReleaseDiscoveryError extends Error {
    constructor(code, message, status = 503) {
        super(message);
        this.name = 'ReleaseDiscoveryError';
        this.code = code;
        this.status = status;
    }
}

function boundedAppend(current, chunk) {
    const next = current + chunk.toString('utf8');
    return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

function positiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function sanitizeRelease(release, source, resolvedCommit) {
    if (!release || release.draft === true || release.prerelease === true) return null;
    const tagName = typeof release.tag_name === 'string' ? release.tag_name : '';
    const version = tagName.startsWith('v') ? tagName.slice(1) : '';
    if (!isNassajReleaseVersion(version) || tagName !== `v${version}`) return null;
    const expectedPrefix = `https://github.com/${source.owner}/${source.repo}/releases/tag/`;
    const htmlUrl = typeof release.html_url === 'string' && release.html_url.startsWith(expectedPrefix)
        ? release.html_url
        : `${expectedPrefix}${encodeURIComponent(tagName)}`;
    const publishedTimestamp = Date.parse(release.published_at);
    if (!Number.isFinite(publishedTimestamp)) return null;
    const publishedAt = new Date(publishedTimestamp).toISOString();
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || !/^[a-f0-9]{40}$/.test(resolvedCommit || '')) return null;
    const assets = Array.isArray(release.assets) ? release.assets.filter((asset) => (
        Number.isSafeInteger(asset?.id) && asset.id > 0 && asset.state === 'uploaded'
        && asset.name === `nassaj-runtime-v${version}.tar.gz`
        && Number.isSafeInteger(asset.size) && asset.size >= 0
        && /^sha256:[a-f0-9]{64}$/.test(asset.digest || '')
    )) : [];
    if (assets.length !== 1) return null;
    const asset = assets[0];
    return {
        releaseId: release.id,
        version,
        tagName,
        commit: resolvedCommit,
        assetId: asset.id,
        assetName: asset.name,
        assetSize: asset.size,
        assetSha256: asset.digest.slice('sha256:'.length),
        title: typeof release.name === 'string' ? release.name.slice(0, 256) : tagName,
        notes: typeof release.body === 'string' ? release.body.slice(0, 32 * 1024) : '',
        htmlUrl,
        publishedAt,
    };
}

function createReleaseRequester({ fetchImpl, source, timeoutMs }) {
    return async function requestRelease(endpoint) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const headers = {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'nassaj-release-discovery',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            const repository = `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
            return await fetchImpl(`https://api.github.com/repos/${repository}/${endpoint}`, {
                headers,
                signal: controller.signal,
                redirect: 'manual',
            });
        } catch {
            throw new ReleaseDiscoveryError('release_source_unavailable', 'The OSS release source is unavailable.');
        } finally {
            clearTimeout(timer);
        }
    };
}

async function readRelease(response) {
    if (!response.ok) {
        throw new ReleaseDiscoveryError('release_source_rejected', 'The OSS release source rejected discovery.');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new ReleaseDiscoveryError('release_source_oversized', 'The OSS release source returned an oversized response.');
    }
    let text;
    try { text = await response.text(); } catch { text = ''; }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new ReleaseDiscoveryError('release_source_oversized', 'The OSS release source returned an oversized response.');
    }
    let release;
    try { release = JSON.parse(text); } catch { release = null; }
    if (!release || Array.isArray(release) || typeof release !== 'object') {
        throw new ReleaseDiscoveryError('release_source_invalid', 'The OSS release source returned an invalid response.');
    }
    return release;
}

/** Create a cached, identity-pinned GitHub release discovery service. */
export function createReleaseDiscovery({
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    source = resolveReleaseSource(env),
    ttlMs = positiveInteger(env.NASSAJ_RELEASE_DISCOVERY_TTL_MS, DEFAULT_TTL_MS, 60 * 60_000),
    timeoutMs = positiveInteger(env.NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 30_000),
} = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Release discovery dependencies are required');
    let cache = null;
    let inFlight = null;
    const requestRelease = createReleaseRequester({ fetchImpl, source, timeoutMs });

    const refresh = async () => {
        const upstream = await readRelease(await requestRelease('releases/latest'));
        const tagName = typeof upstream?.tag_name === 'string' ? upstream.tag_name : '';
        if (!tagName || tagName.length > 128) {
            throw new ReleaseDiscoveryError('release_not_found', 'No governed OSS release is available.', 404);
        }
        // target_commitish may legitimately be "main" and is not an immutable
        // release identity. GitHub's commits/<tag> endpoint dereferences both
        // lightweight and annotated tags to the exact commit SHA.
        const resolved = await readRelease(await requestRelease(`commits/${encodeURIComponent(tagName)}`));
        const commit = typeof resolved?.sha === 'string' && /^[a-f0-9]{40}$/.test(resolved.sha)
            ? resolved.sha : null;
        const release = sanitizeRelease(upstream, source, commit);
        if (!release) {
            throw new ReleaseDiscoveryError('release_not_found', 'No governed OSS release is available.', 404);
        }
        const result = { release };
        cache = { result, freshUntil: now() + ttlMs };
        return result;
    };

    return async function discoverRelease() {
        if (cache && now() < cache.freshUntil) return cache.result;
        if (inFlight) return inFlight;
        inFlight = refresh().finally(() => { inFlight = null; });
        return inFlight;
    };
}

export function releaseErrorPayload(error) {
    if (error instanceof ReleaseDiscoveryError) {
        return { status: error.status, body: { success: false, code: error.code, error: error.message } };
    }
    return { status: 503, body: { success: false, code: 'release_discovery_failed', error: 'OSS release discovery failed.' } };
}
