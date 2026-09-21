/** Production-facing composition contract consumed by the durable update worker. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
    downloadExactGithubAsset, extractTarGzExact, selectExactReleaseAsset, validateReleaseAssetManifest,
    verifyExtractedReleaseAsset, verifyReleaseAssetRuntimeCompatibility,
} from './update-release-asset.mjs';
import { requireReleaseLayout } from './update-release-layout-adapter.mjs';
import { activateReleaseGeneration, rollbackReleaseGeneration, sealReleaseGeneration } from './update-release-layout-activation.mjs';
import { pruneUpdateRuntime } from './update-runtime-janitor.mjs';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function createUpdateRuntimeOrchestrator({
    layoutOptions,
    listRuntimeReferences,
    fetchImpl = fetch,
    runtimeTarget,
    runtimeHost,
} = {}) {
    if (typeof listRuntimeReferences !== 'function') throw new TypeError('Runtime orchestrator requires live job references.');
    const inspectCapability = () => requireReleaseLayout(layoutOptions);
    let mutationLayout = null;
    const acquireMutationLayout = () => { mutationLayout ||= inspectCapability(); return mutationLayout; };
    const maintain = () => {
        const layout = inspectCapability();
        const loadLiveReferences = () => [
            ...listRuntimeReferences(),
            ...[layout.current, layout.previous, layout.lastGood]
                .filter(Boolean)
                .map((reference) => ({ state: 'layout-ref', generationId: reference.id })),
        ];
        try {
            const removed = pruneUpdateRuntime(layout.controlRoot, {
                generationsRoot: layout.releasesRoot,
                loadLiveReferences,
            });
            return Object.freeze({ state: 'complete', removed });
        } catch (error) {
            if (error?.code === 'update_runtime_nonterminal_unresolved') {
                return Object.freeze({ state: 'deferred', code: error.code, removed: [] });
            }
            throw error;
        }
    };
    return Object.freeze({
        inspectCapability,
        beforeWorkerClaim: maintain,
        afterTerminal: maintain,
        sealGeneration: (input) => sealReleaseGeneration({ ...input, layout: acquireMutationLayout() }),
        activateGeneration: (input) => activateReleaseGeneration({ ...input, layout: acquireMutationLayout() }),
        rollbackGeneration: (input) => rollbackReleaseGeneration({ ...input, layout: acquireMutationLayout() }),
        async downloadAndExtractExactAsset({ release, expected, destination, context = {} }) {
            if (typeof context.assertFence !== 'function' || typeof context.checkpoint !== 'function') {
                throw new Error('Release asset operation requires worker fencing and durable checkpoints.');
            }
            const layout = acquireMutationLayout();
            const asset = selectExactReleaseAsset(release, expected);
            if (asset.assetId !== expected.assetId) throw new Error('Exact release asset id changed.');
            if (asset.size !== expected.assetSize) throw new Error('Exact release asset size changed.');
            await context.assertFence();
            await context.checkpoint('downloading', 'intent', { releaseId: expected.releaseId, assetId: asset.assetId });
            const bytes = await downloadExactGithubAsset({ repo: expected.repo, assetId: asset.assetId,
                expectedSize: expected.assetSize, expectedSha256: expected.assetSha256, fetchImpl });
            await context.assertFence();
            await context.checkpoint('archive_verified', 'done', { assetSha256: sha(bytes), assetSize: bytes.length });
            const staging = path.join(layout.controlRoot, `asset-${expected.releaseId}-${asset.assetId}.staging`);
            if (path.resolve(destination) !== path.join(layout.releasesRoot, expected.generationId)) {
                throw new Error('Release asset destination is not the exact generation slot.');
            }
            const makeIdentity = (manifest) => Object.freeze({
                repository: manifest.repo, releaseId: manifest.releaseId, tag: manifest.tag, version: manifest.version,
                commit: manifest.commit, assetId: asset.assetId, assetName: asset.name, assetSize: expected.assetSize,
                assetSha256: expected.assetSha256, archiveSha256: expected.assetSha256,
                sourceTreeSha256: manifest.sourceTreeSha256, updaterProtocol: 2,
                bundleBuildId: manifest.bundleBuildId, bundleManifestSha256: manifest.bundleManifestSha256,
                serverBuildId: manifest.serverBuildId, clientBuildId: manifest.clientBuildId,
                ...(Object.prototype.hasOwnProperty.call(manifest, 'permissionProfile') ? {
                    permissionProfile: manifest.permissionProfile,
                    permissionContractVersion: manifest.permissionContractVersion,
                    permissionProfileDigest: manifest.permissionProfileDigest,
                    permissionCapabilityDigest: manifest.permissionCapabilityDigest,
                    permissionProtocolGeneration: manifest.permissionProtocolGeneration,
                    minimumPermissionBuild: manifest.minimumPermissionBuild,
                } : {}),
                strategy: 'release-layout-v2', jobId: expected.jobId, generationId: expected.generationId,
            });
            if (existsSync(staging)) {
                const recovered = verifyExtractedReleaseAsset(staging, expected, { runtimeTarget });
                verifyReleaseAssetRuntimeCompatibility(recovered.manifest, runtimeHost);
                await context.assertFence();
                await context.checkpoint('extracting', 'recovery', { files: recovered.files.length, generationId: expected.generationId });
                return Object.freeze({ staging, manifest: recovered.manifest, files: recovered.files, asset,
                    identity: makeIdentity(recovered.manifest), recovered: true });
            }
            await context.assertFence();
            mkdirSync(staging, { mode: 0o700 });
            try {
                const files = extractTarGzExact(bytes, staging, expected.limits);
                const manifestPath = path.join(staging, 'RELEASE_ASSET_MANIFEST.json');
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                validateReleaseAssetManifest(manifest, expected, { runtimeTarget });
                verifyReleaseAssetRuntimeCompatibility(manifest, runtimeHost);
                const actualTree = files.filter((entry) => entry.type === 'file' && entry.name !== 'RELEASE_ASSET_MANIFEST.json')
                    .map((entry) => ({ path: entry.name, mode: entry.mode & 0o111 ? 0o755 : 0o644, size: entry.size, sha256: entry.sha256 }))
                    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
                if (JSON.stringify(actualTree) !== JSON.stringify(manifest.files)) throw new Error('Release asset extracted tree does not match its manifest.');
                const bundleManifest = readFileSync(path.join(staging, 'dist-server', 'UPDATE_RUNTIME_MANIFEST.json'));
                if (sha(bundleManifest) !== manifest.bundleManifestSha256
                    || JSON.parse(bundleManifest).buildId !== manifest.bundleBuildId) throw new Error('Release asset runtime bundle identity mismatch.');
                await context.assertFence();
                await context.checkpoint('extracting', 'done', { files: files.length, generationId: expected.generationId });
                // The worker owns the final atomic rename after persisting its sealed receipt.
                const identity = makeIdentity(manifest);
                return Object.freeze({ staging, manifest, files, asset, identity });
            } catch (error) {
                rmSync(staging, { recursive: true, force: true });
                throw error;
            }
        },
    });
}
