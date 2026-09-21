import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stageFixtureInstalledSupport } from './installed-config-authority.mjs';

test('fixture support directories stay non-writable under umask 0002', t => {
    fs.mkdirSync('.artifacts', { recursive: true });
    const root = fs.mkdtempSync(path.join('.artifacts', 'nassaj-fixture-support-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previousUmask = process.umask(0o002);
    try {
        const support = stageFixtureInstalledSupport(root);
        const pending = [support.directory];
        while (pending.length) {
            const directory = pending.pop();
            const info = fs.lstatSync(directory);
            assert.equal(info.mode & 0o022, 0, directory);
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
            }
        }
    } finally {
        process.umask(previousUmask);
    }
});
