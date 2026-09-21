/** Manifest-bound host contract for immutable Nassaj release runtimes. */
export const RELEASE_RUNTIME_COMPATIBILITY_SCHEMA = 'nassaj-release-runtime/v1';
export const RELEASE_RUNTIME_COMPATIBILITY = Object.freeze({
    schema: RELEASE_RUNTIME_COMPATIBILITY_SCHEMA,
    platform: 'linux',
    arch: 'x64',
    libc: Object.freeze({ family: 'glibc', minimum: '2.39' }),
    node: Object.freeze({ major: 24, modules: 137 }),
});

function versionTuple(value) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value)) return null;
    return value.split('.').map(Number);
}

function atLeast(actual, minimum) {
    const left = versionTuple(actual); const right = versionTuple(minimum);
    if (!left || !right) return false;
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] || 0) - (right[index] || 0);
        if (difference) return difference > 0;
    }
    return true;
}

/** Reject unknown or weakened compatibility contracts before considering host facts. */
export function validateReleaseRuntimeCompatibility(value) {
    if (value?.schema !== RELEASE_RUNTIME_COMPATIBILITY_SCHEMA
        || value.platform !== RELEASE_RUNTIME_COMPATIBILITY.platform
        || value.arch !== RELEASE_RUNTIME_COMPATIBILITY.arch
        || value.libc?.family !== RELEASE_RUNTIME_COMPATIBILITY.libc.family
        || value.libc?.minimum !== RELEASE_RUNTIME_COMPATIBILITY.libc.minimum
        || value.node?.major !== RELEASE_RUNTIME_COMPATIBILITY.node.major
        || value.node?.modules !== RELEASE_RUNTIME_COMPATIBILITY.node.modules
        || Object.keys(value).sort().join(',') !== 'arch,libc,node,platform,schema'
        || Object.keys(value.libc).sort().join(',') !== 'family,minimum'
        || Object.keys(value.node).sort().join(',') !== 'major,modules') {
        throw new Error('Release runtime compatibility contract is invalid.');
    }
    return true;
}

/** Detect only facts that are stable and relevant to native production dependencies. */
export function detectReleaseRuntimeHost(injected = {}) {
    const versions = injected.versions || process.versions;
    const report = injected.report || process.report?.getReport?.();
    return Object.freeze({
        platform: injected.platform || process.platform,
        arch: injected.arch || process.arch,
        libc: report?.header?.glibcVersionRuntime || null,
        nodeMajor: Number.parseInt(versions.node, 10),
        nodeModules: Number.parseInt(versions.modules, 10),
    });
}

/** Verify the running Node/native ABI can load this exact immutable release. */
export function verifyReleaseRuntimeHost(contract, host = detectReleaseRuntimeHost()) {
    validateReleaseRuntimeCompatibility(contract);
    const mismatches = [];
    if (host.platform !== contract.platform) mismatches.push(`platform:${host.platform || 'unknown'}`);
    if (host.arch !== contract.arch) mismatches.push(`arch:${host.arch || 'unknown'}`);
    if (!atLeast(host.libc, contract.libc.minimum)) mismatches.push(`glibc:${host.libc || 'unknown'}`);
    if (host.nodeMajor !== contract.node.major) mismatches.push(`node:${host.nodeMajor || 'unknown'}`);
    if (host.nodeModules !== contract.node.modules) mismatches.push(`abi:${host.nodeModules || 'unknown'}`);
    if (mismatches.length) {
        const error = new Error(`Release runtime is incompatible with this host (${mismatches.join(', ')}).`);
        error.code = 'release_runtime_incompatible';
        error.mismatches = mismatches;
        throw error;
    }
    return true;
}
