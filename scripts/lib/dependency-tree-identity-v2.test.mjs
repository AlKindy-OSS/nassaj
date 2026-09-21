import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { hashDependencyTreeV2, sealDependencyTreeV2 } from './dependency-tree-identity-v2.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-v2-'));
    const cleanupChmod = fs.chmodSync;
    t.after(() => {
        function unlock(directory) {
            cleanupChmod(directory, 0o700);
            for (const child of fs.readdirSync(directory)) {
                const file = path.join(directory, child);
                if (fs.lstatSync(file).isDirectory()) unlock(file);
            }
        }
        unlock(root); fs.rmSync(root, { recursive: true, force: true });
    });
    const tree = path.join(root, 'tree'); fs.mkdirSync(tree);
    fs.mkdirSync(path.join(tree, 'pkg')); fs.mkdirSync(path.join(tree, '.bin'));
    const cli = path.join(tree, 'pkg', 'cli');
    fs.writeFileSync(cli, 'native candidate');
    // The no-mutation regression below must not inherit the runner umask.
    fs.chmodSync(cli, 0o644);
    fs.symlinkSync('../pkg/cli', path.join(tree, '.bin', 'cli'));
    return { root, tree };
}

test('v2 identity survives relocation with bin and chained links', t => {
    const { root, tree } = fixture(t);
    fs.symlinkSync('.bin/cli', path.join(tree, 'chain'));
    const original = hashDependencyTreeV2(tree);
    fs.renameSync(tree, path.join(root, 'node_modules'));
    assert.deepEqual(hashDependencyTreeV2(path.join(root, 'node_modules')), original);
    assert.equal(original.links, 2);
});

test('v2 covers empty directories and directory permissions', t => {
    const { tree } = fixture(t), original = hashDependencyTreeV2(tree);
    fs.mkdirSync(path.join(tree, 'empty'));
    assert.notEqual(hashDependencyTreeV2(tree).sha256, original.sha256);
    const beforeMode = hashDependencyTreeV2(tree);
    fs.chmodSync(path.join(tree, 'empty'), 0o700);
    assert.notEqual(hashDependencyTreeV2(tree).sha256, beforeMode.sha256);
});

for (const [name, target, expected] of [['dangling', 'missing', 'unresolved'], ['cycle', 'bad', 'unresolved'],
    ['escape', '../outside', 'escape'], ['absolute', '/etc/passwd', 'absolute']]) {
    test(`v2 rejects ${name} symlinks`, t => {
        const { tree } = fixture(t); fs.symlinkSync(target, path.join(tree, 'bad'));
        assert.throws(() => hashDependencyTreeV2(tree), new RegExp(expected));
    });
}

test('v2 rejects external hardlinks, special files, privileged modes and root aliases', t => {
    const { root, tree } = fixture(t);
    fs.linkSync(path.join(tree, 'pkg/cli'), path.join(root, 'outside'));
    assert.throws(() => hashDependencyTreeV2(tree), /hardlink/);
    fs.unlinkSync(path.join(root, 'outside'));
    fs.chmodSync(path.join(tree, 'pkg/cli'), 0o4755);
    assert.throws(() => hashDependencyTreeV2(tree), /privileged/);
    fs.chmodSync(path.join(tree, 'pkg/cli'), 0o755);
    fs.symlinkSync('tree', path.join(root, 'alias'));
    assert.throws(() => hashDependencyTreeV2(path.join(root, 'alias')), /root/);
    assert.equal(spawnSync('mkfifo', [path.join(tree, 'fifo')]).status, 0);
    assert.throws(() => hashDependencyTreeV2(tree), /special/);
});

test('seal removes writes, preserves execution and detects later writable drift', t => {
    const { tree } = fixture(t);
    fs.chmodSync(path.join(tree, 'pkg/cli'), 0o755);
    const identity = sealDependencyTreeV2(tree);
    assert.deepEqual(hashDependencyTreeV2(tree, { requireSealed: true }), identity);
    assert.equal(fs.statSync(path.join(tree, 'pkg/cli')).mode & 0o777, 0o555);
    fs.chmodSync(tree, 0o755);
    assert.throws(() => hashDependencyTreeV2(tree, { requireSealed: true }), /root_owner_mode/);
    // Restore private scratch directory permissions solely for test cleanup.
    fs.chmodSync(path.join(tree, '.bin'), 0o755); fs.chmodSync(path.join(tree, 'pkg'), 0o755);
});

test('service-owned 0700 root survives real cross-parent exchange and rollback without mode changes', t => {
    const { root, tree } = fixture(t);
    fs.linkSync(path.join(tree, 'pkg/cli'), path.join(tree, 'internal-alias'));
    const initial = sealDependencyTreeV2(tree);
    fs.mkdirSync(path.join(root, 'store'));
    const candidate = path.join(root, 'store/candidate'); fs.renameSync(tree, candidate);
    assert.deepEqual(hashDependencyTreeV2(candidate, { requireSealed: true }), initial);
    const live = path.join(root, 'node_modules'); fs.mkdirSync(live, { mode: 0o700 });
    fs.writeFileSync(path.join(live, 'old'), 'old generation');
    const previous = sealDependencyTreeV2(live);
    for (let pass = 0; pass < 2; pass += 1) {
        const swap = spawnSync('/usr/bin/mv', ['--exchange', '--no-copy', '-T', candidate, live], { encoding: 'utf8' });
        assert.equal(swap.status, 0, swap.stderr);
        assert.deepEqual(hashDependencyTreeV2(pass === 0 ? live : candidate, { requireSealed: true }), initial);
        assert.deepEqual(hashDependencyTreeV2(pass === 0 ? candidate : live, { requireSealed: true }), previous);
    }
    assert.equal(fs.readFileSync(path.join(candidate, '.bin/cli'), 'utf8'), 'native candidate');
    assert.throws(() => hashDependencyTreeV2(candidate, { requireSealed: true, expectedOwnerUid: process.getuid() + 1 }), /root_owner_mode/);
    fs.chmodSync(candidate, 0o770);
    assert.throws(() => hashDependencyTreeV2(candidate, { requireSealed: true }), /root_owner_mode/);
    fs.chmodSync(candidate, 0o700);
    fs.writeFileSync(path.join(candidate, 'unexpected'), 'new'); fs.chmodSync(path.join(candidate, 'unexpected'), 0o444);
    assert.notEqual(hashDependencyTreeV2(candidate, { requireSealed: true }).sha256, initial.sha256);
    fs.unlinkSync(path.join(candidate, 'unexpected'));
    fs.renameSync(path.join(candidate, 'pkg'), path.join(candidate, 'renamed'));
    assert.throws(() => hashDependencyTreeV2(candidate, { requireSealed: true }), /unresolved/);
    fs.renameSync(path.join(candidate, 'renamed'), path.join(candidate, 'pkg'));
    for (const name of ['pkg', '.bin']) fs.chmodSync(path.join(candidate, name), 0o700);
});

for (const aliases of [2, 3]) {
    test(`v2 seals ${aliases} internal aliases once and matches an independent clone`, t => {
        const { root, tree } = fixture(t), original = path.join(tree, 'pkg/cli');
        fs.chmodSync(original, 0o755);
        for (let i = 1; i < aliases; i += 1) fs.linkSync(original, path.join(tree, `alias${i}`));
        const clone = path.join(root, 'clone'); fs.cpSync(tree, clone, { recursive: true, verbatimSymlinks: true });
        assert.equal(fs.statSync(path.join(clone, 'pkg/cli')).nlink, 1);
        assert.deepEqual(hashDependencyTreeV2(tree), hashDependencyTreeV2(clone));
        const inode = fs.statSync(original).ino, actualChmod = fs.fchmodSync; let calls = 0;
        t.mock.method(fs, 'fchmodSync', (fd, mode) => {
            if (fs.fstatSync(fd).ino === inode) calls += 1;
            return actualChmod(fd, mode);
        });
        const sealed = sealDependencyTreeV2(tree);
        assert.equal(calls, 1);
        assert.deepEqual(sealed, sealDependencyTreeV2(clone));
        assert.equal(fs.statSync(original).nlink, aliases);
        assert.equal(fs.readFileSync(path.join(tree, '.bin/cli'), 'utf8'), 'native candidate');
        for (const directory of [tree, clone]) for (const child of ['pkg', '.bin']) fs.chmodSync(path.join(directory, child), 0o700);
    });
}

test('two internal aliases plus an external alias reject before any chmod', t => {
    const { root, tree } = fixture(t), original = path.join(tree, 'pkg/cli');
    fs.linkSync(original, path.join(tree, 'alias'));
    fs.linkSync(original, path.join(root, 'external'));
    let mutations = 0;
    t.mock.method(fs, 'chmodSync', () => { mutations += 1; });
    t.mock.method(fs, 'fchmodSync', () => { mutations += 1; });
    assert.throws(() => sealDependencyTreeV2(tree), /hardlink/);
    assert.equal(mutations, 0);
    assert.equal(fs.statSync(original).mode & 0o777, 0o644);
});

for (const field of ['ino', 'ctimeMs', 'nlink']) {
    test(`v2 refuses ${field} drift after inventory before chmod`, t => {
        const { tree } = fixture(t), original = path.join(tree, 'pkg/cli');
        fs.linkSync(original, path.join(tree, 'alias'));
        const actualStat = fs.lstatSync, actualFstat = fs.fstatSync;
        const inode = actualStat(original).ino; let inventoried = false, mutations = 0;
        // Initial record reads complete before the closing inventory metadata pass.
        let reads = 0;
        t.mock.method(fs, 'fstatSync', (...args) => {
            const stat = actualFstat(...args);
            if (stat.ino === inode && ++reads === 4) inventoried = true;
            return stat;
        });
        t.mock.method(fs, 'lstatSync', (...args) => {
            const stat = actualStat(...args);
            if (inventoried && stat.ino === inode) stat[field] += 1;
            return stat;
        });
        t.mock.method(fs, 'fchmodSync', () => { mutations += 1; });
        assert.throws(() => sealDependencyTreeV2(tree), /changed/);
        assert.equal(mutations, 0);
    });
}

test('seal refuses a replaced alias after pinning without chmod of that inode', t => {
    const { tree } = fixture(t), original = path.join(tree, 'pkg/cli');
    const alias = path.join(tree, 'alias'); fs.linkSync(original, alias);
    const actualFstat = fs.fstatSync, actualChmod = fs.fchmodSync;
    const inode = fs.statSync(original).ino; let calls = 0, altered = false;
    t.mock.method(fs, 'fstatSync', fd => {
        const stat = actualFstat(fd);
        if (stat.ino === inode && ++calls === 7) {
            fs.unlinkSync(alias); fs.writeFileSync(alias, 'replacement'); altered = true;
        }
        return stat;
    });
    let originalChmod = 0;
    t.mock.method(fs, 'fchmodSync', (fd, mode) => {
        if (actualFstat(fd).ino === inode) originalChmod += 1;
        return actualChmod(fd, mode);
    });
    assert.throws(() => sealDependencyTreeV2(tree), /changed/);
    assert.equal(altered, true);
    assert.equal(originalChmod, 0);
});

test('seal rechecks pinned fd metadata before the first chmod', t => {
    const { tree } = fixture(t), original = path.join(tree, 'pkg/cli');
    const inode = fs.statSync(original).ino, actualFstat = fs.fstatSync;
    let reads = 0, mutations = 0;
    t.mock.method(fs, 'fstatSync', fd => {
        const stat = actualFstat(fd);
        if (stat.ino === inode && ++reads === 3) stat.ctimeMs += 1;
        return stat;
    });
    t.mock.method(fs, 'fchmodSync', () => { mutations += 1; });
    assert.throws(() => sealDependencyTreeV2(tree), /changed/);
    assert.equal(mutations, 0);
});

test('seal repeats complete hardlink closure after changing modes', t => {
    const { root, tree } = fixture(t), original = path.join(tree, 'pkg/cli');
    const inode = fs.statSync(original).ino, actualChmod = fs.fchmodSync;
    t.mock.method(fs, 'fchmodSync', (fd, mode) => {
        actualChmod(fd, mode);
        if (fs.fstatSync(fd).ino === inode) fs.linkSync(original, path.join(root, 'late-external'));
    });
    assert.throws(() => sealDependencyTreeV2(tree), /hardlink/);
});

test('EMFILE while pinning closes every opened descriptor before any chmod', t => {
    const { tree } = fixture(t), actualOpen = fs.openSync, actualClose = fs.closeSync;
    const opened = new Set(), pinned = new Set(), closedPinned = new Set();
    let pinning = false, pinAttempts = 0, mutations = 0;
    t.mock.method(fs, 'openSync', (...args) => {
        if (args[0] === tree) pinning = true;
        if (pinning && ++pinAttempts === 3) throw Object.assign(new Error('test descriptor exhaustion'), { code: 'EMFILE' });
        const fd = actualOpen(...args); opened.add(fd);
        if (pinning) pinned.add(fd);
        return fd;
    });
    t.mock.method(fs, 'closeSync', fd => {
        assert.ok(opened.has(fd), 'only an open descriptor may be closed');
        if (pinned.has(fd)) closedPinned.add(fd);
        opened.delete(fd); return actualClose(fd);
    });
    t.mock.method(fs, 'chmodSync', () => { mutations += 1; });
    t.mock.method(fs, 'fchmodSync', () => { mutations += 1; });
    assert.throws(() => sealDependencyTreeV2(tree), error => error.code === 'EMFILE');
    assert.equal(pinAttempts, 3); assert.equal(pinned.size, 2);
    assert.deepEqual(closedPinned, pinned); assert.equal(opened.size, 0); assert.equal(mutations, 0);
});
