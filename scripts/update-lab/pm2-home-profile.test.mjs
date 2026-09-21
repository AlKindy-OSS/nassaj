/** Real private daemon admission probe with no application DB, installer or activation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const artifact=path.resolve('.nassaj-local-preview/server-candidates/e9822b033c825d35976abf2c3850d5f2ea550f73bb15ed88832cc500e7f3af48/OID_CONTROL_CAPSULE.mjs');
for(const runtimeProfile of ['host-local','fleet-public-24.17-npm12'])test('exact private HOME daemon identity '+runtimeProfile,()=>{
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/pm2-home-probe.mjs');
    const pinned=sha(artifact),hostNode=sha('/usr/bin/node'),hostMounts=fs.readFileSync('/proc/self/mountinfo','utf8');
    fs.copyFileSync(artifact,path.join(lab,'harness/capsule.mjs'));assert.equal(sha(path.join(lab,'harness/capsule.mjs')),pinned);
    fs.writeFileSync(entry,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {captureOidTripleSupervisor} from './capsule.mjs';
const lab=process.cwd(),app=lab+'/app',name='pm2-home-probe',pm2Home=process.env.HOME+'/.pm2';
assert.equal(process.pid,1);assert.notEqual(process.getuid(),0);assert.equal(process.env.PM2_HOME,pm2Home);assert.equal(fs.readdirSync(pm2Home).length,0);assert.equal(fs.statSync(pm2Home).mode&511,448);
const status=fs.readFileSync('/proc/self/status','utf8');for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+key+':\\\\s+0+$','m'));assert.match(status,/^NoNewPrivs:\\s+1$/m);
const command=args=>{const r=spawnSync('/usr/bin/pm2',args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,'private pm2 command failed');return r.stdout;};
let daemon;
try {
fs.mkdirSync(app+'/dist-server/server',{recursive:true});fs.writeFileSync(app+'/dist-server/server/index.js','setInterval(()=>{},1000);');
fs.writeFileSync(lab+'/probe.config.cjs','module.exports='+JSON.stringify({apps:[{name,cwd:app,script:'dist-server/server/index.js',interpreter:process.execPath,autorestart:false,treekill:false,kill_timeout:86400000,env:{PM2_HOME:pm2Home,NODE_ENV:'production'}}]}));
process.env.PROC_NAME=name;command(['start',lab+'/probe.config.cjs']);command(['save']);const rows=JSON.parse(command(['jlist']));assert.equal(rows.length,1);const slot=rows[0];
const ticks=fs.readFileSync('/proc/'+slot.pid+'/stat','utf8').split(') ')[1].split(' ')[19];
const verified=await captureOidTripleSupervisor(app,{oldPid:slot.pid,oldStartTicks:ticks});daemon=verified.daemon;
const title=fs.readFileSync('/proc/'+daemon.pid+'/cmdline','utf8').replace(/\\0/g,' ').trim();assert.ok(title.endsWith('('+pm2Home+')'));
const dump=JSON.parse(fs.readFileSync(pm2Home+'/dump.pm2'));assert.equal(dump.length,1);assert.equal(dump[0].name,name);assert.equal(dump[0].PM2_HOME,pm2Home);assert.equal(dump[0].status,'online');
const proof={runtimeProfile:${JSON.stringify(runtimeProfile)},node:process.version,pm2Home,title,daemon,pid:slot.pid,startTime:ticks,uid:process.getuid(),nodeSha256:verified.node.sha256,daemonExecutableSha256:verified.daemonExecutableSha256,pm2TreeSha256:verified.pm2TreeSha256,capsuleSha256:${JSON.stringify(pinned)},captureOriginalPassed:true,dumpMatched:true};
fs.writeFileSync(lab+'/pm2-home-proof.json',JSON.stringify(proof));
}finally{command(['kill']);}
if(daemon){const until=Date.now()+3000;while(Date.now()<until){try{const stat=fs.readFileSync('/proc/'+daemon.pid+'/stat','utf8').split(') ')[1].split(' ');if(stat[0]==='Z'||stat[19]!==daemon.startTime)break;}catch(error){if(error.code==='ENOENT')break;throw error;}await new Promise(r=>setTimeout(r,20));}try{const stat=fs.readFileSync('/proc/'+daemon.pid+'/stat','utf8').split(') ')[1].split(' ');assert.ok(stat[0]==='Z'||stat[19]!==daemon.startTime);}catch(error){if(error.code!=='ENOENT')throw error;}}
console.log(JSON.stringify({state:'private_daemon_verified_and_stopped',lab}));`);
    const result=runBridgeIsolated(lab,entry,{privateDependencies:true,runtimeProfile,timeout:60000});
    assert.equal(sha('/usr/bin/node'),hostNode);assert.equal(fs.readFileSync('/proc/self/mountinfo','utf8'),hostMounts);
    assert.equal(result.status,0,result.stderr);assert.equal(sha(artifact),pinned);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lab,'pm2-home-proof.json'))).captureOriginalPassed,true);
});
