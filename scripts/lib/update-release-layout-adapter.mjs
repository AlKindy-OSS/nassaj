/** Read-only release-layout capability adapter. Absence is never interpreted as ready. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { detectUpdateStrategy, resolveUpdateRuntimeEntry } from './update-runtime-capability.mjs';

const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
function sha(value) { return createHash('sha256').update(value).digest('hex'); }

function realDirectory(value, label) {
    const resolved = realpathSync(value);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
    return resolved;
}

function resolveGenerationLink(deployRoot, releasesRoot, name, required = false) {
    const link = path.join(deployRoot, name);
    if (!existsSync(link)) {
        if (required) throw new Error(`Release layout ${name} reference is absent.`);
        return null;
    }
    const metadata = lstatSync(link);
    if (!metadata.isSymbolicLink()) throw new Error(`Release layout ${name} reference must be a symlink.`);
    const raw = readlinkSync(link);
    const resolved = realpathSync(link);
    if (path.isAbsolute(raw) || path.dirname(resolved) !== releasesRoot || !SAFE_GENERATION.test(path.basename(resolved))) {
        throw new Error(`Release layout ${name} reference escapes the generation store.`);
    }
    return Object.freeze({ id: path.basename(resolved), path: resolved });
}

/** Establish every host/layout fact required before protocol v2 may be advertised. */
export function inspectReleaseLayout(options) {
    if (!options?.deployRoot || !options.projectRoot || !options.artifactRoot || !options.controlRoot || !options.capabilityFile) {
        return Object.freeze({ ready: false, code: 'release_layout_configuration_absent' });
    }
    try {
        const deployRoot = realDirectory(options.deployRoot, 'Release deploy root');
        const releasesRoot = realDirectory(path.join(deployRoot, 'releases'), 'Release generations root');
        const projectRoot = realpathSync(options.projectRoot);
        const controlRoot = realDirectory(options.controlRoot, 'Release control root');
        if (statSync(deployRoot).dev !== statSync(releasesRoot).dev || statSync(deployRoot).dev !== statSync(controlRoot).dev) {
            throw new Error('Release layout must stay on one filesystem.');
        }
        const current = resolveGenerationLink(deployRoot, releasesRoot, 'current', true);
        const previous = resolveGenerationLink(deployRoot, releasesRoot, 'previous');
        const lastGood = resolveGenerationLink(deployRoot, releasesRoot, 'last-good');
        if (projectRoot !== current.path) throw new Error('Project root is not the current immutable release generation.');
        const runtimeStrategy = detectUpdateStrategy({
            artifactRoot: options.artifactRoot,
            capabilityFile: options.capabilityFile,
            context: { projectRoot, controlRoot, nodeInstanceId: options.nodeInstanceId },
        });
        if (runtimeStrategy !== 'artifact-runtime-v2') throw new Error('Host-bound update capability is absent or invalid.');
        const runner = resolveUpdateRuntimeEntry(options.artifactRoot, 'scripts/source-update-candidate.mjs');
        return Object.freeze({
            ready: true, protocol: 2, strategy: 'release-layout-v2', runtimeStrategy,
            deployRoot, releasesRoot, controlRoot, current, previous, lastGood, runner,
            projectRootRealpathHash: sha(projectRoot), controlDevice: statSync(controlRoot).dev,
        });
    } catch (error) {
        return Object.freeze({ ready: false, code: 'release_layout_not_ready', reason: error.message });
    }
}

export function requireReleaseLayout(options) {
    const status = inspectReleaseLayout(options);
    if (!status.ready) {
        const error = new Error(status.code);
        error.code = status.code;
        error.details = status;
        throw error;
    }
    return status;
}
