import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package-lock resolves registry packages only from the canonical npm registry', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const nonCanonical = Object.entries(lock.packages ?? {}).flatMap(([packagePath, value]) => {
        if (typeof value?.resolved !== 'string' || !value.resolved.startsWith('https://')) return [];
        const host = new URL(value.resolved).hostname;
        return host === 'registry.npmjs.org' ? [] : [{ packagePath, host }];
    });
    assert.deepEqual(nonCanonical, [], 'npm 12 rejects non-canonical remote tarball hosts with EALLOWREMOTE');
});
