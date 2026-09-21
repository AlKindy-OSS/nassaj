import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveForwardBashPath } from './lib/release-runtime-forward-child-protocol.mjs';
import { readPinnedForwardBytes } from './release-runtime-forward-child.mjs';
import { runForwardSupervisorPhase } from './lib/release-runtime-forward-supervisor.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('system Bash resolves to the canonical pinned executable without relaxing realpath checks', () => {
    const path = resolveForwardBashPath(); const bytes = fs.readFileSync(path);
    assert.equal(path, fs.realpathSync('/bin/bash'));
    assert.deepEqual(readPinnedForwardBytes({ path, sha256: sha(bytes) }), bytes);
});
for (const canonical of ['/bin/bash', '/usr/bin/bash']) test(`fixed system resolver supports ${canonical} layout`, t => {
    t.mock.method(fs, 'realpathSync', file => { assert.equal(file, '/bin/bash'); return canonical; });
    assert.equal(resolveForwardBashPath(), canonical);
});
test('redirecting the fixed system Bash name outside standard layouts is denied', t => {
    t.mock.method(fs, 'realpathSync', () => '/opt/untrusted/bash');
    assert.throws(resolveForwardBashPath, /system_path_invalid/);
});
for (const variant of ['alias', 'hash', 'arbitrary']) test(`supervisor rejects ${variant} before preparing an effect intent`, async () => {
    const canonical = resolveForwardBashPath(); const bash = { path: canonical, sha256: sha(fs.readFileSync(canonical)) };
    if (variant === 'alias') bash.path = canonical === '/bin/bash' ? '/usr/bin/bash' : '/bin/bash';
    if (variant === 'hash') bash.sha256 = '0'.repeat(64);
    if (variant === 'arbitrary') bash.path = '/opt/untrusted/bash';
    await assert.rejects(runForwardSupervisorPhase({ forwardActivation: { bash } }, 'stop'), /bash_pin_invalid|pin_mismatch/);
});
