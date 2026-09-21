import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { buildSync, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function currentRuntimeAbi() { const report = process.report?.getReport?.().header || {}; return { platform: process.platform,
    arch: process.arch, libc: report.glibcVersionRuntime || null, nodeMajor: Number(process.versions.node.split('.')[0]),
    nodeModules: Number(process.versions.modules) }; }
function packageName(specifier) {
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) return null;
    const parts = specifier.split('/'); return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
function inside(root, target) { return target !== root && target.startsWith(`${root}${path.sep}`); }
function regular(file, root) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !inside(root, realpathSync(file))) {
        throw new Error('migration_closure_file_unsafe');
    }
    return metadata;
}
function assertLiteralLoaders(file, source) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const requireNames = new Set(['require']);
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
            && node.initializer.expression.text === 'createRequire') requireNames.add(node.name.text);
        if (ts.isCallExpression(node)) {
            const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text));
            if (loader && (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))) {
                throw new Error(`migration_closure_computed_import:${file}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
}
function walkPackageFiles(directory, nodeModulesRoot, records) {
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
            if (entry.name === 'node_modules') continue;
            const absolute = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error('migration_closure_package_symlink');
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile()) {
                const metadata = regular(absolute, nodeModulesRoot); const bytes = readFileSync(absolute);
                records.push({ assetPath: `node_modules/${path.relative(nodeModulesRoot, absolute).split(path.sep).join('/')}`,
                    mode: metadata.mode & 0o777, size: bytes.length, sha256: sha(bytes), native: absolute.endsWith('.node') });
            } else throw new Error('migration_closure_package_file_unsafe');
        }
    };
    walk(directory);
}
function assertPackagePath(candidate, nodeModulesRoot) {
    if (!inside(nodeModulesRoot, candidate)) throw new Error('migration_closure_package_escape');
    let cursor = nodeModulesRoot;
    for (const part of path.relative(nodeModulesRoot, candidate).split(path.sep)) {
        cursor = path.join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) throw new Error('migration_closure_package_symlink');
    }
    if (realpathSync(candidate) !== candidate) throw new Error('migration_closure_package_escape');
    return candidate;
}
function resolvePackage(name, from, nodeModulesRoot) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.split('/').some(p => p === '.' || p === '..')) {
        throw new Error('migration_closure_package_identity');
    }
    let cursor = from;
    const candidates = [];
    for (;;) {
        candidates.push(path.join(cursor, 'node_modules', ...name.split('/')));
        const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    candidates.push(path.join(nodeModulesRoot, ...name.split('/')));
    for (const candidate of candidates) {
        if (!inside(nodeModulesRoot, candidate)) continue;
        try { lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        assertPackagePath(candidate, nodeModulesRoot);
        regular(path.join(candidate, 'package.json'), nodeModulesRoot);
        return candidate;
    }
    throw new Error(`migration_closure_package_missing:${name}`);
}
function aliasTarget(spec) {
    const match = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(spec || '');
    if (!match || match[1].split('/').some(p => p === '.' || p === '..')) return null;
    const prerelease = match[2].split('+')[0].split('-').slice(1).join('-');
    if (prerelease.split('.').some(p => /^0\d+$/.test(p))) return null;
    return { name: match[1], version: match[2] };
}
function verifyAliasEdge(request, directory, manifest, nodeModulesRoot, lock) {
    const spec = request.parent?.[request.section]?.[request.name];
    if (manifest.name === request.name && !String(spec || '').startsWith('npm:')) return;
    const fail = () => { throw new Error('migration_closure_package_identity'); };
    const target = aliasTarget(spec);
    if (!target || !request.parent || !request.section) fail();
    const key = dir => `node_modules/${path.relative(nodeModulesRoot, dir).split(path.sep).join('/')}`;
    const parent = lock.packages[key(request.from)], child = lock.packages[key(directory)];
    const installedParentName = request.from.split(`${path.sep}node_modules${path.sep}`).at(-1).split(path.sep).join('/');
    if (!parent || !child || (parent.name || installedParentName) !== request.parent.name
        || parent.version !== request.parent.version || parent[request.section]?.[request.name] !== spec) fail();
    for (const value of [request.parent, parent]) {
        const dep = value.dependencies?.[request.name], optional = value.optionalDependencies?.[request.name];
        if (dep !== undefined && optional !== undefined && dep !== optional) fail();
    }
    if (manifest.name !== target.name || manifest.version !== target.version
        || child.name !== target.name || child.version !== target.version) fail();
    const tarball = `https://registry.npmjs.org/${target.name}/-/${target.name.split('/').at(-1)}-${target.version}.tgz`;
    let url; try { url = new URL(child.resolved); } catch { fail(); }
    if (child.resolved !== tarball || url.origin !== 'https://registry.npmjs.org'
        || url.username || url.password || url.search || url.hash) fail();
    if (typeof child.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(child.integrity)) fail();
    const digest = Buffer.from(child.integrity.slice(7), 'base64');
    if (digest.length !== 64 || `sha512-${digest.toString('base64')}` !== child.integrity) fail();
}
function packageAttestations(roots, nodeModulesRoot, generationRoot, nativeAllowlist, lock) {
    const queue = roots.map((name) => ({ name, from: generationRoot })); const seen = new Set(); const packages = [];
    while (queue.length) {
        const request = queue.shift(); const directory = resolvePackage(request.name, request.from, nodeModulesRoot);
        const manifestFile = path.join(directory, 'package.json'); const manifest = JSON.parse(readFileSync(manifestFile));
        verifyAliasEdge(request, directory, manifest, nodeModulesRoot, lock);
        if (seen.has(directory)) continue; seen.add(directory);
        const files = []; walkPackageFiles(directory, nodeModulesRoot, files); files.sort((a, b) => compare(a.assetPath, b.assetPath));
        if (files.some((file) => file.native) && !nativeAllowlist.has(manifest.name)) {
            throw new Error(`migration_closure_native_package_blocked:${manifest.name}`);
        }
        packages.push({ name: manifest.name, version: manifest.version,
            root: `node_modules/${path.relative(nodeModulesRoot, directory).split(path.sep).join('/')}`,
            peerDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies || {}).sort(([a], [b]) => compare(a, b))),
            peerDependenciesMeta: Object.fromEntries(Object.entries(manifest.peerDependenciesMeta || {}).sort(([a], [b]) => compare(a, b))),
            files, sha256: digestRecords(files) });
        for (const section of ['dependencies', 'optionalDependencies']) {
            for (const name of Object.keys(manifest[section] || {}).sort(compare)) {
                try { resolvePackage(name, directory, nodeModulesRoot); }
                catch (error) {
                    if (section === 'optionalDependencies' && error.message === `migration_closure_package_missing:${name}`) continue;
                    throw error;
                }
                queue.push({ name, from: directory, parent: manifest, section });
            }
        }
    }
    return packages.sort((a, b) => compare(a.root, b.root));
}
function digestRecords(records) {
    const hash = createHash('sha256');
    for (const record of records) hash.update(record.assetPath).update('\0').update(String(record.mode)).update('\0')
        .update(String(record.size)).update('\0').update(record.sha256).update('\0');
    return hash.digest('hex');
}
function closureDigest(value) {
    const hash = createHash('sha256');
    hash.update(value.schema).update('\0').update(value.graphLoader).update('\0').update(value.entry).update('\0')
        .update(value.packageLockSha256).update('\0').update(JSON.stringify(value.runtimeAbi)).update('\0')
        .update(JSON.stringify(value.nativePackageAllowlist)).update('\0');
    for (const file of value.files) hash.update(file.assetPath).update('\0').update(String(file.mode)).update('\0')
        .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    for (const item of value.packages) hash.update(item.root).update('\0').update(item.name).update('\0')
        .update(item.version).update('\0').update(JSON.stringify(item.peerDependencies)).update('\0')
        .update(JSON.stringify(item.peerDependenciesMeta)).update('\0').update(item.sha256).update('\0');
    return hash.digest('hex');
}

/** Resolve the compiled graph with esbuild and attest all external package/native bytes. */
export function collectMigrationClosure(runtimeRoot, entryRelative, options = {}) {
    const root = realpathSync(path.resolve(runtimeRoot)); const rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('migration_closure_root_unsafe');
    if (path.isAbsolute(entryRelative) || path.posix.normalize(entryRelative) !== entryRelative || entryRelative.startsWith('../')) {
        throw new Error('migration_closure_entry_escape');
    }
    const entry = path.resolve(root, ...entryRelative.split('/')); regular(entry, root);
    const result = buildSync({ absWorkingDir: root, entryPoints: [entryRelative], bundle: true, packages: 'external',
        platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent', target: 'node24' });
    const files = Object.keys(result.metafile.inputs).map((input) => {
        const absolute = path.resolve(root, input);
        if (!inside(root, absolute)) throw new Error('migration_closure_graph_escape');
        const metadata = regular(absolute, root); const bytes = readFileSync(absolute);
        assertLiteralLoaders(input, bytes.toString('utf8'));
        return { assetPath: `dist-server/${path.relative(root, absolute).split(path.sep).join('/')}`,
            mode: metadata.mode & 0o777, size: bytes.length, sha256: sha(bytes) };
    }).sort((a, b) => compare(a.assetPath, b.assetPath));
    const roots = new Set();
    for (const output of Object.values(result.metafile.outputs)) {
        for (const item of output.imports || []) { const name = item.external ? packageName(item.path) : null; if (name) roots.add(name); }
    }
    const generationRoot = path.dirname(root);
    const nodeModulesRoot = roots.size
        ? realpathSync(options.nodeModulesRoot ? path.resolve(options.nodeModulesRoot) : path.join(generationRoot, 'node_modules')) : null;
    const nativePackageAllowlist = [...new Set(options.nativePackageAllowlist || ['better-sqlite3'])].sort(compare);
    const packageLockFile = path.resolve(options.packageLockFile || path.join(path.dirname(nodeModulesRoot || path.join(generationRoot, 'node_modules')), 'package-lock.json'));
    const lockMetadata = regular(packageLockFile, path.dirname(nodeModulesRoot || path.join(generationRoot, 'node_modules')));
    if (lockMetadata.size > 32 * 1024 * 1024) throw new Error('migration_closure_lock_unsupported');
    const lockBytes = readFileSync(packageLockFile);
    const lock = JSON.parse(lockBytes);
    if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
        throw new Error('migration_closure_lock_unsupported');
    }
    const packages = roots.size ? packageAttestations([...roots].sort(compare), nodeModulesRoot, generationRoot,
        new Set(nativePackageAllowlist), lock) : [];
    const runtimeAbi = Object.freeze(options.runtimeAbi || currentRuntimeAbi());
    const closure = { schema: 'nassaj-database-migration-closure/v2', graphLoader: `esbuild@${esbuildVersion}`,
        entry: `dist-server/${entryRelative}`, packageLockSha256: sha(lockBytes), runtimeAbi,
        nativePackageAllowlist, files, packages };
    return Object.freeze({ ...closure, sha256: closureDigest(closure) });
}

/** Prove every graph/package/native byte is present identically in the final release asset manifest. */
export function bindMigrationClosureToAsset(closure, assetFiles) {
    const assets = new Map((assetFiles || []).map((file) => [file.path, file]));
    for (const record of [...closure.files, ...closure.packages.flatMap((item) => item.files)]) {
        const asset = assets.get(record.assetPath);
        if (!asset || asset.mode !== record.mode || asset.size !== record.size || asset.sha256 !== record.sha256) {
            throw new Error(`migration_closure_asset_mismatch:${record.assetPath}`);
        }
    }
    return Object.freeze({ ...closure, assetManifestBound: true });
}

/** Recompute the graph, package and native measurements before migration. */
export function verifyMigrationClosure(runtimeRoot, expected, options = {}) {
    const root = realpathSync(path.resolve(runtimeRoot));
    if (expected?.schema !== 'nassaj-database-migration-closure/v2' || !/^esbuild@\d+\.\d+\.\d+$/.test(expected.graphLoader || '')
        || !Array.isArray(expected.files) || !Array.isArray(expected.packages)
        || !Array.isArray(expected.nativePackageAllowlist) || expected.sha256 !== closureDigest(expected)) {
        throw new Error('migration_closure_mismatch');
    }
    const runtimeAbi = options.runtimeAbi || currentRuntimeAbi();
    if (JSON.stringify(expected.runtimeAbi) !== JSON.stringify(runtimeAbi)) throw new Error('migration_closure_runtime_abi_mismatch');
    const generationRoot = path.dirname(root); const packageRoot = path.dirname(path.resolve(options.nodeModulesRoot
        || path.join(generationRoot, 'node_modules'))); const packageLockFile = path.resolve(options.packageLockFile
        || path.join(packageRoot, 'package-lock.json'));
    regular(packageLockFile, packageRoot);
    if (sha(readFileSync(packageLockFile)) !== expected.packageLockSha256) throw new Error('migration_closure_lock_mismatch');
    for (const record of [...expected.files, ...expected.packages.flatMap((item) => item.files || [])]) {
        const relative = record.assetPath.replace(/^dist-server\//, '');
        const base = record.assetPath.startsWith('dist-server/') ? root : packageRoot;
        const absolute = path.resolve(base, ...relative.split('/'));
        const metadata = regular(absolute, base); const bytes = readFileSync(absolute);
        if ((metadata.mode & 0o777) !== record.mode || bytes.length !== record.size || sha(bytes) !== record.sha256) {
            throw new Error('migration_closure_mismatch');
        }
    }
    return Object.freeze({ ...expected });
}
