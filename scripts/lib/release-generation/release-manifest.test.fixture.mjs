/**
 * Synthetic manifest fixtures for the release-generation tests. Values are
 * shaped like ADR-174 §7.3 but identify no real release.
 */
export const digest = character => character.repeat(64);
export const SRI = `sha512-${'A'.repeat(86)}==`;

/**
 * A valid manifest; `overrides` are shallow-merged at the top level.
 * @param {object} [overrides]
 * @returns {object}
 */
export function manifestFixture(overrides = {}) {
    const version = overrides.version ?? '2.4.0.1';
    return {
        schema: 'nassaj-release-manifest/v1',
        channel: 'stable',
        version,
        releaseSequence: 10,
        minUpgradeFrom: '2.4.0.0',
        minVerifierVersion: 1,
        minShimVersion: 1,
        source: {
            repository: 'Example-OSS/nassaj',
            repositoryId: '123456789',
            commit: 'a'.repeat(40),
            ref: `refs/tags/v${version}`,
            workflowPath: '.github/workflows/release-generation.yml',
            buildScript: { path: 'scripts/build-release-generation.mjs', sha256: digest('b') },
        },
        targets: [{
            target: 'linux-x64-glibc',
            glibcFloor: '2.34',
            node: { version: '24.15.0', sha256: digest('c') },
            archive: { name: `nassaj-${version}-linux-x64-glibc.tar.zst`, size: 1000, sha256: digest('d') },
            fileManifestSha256: digest('e'),
        }],
        installer: { name: 'nassaj-install.mjs', size: 200, sha256: digest('f') },
        externalPackages: [{
            name: '@anthropic-ai/claude-agent-sdk',
            version: '0.3.283',
            integrity: SRI,
            tarballUrl: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.283.tgz',
            installPath: 'node_modules/@anthropic-ai/claude-agent-sdk',
        }],
        sigstoreTrustedRootSha256: digest('1'),
        revokedVersions: ['2.3.0.9'],
        database: { migrationClass: 'compatible', readableBy: ['2.4.0.0'] },
        ...overrides,
    };
}
