/** Administrative laboratory child: verify dropped authority before touching private PM2. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const lab=process.env.NASSAJ_LAB_ROOT;
assert.equal(process.pid,1);assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
assert.deepEqual(process.getgroups(),[1000]);
const status=fs.readFileSync('/proc/self/status','utf8');
for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.match(status,new RegExp(`^${key}:\\s+0+$`,'m'));
assert.match(status,/^NoNewPrivs:\s+1$/m);
const parent=JSON.parse(process.env.NASSAJ_LAB_PARENT_NAMESPACES);
assert.equal(fs.readlinkSync('/proc/self/ns/user'),parent.user);
for(const name of ['mnt','net','pid']) assert.notEqual(fs.readlinkSync(`/proc/self/ns/${name}`),parent[name]);
assert.equal(fs.statSync('/usr/bin/python3.13').uid,0);
assert.equal(process.env.PM2_HOME,'/home/operator/.pm2');assert.equal(fs.existsSync('/home/operator/Project/nassaj-dev/.git'),false);
assert.equal(fs.existsSync('/put_old'),false);
const app=path.join(lab,'app'),name='nassaj-isolated-peer-probe';
fs.mkdirSync(path.join(app,'dist-server/server'),{recursive:true,mode:0o700});
fs.copyFileSync('/reviewed-harness/idle.mjs',path.join(app,'dist-server/server/index.js'),fs.constants.COPYFILE_EXCL);
const ecosystem=path.join(lab,'ecosystem.config.cjs');
fs.writeFileSync(ecosystem,`module.exports=${JSON.stringify({apps:[{name,script:path.join(app,'dist-server/server/index.js'),cwd:app,interpreter:'/usr/bin/node',treekill:false,kill_timeout:86400000,autorestart:false,watch:false,env:{NASSAJ_UPDATE_MODE:'local-main',NASSAJ_PREVIEW_TRANSACTION_NONCE:'a'.repeat(64),NASSAJ_PREVIEW_BOOT_NONCE:'b'.repeat(64)}}]})}`,{mode:0o600,flag:'wx'});
const pm2=args=>{const result=spawnSync('/usr/bin/pm2',args,{encoding:'utf8',timeout:15000,env:process.env});assert.equal(result.status,0,`private_pm2_${args[0]}_failed`);return result.stdout;};
let report={schema:'nassaj-service-owner-lab-probe/v1',state:'failed',scope:'isolated-transport-only'};
try {
    report.stage='private-pm2-start';
    pm2(['start',ecosystem]);pm2(['save']);
    report.stage='private-pm2-read';
    const slot=JSON.parse(pm2(['jlist'])).find(row=>row.name===name);assert.ok(slot?.pid>1);
    const raw=fs.readFileSync(`/proc/${slot.pid}/stat`,'utf8'),startTicks=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/)[19];
    process.env.PROC_NAME=name;
    const capsule=await import('./capsule.mjs');
    const begin=performance.now();
    report.stage='capture-supervisor';
    const supervisor=await capsule.captureOidTripleSupervisor(app,{oldPid:slot.pid,oldStartTicks:startTicks});
    report={...report,state:'peer_transport_verified',durationMs:Math.round(performance.now()-begin),pid:slot.pid,
        daemonPid:supervisor.daemon.pid,serviceUid:process.getuid(),pythonOwnerUid:0,capabilitiesZero:true,noNewPrivileges:true,
        namespacesIsolated:true,observerSchema:supervisor.observer.peerCredentialReader?.runtime?.schema || null};
    assert.equal(supervisor.observer.daemon.uid,1000);
    report.stage='completed';
} catch(error){report.state='failed';report.error=error.message;process.exitCode=1;}
finally {
    // PID1 exit tears down the private PID namespace; no PM2 stop/restart touches host state.
    fs.writeFileSync(path.join(lab,'service-owner-probe.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
}
