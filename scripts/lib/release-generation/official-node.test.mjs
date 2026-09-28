import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ensureNodeTarball, nodePinFor, unpackNode } from './official-node.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const BYTES = Buffer.from('pretend node tarball');

function pins(overrides = {}) {
    return { node: { version: '24.18.1', targets: { 'linux-x64-glibc': {
        file: 'node-v24.18.1-linux-x64.tar.xz', sha256: sha(BYTES), ...overrides } } } };
}

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-node-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function fakeFetch(body, status = 200) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return { ok: status === 200, status, arrayBuffer: async () => body };
    };
    return { calls, fetchImpl };
}

test('nodePinFor derives the nodejs.org URL and refuses malformed pins', () => {
    const pin = nodePinFor(pins(), 'linux-x64-glibc');
    assert.equal(pin.url, 'https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.xz');
    assert.throws(() => nodePinFor(pins(), 'linux-arm64-glibc'), /node_pin_invalid/);
    assert.throws(() => nodePinFor(pins({ sha256: 'ABC' }), 'linux-x64-glibc'), /node_pin_invalid/);
    assert.throws(() => nodePinFor(pins({ file: 'node-v1.0.0-linux-x64.tar.xz' }), 'linux-x64-glibc'), /node_pin_invalid/);
    assert.throws(() => nodePinFor(pins({ file: '../evil.tar.xz' }), 'linux-x64-glibc'), /node_pin_invalid/);
});

test('a tarball matching the pin is downloaded once and then reused from the cache', async t => {
    const dir = scratch(t);
    const pin = nodePinFor(pins(), 'linux-x64-glibc');
    const { calls, fetchImpl } = fakeFetch(BYTES);
    const file = await ensureNodeTarball({ pin, cacheDir: dir, fetchImpl });
    assert.deepEqual(fs.readFileSync(file), BYTES);
    assert.equal(calls[0].options.redirect, 'error');
    await ensureNodeTarball({ pin, cacheDir: dir, fetchImpl });
    assert.equal(calls.length, 1, 'verified cache hit must not download again');
});

test('a digest mismatch is refused and leaves nothing usable behind', async t => {
    const dir = scratch(t);
    const pin = nodePinFor(pins(), 'linux-x64-glibc');
    await assert.rejects(ensureNodeTarball({ pin, cacheDir: dir, fetchImpl: fakeFetch(Buffer.from('tampered')).fetchImpl }),
        /node_tarball_digest_mismatch/);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('a tampered cached copy is replaced by a fresh verified download', async t => {
    const dir = scratch(t);
    const pin = nodePinFor(pins(), 'linux-x64-glibc');
    fs.writeFileSync(path.join(dir, pin.file), 'stale');
    const { calls, fetchImpl } = fakeFetch(BYTES);
    const file = await ensureNodeTarball({ pin, cacheDir: dir, fetchImpl });
    assert.equal(calls.length, 1);
    assert.deepEqual(fs.readFileSync(file), BYTES);
});

test('an HTTP error is reported with its status', async t => {
    const dir = scratch(t);
    const pin = nodePinFor(pins(), 'linux-x64-glibc');
    await assert.rejects(ensureNodeTarball({ pin, cacheDir: dir, fetchImpl: fakeFetch(BYTES, 404).fetchImpl }),
        /node_download_failed: HTTP 404/);
});

test('unpackNode requires node, npm and LICENSE in the unpacked tree', t => {
    const dir = scratch(t);
    const run = (command, args) => {
        const destination = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'bin', 'node'), '');
        fs.writeFileSync(path.join(destination, 'LICENSE'), '');
        return { status: 0 };
    };
    assert.throws(() => unpackNode('x.tar.xz', path.join(dir, 'a'), run), /node_unpack_incomplete: .*npm-cli\.js/);
    assert.throws(() => unpackNode('x.tar.xz', path.join(dir, 'b'), () => ({ status: 2, stderr: 'bad' })),
        /node_unpack_failed: bad/);
});
