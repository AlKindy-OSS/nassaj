import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
    createSourceVersionHealthMiddleware,
    createSourceVersionReader,
} from './source-version.service.js';

function createFixture(t, contents) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-source-version-'));
    const packageJsonPath = path.join(fixtureDir, 'package.json');
    fs.writeFileSync(packageJsonPath, contents);
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
    return packageJsonPath;
}

test('reads a canonical four-part source version', (t) => {
    const packageJsonPath = createFixture(t, JSON.stringify({ version: '1.44.0.1' }));
    const readSourceVersion = createSourceVersionReader(packageJsonPath);

    assert.equal(readSourceVersion(), '1.44.0.1');
});

test('observes a package.json version change without recreating the reader', (t) => {
    const packageJsonPath = createFixture(t, JSON.stringify({ version: '1.44.0.1' }));
    const readSourceVersion = createSourceVersionReader(packageJsonPath);
    assert.equal(readSourceVersion(), '1.44.0.1');

    const replacementPath = `${packageJsonPath}.next`;
    fs.writeFileSync(replacementPath, JSON.stringify({ version: '1.44.0.2' }));
    fs.renameSync(replacementPath, packageJsonPath);

    assert.equal(readSourceVersion(), '1.44.0.2');
});

test('returns null for invalid or temporarily unavailable package data and recovers', (t) => {
    const packageJsonPath = createFixture(t, JSON.stringify({ version: '1.44.0' }));
    const readSourceVersion = createSourceVersionReader(packageJsonPath);
    assert.equal(readSourceVersion(), null);

    fs.writeFileSync(packageJsonPath, '{invalid json');
    assert.equal(readSourceVersion(), null);

    fs.writeFileSync(packageJsonPath, JSON.stringify({ version: '2.0.0.0' }));
    assert.equal(readSourceVersion(), '2.0.0.0');
});

test('/health returns the canonical source version, disables caching, and observes atomic replacement', async (t) => {
    const packageJsonPath = createFixture(t, JSON.stringify({ version: '1.44.0.1' }));
    const app = express();
    app.get('/health', createSourceVersionHealthMiddleware(packageJsonPath), (_req, res) => {
        res.json({ sourceVersion: res.locals.sourceVersion });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    const healthUrl = `http://127.0.0.1:${address.port}/health`;

    const firstResponse = await fetch(healthUrl);
    assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await firstResponse.json(), { sourceVersion: '1.44.0.1' });

    const replacementPath = `${packageJsonPath}.next`;
    fs.writeFileSync(replacementPath, JSON.stringify({ version: '1.44.0.2' }));
    fs.renameSync(replacementPath, packageJsonPath);

    const secondResponse = await fetch(healthUrl);
    assert.equal(secondResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await secondResponse.json(), { sourceVersion: '1.44.0.2' });
});
