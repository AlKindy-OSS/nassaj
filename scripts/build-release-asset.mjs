#!/usr/bin/env node
/** Build one deterministic GitHub release runtime archive from already-built artefacts. */
import { LOCAL_BUILD_KIND, LOCAL_MANIFEST_SCHEMA, validateLocalBuildCore, localBuildIdentitySha256 } from './lib/local-reviewed-build-identity.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
    readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { satisfies as versionSatisfies } from 'semver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    compareReleasePaths, computeReleaseFileTreeSha256, currentReleaseRuntimeTarget, extractTarGzExact,
    RELEASE_ASSET_LIMITS, verifyExtractedReleaseAsset, FORWARD_EXECUTABLE_MANIFEST_PATH,
} from './lib/update-release-asset.mjs';
import {
    RELEASE_RUNTIME_COMPATIBILITY, verifyReleaseRuntimeHost,
} from './lib/release-runtime-compatibility.mjs';
import { verifyUpdateRuntimeBundle, FORWARD_EXECUTABLE_ENTRIES } from './lib/update-runtime-bundle.mjs';
import { verifyCodexSdkImageOnlySync } from './patch-codex-sdk-image-only.mjs';
import { verifyServerArtefact } from './server-build-atomic.mjs';
import { CLIENT_SOURCE_ENTRIES, verifyBuildIdentity } from './client-build-atomic.mjs';
import { createMeasuredPermissionReleaseContract } from './lib/permission-release-contract.mjs';
import { bindMigrationClosureToAsset, collectMigrationClosure } from './lib/release-database-migration-closure.mjs';
import { generateLegacy144AcceptedPredecessors } from './lib/legacy-144-database-fixture.mjs';

import { FORWARD_PROFILE_ID, collectForwardStartupMaterial, verifyForwardStartupMaterial,
    observeForwardProfile, createForwardDatabaseContract, canonicalForward, forwardSha256 } from './lib/compatible-forward-release-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA40 = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const ALLOWED_COMPUTED_IMPORT_EXPRESSIONS = new Map([
    // The release builder moves the compiled application to application.js and
    // copies this reviewed bootstrap wrapper to the legacy PM2 entry index.js.
    ['server/index.js', new Set(['applicationModule'])],
    ['server/bootstrap.js', new Set(['applicationModule'])],
    ['scripts/client-isolated-publish.mjs', new Set([
        "`${pathToFileURL(path.join(sourceRoot, 'scripts', 'client-build-atomic.mjs')).href}?source=${oid}`",
    ])],
    ['UPDATE_RUNTIME_BUNDLE/scripts/client-isolated-publish.mjs', new Set([
        "`${pathToFileURL(path.join(sourceRoot, 'scripts', 'client-build-atomic.mjs')).href}?source=${oid}`",
    ])],
    // OID contracts are resolved only from a verified immutable snapshot. Both
    // build modules are also scanned as literal files in this runtime bundle.
    ...['scripts/', 'UPDATE_RUNTIME_BUNDLE/scripts/'].flatMap(prefix => [
        [`${prefix}preview-oid-consumer.mjs`, new Set([
            "pathToFileURL(path.join(PUBLICATION_BOOT.bundleRoot, 'scripts/lib/client-publication-executor.mjs')).href",
        ])],
        [`${prefix}server-preview-from-oid.mjs`, new Set([
            "`${pathToFileURL(path.join(sourceRoot, 'scripts', 'server-build-atomic.mjs')).href}?oid=${oid}`",
        ])],
        [`${prefix}client-preview-from-oid.mjs`, new Set([
            "`${pathToFileURL(path.join(options.sourceRoot, 'scripts', 'client-build-atomic.mjs')).href}?oid=${oid}`",
            "`${pathToFileURL(path.join(sourceRoot, 'scripts', 'client-build-atomic.mjs')).href}?promote=${oid}`",
        ])],
        // The launcher pins capsule bytes to the loaded manifest; the capsule
        // closure verifier permits only static Node builtins, no npm packages.
        [`${prefix}preview-oid-capsule-launcher.mjs`, new Set([
            "`data:text/javascript;base64,${capsule.toString('base64')}`",
        ])],
    ]),
]);
export const REQUIRED_RELEASE_RUNTIME_PACKAGES = Object.freeze([
    '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@vscode/ripgrep',
    'argon2', 'bcrypt', 'better-sqlite3', 'node-pty',
]);
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const DATABASE_PRESERVATION_POLICY_SHA256 = sha(Buffer.from(JSON.stringify({ schema: 'nassaj-database-preservation-policy/v1',
    exact: ['users', 'projects', 'sessions', 'credentials', 'credentialIdentityDigest'],
    transform: ['plaintext-credential->authenticated-envelope', 'plaintext-api-key->sha256-digest+prefix'],
    derived: ['migration-markers-monotonic'],
    markerAllowlist: ['participants_backfill_completed_at', 'participants_ownership_repaired_at',
        'source_update_v1_migration_completed_at', 'migration.session_workspace_modes.snapshot.v1',
        'user_credentials_encrypted_at'], allowedDerivedFields: { users: ['password_changed_at'] } })));
function value(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }

function slash(value) { return value.split(path.sep).join('/'); }
function inside(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

function packageNameFromSpecifier(specifier) {
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')
        || specifier.startsWith('node:') || isBuiltin(specifier)) return null;
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    return PACKAGE.test(name) ? name : null;
}

const CLIENT_TOOLCHAIN_CONFIG_ENTRIES = Object.freeze([
    'vite.config.js', 'postcss.config.js', 'tailwind.config.js',
]);

function literalPropertyName(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    return null;
}

function postcssPluginPackageRoots(ast, relative) {
    const roots = [];
    const assignment = ast.statements.find((node) => ts.isExportAssignment(node));
    const config = assignment?.expression;
    if (!config || !ts.isObjectLiteralExpression(config)) {
        throw new Error(`Client toolchain config must export one literal object: ${relative}`);
    }
    const plugins = config.properties.find((property) => ts.isPropertyAssignment(property)
        && literalPropertyName(property.name) === 'plugins');
    if (!plugins || !ts.isObjectLiteralExpression(plugins.initializer)) {
        throw new Error(`Client PostCSS plugins must be one literal object: ${relative}`);
    }
    for (const property of plugins.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
            throw new Error(`Client PostCSS plugin must be a literal package root: ${relative}`);
        }
        const name = packageNameFromSpecifier(literalPropertyName(property.name));
        if (!name) throw new Error(`Client PostCSS plugin package root is invalid: ${relative}`);
        roots.push(name);
    }
    return roots;
}

/** Derive every shipped client-build toolchain root from reviewed literal configuration. */
export function clientToolchainPackageRoots(sourceRoot = ROOT) {
    const root = realpathSync(sourceRoot);
    const roots = new Set(['postcss']);
    for (const relative of CLIENT_TOOLCHAIN_CONFIG_ENTRIES) {
        if (!CLIENT_SOURCE_ENTRIES.includes(relative)) {
            throw new Error(`Client toolchain config is not a shipped client source entry: ${relative}`);
        }
        const absolute = path.join(root, relative);
        const metadata = lstatSync(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink() || !inside(root, realpathSync(absolute))) {
            throw new Error(`Client toolchain config is unsafe: ${relative}`);
        }
        const ast = ts.createSourceFile(relative, readFileSync(absolute, 'utf8'),
            ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const requireNames = new Set(['require']);
        const visit = (node) => {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
                && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
                && node.initializer.expression.text === 'createRequire') requireNames.add(node.name.text);
            let specifier = null;
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
                && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
            if (ts.isCallExpression(node)) {
                const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword
                    || (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text));
                if (loader && (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))) {
                    throw new Error(`Client toolchain config contains a computed import: ${relative}`);
                }
                if (loader) specifier = node.arguments[0].text;
            }
            const packageName = packageNameFromSpecifier(specifier);
            if (packageName) roots.add(packageName);
            ts.forEachChild(node, visit);
        };
        visit(ast);
        if (relative === 'postcss.config.js') {
            for (const name of postcssPluginPackageRoots(ast, relative)) roots.add(name);
        }
    }
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const name of roots) {
        if (typeof manifest.dependencies?.[name] !== 'string') {
            throw new Error(`Client toolchain root is not a direct production dependency: ${name}`);
        }
    }
    return [...roots].sort(compareReleasePaths);
}

/** Extract literal external imports from the compiled server; computed imports fail closed via explicit roots below. */
export function serverRuntimePackageRoots(serverArtifact) {
    const packages = new Set();
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile() && /\.[cm]?js$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
                && !slash(path.relative(serverArtifact, absolute)).split('/').some((part) => ['tests', '__tests__'].includes(part))) {
                const source = readFileSync(absolute, 'utf8');
                const relative = slash(path.relative(serverArtifact, absolute));
                const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                const requireNames = new Set(['require']);
                const visit = (node) => {
                    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
                        && ts.isCallExpression(node.initializer)
                        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'createRequire') {
                        requireNames.add(node.name.text);
                    }
                    let specifier = null;
                    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
                        && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
                    if (ts.isCallExpression(node)) {
                        const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword
                            || (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text));
                        if (loader) {
                            if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
                                const expression = node.arguments.length === 1 ? node.arguments[0].getText(ast) : null;
                                if (!expression || !ALLOWED_COMPUTED_IMPORT_EXPRESSIONS.get(relative)?.has(expression)) {
                                    throw new Error(`Release runtime contains an unapproved computed import: ${relative}`);
                                }
                            } else specifier = node.arguments[0].text;
                        }
                    }
                    const packageName = packageNameFromSpecifier(specifier);
                    if (packageName) packages.add(packageName);
                    ts.forEachChild(node, visit);
                };
                visit(ast);
            }
        }
    };
    walk(serverArtifact);
    return [...packages].sort(compareReleasePaths);
}

function resolveInstalledPackage(nodeModulesRoot, name, fromDirectory, optional = false) {
    let cursor = fromDirectory;
    for (;;) {
        const candidate = path.join(cursor, 'node_modules', ...name.split('/'));
        if (existsRegularPackage(candidate)) return realpathSync(candidate);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    const topLevel = path.join(nodeModulesRoot, ...name.split('/'));
    if (existsRegularPackage(topLevel)) return realpathSync(topLevel);
    if (optional) return null;
    throw new Error(`Release runtime dependency is not installed: ${name}`);
}

function existsRegularPackage(directory) {
    try {
        const metadata = lstatSync(directory);
        const manifest = lstatSync(path.join(directory, 'package.json'));
        return metadata.isDirectory() && !metadata.isSymbolicLink()
            && manifest.isFile() && !manifest.isSymbolicLink();
    } catch { return false; }
}

/** Resolve the installed transitive production/optional/required-peer closure. */
function platformAllowed(values, current) {
    if (!Array.isArray(values) || values.length === 0) return true;
    if (values.includes(`!${current}`)) return false;
    const positives = values.filter((value) => !value.startsWith('!'));
    return positives.length === 0 || positives.includes(current);
}

function executableLooksNative(absolute, metadata) {
    if (!(metadata.mode & 0o111)) return false;
    const bytes = readFileSync(absolute).subarray(0, 4);
    return (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
        || (bytes[0] === 0x4d && bytes[1] === 0x5a)
        || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(bytes.toString('hex'));
}

function packageContainsNativeCode(directory) {
    const queue = [directory];
    while (queue.length) {
        const current = queue.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) queue.push(absolute);
            else if (entry.isFile()) {
                const metadata = lstatSync(absolute);
                if (entry.name.endsWith('.node') || ['claude', 'codex', 'rg'].includes(entry.name)
                    || executableLooksNative(absolute, metadata)) return true;
            }
        }
    }
    return false;
}

function nativePackageAllowed(name) {
    return ['esbuild', '@openai/codex'].includes(name) || REQUIRED_RELEASE_RUNTIME_PACKAGES.includes(name)
        || /^@(?:anthropic-ai\/claude-agent-sdk|openai\/codex)-/.test(name)
        || /^@vscode\/ripgrep(?:-|$)/.test(name)
        || /^@(?:esbuild|rollup)\//.test(name)
        // sharp (chat image downscaling, T-1667) ships its libvips binding as platform packages.
        || name === 'sharp' || /^@img\/sharp-/.test(name);
}

export function resolveRuntimeDependencyClosure(nodeModulesDirectory, roots, packageLockFile) {
    const nodeModulesRoot = realpathSync(nodeModulesDirectory);
    const lockPath = packageLockFile || path.join(path.dirname(nodeModulesRoot), 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') {
        throw new Error('Release runtime package-lock is invalid.');
    }
    const queue = roots.map((name) => ({ name, from: path.dirname(nodeModulesRoot), optional: false }));
    const packages = new Map();
    while (queue.length) {
        const request = queue.shift();
        const directory = resolveInstalledPackage(nodeModulesRoot, request.name, request.from, request.optional);
        if (!directory || packages.has(directory)) continue;
        if (!inside(nodeModulesRoot, directory)) throw new Error('Release runtime dependency escapes node_modules.');
        const bytes = readFileSync(path.join(directory, 'package.json'));
        const manifest = JSON.parse(bytes);
        if (!PACKAGE.test(manifest.name || '') || typeof manifest.version !== 'string' || !manifest.version) {
            throw new Error(`Release runtime dependency identity mismatch: ${request.name}`);
        }
        const packagePath = slash(path.join('node_modules', path.relative(nodeModulesRoot, directory)));
        const locked = lock.packages[packagePath];
        if (!locked || locked.version !== manifest.version || (locked.name && locked.name !== manifest.name)
            || !INTEGRITY.test(locked.integrity || '')) throw new Error(`Release runtime lock mismatch: ${request.name}`);
        const libc = process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
        if (!platformAllowed(manifest.os || locked.os, process.platform)
            || !platformAllowed(manifest.cpu || locked.cpu, process.arch)
            || !platformAllowed(manifest.libc || locked.libc, libc)) throw new Error(`Release runtime ABI mismatch: ${request.name}`);
        const enginesNode = manifest.engines?.node || locked.engines?.node || null;
        if (enginesNode && !versionSatisfies(process.version, enginesNode, { includePrerelease: true })) {
            throw new Error(`Release runtime Node engine mismatch: ${request.name}`);
        }
        const native = packageContainsNativeCode(directory);
        if (native && (!nativePackageAllowed(request.name) || !nativePackageAllowed(manifest.name))) {
            throw new Error(`Release runtime native package is not allowlisted: ${request.name} -> ${manifest.name}`);
        }
        packages.set(directory, {
            path: packagePath, name: request.name, resolvedName: manifest.name, version: manifest.version,
            integrity: locked.integrity, enginesNode,
            os: manifest.os || locked.os || null, cpu: manifest.cpu || locked.cpu || null,
            libc: manifest.libc || locked.libc || null, native,
            packageJsonSha256: sha(bytes), directory,
        });
        for (const name of Object.keys(manifest.dependencies || {})) queue.push({ name, from: directory, optional: false });
        for (const name of Object.keys(manifest.optionalDependencies || {})) queue.push({ name, from: directory, optional: true });
        for (const name of Object.keys(manifest.peerDependencies || {})) {
            if (!manifest.peerDependenciesMeta?.[name]?.optional) queue.push({ name, from: directory, optional: false });
        }
        for (const name of manifest.bundledDependencies || manifest.bundleDependencies || []) {
            queue.push({ name, from: directory, optional: false });
        }
    }
    const records = [...packages.values()].sort((left, right) => compareReleasePaths(left.path, right.path));
    const digest = createHash('sha256');
    for (const entry of records) digest.update(entry.path).update('\0').update(entry.name).update('\0')
        .update(entry.resolvedName).update('\0').update(entry.version).update('\0').update(entry.integrity).update('\0')
        .update(JSON.stringify([entry.enginesNode, entry.os, entry.cpu, entry.libc, entry.native])).update('\0')
        .update(entry.packageJsonSha256).update('\0');
    return Object.freeze({ packages: records, sha256: digest.digest('hex') });
}

/** Include the reviewed shell shim at its release-root-relative runtime location. */
export function installManagedClaudeRuntimeAsset(sourceRoot, staging) {
    const relative = 'server/bin/claude';
    const source = path.join(sourceRoot, relative);
    const compiled = path.join(staging, 'dist-server/server/services/isolation/managed-claude-launcher.js');
    for (const file of [source, compiled]) {
        const info = lstatSync(file, { throwIfNoEntry: false });
        if (!info?.isFile() || info.isSymbolicLink() || realpathSync(file) !== file) {
            throw new Error(`Managed Claude runtime asset is missing or unsafe: ${file}`);
        }
    }
    const bytes = readFileSync(source);
    if (!bytes.length || bytes.length > 65536) throw new Error('Managed Claude wrapper size is invalid.');
    const destination = path.join(staging, relative);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o755 });
    chmodSync(destination, 0o755);
}

function copyRuntimeClosure(source, destination, closure, binDirectories, copy) {
    mkdirSync(destination, { mode: 0o755 });
    const excluded = new Set(binDirectories.map((entry) => path.resolve(entry)));
    for (const entry of closure.packages) {
        const target = path.join(destination, path.relative(source, entry.directory));
        mkdirSync(path.dirname(target), { recursive: true });
        copy(entry.directory, target, { recursive: true, dereference: false, errorOnExist: true,
            filter: (candidate) => {
                const resolved = path.resolve(candidate);
                return !excluded.has(resolved) && (resolved === entry.directory
                    || !slash(path.relative(entry.directory, resolved)).split('/').includes('node_modules'));
            } });
    }
}

/** Execute the minimum real runtime proof from the extracted archive, never from the build tree. */
export function smokeExtractedReleaseRuntime(root, run = spawnSync) {
    const home = mkdtempSync(path.join(path.resolve(root), '.release-smoke-home-'));
    const script = String.raw`
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[1]);
const require = createRequire(path.join(root, 'package.json'));
const Database = require('better-sqlite3');
const database = new Database(':memory:');
try {
  const row = database.prepare('SELECT 1 AS ok').get();
  if (row.ok !== 1) throw new Error('better-sqlite3 SELECT 1 failed');
} finally { database.close(); }
await import('@anthropic-ai/claude-agent-sdk');
await import('@openai/codex-sdk');
const argon2 = require('argon2');
const bcrypt = require('bcrypt');
const pty = require('node-pty');
if (typeof argon2.hash !== 'function' || typeof bcrypt.hash !== 'function' || typeof pty.spawn !== 'function') {
  throw new Error('native runtime exports are invalid');
}
const binaries = [
  path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'),
  path.join(root, 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'),
  path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
];
for (const binary of binaries) {
  const result = spawnSync(binary, ['--version'], { cwd: root, encoding: 'utf8', timeout: 15000, env: process.env });
  if (result.status !== 0 || !String(result.stdout || result.stderr || '').trim()) {
    throw new Error('runtime CLI smoke failed: ' + path.basename(binary));
  }
}
const fixture = process.env.HOME;
mkdirSync(path.join(fixture, 'src'));
writeFileSync(path.join(fixture, 'package.json'),
  '{"type":"module","browserslist":["ie 10"]}\n');
writeFileSync(path.join(fixture, 'index.html'),
  '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>\n');
writeFileSync(path.join(fixture, 'src', 'main.jsx'),
  "import './style.css'; window.renderFixture = () => <main className=\"flex prose rtl:mr-2\">fixture</main>;\n");
writeFileSync(path.join(fixture, 'src', 'style.css'),
  '@tailwind utilities;\n.fixture-select { display: flex; user-select: none; }\n');
writeFileSync(path.join(fixture, 'vite.config.mjs'),
  "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n"
  + "const plugins = react({ jsxRuntime: 'classic' });\n"
  + "if (!Array.isArray(plugins) || !plugins.some((plugin) => plugin.name === 'vite:react-babel')) throw new Error('plugin-react did not initialize');\n"
  + "export default defineConfig({ root: new URL('.', import.meta.url).pathname, plugins, build: { outDir: 'dist', emptyOutDir: true, minify: false } });\n");
writeFileSync(path.join(fixture, 'postcss.config.mjs'),
  "export default { plugins: { tailwindcss: { config: './tailwind.config.cjs' }, autoprefixer: {} } };\n");
writeFileSync(path.join(fixture, 'tailwind.config.cjs'),
  "module.exports = { content: ['./src/main.jsx'], plugins: [require('@tailwindcss/typography'), require('tailwindcss-rtl')] };\n");
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const build = spawnSync(process.execPath, ['--max-old-space-size=1536', vite, 'build',
  '--config', path.join(fixture, 'vite.config.mjs')], {
  cwd: fixture, encoding: 'utf8', timeout: 30000,
  env: { ...process.env, NASSAJ_ATOMIC_CLIENT_BUILD: '1', NASSAJ_BUILD_ID: 'a'.repeat(64) },
});
if (build.status !== 0) throw new Error('isolated client toolchain build failed: ' + String(build.stderr || build.stdout || '').trim());
const assets = path.join(fixture, 'dist', 'assets');
const css = readdirSync(assets).filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(path.join(assets, name), 'utf8')).join('\n');
const js = readdirSync(assets).filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(path.join(assets, name), 'utf8')).join('\n');
if (!css.includes('.flex') || !css.includes('-ms-flexbox') || js.includes('<main')) {
  throw new Error('isolated client toolchain output proof failed');
}`;
    try {
        const result = run(process.execPath, ['--input-type=module', '--eval', script, root], {
            cwd: root, encoding: 'utf8', timeout: 45_000,
            env: { HOME: home, PATH: '/usr/bin:/bin', NODE_PATH: '', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
        });
        if (result.status !== 0) {
            throw new Error(`Release runtime isolated smoke failed: ${String(result.stderr || result.stdout || '').trim()}`);
        }
        return true;
    } finally { rmSync(home, { recursive: true, force: true }); }
}

function directPackageRoot(root, base, target, linkPath) {
    const fromBase = path.relative(base, target);
    if (!fromBase || fromBase === '..' || fromBase.startsWith(`..${path.sep}`) || path.isAbsolute(fromBase)) {
        throw new Error(`Release npm bin link does not target a direct package: ${slash(path.relative(root, linkPath))}`);
    }
    const segments = fromBase.split(path.sep);
    const packageSegments = segments[0]?.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1);
    if (packageSegments.length === 0 || packageSegments.some((segment) => !segment)) {
        throw new Error(`Release npm bin package identity is invalid: ${slash(path.relative(root, linkPath))}`);
    }
    const packageRoot = path.join(base, ...packageSegments);
    if (!inside(packageRoot, target) || target === packageRoot) {
        throw new Error(`Release npm bin link escapes its package: ${slash(path.relative(root, linkPath))}`);
    }
    return { packageRoot, packageSegments };
}

function declaredPackageBin(root, packageRoot, packageSegments, linkName) {
    const packageMetadata = lstatSync(packageRoot);
    if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink() || realpathSync(packageRoot) !== packageRoot) {
        throw new Error(`Release npm bin package root is unsafe: ${slash(path.relative(root, packageRoot))}`);
    }
    const manifestPath = path.join(packageRoot, 'package.json');
    const manifestMetadata = lstatSync(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
        throw new Error(`Release npm bin package manifest is unsafe: ${slash(path.relative(root, manifestPath))}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const packageName = typeof manifest.name === 'string' ? manifest.name : '';
    const expectedPackageName = packageSegments.length === 2 ? packageSegments.join('/') : packageSegments[0];
    if (packageName !== expectedPackageName) {
        throw new Error(`Release npm bin package name does not match its directory: ${slash(path.relative(root, packageRoot))}`);
    }
    const declarations = typeof manifest.bin === 'string'
        ? { [packageName.split('/').pop() || '']: manifest.bin }
        : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? manifest.bin : {};
    return { packageName, declared: declarations[linkName] };
}

function attestNpmBinLink(root, base, farm, entry) {
    const linkPath = path.join(farm, entry.name);
    if (!lstatSync(linkPath).isSymbolicLink()) {
        throw new Error(`Release npm bin farm contains a non-symlink: ${slash(path.relative(root, linkPath))}`);
    }
    const rawTarget = readlinkSync(linkPath);
    if (!rawTarget || rawTarget.includes('\0') || rawTarget.includes('\\') || path.isAbsolute(rawTarget)) {
        throw new Error(`Release npm bin link target is invalid: ${slash(path.relative(root, linkPath))}`);
    }
    const target = path.resolve(farm, rawTarget);
    if (!inside(root, target)) throw new Error(`Release npm bin link escapes node_modules: ${slash(path.relative(root, linkPath))}`);
    const { packageRoot, packageSegments } = directPackageRoot(root, base, target, linkPath);
    const { packageName, declared } = declaredPackageBin(root, packageRoot, packageSegments, entry.name);
    if (typeof declared !== 'string' || !declared || declared.includes('\0') || declared.includes('\\') || path.isAbsolute(declared)) {
        throw new Error(`Release npm bin link is not declared by its package: ${slash(path.relative(root, linkPath))}`);
    }
    const declaredTarget = path.resolve(packageRoot, declared);
    if (path.normalize(path.relative(farm, declaredTarget)) !== path.normalize(rawTarget) || declaredTarget !== target) {
        throw new Error(`Release npm bin link does not match its package declaration: ${slash(path.relative(root, linkPath))}`);
    }
    const targetMetadata = lstatSync(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink() || !(targetMetadata.mode & 0o111)
        || !inside(packageRoot, realpathSync(target))) {
        throw new Error(`Release npm bin target must be a confined regular executable file: ${slash(path.relative(root, target))}`);
    }
    return { link: slash(path.join('node_modules', path.relative(root, linkPath))), package: packageName,
        target: slash(path.join('node_modules', path.relative(root, target))) };
}

/** Validate npm's generated POSIX bin link farms, returning a deterministic omission attestation. */
export function attestNpmBinLinkFarms(nodeModulesDirectory) {
    const root = path.resolve(nodeModulesDirectory); const rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || realpathSync(root) !== root) {
        throw new Error('Release node_modules input must be a real directory.');
    }
    const records = []; const directories = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareReleasePaths(a.name, b.name))) {
            const absolute = path.join(directory, entry.name);
            const metadata = lstatSync(absolute);
            if (metadata.isSymbolicLink()) throw new Error(`Release asset rejects symlink: ${slash(path.join('node_modules', path.relative(root, absolute)))}`);
            if (entry.name === '.bin' && path.basename(directory) === 'node_modules') {
                if (!metadata.isDirectory() || realpathSync(absolute) !== absolute) {
                    throw new Error(`Release npm bin farm is not a real directory: ${slash(path.relative(root, absolute))}`);
                }
                directories.push(absolute);
                for (const link of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => compareReleasePaths(a.name, b.name))) {
                    records.push(attestNpmBinLink(root, directory, absolute, link));
                }
            } else if (entry.isDirectory()) walk(absolute);
            else if (!entry.isFile()) throw new Error(`Release asset rejects special file: ${slash(path.join('node_modules', path.relative(root, absolute)))}`);
        }
    };
    walk(root);
    records.sort((left, right) => compareReleasePaths(left.link, right.link));
    const digest = sha(Buffer.from(`${records.map((record) => `${record.link}\0${record.package}\0${record.target}\0`).join('')}`));
    return Object.freeze({ count: records.length, sha256: digest, records: Object.freeze(records), directories: Object.freeze(directories) });
}

function collect(directory, root, output) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const absolute = path.join(directory, entry.name);
        const metadata = lstatSync(absolute);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (metadata.isSymbolicLink()) throw new Error(`Release asset rejects symlink: ${relative}`);
        if (entry.isDirectory()) collect(absolute, root, output);
        else if (entry.isFile()) {
            const mode = metadata.mode & 0o111 ? 0o755 : 0o644;
            chmodSync(absolute, mode);
            const bytes = readFileSync(absolute);
            output.push({ path: relative, mode, size: bytes.length, sha256: sha(bytes) });
        } else throw new Error(`Release asset rejects special file: ${relative}`);
    }
}

function normalizeMigrationClosureModes(staging, closure) {
    const records = [...closure.files, ...closure.packages.flatMap((item) => item.files)];
    for (const record of records) {
        const file = path.join(staging, record.assetPath);
        const metadata = lstatSync(file);
        chmodSync(file, metadata.mode & 0o111 ? 0o755 : 0o644);
    }
}

const FORWARD_CODEC_SOURCE_SHA256 = '629b7a45591c002374845f72fb19ee4a3be363a462af393f77827beb99afe43d';
function validateForwardCodecBinding(ast) {
    const bindings = new Set(); let rootBinding; let factoryImports = 0;
    for (const statement of ast.statements) {
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'require') continue;
            if (rootBinding) throw Error('Forward codec binding is duplicated.');
            rootBinding = declaration;
        }
    }
    if (!rootBinding || !rootBinding.initializer || !ts.isCallExpression(rootBinding.initializer)
        || rootBinding.initializer.expression.getText(ast) !== 'createRequire'
        || rootBinding.initializer.arguments.length !== 1
        || rootBinding.initializer.arguments[0].getText(ast) !== 'import.meta.url') throw Error('Forward codec binding is invalid.');
    const collectBindings = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'createRequire') bindings.add(node.name.text);
        if (ts.isIdentifier(node) && node.text === 'require') {
            const parent = node.parent;
            const allowed = node === rootBinding.name
                || (ts.isCallExpression(parent) && parent.expression === node)
                || (ts.isPropertyAccessExpression(parent) && parent.expression === node && ['resolve', 'cache'].includes(parent.name.text));
            if (!allowed) throw Error('Forward codec binding shadow or alias is invalid.');
        }
        if (ts.isIdentifier(node) && node.text === 'createRequire') {
            const parent = node.parent;
            const imported = ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName
                && parent.parent.parent.parent.moduleSpecifier.text === 'node:module';
            if (imported) factoryImports++;
            if (!imported && !(ts.isCallExpression(parent) && parent.expression === node)) throw Error('Forward codec factory binding is invalid.');
        }
        ts.forEachChild(node, collectBindings);
    };
    collectBindings(ast);
    if (factoryImports !== 1) throw Error('Forward codec factory binding is duplicated or absent.');
    const verify = node => {
        if (ts.isIdentifier(node) && bindings.has(node.text)) {
            const parent = node.parent;
            const declaration = ts.isVariableDeclaration(parent) && parent.name === node;
            const direct = ts.isCallExpression(parent) && parent.expression === node && node.text === 'require';
            const property = ts.isPropertyAccessExpression(parent) && parent.expression === node && ['resolve','cache'].includes(parent.name.text);
            if (!declaration && !direct && !property) throw Error('Forward codec require alias is invalid.');
        }
        ts.forEachChild(node, verify);
    };
    verify(ast);
}
function collectForwardCodecSource(directory, root, output) {
    for (const name of readdirSync(directory).sort()) {
        const absolute = path.join(directory, name); const info = lstatSync(absolute);
        if (info.isSymbolicLink() || realpathSync(absolute) !== absolute) throw Error('Forward codec source link is invalid.');
        if (info.isDirectory()) collectForwardCodecSource(absolute, root, output);
        else if (info.isFile()) output.push({ path: path.relative(root, absolute).split(path.sep).join('/') });
        else throw Error('Forward codec source type is invalid.');
    }
}
function prepareForwardCodecLocks(source, lock, staging, packages) {
    return source.packages.map(item => {
        const relative = `node_modules/${item.name}`;
        if (packages.some(record => record.path === relative)
            || lstatSync(path.join(staging, relative), { throwIfNoEntry: false })) throw Error('Forward codec package collision.');
        const entry = { version: item.version, resolved: item.url, integrity: item.integrity,
            ...(item.name === 'amp-message' ? { dependencies: { amp: '0.3.1' } } : {}) };
        if (Object.hasOwn(lock.packages, relative)) {
            const existing = lock.packages[relative];
            if (!existing || Object.getPrototypeOf(existing) !== Object.prototype) throw Error('Forward codec package collision.');
            const { dev, license, ...identity } = existing;
            // Only matching dev-only lock metadata may be replaced; vendor bytes remain authoritative.
            // amp has no dependencies field; amp-message has exactly the pinned amp dependency.
            if (dev !== true || (license !== undefined && license !== 'MIT')
                || canonical(identity) !== canonical(entry)) throw Error('Forward codec package collision.');
        }
        return { item, relative, entry };
    });
}

function installForwardCodec(sourceRoot, staging, closure) {
    const root = path.join(sourceRoot,'scripts/vendor/pm2-codec'); const bytes=readFileSync(path.join(root,'SOURCE_MANIFEST.json'));
    if(sha(bytes)!==FORWARD_CODEC_SOURCE_SHA256)throw Error('Forward codec source manifest changed.');
    const source=JSON.parse(bytes);const actual=[];collectForwardCodecSource(root,root,actual);
    if(actual.map(file=>file.path).filter(file=>file!=='SOURCE_MANIFEST.json').sort().join(',')!==source.files.map(file=>file.path).sort().join(','))throw Error('Forward codec coverage changed.');
    const lockFile=path.join(staging,'package-lock.json');const lock=JSON.parse(readFileSync(lockFile));const packages=[...closure.packages];
    const codecLocks = prepareForwardCodecLocks(source, lock, staging, packages);
    for(const record of source.files) {
        const file=path.join(root,record.path);const info=lstatSync(file);const content=readFileSync(file);
        if(realpathSync(file)!==file||!info.isFile()||info.isSymbolicLink()||content.length!==record.size||sha(content)!==record.sha256)throw Error('Forward codec bytes changed.');
        const target=path.join(staging,'node_modules',record.path);mkdirSync(path.dirname(target),{recursive:true});
        writeFileSync(target,content,{flag:'wx',mode:0o644});
    }
    for(const { item, relative, entry } of codecLocks) {
        const manifest=JSON.parse(readFileSync(path.join(staging,relative,'package.json')));
        lock.packages[relative]=entry;
        packages.push({path:relative,name:item.name,resolvedName:item.name,version:item.version,integrity:item.integrity,
            enginesNode:null,os:null,cpu:null,libc:null,native:false,packageJsonSha256:sha(readFileSync(path.join(staging,relative,'package.json')))});
        if(manifest.name!==item.name||manifest.version!==item.version)throw Error('Forward codec package identity changed.');
    }
    writeFileSync(lockFile,`${JSON.stringify(lock,null,2)}\n`);packages.sort((a,b)=>compareReleasePaths(a.path,b.path));const digest=createHash('sha256');
    for(const entry of packages)digest.update(entry.path).update('\0').update(entry.name).update('\0').update(entry.resolvedName).update('\0')
        .update(entry.version).update('\0').update(entry.integrity).update('\0').update(JSON.stringify([entry.enginesNode,entry.os,entry.cpu,entry.libc,entry.native]))
        .update('\0').update(entry.packageJsonSha256).update('\0');
    return {packages,sha256:digest.digest('hex')};
}

/** Collect the fixed root operator graph; its sole dynamic edge is separately bound to compiled migration A. */
export function collectForwardExecutableClosure(sourceRoot) {
    const root = realpathSync(sourceRoot); const pending = [...FORWARD_EXECUTABLE_ENTRIES];
    const files = new Map(); const packages = new Set();
    while (pending.length) {
        const relative = pending.pop(); if (files.has(relative)) continue;
        const file = path.join(root, relative); const metadata = lstatSync(file);
        if (!relative.startsWith('scripts/') || realpathSync(file) !== file || !metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error('Forward executable source placement is invalid.');
        }
        const bytes = readFileSync(file);
        if(relative==='scripts/safe-restart.sh') {
            // This single reviewed shell entry has two fixed forward dispatch edges, not a general shell resolver.
            const source=bytes.toString('utf8');
            if(!source.includes('/managed-safe-restart-client.mjs')||!source.includes('/release-runtime-forward-parent.mjs')
                ||!source.includes('--first-forward-phase')||!source.includes('--managed-operation'))throw Error('Forward safe-script dispatch boundary is invalid.');
            pending.push('scripts/managed-safe-restart-client.mjs','scripts/release-runtime-forward-parent.mjs');
            files.set(relative,{path:relative,size:bytes.length,mode:metadata.mode&0o111?0o755:0o644,sha256:sha(bytes),sourceMode:metadata.mode&0o777});
            continue;
        }
        const ast = ts.createSourceFile(relative, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        if (ast.parseDiagnostics.length) throw new Error('Forward executable syntax is invalid.');
        const dependencies = [];
        if (relative === 'scripts/lib/pm2-readonly-observer.mjs') validateForwardCodecBinding(ast);
        const visit = node => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
                if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw new Error('Forward executable import is nonliteral.');
                dependencies.push(node.moduleSpecifier.text);
            }
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                const argument = node.arguments[0];
                if (relative === 'scripts/lib/pm2-readonly-observer.mjs' && ts.isIdentifier(node.expression)
                    && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(argument)
                    && argument.text === '../../node_modules/amp-message/index.js') { ts.forEachChild(node, visit); return; }
                if (node.expression.kind !== ts.SyntaxKind.ImportKeyword || relative !== 'scripts/release-runtime-forward-child.mjs'
                    || node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)
                    || argument.text !== '../dist-server/server/scripts/release-database-migration.js') {
                    throw new Error('Forward executable dynamic edge is not the fixed migration entry.');
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(ast);
        files.set(relative, { path: relative, size: bytes.length, mode: metadata.mode & 0o111 ? 0o755 : 0o644,
            sha256: sha(bytes), sourceMode: metadata.mode & 0o777 });
        for (const specifier of dependencies) {
            if (isBuiltin(specifier)) continue;
            if (!specifier.startsWith('.')) {
                const name = packageNameFromSpecifier(specifier); if (!name) throw new Error('Forward executable external import is invalid.');
                packages.add(name); continue;
            }
            const resolved = path.resolve(path.dirname(file), specifier);
            if (!inside(root, resolved)) throw new Error('Forward executable import escapes its source root.');
            pending.push(slash(path.relative(root, resolved)));
        }
    }
    return { roots: [...FORWARD_EXECUTABLE_ENTRIES].sort(compareReleasePaths),
        files: [...files.values()].sort((a, b) => compareReleasePaths(a.path, b.path)), packages: [...packages].sort(compareReleasePaths) };
}

function copyForwardExecutableClosure(sourceRoot, staging, closure) {
    for (const record of closure.files) {
        const source = path.join(sourceRoot, record.path); const info = lstatSync(source); const bytes = readFileSync(source);
        if (realpathSync(source) !== source || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== record.sourceMode
            || info.size !== record.size || sha(bytes) !== record.sha256) throw new Error('Forward executable source changed before packaging.');
        const target = path.join(staging, record.path); mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: 'wx', mode: record.mode });
    }
}

export function buildReleaseAsset(options, injected = {}) {
    const local = options.kind === LOCAL_BUILD_KIND;
    if (options.kind !== undefined && !local) throw Error('Unknown release identity kind.');
    if (local && ['repo','releaseId','tag','assetId','detachedManifestId'].some(key => Object.hasOwn(options,key))) throw Error('Mixed local build identity.');
    const permissionProtocolGeneration = options.permissionProtocolGeneration ?? 1;
    if (!VERSION.test(options.version || '') || !SHA40.test(options.commit || '') || (!local && (!REPO.test(options.repo || '')
        || !Number.isSafeInteger(options.releaseId) || options.releaseId <= 0))
        || !Number.isSafeInteger(permissionProtocolGeneration) || permissionProtocolGeneration <= 0) {
        throw new Error('Release asset identity is invalid.');
    }
    const profile = options.profile ?? 'default';
    if (!['default', FORWARD_PROFILE_ID].includes(profile)) throw new Error('Release build profile is invalid.');
    const forward = profile === FORWARD_PROFILE_ID;
    if (local && (!forward || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.projectId || ''))) throw Error('Local builds require a project and the reviewed forward profile.');
    if (!local && forward && `${options.version}-${options.commit.slice(0, 12)}-forward-${'0'.repeat(64)}`.length > 96) {
        throw new Error('Forward generation id exceeds the 96-character bound.');
    }
    const assetName = local ? `nassaj-local-forward-${options.commit}.tar.gz` : forward ? `nassaj-runtime-forward-v${options.version}.tar.gz` : `nassaj-runtime-v${options.version}.tar.gz`;
    const manifestName = local ? 'LOCAL_BUILD_MANIFEST.json' : forward ? 'RELEASE_ASSET_MANIFEST.forward.json' : 'RELEASE_ASSET_MANIFEST.json';
    verifyReleaseRuntimeHost(RELEASE_RUNTIME_COMPATIBILITY, injected.runtimeHost);
    const outputDirectory = path.resolve(options.outputDirectory);
    const sourceRoot = path.resolve(options.sourceRoot || ROOT);
    verifyCodexSdkImageOnlySync(sourceRoot);
    const forwardExecutables = forward ? collectForwardExecutableClosure(sourceRoot) : null;
    mkdirSync(outputDirectory, { recursive: true });
    const scratch = mkdtempSync(path.join(options.temporaryRoot || os.tmpdir(), 'nassaj-release-asset-'));
    const staging = path.join(scratch, 'runtime'); mkdirSync(staging, { mode: 0o700 });
    const copy = injected.copy || cpSync;
    let npmBinLinksExcluded;
    try {
        let runtimeClosure;
        for (const [relative, configured] of [['dist', options.clientArtifact], ['dist-server', options.serverArtifact]]) {
            const source = path.resolve(configured || path.join(sourceRoot, relative));
            const metadata = lstatSync(source);
            if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Release input is unsafe: ${relative}`);
            copy(source, path.join(staging, relative), { recursive: true, dereference: false, errorOnExist: true });
        }
        installManagedClaudeRuntimeAsset(sourceRoot, staging);
        if (forwardExecutables) copyForwardExecutableClosure(sourceRoot, staging, forwardExecutables);
        const nodeModulesSource = path.resolve(path.join(sourceRoot, 'node_modules'));
        const allBins = attestNpmBinLinkFarms(nodeModulesSource);
        const clientToolchainRoots = injected.runtimeRoots
            ? [...(injected.clientToolchainRoots || [])].sort(compareReleasePaths)
            : clientToolchainPackageRoots(sourceRoot);
        const roots = [...new Set([...(forwardExecutables?.packages || []), ...(injected.runtimeRoots
            ? injected.runtimeRoots(path.join(staging, 'dist-server'))
            : [
                ...serverRuntimePackageRoots(path.join(staging, 'dist-server')),
                ...REQUIRED_RELEASE_RUNTIME_PACKAGES,
                ...clientToolchainRoots,
            ])])].sort(compareReleasePaths);
        runtimeClosure = resolveRuntimeDependencyClosure(nodeModulesSource, roots, path.join(sourceRoot, 'package-lock.json'));
        copyRuntimeClosure(nodeModulesSource, path.join(staging, 'node_modules'), runtimeClosure, allBins.directories, copy);
        verifyCodexSdkImageOnlySync(staging);
        const included = runtimeClosure.packages.map((entry) => `${entry.path}/`);
        const records = allBins.records.filter((record) => included.some((prefix) => record.target.startsWith(prefix)));
        const binDigest = sha(Buffer.from(records.map((record) => `${record.link}\0${record.package}\0${record.target}\0`).join('')));
        npmBinLinksExcluded = { count: records.length, sha256: binDigest, records };
        for (const relative of ['package.json', 'package-lock.json']) {
            copy(path.join(sourceRoot, relative), path.join(staging, relative), { errorOnExist: true });
        }
        if (forward) { runtimeClosure=installForwardCodec(sourceRoot,staging,runtimeClosure); roots.push('amp','amp-message'); roots.sort(compareReleasePaths); }
        if (!forward && existsSync(path.join(staging, 'dist-server', 'STARTUP_CLOSURE.json'))) {
            throw new Error('The default asset cannot package a forward server candidate.');
        }
        const bundleBytes = readFileSync(path.join(staging, 'dist-server', 'UPDATE_RUNTIME_MANIFEST.json'));
        const bundle = JSON.parse(bundleBytes);
        verifyUpdateRuntimeBundle(path.join(staging, 'dist-server'));
        const server = JSON.parse(readFileSync(path.join(staging, 'dist-server', 'BUILD_PROVENANCE.json')));
        const client = JSON.parse(readFileSync(path.join(staging, 'dist', 'BUILD_PROVENANCE.json')));
        if (server.commit !== options.commit || client.commit !== options.commit || server.version !== options.version || client.version !== options.version
            || !/^[a-f0-9]{64}$/.test(server.buildId || '') || !/^[a-f0-9]{64}$/.test(client.buildId || '')
            || !/^[a-f0-9]{64}$/.test(bundle.buildId || '')) throw new Error('Release build provenance does not match exact tag commit.');
        if (local) (injected.verifyLocalServerCandidate || verifyServerArtefact)(path.join(staging,'dist-server'), {
            root:sourceRoot, version:options.version, expectedCommit:options.commit, expectedBuildId:server.buildId });
        if (local) (injected.verifyLocalClientCandidate || verifyBuildIdentity)(path.join(staging,'dist'),client.buildId);
        const migrationEntry = path.join(staging, 'dist-server', 'server', 'scripts', 'release-database-migration.js');
        const migrationMetadata = lstatSync(migrationEntry);
        if (!migrationMetadata.isFile() || migrationMetadata.isSymbolicLink()) throw new Error('Release migration-only entry is unavailable.');
        let migrationClosure = collectMigrationClosure(path.join(staging, 'dist-server'),
            'server/scripts/release-database-migration.js', { packageLockFile: path.join(staging, 'package-lock.json'),
                runtimeAbi: injected.buildTarget || currentReleaseRuntimeTarget() });
        normalizeMigrationClosureModes(staging, migrationClosure);
        migrationClosure = collectMigrationClosure(path.join(staging, 'dist-server'),
            'server/scripts/release-database-migration.js', { packageLockFile: path.join(staging, 'package-lock.json'),
                runtimeAbi: injected.buildTarget || currentReleaseRuntimeTarget() });
        const predecessorMatrix = forward ? null : injected.predecessorMatrix || generateLegacy144AcceptedPredecessors({
            workspaceDirectory: path.join(scratch, 'legacy-144-matrix'), migrationEntry,
        });
        const groupedPredecessors = new Map();
        for (const entry of predecessorMatrix?.acceptedPredecessors || []) {
            const key = `${entry.schemaDigest}:${entry.compatibilityShapeDigest}`;
            const current = groupedPredecessors.get(key) || { schemaDigest: entry.schemaDigest,
                compatibilityShapeDigest: entry.compatibilityShapeDigest, allowedMigrationStateDigests: [] };
            current.allowedMigrationStateDigests.push(entry.migrationStateDigest); groupedPredecessors.set(key, current);
        }
        const acceptedPredecessors = [...groupedPredecessors.values()].map((entry) => ({ ...entry,
            allowedMigrationStateDigests: [...new Set(entry.allowedMigrationStateDigests)].sort(compareReleasePaths) }))
            .sort((left, right) => `${left.schemaDigest}:${left.compatibilityShapeDigest}`
                .localeCompare(`${right.schemaDigest}:${right.compatibilityShapeDigest}`));
        const targetCompatibilityShapes = [...new Set((predecessorMatrix?.acceptedPredecessors || [])
            .map((entry) => entry.targetCompatibilityShapeDigest))];
        if (!forward && targetCompatibilityShapes.length !== 1) throw new Error('Release migration target compatibility shape diverged.');
        const targetMigrationStateDigests = [...new Set((predecessorMatrix?.acceptedPredecessors || [])
            .map((entry) => entry.targetMigrationStateDigest))].sort(compareReleasePaths);
        let databaseReleaseIdentity = local ? null : sha(Buffer.from(canonical({ repo: options.repo, releaseId: options.releaseId,
            tag: `v${options.version}`, version: options.version, commit: options.commit, serverBuildId: server.buildId,
            clientBuildId: client.buildId, bundleBuildId: bundle.buildId })));
        let databaseContract = forward ? null : { schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256: databaseReleaseIdentity,
            migrationEntrySha256: sha(readFileSync(migrationEntry)), migrationClosureSha256: migrationClosure.sha256,
            acceptedPredecessors, targetSchemaDigest: predecessorMatrix.targetSchemaDigest,
            targetCompatibilityShapeDigest: targetCompatibilityShapes[0], targetMigrationStateDigests,
            preservationPolicySha256: DATABASE_PRESERVATION_POLICY_SHA256,
            schemaVersion: 1, minimumReadableSchemaVersion: 1, previousReleasePolicy: 'restore_required', rehearsalRequired: true };
        if (forwardExecutables) {
            const material = { schema: 'nassaj-forward-executable-files/v1', roots: forwardExecutables.roots,
                files: forwardExecutables.files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })) };
            writeFileSync(path.join(staging, FORWARD_EXECUTABLE_MANIFEST_PATH), `${JSON.stringify(material)}\n`, { mode: 0o644, flag: 'wx' });
        }
        const files = []; collect(staging, staging, files);
        files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        const localBuild = local ? validateLocalBuildCore({kind: LOCAL_BUILD_KIND, projectId: options.projectId,
            commit: server.commit, version: server.version, profileId: profile,
            sourceTreeSha256: computeReleaseFileTreeSha256(files),
            inputManifestSha256: sha(readFileSync(path.join(staging, 'dist-server', 'SERVER_INPUT_MANIFEST.json'))),
            serverBuildId: server.buildId, clientBuildId: client.buildId, bundleBuildId: bundle.buildId }) : null;
        if (local) databaseReleaseIdentity = localBuildIdentitySha256(localBuild);
        const boundMigration = bindMigrationClosureToAsset(migrationClosure, files);
        let startupClosureSha256;
        if (forward) {
            const startupFile = path.join(staging, 'dist-server', 'STARTUP_CLOSURE.json');
            const startupMaterial = JSON.parse(readFileSync(startupFile, 'utf8'));
            startupClosureSha256 = forwardSha256(canonicalForward(startupMaterial));
            verifyForwardStartupMaterial(staging, startupClosureSha256);
            const recomputed = collectForwardStartupMaterial(path.join(staging, 'dist-server'), {
                packageLockFile: path.join(staging, 'package-lock.json'),
            });
            if (recomputed.sha256 !== startupClosureSha256) throw new Error('Forward startup closure coverage mismatch.');
            const observation = (injected.observeForwardProfile || observeForwardProfile)({ sourceRoot, runtimeRoot: path.join(staging, 'dist-server'),
                packageLockFile: path.join(staging, 'package-lock.json') });
            databaseContract = createForwardDatabaseContract({ releaseIdentitySha256: databaseReleaseIdentity,
                migrationEntrySha256: sha(readFileSync(migrationEntry)), migrationClosure: boundMigration,
                startupClosureSha256, observation });
        } else databaseContract.migrationClosure = boundMigration;
        const manifest = {
            ...(local ? {schema: LOCAL_MANIFEST_SCHEMA, build: localBuild} : {
                schemaVersion: 2, updaterProtocol: 2, repo: options.repo, releaseId: options.releaseId,
                tag: `v${options.version}`, version: options.version, commit: options.commit, bundleBuildId: bundle.buildId,
                sourceTreeSha256: computeReleaseFileTreeSha256(files), serverBuildId: server.buildId, clientBuildId: client.buildId }),
            bundleManifestSha256: sha(bundleBytes),
            ...createMeasuredPermissionReleaseContract(server.buildId, permissionProtocolGeneration),
            databaseContract,
            runtimeCompatibility: RELEASE_RUNTIME_COMPATIBILITY,
            targetRuntime: injected.buildTarget || currentReleaseRuntimeTarget(),
            runtimeClosure: { schemaVersion: 2, sha256: runtimeClosure.sha256,
                roots, clientToolchainRoots,
                packages: runtimeClosure.packages.map(({ directory: _, ...entry }) => entry) },
            npmBinLinksExcluded: { count: npmBinLinksExcluded.count, sha256: npmBinLinksExcluded.sha256,
                records: npmBinLinksExcluded.records },
            files,
        };
        const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
        writeFileSync(path.join(staging, 'RELEASE_ASSET_MANIFEST.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
        const publishedManifest = path.join(outputDirectory, manifestName);
        writeFileSync(publishedManifest, manifestBytes, { flag: 'wx', mode: 0o644 });
        const asset = path.join(outputDirectory, assetName);
        const run = injected.run || spawnSync;
        const result = run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
            '--format=ustar', '-czf', asset, '-C', staging, 'dist', 'dist-server', 'node_modules',
            'package.json', 'package-lock.json', 'server/bin/claude', 'RELEASE_ASSET_MANIFEST.json',
            ...(forward ? ['scripts', FORWARD_EXECUTABLE_MANIFEST_PATH] : [])], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`Release archive creation failed: ${(result.stderr || '').trim()}`);
        const assetBytes = readFileSync(asset);
        if (assetBytes.length > RELEASE_ASSET_LIMITS.archiveBytes || files.length > RELEASE_ASSET_LIMITS.files) {
            throw new Error('Release archive exceeds the consumer safety limits.');
        }
        const assetSha256 = sha(assetBytes);
        writeFileSync(`${asset}.sha256`, `${assetSha256}  ${assetName}\n`, { flag: 'wx', mode: 0o644 });
        // The archive now owns the verified bytes. Drop only our scratch copy
        // before extraction so two complete dependency trees never coexist.
        rmSync(staging, { recursive: true });
        const roundtrip = path.join(scratch, 'consumer-roundtrip'); mkdirSync(roundtrip, { mode: 0o700 });
        extractTarGzExact(assetBytes, roundtrip, RELEASE_ASSET_LIMITS);
        verifyExtractedReleaseAsset(roundtrip, local ? {kind: LOCAL_BUILD_KIND, build: localBuild} : {
            repo: options.repo, releaseId: options.releaseId, tag: `v${options.version}`,
            version: options.version, commit: options.commit,
        }, { runtimeTarget: injected.runtimeTarget, expectedStartupClosureSha256: startupClosureSha256 });
        verifyCodexSdkImageOnlySync(roundtrip);
        if (forward) verifyForwardStartupMaterial(roundtrip, startupClosureSha256);
        (injected.runtimeSmoke || smokeExtractedReleaseRuntime)(roundtrip);
        return Object.freeze({ asset, assetName, assetSha256, size: assetBytes.length,
            publishedManifest, publishedManifestSha256: sha(manifestBytes), manifest,
            ...(local ? {preparedArtifact: {kind: LOCAL_BUILD_KIND, buildIdentitySha256: databaseReleaseIdentity,
                archiveName: assetName, archiveSha256: assetSha256, archiveSize: assetBytes.length,
                manifestName, manifestSha256: sha(manifestBytes), manifestSize: manifestBytes.length,
                startupClosureSha256, databaseContractSha256: sha(canonical(databaseContract))}} : {}),
            ...(forwardExecutables ? { forwardExecutableFiles: forwardExecutables.files.map(({ sourceMode: _, ...file }) => file) } : {}) });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function parseReleaseAssetArguments(argv, env = process.env) {
    if (value(argv,'--kind')===LOCAL_BUILD_KIND && ['--repo','--release-id','--tag','--asset-id','--detached-manifest-id'].some(flag=>argv.includes(flag))) throw Error('Mixed local build identity arguments.');
    const generation = value(argv, '--permission-protocol-generation');
    return {
        profile: value(argv, '--profile') || 'default',
        version: value(argv, '--version'), commit: value(argv, '--commit'),
        ...(value(argv, '--kind') === LOCAL_BUILD_KIND ? {kind: LOCAL_BUILD_KIND, projectId: value(argv, '--project-id'),
            ...(value(argv,'--repo') !== null ? {repo:value(argv,'--repo')} : {}),
            ...(value(argv,'--release-id') !== null ? {releaseId:value(argv,'--release-id')} : {})}
            : { ...(value(argv,'--kind') !== null ? {kind:value(argv,'--kind')} : {}), repo: value(argv, '--repo'), releaseId: Number(value(argv, '--release-id') || 0)}),
        outputDirectory: value(argv, '--output'),
        clientArtifact: value(argv, '--client-artifact'), serverArtifact: value(argv, '--server-artifact'),
        permissionProtocolGeneration: generation === null ? 1 : Number(generation),
        temporaryRoot: env.RUNNER_TEMP || '/var/tmp',
    };
}

function main() {
    const options = parseReleaseAssetArguments(process.argv.slice(2));
    if (!options.outputDirectory) throw new Error('Usage: build-release-asset --version V --commit SHA --repo O/R --release-id ID --output DIR [--permission-protocol-generation N]');
    const result = buildReleaseAsset(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) { console.error(`[release-asset] ${error.message}`); process.exitCode = 1; }
}
