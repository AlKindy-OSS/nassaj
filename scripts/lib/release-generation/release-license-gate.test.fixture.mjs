/**
 * Throwaway project trees for the license-gate tests: a package.json, a
 * lockfile, installed packages and the two policy files, all under a fresh
 * directory in the test scratch TMPDIR (disk, never tmpfs, when run via
 * `npm run test:scripts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MIT_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge (fixture text).\n';
export const MIT_SHA = createHash('sha256').update(MIT_TEXT).digest('hex');
/** A well-formed lockfile integrity for fixture entries (identifies no real tarball). */
export const FIXTURE_SRI = `sha512-${'A'.repeat(86)}==`;

/** Make a fresh scratch directory; caller removes it. */
export function scratchDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'license-gate-'));
}

/** Write `content` (string, Buffer or JSON value) to root/relative, creating parents. */
export function put(root, relative, content) {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`;
    fs.writeFileSync(file, bytes);
    return file;
}

/** Exclusion policy document with the Claude SDK family. */
export function exclusionsDoc(extra = {}) {
    return {
        schema: 'nassaj-release-exclusions/v1',
        packages: [
            { name: '@anthropic-ai/claude-agent-sdk', reason: 'proprietary' },
            { name: '@anthropic-ai/claude-agent-sdk-linux-x64', reason: 'proprietary' },
            { name: '@openai/codex-linux-x64', reason: 'binary' },
        ],
        familyPatterns: [
            { pattern: '^@anthropic-ai/claude-agent-sdk(-[a-z0-9-]+)?$', reason: 'family' },
            { pattern: '^@openai/codex-(?!sdk$)[a-z0-9-]+$', reason: 'family' },
        ],
        ...extra,
    };
}

/** License policy document; texts point at release-license-texts/MIT.txt. */
export function policyDoc(extra = {}) {
    return {
        schema: 'nassaj-release-license-policy/v1',
        allowed: ['MIT', 'ISC', 'Apache-2.0', 'MPL-2.0'],
        denied: ['GPL-3.0-only'],
        texts: [{ id: 'MIT', file: 'release-license-texts/MIT.txt', sha256: MIT_SHA, source: 'https://example.test/MIT.txt' }],
        overrides: [],
        ...extra,
    };
}

/**
 * Build a project. `packages` maps lockfile path → { lock, manifest, files }:
 * `lock` = lockfile entry, `manifest` = installed package.json (omit to leave
 * it uninstalled), `files` = extra files in the package dir.
 */
export function buildProject(root, { packages = {}, rootManifest, policy = policyDoc(), exclusions = exclusionsDoc() } = {}) {
    put(root, 'package.json', rootManifest ?? { name: 'app', version: '1.0.0', scripts: {} });
    const lockPackages = { '': { name: 'app', version: '1.0.0' } };
    for (const [lockPath, spec] of Object.entries(packages)) {
        lockPackages[lockPath] = spec.lock;
        if (spec.manifest) put(root, `${lockPath}/package.json`, spec.manifest);
        for (const [name, content] of Object.entries(spec.files ?? {})) put(root, `${lockPath}/${name}`, content);
    }
    put(root, 'package-lock.json', { name: 'app', lockfileVersion: 3, packages: lockPackages });
    put(root, 'scripts/release-license-texts/MIT.txt', MIT_TEXT);
    put(root, 'scripts/release-license-allowlist.json', policy);
    put(root, 'scripts/release-excluded-packages.json', exclusions);
    return root;
}

/** A normal MIT package spec with a LICENSE file. */
export function mitPackage(name, version = '1.0.0', lockExtra = {}, manifestExtra = {}) {
    return {
        lock: { version, resolved: `https://registry.npmjs.org/${name}/-/x-${version}.tgz`, integrity: FIXTURE_SRI,
            license: 'MIT', ...lockExtra },
        manifest: { name, version, license: 'MIT', ...manifestExtra },
        files: { LICENSE: `MIT License\n\nCopyright (c) ${name}\n` },
    };
}
