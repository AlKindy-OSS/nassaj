import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectMigrationClosure, verifyMigrationClosure, bindMigrationClosureToAsset } from './lib/release-database-migration-closure.mjs';
const version = '0.153.2-linux-x64';
const spec = `npm:@openai/codex@${version}`;
function fixture(t, nested = false) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'b952-alias-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const parent = { name: 'parent', version: '1.0.0', optionalDependencies: { '@openai/codex-linux-x64': spec } };
    const child = { name: '@openai/codex', version };
    const childKey = `${nested ? 'node_modules/parent/' : ''}node_modules/@openai/codex-linux-x64`;
    const lock = { lockfileVersion: 3, packages: {
        'node_modules/parent': structuredClone(parent),
        [childKey]: { ...child, resolved: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    } };
    const write = (file, value) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
    const save = () => { write('node_modules/parent/package.json', parent); write(`${childKey}/package.json`, child); write('package-lock.json', lock); };
    write('dist-server/entry.js', 'import "parent";'); save();
    const collect = () => collectMigrationClosure(path.join(root, 'dist-server'), 'entry.js');
    return { root, parent, child, childKey, lock, save, write, collect };
}
for (const nested of [false, true]) test(`exact scoped alias and deterministic byte binding (nested=${nested})`, t => {
    const f = fixture(t, nested), closure = f.collect();
    assert.equal(closure.packages.length, 2);
    assert.deepEqual(f.collect(), closure);
    assert.equal(closure.packages.find(p => p.root === f.childKey).name, '@openai/codex');
    const assets = [...closure.files, ...closure.packages.flatMap(p => p.files)].map(f => ({ ...f, path: f.assetPath }));
    assert.equal(bindMigrationClosureToAsset(closure, assets).assetManifestBound, true);
    assert.doesNotThrow(() => verifyMigrationClosure(path.join(f.root, 'dist-server'), closure));
    f.write(`${f.childKey}/package.json`, { ...f.child, extra: true });
    assert.throws(() => verifyMigrationClosure(path.join(f.root, 'dist-server'), closure), /migration_closure_mismatch/);
    f.save(); f.write('package-lock.json', `${readFileSync(path.join(f.root, 'package-lock.json'))}\n`);
    assert.throws(() => verifyMigrationClosure(path.join(f.root, 'dist-server'), closure), /lock_mismatch/);
});
const mutations = {
    'wrong installed name': f => { f.child.name = 'wrong'; },
    'wrong installed version': f => { f.child.version = '0.0.0'; },
    'parent lock disagreement': f => { f.lock.packages['node_modules/parent'].optionalDependencies['@openai/codex-linux-x64'] = 'npm:wrong@1.0.0'; },
    'parent version disagreement': f => { f.lock.packages['node_modules/parent'].version = '2.0.0'; },
    'missing child key': f => { f.lock.packages['other'] = f.lock.packages[f.childKey]; delete f.lock.packages[f.childKey]; },
    'wrong child name': f => { f.lock.packages[f.childKey].name = 'wrong'; },
    'wrong child version': f => { f.lock.packages[f.childKey].version = '0.0.0'; },
    'shadow conflict': f => { f.parent.dependencies = { '@openai/codex-linux-x64': '1.0.0' }; },
    'lock shadow conflict': f => { f.lock.packages['node_modules/parent'].dependencies = { '@openai/codex-linux-x64': '1.0.0' }; },
    'bad SRI': f => { f.lock.packages[f.childKey].integrity = 'sha512-YQ=='; },
    'noncanonical SRI': f => { f.lock.packages[f.childKey].integrity = `sha512-${'A'.repeat(85)}B==`; },
};
for (const value of ['npm:@openai/codex@^1.0.0', 'npm:@openai/codex@latest', 'file:codex', 'git:https://example.com/codex', 'npm:@openai/codex@1.0.0-01', ' npm:@openai/codex@1.0.0']) {
    mutations[`reject spec ${value}`] = f => { f.parent.optionalDependencies['@openai/codex-linux-x64'] = value; f.lock.packages['node_modules/parent'].optionalDependencies['@openai/codex-linux-x64'] = value; };
}
for (const value of ['https://registry.npmjs.org.evil/', 'https://user@registry.npmjs.org/', 'https://registry.npmjs.org/@openai/codex/-/wrong.tgz', `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz?x=1`, `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz#x`]) {
    mutations[`reject URL ${value}`] = f => { f.lock.packages[f.childKey].resolved = value; };
}
for (const [name, change] of Object.entries(mutations)) test(name, t => { const f = fixture(t); change(f); f.save(); assert.throws(f.collect, /migration_closure_package_identity/); });
test('second incoming alias edge is checked after directory deduplication', t => {
    const f = fixture(t);
    const badParent = { name: 'second', version: '1.0.0', dependencies: { '@openai/codex-linux-x64': spec } };
    f.parent.dependencies = { second: '1.0.0' };
    f.lock.packages['node_modules/parent'] = structuredClone(f.parent);
    f.lock.packages['node_modules/second'] = { ...badParent, dependencies: {} };
    f.write('node_modules/second/package.json', badParent); f.save();
    assert.throws(f.collect, /migration_closure_package_identity/);
});
test('optional absent is ignored; present symlink is rejected', t => {
    const f = fixture(t); rmSync(path.join(f.root, f.childKey), { recursive: true });
    assert.equal(f.collect().packages.length, 1);
    symlinkSync(path.join(f.root, 'node_modules/parent'), path.join(f.root, f.childKey));
    assert.throws(f.collect, /package_symlink/);
});
test('ordinary dependency remains accepted without alias metadata', t => {
    const f = fixture(t); f.child.name = '@openai/codex-linux-x64'; f.parent.optionalDependencies['@openai/codex-linux-x64'] = '1.0.0'; f.save();
    assert.equal(f.collect().packages.length, 2);
});
test('root alias remains rejected without transitive parent proof', t => {
    const f = fixture(t); f.write('dist-server/entry.js', 'import "@openai/codex-linux-x64";');
    assert.throws(f.collect, /package_identity/);
});
test('actual installed Codex tree alias is measured read-only', t => {
    const f = fixture(t); f.write('dist-server/entry.js', 'import "@openai/codex";');
    const project = path.resolve(import.meta.dirname, '..');
    const closure = collectMigrationClosure(path.join(f.root, 'dist-server'), 'entry.js', { nodeModulesRoot: path.join(project, 'node_modules'), packageLockFile: path.join(project, 'package-lock.json') });
    const alias = closure.packages.find(p => p.root === 'node_modules/@openai/codex-linux-x64');
    assert.equal(alias.name, '@openai/codex'); assert.equal(alias.version, version); assert.ok(alias.files.length > 0);
});

test('nested package path symlink and path traversal are rejected', t => {
    const f = fixture(t, true);
    f.write('node_modules/@openai/codex-linux-x64/package.json', f.child);
    rmSync(path.join(f.root, 'node_modules/parent/node_modules'), { recursive: true });
    symlinkSync(path.join(f.root, 'node_modules'), path.join(f.root, 'node_modules/parent/node_modules'));
    assert.throws(f.collect, /package_symlink/);
});
test('supported bounded lock snapshot is mandatory', t => {
    const f = fixture(t); f.lock.lockfileVersion = 2; f.save();
    assert.throws(f.collect, /lock_unsupported/);
});
