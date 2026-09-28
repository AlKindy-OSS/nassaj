import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
    collectTreeEntries, normaliseFileMode, paxRecord, ustarHeader, writeDeterministicTarGz,
} from './deterministic-tar.mjs';

const LONG = `${'deep/'.repeat(30)}file.txt`;

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'det-tar-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function makeTree(root, order) {
    const files = { 'b.txt': 'bravo', 'a/x.bin': 'x', 'bin/tool': '#!/bin/sh\n', [LONG]: 'long', 'ملف.txt': 'arabic' };
    for (const name of order(Object.keys(files))) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), files[name]);
    }
    fs.chmodSync(path.join(root, 'bin/tool'), 0o700);
    fs.chmodSync(path.join(root, 'b.txt'), 0o600);
    fs.mkdirSync(path.join(root, 'empty'));
}

test('the same tree built in a different order and at different times gives identical bytes', async t => {
    const dir = scratch(t);
    makeTree(path.join(dir, 'one'), names => names);
    makeTree(path.join(dir, 'two'), names => [...names].reverse());
    fs.utimesSync(path.join(dir, 'two', 'b.txt'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    await writeDeterministicTarGz({ root: path.join(dir, 'one'), outputFile: path.join(dir, 'one.tar.gz') });
    await writeDeterministicTarGz({ root: path.join(dir, 'two'), outputFile: path.join(dir, 'two.tar.gz') });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'one.tar.gz')), fs.readFileSync(path.join(dir, 'two.tar.gz')));
});

test('GNU tar reads the archive: sorted order, normalised modes, root owner, epoch mtime, long and non-ASCII names', async t => {
    const dir = scratch(t);
    makeTree(path.join(dir, 'tree'), names => names);
    const archive = path.join(dir, 'tree.tar.gz');
    await writeDeterministicTarGz({ root: path.join(dir, 'tree'), outputFile: archive });
    const listing = spawnSync('tar', ['-tvzf', archive, '--numeric-owner', '--utc'], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const lines = listing.stdout.trim().split('\n');
    assert.ok(lines.every(line => / 0\/0 /.test(line) && line.includes('1970-01-01 00:00')), listing.stdout);
    assert.match(lines.find(line => line.endsWith(' bin/tool')), /^-rwxr-xr-x /);
    assert.match(lines.find(line => line.endsWith(' b.txt')), /^-rw-r--r-- /);
    assert.match(lines.find(line => line.endsWith(' empty/')), /^drwxr-xr-x /);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', out]).status, 0);
    assert.equal(fs.readFileSync(path.join(out, LONG), 'utf8'), 'long');
    assert.equal(fs.readFileSync(path.join(out, 'ملف.txt'), 'utf8'), 'arabic');
});

test('entries are sorted by path bytes and directories precede their children', t => {
    const dir = scratch(t);
    makeTree(dir, names => names);
    const paths = collectTreeEntries(dir).map(entry => entry.path);
    const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(paths, sorted);
    assert.ok(paths.indexOf('bin') < paths.indexOf('bin/tool'));
});

test('a symlink fails the build instead of being archived', async t => {
    const dir = scratch(t);
    fs.mkdirSync(path.join(dir, 'tree'));
    fs.symlinkSync('/etc/passwd', path.join(dir, 'tree', 'link'));
    await assert.rejects(writeDeterministicTarGz({ root: path.join(dir, 'tree'), outputFile: path.join(dir, 'x.tar.gz') }),
        /generation_entry_unsupported/);
});

test('an existing output file is never overwritten', async t => {
    const dir = scratch(t);
    fs.mkdirSync(path.join(dir, 'tree'));
    fs.writeFileSync(path.join(dir, 'x.tar.gz'), 'keep');
    await assert.rejects(writeDeterministicTarGz({ root: path.join(dir, 'tree'), outputFile: path.join(dir, 'x.tar.gz') }),
        /EEXIST/);
    assert.equal(fs.readFileSync(path.join(dir, 'x.tar.gz'), 'utf8'), 'keep');
});

test('file modes collapse to 0755 or 0644', () => {
    assert.equal(normaliseFileMode(0o100700), 0o755);
    assert.equal(normaliseFileMode(0o100001), 0o755);
    assert.equal(normaliseFileMode(0o100600), 0o644);
    assert.equal(normaliseFileMode(0o100666), 0o644);
});

test('PAX record length counts its own digits, including across a digit boundary', () => {
    for (const value of ['x', 'a'.repeat(88), 'a'.repeat(89), 'a'.repeat(90), 'a'.repeat(990), 'ب'.repeat(50)]) {
        const record = paxRecord('path', value);
        const declared = Number(record.toString('utf8').split(' ')[0]);
        assert.equal(declared, record.length, `value length ${value.length}`);
    }
});

test('ustar header checksum is the unsigned byte sum with the field as spaces', () => {
    const header = ustarHeader({ name: 'a', mode: 0o644, size: 3, typeflag: '0', mtime: 0 });
    const stored = parseInt(header.subarray(148, 154).toString('ascii'), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    assert.equal(stored, copy.reduce((sum, byte) => sum + byte, 0));
    assert.throws(() => ustarHeader({ name: 'big', mode: 0o644, size: 8 ** 11, typeflag: '0', mtime: 0 }),
        /generation_entry_too_large/);
});
