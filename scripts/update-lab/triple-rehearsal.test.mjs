import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';
import {probeTripleIsolation,copyTree} from './triple-rehearsal.mjs';
import {hashDependencyTreeV2} from '../lib/dependency-tree-identity-v2.mjs';

test('private dependency copy preserves 0775 directories under restrictive umask and does not follow links',()=>{
    const lab=prepareBridgeWorkspace(),source=path.join(lab,'mode-source'),destination=path.join(lab,'mode-copy');
    fs.mkdirSync(path.join(source,'bin'),{recursive:true});
    fs.chmodSync(source,0o775);fs.chmodSync(path.join(source,'bin'),0o775);
    fs.writeFileSync(path.join(source,'bin/tool'),'fixture');fs.chmodSync(path.join(source,'bin/tool'),0o755);
    fs.symlinkSync('bin/tool',path.join(source,'tool'));
    const expected=hashDependencyTreeV2(source),previous=process.umask(0o077);
    try {copyTree(source,destination);} finally {process.umask(previous);}
    assert.deepEqual(hashDependencyTreeV2(destination),expected);
    assert.deepEqual(hashDependencyTreeV2(source),expected);
    assert.equal(fs.lstatSync(path.join(destination,'tool')).isSymbolicLink(),true);
    assert.equal(fs.statSync(path.join(destination,'bin')).mode&0o777,0o775);
});

test('private pivot preserves UID, drops every capability and isolates data, dependencies and network',()=>{
    const result=probeTripleIsolation();assert.equal(result.status,0,result.stderr);
    const proof=JSON.parse(result.stdout);assert.equal(proof.uid,process.getuid());assert.equal(proof.noNewPrivs,true);assert.equal(proof.capabilities,'all-zero');
    fs.writeFileSync(path.join(result.lab,'isolation-proof.json'),JSON.stringify(proof),{mode:0o600});
});

test('private pivot timeout ends namespace PID1 and its native descendants',async()=>{
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/triple-timeout.mjs');
    fs.writeFileSync(entry,`import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn('/usr/bin/sleep',['120'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(lab,'timeout-marker.json'))},JSON.stringify({namespace:fs.readlinkSync('/proc/self/ns/pid'),pid:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
    const result=runBridgeIsolated(lab,entry,{privateDependencies:true,timeout:1500});
    assert.equal(result.error?.code,'ETIMEDOUT');assert.equal(result.signal,'SIGKILL');
    const marker=JSON.parse(fs.readFileSync(path.join(lab,'timeout-marker.json')));assert.equal(marker.pid,1);assert.ok(marker.child>1);
    let alive=[];const until=Date.now()+3000;
    do {
        alive=[];
        for(const name of fs.readdirSync('/proc')) {
            if(!/^[0-9]+$/.test(name))continue;
            try {if(fs.readlinkSync(`/proc/${name}/ns/pid`)===marker.namespace)alive.push(name);} catch(error){if(!['ENOENT','EACCES','ESRCH'].includes(error.code))throw error;}
        }
        if(alive.length)await new Promise(resolve=>setTimeout(resolve,50));
    } while(alive.length&&Date.now()<until);
    assert.deepEqual(alive,[]);
    fs.writeFileSync(path.join(lab,'timeout-proof.json'),JSON.stringify({state:'terminated',namespace:marker.namespace,remainingProcesses:alive}),{mode:0o600});
});
