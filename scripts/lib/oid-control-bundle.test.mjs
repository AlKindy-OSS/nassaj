import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bundleOidControlCapsule } from './oid-control-bundle.mjs';
import { verifyOidCapsuleModuleClosure, verifyOidLauncherModuleClosure } from '../server-build-atomic.mjs';

const root = path.resolve(import.meta.dirname, '../..');
test('actual capsule packages only the explicit reviewed builtins-only closure', () => {
    const bundle = bundleOidControlCapsule(root, verifyOidCapsuleModuleClosure);
    assert.ok(bundle.sources.some(item => item.path === 'scripts/lib/dependency-tree-identity-v2.mjs'));
    assert.ok(bundle.sources.some(item => item.path === 'scripts/lib/update-generation-reconciliation.mjs'));
    assert.equal(verifyOidCapsuleModuleClosure(bundle.bytes), true);
    assert.deepEqual(bundle.bytes, fs.readFileSync(path.join(root, 'scripts/oid-control-capsule.mjs')));
    assert.throws(() => verifyOidCapsuleModuleClosure(fs.readFileSync(path.join(root, 'scripts/oid-control-capsule.source.mjs'))), /closure/);
});

test('bundle refuses a non-reviewed local import even when it uses only builtins', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-closure-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmp, 'scripts/lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts/lib/dependency-tree-identity-v2.mjs'), 'export const identity=1;');
    fs.writeFileSync(path.join(tmp, 'scripts/lib/escape.mjs'), 'export const unsafe=2;');
    fs.writeFileSync(path.join(tmp, 'scripts/oid-control-capsule.source.mjs'),
        "import {identity} from './lib/dependency-tree-identity-v2.mjs'; import {unsafe} from './lib/escape.mjs'; export const result=identity+unsafe;");
    assert.throws(() => bundleOidControlCapsule(tmp, verifyOidCapsuleModuleClosure), /unreviewed/);
});

test('launcher permits only its captured-capsule template within the existing launcher function', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/preview-oid-capsule-launcher.mjs'), 'utf8');
    assert.equal(verifyOidLauncherModuleClosure(Buffer.from(source)), true);
    assert.throws(() => verifyOidLauncherModuleClosure(Buffer.from(source.replace("capsule.toString('base64')", "untrusted.toString('base64')"))), /loader/);
    assert.throws(() => verifyOidLauncherModuleClosure(Buffer.from("export async function other(capsule){return import(`data:text/javascript;base64,${capsule.toString('base64')}`)}")), /loader/);
    assert.throws(() => verifyOidLauncherModuleClosure(Buffer.from("export const load=x=>import(x);")), /loader/);
});

test('capsule rejects esbuild dynamic require fallback', () => {
    assert.throws(() => verifyOidCapsuleModuleClosure(Buffer.from('const codec=__require(\"util\");')), /runtime-loader/);
});
