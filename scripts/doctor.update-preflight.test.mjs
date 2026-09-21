import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PREFLIGHT_CODES } from './lib/update-preflight-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.mjs');

/**
 * A PATH prefix holding stub `pm2` and `git` executables, so the run is fast,
 * offline, and says exactly what this test needs it to say.
 */
function stubBin(t, { pm2Account, gitExit = 1, pm2Unavailable = false }) {
    const bin = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-doctor-bin-'));
    t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
    const jlist = JSON.stringify(pm2Unavailable ? [] : [{ name: 'nassaj-dev', pm2_env: { pm_cwd: ROOT, USER: pm2Account } }]);
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\n[ "$1" = jlist ] && echo '${jlist}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nexit ${gitExit}\n`, { mode: 0o755 });
    return bin;
}

const runDoctor = (bin, extraEnv = {}) => spawnSync(process.execPath, [DOCTOR, '--update-preflight'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS: '2000',
        ...extraEnv,
    },
});

test('the doctor file holds no writer primitive, so the READ-ONLY contract is structural', () => {
    const source = fs.readFileSync(DOCTOR, 'utf8');
    const writers = [
        'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
        'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync',
        'chmod', 'chmodSync', 'chown', 'chownSync', 'copyFile', 'copyFileSync',
        'truncate', 'truncateSync', 'symlink', 'symlinkSync', 'link', 'linkSync',
        'createWriteStream', 'utimes', 'utimesSync', 'open', 'openSync', 'mkdtemp', 'mkdtempSync',
    ];
    for (const writer of writers) {
        // member access on any binding (fs.x, fsp.x, fs.promises.x) ...
        assert.doesNotMatch(source, new RegExp(`\\.\\s*${writer}\\s*\\(`),
            `doctor.mjs must not call .${writer}()`);
        // ... and a named import that would let it be called bare.
        assert.doesNotMatch(source, new RegExp(`^import\\s*\\{[^}]*\\b${writer}\\b`, 'm'),
            `doctor.mjs must not import ${writer}`);
    }
    assert.doesNotMatch(source, /fs\/promises|fs\.promises/, 'the promise API is another door to the same writers');
    assert.match(source, /Contract: READ-ONLY/);
});

test('a run by the wrong account is reported as a false green and exits non-zero', (t) => {
    const result = runDoctor(stubBin(t, { pm2Account: 'someone-else' }));
    assert.match(result.stdout, /FALSE GREEN/);
    assert.match(result.stdout, /running as ".+" but pm2 runs "nassaj-dev" as "someone-else"/);
    assert.match(result.stdout, /sudo -u someone-else/);
    assert.equal(result.status, 1);
});

test('an operator token in the environment is called out explicitly', (t) => {
    const result = runDoctor(stubBin(t, { pm2Account: os.userInfo().username }), { GH_TOKEN: 'x' });
    assert.match(result.stdout, /GH_TOKEN present in this shell/);
    assert.match(result.stdout, /env -u GH_TOKEN/);
});

test('every code prints one reason and one action in Arabic and English', (t) => {
    const result = runDoctor(stubBin(t, { pm2Account: 'someone-else' }));
    for (const code of PREFLIGHT_CODES) assert.ok(result.stdout.includes(code), `missing code ${code}`);
    assert.match(result.stdout, /ع:/);
    assert.match(result.stdout, /en:/);
    assert.match(result.stdout, /الحاجز \/ blocker:/);
    assert.match(result.stdout, /blocker\(s\)/);
    assert.match(result.stdout, /write actions: none/);
});

test('an unverifiable service account is a failure, never a silent pass (م-4)', (t) => {
    const result = runDoctor(stubBin(t, { pm2Account: 'nobody', pm2Unavailable: true }));
    assert.match(result.stdout, /UNTRUSTED/);
    assert.match(result.stdout, /cannot be verified/);
    assert.match(result.stdout, /حكم غير موثوق/);
    assert.equal(result.status, 1, 'an unverified run must never exit 0');
});

test('the installed updater version the verdict rests on is printed', (t) => {
    const result = runDoctor(stubBin(t, { pm2Account: os.userInfo().username }));
    assert.match(result.stdout, /installed updater on this node:/);
});

test('the default mode is untouched and still reports boot readiness', () => {
    const result = spawnSync(process.execPath, [DOCTOR], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    assert.match(result.stdout, /nassaj doctor/);
    assert.match(result.stdout, /node runtime/);
    assert.doesNotMatch(result.stdout, /update preflight/);
});
