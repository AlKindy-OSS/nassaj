import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { runForwardSupervisorChild, prepareForwardSupervisorIntent, inspectForwardLiveWork } from './lib/release-runtime-forward-supervisor.mjs';

test('fixed safe-restart phase routes only stop/start with literal operation argument to the local facade', t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/forward-safe-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'safe-restart.sh'); fs.copyFileSync(path.resolve('scripts/safe-restart.sh'), script);
    // Routing-only fixture: this facade has no authority or effects and is never packaged.
    fs.writeFileSync(path.join(root, 'release-runtime-forward-parent.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const operation = 'literal-$(must-not-execute)';
    for (const phase of ['stop', 'start']) {
        const output = execFileSync('/bin/bash', [script, '--first-forward-phase', phase, '--operation', operation], {
            cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 3000 });
        assert.deepEqual(JSON.parse(output), ['--supervisor-child', phase, operation]);
    }
    for (const args of [['--first-forward-phase', 'restart', '--operation', 'fixture-operation'],
        ['--first-forward-phase', 'stop', '--operation', 'fixture-operation', '--force']]) {
        assert.throws(() => execFileSync('/bin/bash', [script, ...args], { cwd: root, stdio: 'pipe', timeout: 3000 }), error => error.status === 7);
    }
});
test('non-root supervisor entry rejects before reading root configuration or performing credential/PM2 effects', async () => {
    if (process.geteuid() === 0) return;
    await assert.rejects(runForwardSupervisorChild('stop', 'fixture-operation'), /request_invalid/);
    assert.throws(() => prepareForwardSupervisorIntent({}, 'stop'), /root_phase_required/);
});

test('pre-effect live-work probe returns only bounded counters and distinguishes busy from unknown',()=>{
    const config={zeroWorkProbe:{file:'/pinned/probe',sha256:'a'.repeat(64),args:['--read-only'],timeoutMs:1000}};
    const deps={readPin:()=>{},exec:()=>JSON.stringify({liveSessions:1,workflows:0,admittedTurns:0,privateDetail:'not exposed'})};
    assert.deepEqual(inspectForwardLiveWork(config,deps),{busy:true,counters:{liveSessions:1,workflows:0,admittedTurns:0}});
    assert.equal(inspectForwardLiveWork(config,{...deps,exec:()=>JSON.stringify({liveSessions:0,workflows:0,admittedTurns:0})}).busy,false);
    for(const value of [-1,1.5,'0',null])assert.throws(()=>inspectForwardLiveWork(config,{...deps,exec:()=>JSON.stringify({liveSessions:value,workflows:0,admittedTurns:0})}),/counters/);
    assert.throws(()=>inspectForwardLiveWork(config,{...deps,exec:()=>{throw Error('probe lost');}}),/probe_unknown/);
});
