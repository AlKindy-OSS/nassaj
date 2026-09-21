import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FORWARD_EXECUTABLE_ENTRIES, collectUpdateRuntimeClosure } from './lib/update-runtime-bundle.mjs';
import { FORWARD_EXECUTABLE_MANIFEST_PATH, verifyForwardExecutableManifest } from './lib/update-release-asset.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// These fixtures only read/write their own temporary files; no Git or production writer is invoked.
function fixture(t) {
    const root = fs.mkdtempSync(path.resolve('.artifacts/b951-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roots = [...FORWARD_EXECUTABLE_ENTRIES].sort();
    const files = [...roots, 'scripts/lib/nested-fixture.mjs'].sort().map(relative => {
        const bytes = Buffer.from('export const fixture = true;\n'), file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { mode: 0o644 });
        return { path: relative, mode: 0o644, size: bytes.length, sha256: sha(bytes) };
    });
    const material = { schema: 'nassaj-forward-executable-files/v1', roots, files };
    const release = { databaseContract: { schema: 'nassaj-database-release-contract/v2' }, files: [] };
    const seal = () => {
        const bytes = Buffer.from(JSON.stringify(material));
        fs.writeFileSync(path.join(root, FORWARD_EXECUTABLE_MANIFEST_PATH), bytes, { mode: 0o644 });
        release.files = [...files.map(record => ({ ...record })), { path: FORWARD_EXECUTABLE_MANIFEST_PATH,
            mode: 0o644, size: bytes.length, sha256: sha(bytes) }].sort((a, b) => a.path < b.path ? -1 : 1);
    };
    seal(); return { root, material, release, seal };
}

test('B951 core verifier checks measured fixed roots and transitive files without build tooling', t => {
    const f = fixture(t);
    assert.deepEqual(verifyForwardExecutableManifest(f.root, f.release), f.material);
    const closure = collectUpdateRuntimeClosure(path.resolve('.'), ['scripts/lib/prepare-first-forward-config.mjs']);
    assert.ok(!closure.some(file => /(?:build-release-asset|client-build-atomic|server-build-atomic)\.mjs$/.test(file)));
});

test('B951 rejects unanchored, missing, changed, oversized and self-described executable material', async t => {
    const cases = {
        unanchored: f => { f.release.files = f.release.files.filter(record => record.path !== FORWARD_EXECUTABLE_MANIFEST_PATH); },
        anchorBytes: f => fs.appendFileSync(path.join(f.root, FORWARD_EXECUTABLE_MANIFEST_PATH), ' '),
        anchorSize: f => { f.release.files.find(record => record.path === FORWARD_EXECUTABLE_MANIFEST_PATH).size = 33 * 1024 * 1024; },
        rootMissing: f => { f.material.roots.pop(); f.seal(); },
        extraField: f => { f.material.authority = true; f.seal(); },
        duplicate: f => { f.material.files.push({ ...f.material.files[0] }); f.seal(); },
        traversal: f => { f.material.files[0].path = 'scripts/../escape.mjs'; f.seal(); },
        recordRootMissing: f => { f.material.files.splice(f.material.files.findIndex(record => record.path === f.material.roots[0]), 1); f.seal(); },
        releaseDisagreement: f => { f.release.files.find(record => record.path === f.material.files[0].path).sha256 = '0'.repeat(64); },
        missing: f => fs.unlinkSync(path.join(f.root, f.material.files[0].path)),
        bytes: f => fs.writeFileSync(path.join(f.root, f.material.files[0].path), 'X'.repeat(f.material.files[0].size)),
        mode: f => fs.chmodSync(path.join(f.root, f.material.files[0].path), 0o755),
        writable: f => fs.chmodSync(path.join(f.root, f.material.files[0].path), 0o666),
        symlink: f => { const file = path.join(f.root, f.material.files[0].path); fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, f.material.files[1].path), file); },
        symlinkParent: f => { fs.renameSync(path.join(f.root, 'scripts'), path.join(f.root, 'moved')); fs.symlinkSync('moved', path.join(f.root, 'scripts')); },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, child => {
        const f = fixture(child); mutate(f); assert.throws(() => verifyForwardExecutableManifest(f.root, f.release));
    });
});
