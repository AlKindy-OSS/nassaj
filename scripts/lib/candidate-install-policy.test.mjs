import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateInstallScriptInventory } from './candidate-install-policy.mjs';

test('release policy covers exactly the seven reviewed Linux lifecycle versions', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
    const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url)));
    const result = validateInstallScriptInventory(pkg, lock, { platform: 'linux', arch: 'x64' });
    assert.deepEqual(result.applicable.map(item => item.identity).sort(), [
        '@vscode/ripgrep@1.17.1', 'argon2@0.44.0', 'bcrypt@6.0.0', 'better-sqlite3@12.6.2',
        'esbuild@0.28.2', 'node-pty@1.2.0-beta.12', 'unrs-resolver@1.11.1',
    ].sort());
    assert.deepEqual(result.excluded, ['fsevents@2.3.2', 'fsevents@2.3.3']);
    assert.equal(Object.keys(pkg.allowScripts).length, 7);
});

test('a changed script-bearing dependency needs its exact release approval', () => {
    const pkg = { allowScripts: { 'native@1.0.0': true } };
    const lock = { packages: { 'node_modules/native': { version: '2.0.0', hasInstallScript: true } } };
    assert.throws(() => validateInstallScriptInventory(pkg, lock), /unreviewed/);
    pkg.allowScripts['native@2.0.0'] = true;
    assert.equal(validateInstallScriptInventory(pkg, lock).applicable[0].allowed, true);
    pkg.allowScripts['native@2.0.0'] = false;
    assert.equal(validateInstallScriptInventory(pkg, lock).applicable[0].allowed, false);
});

test('broad, missing and nonboolean policy entries fail before installation', () => {
    const lock = { packages: {} };
    for (const pkg of [{}, { allowScripts: { '*': true } }, { allowScripts: { 'native@^1.0.0': true } },
        { allowScripts: { 'native@1.0.0': 'true' } }]) assert.throws(() => validateInstallScriptInventory(pkg, lock), /policy/);
});
