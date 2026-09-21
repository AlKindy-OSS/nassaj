import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPinnedPm2RuntimeMetadata, observePinnedPm2PrivateRuntime } from './lib/pm2-readonly-observer.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('root metadata pins actual interpreter and nearest nested package; drift never falls back to release root', t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/pm2-metadata-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'nested')); const entryPath = path.join(root, 'nested/app.cjs'); fs.writeFileSync(entryPath, '');
    const packagePath = path.join(root, 'nested/package.json'); fs.writeFileSync(packagePath, '{"version":"9.8.7"}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"wrong-root-version"}');
    // Pinned fixture files must not inherit a group-writable runner umask.
    for (const file of [entryPath, packagePath, path.join(root, 'package.json')]) fs.chmodSync(file, 0o644);
    // Explicit fixture ownership seam only; actual file paths, bytes, symlinks and opened inode checks remain.
    const lstat = fs.lstatSync.bind(fs); const fstat = fs.fstatSync.bind(fs);
    t.mock.method(fs, 'lstatSync', (...args) => { const value = lstat(...args); value.uid = 0; if (value.isDirectory()) value.mode &= ~0o022; return value; });
    t.mock.method(fs, 'fstatSync', (...args) => { const value = fstat(...args); value.uid = 0; return value; });
    const node = fs.realpathSync(process.execPath); const settings = { entryPath, packageJson: { path: packagePath,
        sha256: hash(fs.readFileSync(packagePath)) }, node: { path: node, sha256: hash(fs.readFileSync(node)) } };
    const deps = { effectiveUid: () => 0 };
    assert.deepEqual(readPinnedPm2RuntimeMetadata(settings, deps), { version: '9.8.7', nodeVersion: process.versions.node });
    assert.throws(() => readPinnedPm2RuntimeMetadata({ ...settings, node: { ...settings.node, sha256: '0'.repeat(64) } }, deps), /pin_digest/);
    assert.throws(() => readPinnedPm2RuntimeMetadata({ ...settings, packageJson: { path: path.join(root, 'package.json'),
        sha256: hash(fs.readFileSync(path.join(root, 'package.json'))) } }, deps), /metadata_package_lookup/);
    fs.writeFileSync(packagePath, '{"version":"drift"}'); assert.throws(() => readPinnedPm2RuntimeMetadata(settings, deps), /pin_digest/);
    fs.unlinkSync(packagePath); fs.symlinkSync(path.join(root, 'package.json'), packagePath);
    assert.throws(() => readPinnedPm2RuntimeMetadata(settings, deps), /pin_path/);
});
test('private runtime and metadata APIs reject non-root before reading a socket or pin', async () => {
    assert.throws(() => readPinnedPm2RuntimeMetadata({}, { effectiveUid: () => 1000 }), /private_root_required/);
    await assert.rejects(observePinnedPm2PrivateRuntime({}, { effectiveUid: () => 1000 }), /private_root_required/);
});
