import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import { mergeLegacyAssets, promoteWithExchange, supportsAtomicExchange } from './client-build-atomic.mjs';

const EXCHANGE_SUPPORTED = supportsAtomicExchange();

function scratch() {
    return mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'client-http-atomic-'));
}

function writeGeneration(directory, generation) {
    const emittedAssets = [
        `assets/entry-${generation}.js`,
        `assets/lazy-${generation}.js`,
    ];
    mkdirSync(path.join(directory, 'assets'), { recursive: true });
    writeFileSync(
        path.join(directory, 'index.html'),
        `<main data-generation="${generation}"></main><script src="/assets/entry-${generation}.js"></script>`,
    );
    writeFileSync(path.join(directory, emittedAssets[0]), `globalThis.entryGeneration=${generation};`);
    writeFileSync(path.join(directory, emittedAssets[1]), `globalThis.lazyGeneration=${generation};`);
    writeFileSync(
        path.join(directory, 'ATOMIC_GENERATION.json'),
        `${JSON.stringify({ buildId: String(generation), emittedAssets })}\n`,
    );
}

async function listen(directory) {
    const app = express();
    app.use(express.static(directory));
    const server = http.createServer(app);
    const webSockets = new WebSocketServer({ server });
    webSockets.on('connection', (socket) => {
        socket.on('message', (payload) => socket.send(payload));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    return { server, webSockets, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server, webSockets) {
    await new Promise((resolve) => webSockets.close(resolve));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('HTTP stays coherent across exchanges and an old tab keeps its lazy asset', { skip: !EXCHANGE_SUPPORTED }, async () => {
    const root = scratch();
    const live = path.join(root, 'dist');
    writeGeneration(live, 0);
    const { server, webSockets, origin } = await listen(live);
    const socket = new WebSocket(origin.replace('http:', 'ws:'));
    await once(socket, 'open');
    let stopped = false;
    const failures = [];

    const reader = async () => {
        while (!stopped) {
            try {
                const htmlResponse = await fetch(`${origin}/index.html`, { cache: 'no-store' });
                assert.equal(htmlResponse.status, 200);
                const html = await htmlResponse.text();
                const entry = html.match(/src="([^"]+)"/)?.[1];
                assert(entry, 'served HTML must reference its entry asset');
                const entryResponse = await fetch(`${origin}${entry}`, { cache: 'no-store' });
                assert.equal(entryResponse.status, 200, `entry disappeared after serving HTML: ${entry}`);

                const oldLazy = await fetch(`${origin}/assets/lazy-0.js`, { cache: 'no-store' });
                assert.equal(oldLazy.status, 200, 'the original tab lost its not-yet-loaded lazy chunk');
                assert.equal(await oldLazy.text(), 'globalThis.lazyGeneration=0;');
            } catch (error) {
                failures.push(error);
                return;
            }
        }
    };

    const readers = Array.from({ length: 4 }, reader);
    try {
        for (let generation = 1; generation <= 12; generation += 1) {
            const staged = path.join(root, `staged-${generation}`);
            writeGeneration(staged, generation);
            mergeLegacyAssets(live, staged);
            promoteWithExchange(staged, live);
            // The production publisher retains exchanged-out directories rather
            // than deleting them while requests may still hold filesystem paths.
            renameSync(staged, path.join(root, `retained-${generation}`));
            const echoed = once(socket, 'message');
            socket.send(String(generation));
            assert.equal(String((await echoed)[0]), String(generation), 'the live WebSocket was interrupted by a client publish');
            await new Promise((resolve) => setImmediate(resolve));
        }
    } finally {
        stopped = true;
        await Promise.all(readers);
        socket.close();
        await once(socket, 'close');
        await close(server, webSockets);
        rmSync(root, { recursive: true, force: true });
    }

    assert.deepEqual(failures, []);
});

test('a failed exchange leaves the staged generation intact', () => {
    const root = scratch();
    try {
        const staged = path.join(root, 'staged');
        mkdirSync(staged);
        writeFileSync(path.join(staged, 'sentinel'), 'candidate');
        assert.throws(() => promoteWithExchange(staged, path.join(root, 'missing-live')), /Atomic exchange failed/);
        assert.equal(readFileSync(path.join(staged, 'sentinel'), 'utf8'), 'candidate');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
