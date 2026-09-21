import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { NODE_ENV_ALLOWLIST, parseAllowlistedEnv, loadNodeEnvAllowlist } from './node-env-allowlist.js';

test('the pinned allowlist holds TMPDIR alone (widening needs an ADR)', () => {
    assert.deepEqual([...NODE_ENV_ALLOWLIST], ['TMPDIR']);
});

test('parseAllowlistedEnv keeps only allowlisted keys and drops the rest', () => {
    const parsed = parseAllowlistedEnv([
        '# a comment',
        '',
        'TMPDIR=/var/tmp',
        'NODE_OPTIONS=--max-old-space-size=8192',
        'JWT_SECRET=super-secret',
        'NASSAJ_RELEASE_SOURCE=owner/repo',
    ].join('\n'));
    assert.equal(parsed.get('TMPDIR'), '/var/tmp');
    assert.equal(parsed.has('NODE_OPTIONS'), false);
    assert.equal(parsed.has('JWT_SECRET'), false);
    assert.equal(parsed.has('NASSAJ_RELEASE_SOURCE'), false);
    assert.equal(parsed.size, 1);
});

test('parseAllowlistedEnv tolerates values containing = and surrounding blanks', () => {
    const parsed = parseAllowlistedEnv('  TMPDIR = /var/tmp/a=b  ');
    assert.equal(parsed.get('TMPDIR'), '/var/tmp/a=b');
});

test('parseAllowlistedEnv ignores lines with no key or a leading =', () => {
    const parsed = parseAllowlistedEnv(['=orphan', 'TMPDIR', 'TMPDIR='].join('\n'));
    // "TMPDIR=" is a valid empty assignment; "TMPDIR" and "=orphan" are not.
    assert.equal(parsed.get('TMPDIR'), '');
    assert.equal(parsed.size, 1);
});

test('loadNodeEnvAllowlist fills only absent keys, never overriding the live env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-env-allow-'));
    try {
        const configPath = path.join(dir, 'node.env');
        fs.writeFileSync(configPath, 'TMPDIR=/var/tmp\n');

        const absent = {};
        const r1 = loadNodeEnvAllowlist({ configPath, env: absent });
        assert.equal(absent.TMPDIR, '/var/tmp');
        assert.deepEqual(r1.loaded, ['TMPDIR']);
        assert.deepEqual(r1.skipped, []);

        const preset = { TMPDIR: '/tmp/live-wins' };
        const r2 = loadNodeEnvAllowlist({ configPath, env: preset });
        assert.equal(preset.TMPDIR, '/tmp/live-wins');
        assert.deepEqual(r2.loaded, []);
        assert.deepEqual(r2.skipped, ['TMPDIR']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadNodeEnvAllowlist never throws on a missing file and touches nothing', () => {
    const env = { FOO: 'bar' };
    const result = loadNodeEnvAllowlist({ configPath: '/nonexistent/does/not/exist/node.env', env });
    assert.deepEqual(result, { loaded: [], skipped: [] });
    assert.deepEqual(env, { FOO: 'bar' });
});

test('loadNodeEnvAllowlist does not import a non-allowlisted key from the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-env-allow-'));
    try {
        const configPath = path.join(dir, 'node.env');
        fs.writeFileSync(configPath, 'NODE_OPTIONS=--inspect\nJWT_SECRET=leak\n');
        const env = {};
        loadNodeEnvAllowlist({ configPath, env });
        assert.equal('NODE_OPTIONS' in env, false);
        assert.equal('JWT_SECRET' in env, false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
