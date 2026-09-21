import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureRecoveryPm2DumpBaseline,assertRecoveryPm2DumpBaseline,initializeRecoveryPm2Dump} from './local-source-recovery-pm2-baseline.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function fixture(t) {
    const root=fs.mkdtempSync(path.join(project,'.artifacts/recovery-pm2-dump-test-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const live=path.join(root,'baseline'),target=path.join(root,'private');
    fs.mkdirSync(live,{mode:0o700});fs.mkdirSync(target,{mode:0o700});
    const dump=path.join(live,'dump.pm2');fs.writeFileSync(dump,'[{"fixture":"baseline contents must not be copied"}]',{mode:0o600});
    return {root,live,target,dump};
}

test('fresh PM2 seed is exclusive empty JSON0600 and preserves baseline identity and umask',t=>{
    const f=fixture(t),baseline=captureRecoveryPm2DumpBaseline(f.live),mask=process.umask();
    const seeded=initializeRecoveryPm2Dump(f.target,baseline);
    assert.equal(seeded.mode,0o600);assert.equal(seeded.nlink,1);assert.equal(seeded.uid,process.getuid());
    assert.deepEqual(JSON.parse(fs.readFileSync(seeded.file)),[]);assert.notEqual(seeded.sha256,baseline.sha256);
    assert.deepEqual(assertRecoveryPm2DumpBaseline(baseline),baseline);assert.equal(process.umask(),mask);
});

test('missing, unsafe permissions, symlink and hardlink PM2 baselines are rejected',t=>{
    const f=fixture(t);
    for(const mode of [0,0o400,0o644,0o664]){fs.chmodSync(f.dump,mode);assert.throws(()=>captureRecoveryPm2DumpBaseline(f.live),/baseline_unsafe/);}
    fs.chmodSync(f.dump,0o600);fs.linkSync(f.dump,path.join(f.root,'hardlink'));
    assert.throws(()=>captureRecoveryPm2DumpBaseline(f.live),/baseline_unsafe/);
    fs.unlinkSync(f.dump);assert.throws(()=>captureRecoveryPm2DumpBaseline(f.live),/ENOENT/);
    fs.symlinkSync(path.join(f.root,'hardlink'),f.dump);assert.throws(()=>captureRecoveryPm2DumpBaseline(f.live),/baseline_unsafe/);
});

test('same-inode contents drift or replacement identity blocks launch and fixture creation',t=>{
    const f=fixture(t),baseline=captureRecoveryPm2DumpBaseline(f.live);
    fs.appendFileSync(f.dump,' ');assert.throws(()=>assertRecoveryPm2DumpBaseline(baseline),/baseline_changed/);
    assert.throws(()=>initializeRecoveryPm2Dump(f.target,baseline),/baseline_changed/);assert.deepEqual(fs.readdirSync(f.target),[]);
    fs.writeFileSync(f.dump,'[{"fixture":"baseline contents must not be copied"}]');
    const fresh=captureRecoveryPm2DumpBaseline(f.live);fs.renameSync(f.dump,path.join(f.root,'old'));
    fs.writeFileSync(f.dump,'[{"fixture":"baseline contents must not be copied"}]',{mode:0o600});
    assert.throws(()=>assertRecoveryPm2DumpBaseline(fresh),/baseline_changed/);
});

test('existing private dump or dangling link is never overwritten, chmodded or followed',t=>{
    const f=fixture(t),baseline=captureRecoveryPm2DumpBaseline(f.live),target=path.join(f.target,'dump.pm2');
    fs.writeFileSync(target,'unknown fixture',{mode:0o644});const before=fs.statSync(target);
    assert.throws(()=>initializeRecoveryPm2Dump(f.target,baseline),/EEXIST/);
    assert.equal(fs.readFileSync(target,'utf8'),'unknown fixture');assert.equal(fs.statSync(target).mode,before.mode);assert.equal(fs.statSync(target).ino,before.ino);
    fs.unlinkSync(target);fs.symlinkSync(path.join(f.root,'missing'),target);
    assert.throws(()=>initializeRecoveryPm2Dump(f.target,baseline),/EEXIST/);assert.equal(fs.lstatSync(target).isSymbolicLink(),true);
    assert.throws(()=>initializeRecoveryPm2Dump(f.live,baseline),/destination_unsafe/);
});
