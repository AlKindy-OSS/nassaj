/** Serve immutable archived generations by their sealed asset manifest. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const HASH = /^[a-f0-9]{64}$/;
const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.includes('\0') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

function openRelative(root, relative, operation) {
    const descriptors = [];
    let directory = root;
    try {
        const parts = /^\/proc\/self\/fd\/\d+$/.test(root) ? relative.split('/') : ['', ...relative.split('/')];
        for (const [index, part] of parts.entries()) {
            const fd = fs.openSync(path.join(directory, part), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
                | fs.constants.O_NONBLOCK | (index < parts.length - 1 ? fs.constants.O_DIRECTORY : 0));
            descriptors.push(fd);
            directory = `/proc/self/fd/${fd}`;
        }
        return operation(descriptors.at(-1));
    } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}

/** Read and hash only a manifest-authorized regular asset, pinning every path component. */
export function readArchivedClientAsset(root, generationId, relative) {
    if (!HASH.test(generationId || '') || !safePath(relative)) throw new Error('client_asset_path_invalid');
    const generation = `.nassaj-local-preview/client-assets/generations/${generationId}`;
    return openRelative(root, `${generation}/CLIENT_ASSET_MANIFEST.json`, manifestFd => {
        const stat = fs.fstatSync(manifestFd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('client_asset_manifest_invalid');
        const manifest = JSON.parse(fs.readFileSync(manifestFd, 'utf8'));
        if (manifest.schema !== 'nassaj-client-assets/v1' || manifest.generationId !== generationId
            || !HASH.test(manifest.buildId || '') || !/^[a-f0-9]{40}$/.test(manifest.sourceOid || '') || !Array.isArray(manifest.entries)) throw new Error('client_asset_manifest_invalid');
        const names = new Set();
        for (const entry of manifest.entries) {
            if (!safePath(entry.path) || names.has(entry.path) || !HASH.test(entry.sha256 || '')
                || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('client_asset_manifest_invalid');
            names.add(entry.path);
        }
        const entry = manifest.entries.find(item => item.path === relative);
        if (!entry || /(?:^|\/)(?:index\.html|BUILD_PROVENANCE\.json|CLIENT_ASSET_MANIFEST\.json)$/.test(relative)) throw new Error('client_asset_not_found');
        return openRelative(root, `${generation}/${relative}`, fd => {
            const metadata = fs.fstatSync(fd);
            if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== entry.size || metadata.size > 64 * 1024 * 1024) throw new Error('client_asset_identity_invalid');
            const bytes = fs.readFileSync(fd);
            if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('client_asset_identity_invalid');
            return { bytes, sha256: entry.sha256, relative };
        });
    });
}

/** Mount before legacy assets; missing archive paths never fall through to SPA HTML. */
export function createClientPublicationStaticMiddleware(root) {
    return (req, res) => {
        if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
        try {
            const raw = req.url.split('?')[0];
            if (/%(?:2f|5c|00)/i.test(raw)) throw new Error('client_asset_path_invalid');
            const [, generationId, ...segments] = decodeURIComponent(raw).split('/');
            const asset = readArchivedClientAsset(root, generationId, segments.join('/'));
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('ETag', `"${asset.sha256}"`);
            res.type(path.extname(asset.relative));
            return res.send(asset.bytes);
        } catch {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).end();
        }
    };
}

/** Preserve dynamic manifest branding while binding local icon URLs to the pinned served generation. */
export function readServedClientManifest(root) {
    return openRelative(root, 'dist', directoryFd => {
        const directory = `/proc/self/fd/${directoryFd}`;
        const raw = openRelative(directory, 'manifest.json', fd => fs.readFileSync(fd));
        const manifest = JSON.parse(raw);
        let assets;
        try { assets = openRelative(directory, 'CLIENT_ASSET_MANIFEST.json', fd => JSON.parse(fs.readFileSync(fd, 'utf8'))); }
        catch (error) { if (error.code === 'ENOENT') return manifest; throw error; }
        if (assets.schema !== 'nassaj-client-assets/v1' || !HASH.test(assets.generationId || '') || !Array.isArray(assets.entries)) throw new Error('client_manifest_generation_invalid');
        const entry = assets.entries.find(item => item.path === 'manifest.json');
        if (!entry || entry.size !== raw.length || entry.sha256 !== createHash('sha256').update(raw).digest('hex')) throw new Error('client_manifest_generation_invalid');
        const prefix = `/assets/generations/${assets.generationId}/`;
        const iconUrl = src => {
            if (typeof src !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src;
            const suffixIndex = src.search(/[?#]/);
            const pathname = suffixIndex < 0 ? src : src.slice(0, suffixIndex);
            const suffix = suffixIndex < 0 ? '' : src.slice(suffixIndex);
            const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname.replace(/^\//, '');
            if (!safePath(relative) || !assets.entries.some(item => item.path === relative)) throw new Error('client_manifest_asset_unsealed');
            readArchivedClientAsset(root, assets.generationId, relative);
            return `${prefix}${relative}${suffix}`;
        };
        for (const item of [...(manifest.icons || []), ...(manifest.screenshots || []), ...(manifest.shortcuts || []).flatMap(shortcut => shortcut.icons || [])]) item.src = iconUrl(item.src);
        return manifest;
    });
}

/** Existing dynamic manifest endpoint; branding remains evaluated on every request. */
export function createClientManifestHandler(root, getBrandingTitle, onError = () => {}) {
    return (_req, res) => {
        try {
            const manifest = readServedClientManifest(root), title = getBrandingTitle();
            if (title) { manifest.name = title; manifest.short_name = title; }
            res.setHeader('Cache-Control', 'no-cache');
            return res.type('application/manifest+json').send(JSON.stringify(manifest));
        } catch (error) {
            onError({ event: 'client_manifest_failed', code: error.code || 'client_manifest_unavailable' });
            res.setHeader('Cache-Control', 'no-store');
            return res.status(500).json({ error: 'Failed to serve manifest' });
        }
    };
}
