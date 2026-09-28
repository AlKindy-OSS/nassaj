import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { collectTreeEntries } from './deterministic-tar.mjs';
import {
    GENERATION_FILES_SCHEMA, buildFileManifest, computeGlibcFloor, glibcExceeds, maxGlibcMinor,
} from './generation-files.mjs';

/** A 20-byte ELF64 header prefix with e_machine `machine` in the given byte order. */
function elfHeader(machine, bigEndian = false) {
    const head = Buffer.alloc(20);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, bigEndian ? 2 : 1, 1, 0]).copy(head);
    if (bigEndian) head.writeUInt16BE(machine, 18); else head.writeUInt16LE(machine, 18);
    return head;
}
const ELF = elfHeader(62);
const X64 = { target: 'linux-x64-glibc' };

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-files-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('maxGlibcMinor reads the highest GLIBC_2.x and ignores look-alikes', () => {
    assert.equal(maxGlibcMinor(Buffer.from('GLIBC_2.2.5\0GLIBC_2.34\0GLIBC_2.17\0')), 34);
    assert.equal(maxGlibcMinor(Buffer.from('GLIBC_PRIVATE\0GLIBCXX_3.4.30\0')), -1);
    assert.equal(maxGlibcMinor(Buffer.from('GLIBC_2.38x')), 38);
    assert.equal(maxGlibcMinor(Buffer.from('')), -1);
});

test('the glibc floor is the maximum over ELF files only', t => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'addon.node'), Buffer.concat([ELF, Buffer.from('GLIBC_2.29\0GLIBC_2.14\0')]));
    fs.writeFileSync(path.join(dir, 'node'), Buffer.concat([ELF, Buffer.from('GLIBC_2.28\0')]));
    fs.writeFileSync(path.join(dir, 'static-rg'), Buffer.concat([ELF, Buffer.from('no versions')]));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'GLIBC_2.99 mentioned in text');
    fs.writeFileSync(path.join(dir, 'short'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const result = computeGlibcFloor(collectTreeEntries(dir), X64);
    assert.equal(result.floor, '2.29');
    assert.deepEqual(result.elfFiles.map(entry => [entry.path, entry.glibc]),
        [['addon.node', '2.29'], ['node', '2.28'], ['static-rg', null]]);
});

test('ELF files for another machine are listed but never raise the floor', t => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'x64.node'), Buffer.concat([ELF, Buffer.from('GLIBC_2.28\0')]));
    fs.writeFileSync(path.join(dir, 'arm64.node'), Buffer.concat([elfHeader(183), Buffer.from('GLIBC_2.39\0')]));
    fs.writeFileSync(path.join(dir, 'ppc.node'), Buffer.concat([elfHeader(21, true), Buffer.from('GLIBC_2.40\0')]));
    const x64 = computeGlibcFloor(collectTreeEntries(dir), X64);
    assert.equal(x64.floor, '2.28');
    assert.deepEqual(x64.foreignElfFiles, [{ path: 'arm64.node', machine: 183 }, { path: 'ppc.node', machine: 21 }]);
    const arm = computeGlibcFloor(collectTreeEntries(dir), { target: 'linux-arm64-glibc' });
    assert.equal(arm.floor, '2.39');
    assert.throws(() => computeGlibcFloor([], { target: 'darwin-x64' }), /unknown target/);
    assert.throws(() => computeGlibcFloor([]), /unknown target/);
});

test('no ELF with glibc versions yields a null floor', t => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'a.js'), 'x');
    assert.equal(computeGlibcFloor(collectTreeEntries(dir), X64).floor, null);
});

test('glibcExceeds compares minor versions numerically', () => {
    assert.equal(glibcExceeds('2.38', '2.34'), true);
    assert.equal(glibcExceeds('2.34', '2.34'), false);
    assert.equal(glibcExceeds('2.4', '2.34'), false);
});

test('the file manifest is canonical, lists dirs and files, and hashes each file', t => {
    const dir = scratch(t);
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'tool'), 'run');
    fs.chmodSync(path.join(dir, 'bin', 'tool'), 0o750);
    const { bytes, files } = buildFileManifest(collectTreeEntries(dir));
    const text = bytes.toString('utf8');
    assert.ok(text.endsWith('}\n') && !text.includes(' '));
    const document = JSON.parse(text);
    assert.equal(document.schema, GENERATION_FILES_SCHEMA);
    assert.deepEqual(files, [
        { path: 'bin', type: 'dir', mode: 0o755 },
        { path: 'bin/tool', type: 'file', mode: 0o755, size: 3, sha256: createHash('sha256').update('run').digest('hex') },
    ]);
    assert.deepEqual(buildFileManifest(collectTreeEntries(dir)).bytes, bytes);
});
