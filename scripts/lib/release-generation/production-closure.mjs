/**
 * Production dependency closure and exclusion checks for a release
 * generation (ADR-174 §6.2, §16 P1 exits 9 and 11).
 *
 * The closure is read from package-lock.json exactly as `npm ci --omit=dev`
 * would install it for one release target: every non-dev entry, minus
 * optional entries whose os/cpu/libc do not match the target, minus the
 * public exclusion list (`scripts/release-excluded-packages.json`). The
 * installed tree is then held to that closure, so the notices and the
 * license gate describe exactly what ships. Every non-dev, non-link entry
 * must carry an SRI `integrity` and resolve on registry.npmjs.org (exit 11).
 */
import fs from 'node:fs';
import path from 'node:path';
import { NPM_REGISTRY_ORIGIN, RELEASE_TARGETS } from './release-manifest.mjs';
import { assertShape, shape } from './strict-shape.mjs';
import { failRelease } from './release-manifest-codes.mjs';
import { GATE_CODES as CODES, GATE_WARNINGS as WARNINGS, compareText, finding } from './release-gate-findings.mjs';

export const EXCLUSIONS_SCHEMA = 'nassaj-release-exclusions/v1';

const TARGET_PLATFORMS = Object.freeze({
    'linux-x64-glibc': Object.freeze({ os: 'linux', cpu: 'x64', libc: 'glibc' }),
    'linux-arm64-glibc': Object.freeze({ os: 'linux', cpu: 'arm64', libc: 'glibc' }),
});
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SCOPED_TOKEN = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi;
const LIFECYCLE_HOOKS = Object.freeze(['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']);
const SCRIPT_FILE_REF = /(?:^|[\s;&|(])(?:node|bash|sh)\s+(?:--?[\w-]+\s+)*([^\s;&|()'"]+)/g;
const SRI_TOKEN = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

const EXCLUSIONS_SHAPE = shape.object({
    schema: shape.oneOf([EXCLUSIONS_SCHEMA]),
    packages: shape.array(shape.object({
        name: shape.string(NPM_NAME, 214),
        reason: shape.string(null, 512),
    }), { min: 1, max: 128, key: entry => entry.name }),
    familyPatterns: shape.array(shape.object({
        pattern: shape.string(/^\^.*\$$/, 256),
        reason: shape.string(null, 512),
    }), { max: 32, key: entry => entry.pattern }),
});

/**
 * Validate and compile the exclusion policy.
 * @param {unknown} document parsed `release-excluded-packages.json`
 * @returns {{names: Set<string>, families: RegExp[], isExcluded: (name: string) => boolean,
 *   isListed: (name: string) => boolean}}
 */
export function loadExclusionPolicy(document) {
    assertShape(EXCLUSIONS_SHAPE, document, 'exclusions', CODES.POLICY_INVALID);
    const names = new Set(document.packages.map(entry => entry.name));
    const families = document.familyPatterns.map(entry => {
        try { return new RegExp(entry.pattern); } catch {
            return failRelease(CODES.POLICY_INVALID, 'exclusions.familyPatterns has an invalid pattern');
        }
    });
    for (const name of names) {
        if (families.length && !families.some(family => family.test(name))) {
            failRelease(CODES.POLICY_INVALID, `excluded package ${name} matches no family pattern`);
        }
    }
    return Object.freeze({
        names,
        families,
        isListed: name => names.has(name),
        isExcluded: name => names.has(name) || families.some(family => family.test(name)),
    });
}

/** Platform triple for a release target. */
export function targetPlatform(target) {
    if (!RELEASE_TARGETS.includes(target) || !Object.hasOwn(TARGET_PLATFORMS, target)) {
        failRelease(CODES.LOCKFILE_UNSUPPORTED, `unknown release target ${target}`);
    }
    return TARGET_PLATFORMS[target];
}

/**
 * npm os/cpu/libc matching: `!x` entries deny, plain entries allow-list.
 * @param {object} entry lockfile package entry
 * @param {{os: string, cpu: string, libc: string}} platform
 */
export function platformMatches(entry, platform) {
    return ['os', 'cpu', 'libc'].every(field => {
        const list = entry[field];
        if (!Array.isArray(list) || list.length === 0) return true;
        const denied = list.filter(item => item.startsWith('!')).map(item => item.slice(1));
        const allowed = list.filter(item => !item.startsWith('!'));
        if (denied.includes(platform[field])) return false;
        return allowed.length === 0 || allowed.includes(platform[field]);
    });
}

/** Package name for a lockfile path such as `node_modules/a/node_modules/@s/b`. */
export function packageNameFromPath(lockPath) {
    const marker = lockPath.lastIndexOf('node_modules/');
    return marker === -1 ? lockPath : lockPath.slice(marker + 'node_modules/'.length);
}

function describeEntry(lockPath, entry) {
    const installName = packageNameFromPath(lockPath);
    return Object.freeze({
        path: lockPath,
        installName,
        name: typeof entry.name === 'string' ? entry.name : installName,
        version: entry.version,
        license: entry.license,
        resolved: entry.resolved,
        integrity: entry.integrity,
        entry,
    });
}

function assertLockfile(lock) {
    const supported = lock && (lock.lockfileVersion === 2 || lock.lockfileVersion === 3);
    if (!supported || !lock.packages || typeof lock.packages !== 'object') {
        failRelease(CODES.LOCKFILE_UNSUPPORTED, 'package-lock.json must be lockfileVersion 2 or 3 with "packages"');
    }
}

/**
 * Compute the shipped closure for one target.
 * @param {object} lock parsed package-lock.json
 * @param {{target: string, exclusions: ReturnType<typeof loadExclusionPolicy>}} options
 * @returns {{target: string, shipped: object[], excluded: object[], skipped: object[],
 *   findings: object[], warnings: object[]}}
 */
export function computeShippedClosure(lock, { target, exclusions }) {
    assertLockfile(lock);
    const platform = targetPlatform(target);
    const result = { target, shipped: [], excluded: [], skipped: [], findings: [], warnings: [] };
    const paths = Object.keys(lock.packages).filter(key => key !== '').sort(compareText);
    for (const lockPath of paths) classifyEntry(result, describeEntry(lockPath, lock.packages[lockPath]), platform, exclusions);
    result.findings.push(...requiredExclusionFindings(result.shipped, exclusions));
    result.warnings.push(...absentExclusionWarnings(lock, exclusions));
    return result;
}

function classifyEntry(result, pkg, platform, exclusions) {
    const { entry } = pkg;
    if (entry.dev === true) return;
    if (entry.link || entry.inBundle || !pkg.path.includes('node_modules/')) {
        result.findings.push(finding(CODES.LOCKFILE_UNSUPPORTED, pkg.path, 'linked, bundled or workspace entry'));
        return;
    }
    result.findings.push(...registryFindings(pkg));
    // npm aliases (`"x": "npm:real@v"`) install under `x`: both names are checked.
    if (exclusions.isExcluded(pkg.installName) || exclusions.isExcluded(pkg.name)) {
        if (!exclusions.isListed(pkg.installName)) {
            result.findings.push(finding(CODES.EXCLUDED_FAMILY_UNLISTED, pkg.path,
                `${pkg.installName} matches an excluded family but is not in the exact exclusion list`));
        }
        result.excluded.push(Object.freeze({ ...pkg, forTarget: platformMatches(entry, platform) }));
        return;
    }
    if (!platformMatches(entry, platform)) {
        if (entry.optional === true || entry.devOptional === true) { result.skipped.push(pkg); return; }
        result.findings.push(finding(CODES.PLATFORM_REQUIRED_MISMATCH, pkg.path,
            'non-optional package does not support this target'));
        return;
    }
    result.shipped.push(pkg);
}

/**
 * Exit 11 (second clause): the entry is pinned by an SRI integrity and was
 * resolved from the public npm registry (no git, file, tarball-URL or mirror).
 * @param {{path: string, integrity: unknown, resolved: unknown}} pkg
 * @returns {object[]} findings
 */
export function registryFindings(pkg) {
    const out = [];
    const tokens = typeof pkg.integrity === 'string' ? pkg.integrity.trim().split(/\s+/) : [];
    if (!tokens.length || !tokens.every(token => SRI_TOKEN.test(token))) {
        out.push(finding(CODES.LOCKFILE_INTEGRITY_MISSING, pkg.path, 'lockfile entry has no SRI integrity'));
    }
    if (!isRegistryUrl(pkg.resolved)) {
        out.push(finding(CODES.LOCKFILE_RESOLVED_OFF_REGISTRY, pkg.path, 'lockfile entry does not resolve on the npm registry'));
    }
    return out;
}

function isRegistryUrl(value) {
    if (typeof value !== 'string' || !value.startsWith(`${NPM_REGISTRY_ORIGIN}/`)) return false;
    try {
        const url = new URL(value);
        return url.origin === NPM_REGISTRY_ORIGIN && !url.username && !url.password && !url.search && !url.hash;
    } catch {
        return false;
    }
}

function requiredExclusionFindings(shipped, exclusions) {
    const out = [];
    for (const pkg of shipped) {
        const optionalPeers = pkg.entry.peerDependenciesMeta ?? {};
        const peers = Object.keys(pkg.entry.peerDependencies ?? {}).filter(name => !optionalPeers[name]?.optional);
        const required = [...Object.keys(pkg.entry.dependencies ?? {}), ...peers];
        for (const name of required.filter(exclusions.isExcluded).sort(compareText)) {
            out.push(finding(CODES.EXCLUDED_PACKAGE_REQUIRED, pkg.path, `requires excluded package ${name}`));
        }
    }
    return out;
}

function absentExclusionWarnings(lock, exclusions) {
    const present = new Set(Object.entries(lock.packages)
        .filter(([key]) => key !== '')
        .map(([key]) => packageNameFromPath(key)));
    return [...exclusions.names].filter(name => !present.has(name)).sort(compareText)
        .map(name => finding(WARNINGS.EXCLUSION_ABSENT, name, 'excluded package is not in the lockfile'));
}

/**
 * List every installed package directory under `rootDir` as lockfile-style
 * paths (`node_modules/x`, `node_modules/x/node_modules/@s/y`). Symlinked
 * entries are listed but not followed.
 * @param {string} rootDir directory that holds the top-level node_modules
 * @returns {string[]} sorted paths
 */
export function listInstalledPackagePaths(rootDir) {
    const out = [];
    const walk = (dir, prefix) => {
        const modules = path.join(dir, 'node_modules');
        for (const [name, dirent] of readPackageEntries(modules)) {
            const lockPath = `${prefix}node_modules/${name}`;
            out.push(lockPath);
            if (!dirent.isSymbolicLink()) walk(path.join(modules, name), `${lockPath}/`);
        }
    };
    walk(rootDir, '');
    return out.sort(compareText);
}

function readPackageEntries(modulesDir) {
    const visible = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
        .filter(dirent => !dirent.name.startsWith('.') && (dirent.isDirectory() || dirent.isSymbolicLink()));
    const entries = [];
    for (const dirent of visible(modulesDir)) {
        if (!dirent.name.startsWith('@')) { entries.push([dirent.name, dirent]); continue; }
        for (const child of visible(path.join(modulesDir, dirent.name))) entries.push([`${dirent.name}/${child.name}`, child]);
    }
    return entries;
}

/**
 * Hold an installed tree to the computed closure: an excluded package on disk
 * is `excluded_package_shipped`; any other package outside the closure is
 * `tree_package_unexpected` (its license would otherwise go unreviewed).
 * @param {string[]} treePaths output of listInstalledPackagePaths
 * @param {ReturnType<typeof computeShippedClosure>} closure
 * @param {ReturnType<typeof loadExclusionPolicy>} exclusions
 */
export function compareTreeToClosure(treePaths, closure, exclusions) {
    const shipped = new Set(closure.shipped.map(pkg => pkg.path));
    const out = [];
    for (const treePath of treePaths) {
        if (exclusions.isExcluded(packageNameFromPath(treePath))) {
            out.push(finding(CODES.EXCLUDED_PACKAGE_SHIPPED, treePath, 'excluded package present in the shipped tree'));
        } else if (!shipped.has(treePath)) {
            out.push(finding(CODES.TREE_PACKAGE_UNEXPECTED, treePath, 'installed package is not in the computed closure'));
        }
    }
    return out;
}

/**
 * Exit 9 for archive file lists: any file under `node_modules/<excluded>/`
 * at any depth is `excluded_package_shipped` (one finding per package dir).
 * @param {Iterable<string>} relativePaths archive member paths ('/' separated)
 * @param {ReturnType<typeof loadExclusionPolicy>} exclusions
 */
export function excludedFileFindings(relativePaths, exclusions) {
    const hits = new Set();
    for (const filePath of relativePaths) {
        const parts = filePath.split('/');
        for (let index = 0; index < parts.length - 1; index += 1) {
            if (parts[index] !== 'node_modules') continue;
            const scoped = parts[index + 1].startsWith('@') && index + 2 < parts.length;
            const name = scoped ? `${parts[index + 1]}/${parts[index + 2]}` : parts[index + 1];
            if (exclusions.isExcluded(name)) hits.add(`${parts.slice(0, index + 1).join('/')}/${name}`);
        }
    }
    return [...hits].sort(compareText)
        .map(dir => finding(CODES.EXCLUDED_PACKAGE_SHIPPED, dir, 'archive contains files of an excluded package'));
}

/**
 * Root lifecycle scripts plus every local file they run with node/bash/sh.
 * @param {string} rootDir project root
 * @returns {{source: string, text: string}[]}
 */
export function collectLifecycleScriptSources(rootDir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const sources = [];
    const seen = new Set();
    for (const hook of LIFECYCLE_HOOKS) {
        const command = manifest.scripts?.[hook];
        if (typeof command !== 'string') continue;
        sources.push({ source: `package.json#scripts.${hook}`, text: command });
        for (const match of command.matchAll(SCRIPT_FILE_REF)) {
            const file = path.resolve(rootDir, match[1]);
            const inside = file.startsWith(`${path.resolve(rootDir)}${path.sep}`);
            if (!inside || seen.has(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
            seen.add(file);
            sources.push({ source: path.relative(rootDir, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') });
        }
    }
    return sources;
}

/**
 * Exit 11 (first clause): no install/patch script may name an excluded
 * package (the SDK binaries must stay unmodified, §6.2).
 * @param {{source: string, text: string}[]} sources
 * @param {ReturnType<typeof loadExclusionPolicy>} exclusions
 */
export function excludedScriptReferenceFindings(sources, exclusions) {
    const out = [];
    for (const { source, text } of sources) {
        const names = new Set([...text.matchAll(SCOPED_TOKEN)]
            .map(match => match[0].toLowerCase().replace(/[._-]+$/, '')));
        for (const name of [...names].filter(exclusions.isExcluded).sort(compareText)) {
            out.push(finding(CODES.EXCLUDED_REFERENCE_IN_SCRIPT, source, `references excluded package ${name}`));
        }
    }
    return out;
}
