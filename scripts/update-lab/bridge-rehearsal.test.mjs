import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prepareBridgeWorkspace,runBridgeIsolated,probeBridgeIsolation} from './bridge-rehearsal.mjs';
// bridge-namespace.sh binds the lab over a /home/* HOME before it hides /var/tmp, so it refuses any
// other HOME; the B-1771 isolated test HOME lives under /var/tmp and cannot host this rehearsal.
const noHostHome=/^\/home\/[^/]+/.test(process.env.HOME??'')?false
    :'bridge rehearsal needs a /home/* HOME; the isolated test HOME (B-1771) is outside /home';

test('private namespace restricts writable mounts and preserves HOME value', {skip:noHostHome}, () => {
    const result=probeBridgeIsolation();
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).pid,1);
});

test('driver timeout kills namespace PID1 and all descendant processes', {skip:noHostHome}, async () => {
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/timeout.mjs');
    fs.writeFileSync(entry,`import fs from 'node:fs';import {spawn} from 'node:child_process';
fs.writeFileSync('pid-namespace',fs.readlinkSync('/proc/self/ns/pid'));
spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000);`);
    const started=Date.now();
    const result=runBridgeIsolated(lab,entry,{timeout:2500});
    assert.ok(Date.now()-started<7500,'timeout must terminate promptly without external intervention');
    assert.equal(result.error?.code,'ETIMEDOUT');
    const namespace=fs.readFileSync(path.join(lab,'pid-namespace'),'utf8');
    const live=()=>fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).filter(pid=>{
        try{return fs.readlinkSync(`/proc/${pid}/ns/pid`)===namespace;}catch{return false;}
    });
    const deadline=Date.now()+5000;
    while(live().length && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.deepEqual(live(),[]);
    fs.writeFileSync(path.join(lab,'timeout-proof.json'),JSON.stringify({namespace,remainingProcesses:0,timeout:result.error.code}));
});
