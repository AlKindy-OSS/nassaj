/** Shared immutable archive contract for development publication and full-update capsules. */
import fs from 'node:fs';
import path from 'node:path';
import { inspectClientPublicationTree, validateClientAssetManifest } from './client-publication-artifacts.mjs';
const MAX_ASSETS = 1024 ** 3;
export const CLIENT_PUBLICATION_RESERVE_BYTES = 16 * 1024 ** 3;

function mkdirReal(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('client_publication_parent_unsafe');
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Account for retained generations, incoming assets and disk reserve without deleting any generation. */
export function assertClientPublicationCapacity(root, incomingBytes = 0, options = {}) {
    const reserveBytes = options.reserveBytes ?? CLIENT_PUBLICATION_RESERVE_BYTES;
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 2 * 1024 ** 3) throw new Error('client_publication_reserve_invalid');
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0 || incomingBytes > MAX_ASSETS) throw new Error('client_publication_capacity_exceeded');
    const archive = path.join(root, '.nassaj-local-preview/client-assets/generations'), unique = new Map();
    if (fs.existsSync(archive)) {
        for (const entry of fs.readdirSync(archive)) {
            const tree = inspectClientPublicationTree(path.join(archive, entry));
            for (const asset of tree.entries) unique.set(asset.sha256, asset.size);
        }
    }
    const bytes = [...unique.values()].reduce((sum, value) => sum + value, 0);
    const disk = fs.statfsSync(root);
    if (bytes + incomingBytes > MAX_ASSETS || disk.bavail * disk.bsize < reserveBytes + 3 * incomingBytes) throw new Error('client_publication_capacity_exceeded');
    return { uniqueAssetBytes: bytes, incomingBytes, reserveBytes };
}

/** Prepare a separate serving archive; sealed source generations are never appended to or stripped. */
export function prepareClientPublicationAssets(root, candidate, expected, verifyClosure, options = {}) {
    const verified = validateClientAssetManifest(candidate, expected, verifyClosure);
    const parent = path.join(root, '.nassaj-local-preview/client-assets/generations'), destination = path.join(parent, verified.manifest.generationId);
    mkdirReal(parent);
    if (fs.existsSync(destination)) {
        validateClientAssetManifest(destination, expected, verifyClosure);
        return destination;
    }
    assertClientPublicationCapacity(root, verified.totalBytes, options);
    const staging = path.join(parent, `.${verified.manifest.generationId}-${process.pid}`);
    if (fs.existsSync(staging)) throw new Error('client_publication_asset_preparation_unresolved');
    fs.cpSync(candidate, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
    validateClientAssetManifest(staging, expected, verifyClosure);
    for (const entry of [...verified.entries, { path: 'CLIENT_ASSET_MANIFEST.json' }]) {
        const fd = fs.openSync(path.join(staging, entry.path), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    syncDirectory(staging); fs.renameSync(staging, destination); syncDirectory(parent);
    return destination;
}
