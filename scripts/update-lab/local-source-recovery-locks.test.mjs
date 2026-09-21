import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureRecoveryLockBaseline,initializeRecoveryLockBaseline} from './local-source-recovery-locks.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const names=['nassaj-preview-event-mutation.lock','nassaj-local-preview-build.lock','nassaj-client-build.lock'];

function fixture(t) {
    const root=fs.mkdtempSync(path.join(project,'.artifacts/recovery-lock-test-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const baseline=path.join(root,'baseline'),destination=path.join(root,'destination');
    fs.mkdirSync(baseline);fs.mkdirSync(destination);
    for(const name of names)fs.writeFileSync(path.join(baseline,name),'baseline sentinel',{mode:0o644});
    return {root,baseline,destination};
}

test('fresh fixture retains all baseline lock modes and leaves baseline bytes and inodes unchanged',t=>{
    const f=fixture(t),before=captureRecoveryLockBaseline(f.baseline),umask=process.umask();
    const actual=initializeRecoveryLockBaseline(f.destination,before);
    assert.deepEqual(actual.locks.map(({name,mode,uid})=>({name,mode,uid})),before.locks.map(({name,mode,uid})=>({name,mode,uid})));
    assert.deepEqual(captureRecoveryLockBaseline(f.baseline),before);
    for(const name of names){assert.equal(fs.readFileSync(path.join(f.destination,name)).length,0);assert.equal(fs.readFileSync(path.join(f.baseline,name),'utf8'),'baseline sentinel');}
    assert.equal(process.umask(),umask);
});

test('baseline lacking owner read/write, allowing group write, or using symlinks is rejected before creation',t=>{
    const f=fixture(t),file=path.join(f.baseline,names[0]);
    for(const mode of [0,0o400,0o200,0o664]) {
        fs.chmodSync(file,mode);
        assert.throws(()=>captureRecoveryLockBaseline(f.baseline),/baseline_unsafe/);
    }
    fs.unlinkSync(file);fs.symlinkSync(path.join(f.baseline,names[1]),file);
    assert.throws(()=>captureRecoveryLockBaseline(f.baseline),/baseline_unsafe/);
    assert.deepEqual(fs.readdirSync(f.destination),[]);
});

test('any existing destination including dangling symlink prevents all creation and permission changes',t=>{
    const f=fixture(t),baseline=captureRecoveryLockBaseline(f.baseline),file=path.join(f.destination,names[2]);
    fs.writeFileSync(file,'unknown state',{mode:0o600});const original=fs.statSync(file);
    assert.throws(()=>initializeRecoveryLockBaseline(f.destination,baseline),/destination_exists/);
    assert.deepEqual(fs.readdirSync(f.destination),[names[2]]);assert.equal(fs.readFileSync(file,'utf8'),'unknown state');
    assert.equal(fs.statSync(file).ino,original.ino);assert.equal(fs.statSync(file).mode,original.mode);
    fs.unlinkSync(file);fs.symlinkSync(path.join(f.root,'missing'),file);
    assert.throws(()=>initializeRecoveryLockBaseline(f.destination,baseline),/destination_exists/);
    assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
});

test('invalid captured contract and source destination are rejected before writes',t=>{
    const f=fixture(t),baseline=captureRecoveryLockBaseline(f.baseline);
    for(const patch of [{mode:0o664},{mode:0o4644},{mode:0},{mode:0o400},{mode:0o200},{uid:process.getuid()+1},{name:'../outside.lock'}]) {
        const invalid=structuredClone(baseline);Object.assign(invalid.locks[0],patch);
        assert.throws(()=>initializeRecoveryLockBaseline(f.destination,invalid),/baseline_unsafe/);
    }
    assert.throws(()=>initializeRecoveryLockBaseline(f.baseline,baseline),/destination_unsafe/);
    assert.deepEqual(fs.readdirSync(f.destination),[]);
});
