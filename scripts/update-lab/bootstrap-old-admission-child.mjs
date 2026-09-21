/** Isolated prerequisite only: execute exact old bytes and exercise their existing admission/return protocol. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashDependencyTreeV2 } from './dependency-tree-identity-v2.mjs';
const lab=process.cwd(), app=path.join(lab,'app');
assert.equal(process.pid,1); assert.ok(lab.includes('/.artifacts/t1772-bridge-rehearsal/run-'));
assert.equal(process.env.PM2_HOME,path.join(process.env.HOME,'.pm2'));
for(const [key,name] of [['USER','user'],['MOUNT','mnt'],['NET','net'],['PID','pid']]) assert.notEqual(fs.readlinkSync(`/proc/self/ns/${name}`),process.env[`NASSAJ_LAB_PARENT_${key}_NS`]);
const meta=JSON.parse(fs.readFileSync(path.join(lab,'scenario.json'))), capsule=await import(pathToFileURL(path.join(app,'dist-server/OID_CONTROL_CAPSULE.mjs')));
const {createUpdateMaintenanceGate}=await import(pathToFileURL(path.join(app,'dist-server/server/services/update-maintenance-gate.js')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'), tick=()=>new Promise(resolve=>setTimeout(resolve,100));
const report={schema:'nassaj-actual-old-prerequisite/v1',scope:'old-protocol-only-root-mapped-namespace',state:'running',oldOid:meta.old.oid,checks:{}};
const write=()=>fs.writeFileSync(path.join(lab,'old-admission-prerequisite.json'),JSON.stringify(report,null,2),{mode:0o600});
const pm2=(args,extra={})=>{const env={...process.env,...extra};delete env.NASSAJ_UPDATE_MODE;const r=spawnSync('/usr/bin/pm2',args,{env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,`private_pm2_${args[0]}_failed`);return r.stdout;};
async function health(closed=false) {
    const end=Date.now()+30000;
    while(Date.now()<end){try{const r=await fetch(`http://127.0.0.1:${meta.port}/health`,{signal:AbortSignal.timeout(1000)}),d=await r.json();
        if(d.serverLoadedOid===meta.old.oid && (closed || d.normalAdmissionReady===true))return d;}catch{}await tick();}
    throw Error('old_health_timeout');
}
function dbRead(fn){const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});try{return fn(db);}finally{db.close();}}
let handle;
try {
    write();pm2(['start',path.join(lab,'ecosystem.config.cjs')]);const old=await health();
    assert.equal(old.updateMode,'release');assert.equal(old.serverLoadedBuildId,meta.old.buildId);
    report.checks.loadedIdentity={pid:old.pid,buildId:old.serverLoadedBuildId,mode:old.updateMode};write();
    const env=Object.fromEntries(fs.readFileSync(path.join(app,'.env'),'utf8').trim().split('\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),line.slice(n+1)];}));
    const login=await fetch(`http://127.0.0.1:${meta.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:env.BOOTSTRAP_OWNER_USERNAME,password:env.BOOTSTRAP_OWNER_PASSWORD})});
    assert.equal(login.status,200);const token=(await login.json()).token;
    const ownerId=dbRead(db=>db.prepare("SELECT id FROM users WHERE username=? AND role='owner' AND is_active=1").get(env.BOOTSTRAP_OWNER_USERNAME).id);
    const usersBefore=dbRead(db=>sha(JSON.stringify(db.prepare('SELECT * FROM users ORDER BY id').all()))), database=fs.statSync(process.env.DATABASE_PATH);
    const manifestFile=path.join(app,'dist-server/OID_CONTROL_MANIFEST.json'),client=JSON.parse(fs.readFileSync(path.join(app,'dist/BUILD_PROVENANCE.json')));
    const nonce='a'.repeat(64),bootNonce='b'.repeat(64),digest='c'.repeat(64);
    const previous={clientBuildId:client.buildId,serverBuildId:meta.old.buildId,clientOid:client.commit,
        clientTreeSha256:capsule.hashOidPairTree(path.join(app,'dist')),serverTreeSha256:capsule.hashOidPairTree(path.join(app,'dist-server')),
        nodeModulesTreeSha256:hashDependencyTreeV2(path.join(app,'node_modules')).sha256,controlManifestSha256:sha(fs.readFileSync(manifestFile)),
        runtime:{pid:old.pid,startTime:old.serverProcessStartTicks,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),oid:meta.old.oid},
        installRuntime:{nodeBinarySha256:sha(fs.readFileSync(process.execPath)),nodeVersion:process.version,nodeModuleAbi:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch}};
    const identity={sequence:1,group:'event-0000000000000001',oid:meta.old.oid,targetDigest:digest,transactionNonce:nonce,
        targetClientBuildId:previous.clientBuildId,targetServerBuildId:previous.serverBuildId,journalBasename:`nassaj-oid-control-transaction-1-${nonce}.json`};
    const owner={pid:process.pid,startTime:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19],bootId:previous.runtime.bootId};
    const journalFile=path.join(app,'.git',identity.journalBasename),target={...previous,schema:'nassaj-oid-triple-target/v2'};
    let transaction={schema:'nassaj-oid-control-transaction/v2',generationNames:['nodeModules','server','client'],...identity,owner,actionId:'00000000-0000-0000-0000-000000000001',
        state:'triple_prepared',pair:{targetDigest:digest,target,previous,databaseState:'PRE_CANDIDATE'}};
    const save=()=>fs.writeFileSync(journalFile,JSON.stringify(transaction),{mode:0o600});save();
    const gate=createUpdateMaintenanceGate({projectPath:app});process.env.NASSAJ_UPDATE_MODE='local-main';
    const writer=await gate.acquireWriterLease({kind:'prerequisite',waitMs:100});
    try{await assert.rejects(capsule.beginOidPairAdmission(app,identity,{waitMs:100}),/lock_contended/);}finally{writer.release();}
    assert.equal(gate.readPublicStatus().gateClosed,false);assert.equal((await health()).pid,old.pid);report.checks.activeWriterDefers=true;write();
    handle=await capsule.beginOidPairAdmission(app,identity,{waitMs:1000});
    await assert.rejects(gate.acquireWriterLease({kind:'blocked',waitMs:100}),/lock|timeout/);
    const blocked=await fetch(`http://127.0.0.1:${meta.port}/api/projects`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:'{}'});
    assert.equal(blocked.status,503);report.checks.newWriterExcluded=true;write();
    const snapshot=await capsule.captureOidPairSnapshot(process.env.DATABASE_PATH,{...identity,ownerId:String(ownerId),actionId:transaction.actionId});
    transaction={...transaction,state:'triple_previous_start_intent',bootDirection:'previous',bootNonce,pair:{...transaction.pair,snapshot}};save();
    pm2(['stop',meta.processName]);assert.throws(()=>fs.statSync(`/proc/${old.pid}`));report.checks.oldStopped=true;write();
    handle.transition({phase:'OID_BOOTSTRAP_VERIFYING',databaseState:'PRE_CANDIDATE'});
    pm2(['restart',meta.processName,'--update-env'],{NASSAJ_PREVIEW_TRANSACTION_NONCE:nonce,NASSAJ_PREVIEW_BOOT_NONCE:bootNonce});
    const returned=await health(true);assert.notEqual(returned.pid,old.pid);assert.equal(returned.updateMode,'release');
    const child=JSON.parse(fs.readFileSync(path.join(app,'.git/nassaj-source-update',`oid-child-${nonce}.json`)));
    assert.equal(child.schema,'nassaj-oid-triple-bootstrap/v2');assert.equal(child.rollback,true);assert.equal(child.pid,returned.pid);
    assert.equal(fs.statSync(process.env.DATABASE_PATH).ino,database.ino);assert.equal(dbRead(db=>sha(JSON.stringify(db.prepare('SELECT * FROM users ORDER BY id').all()))),usersBefore);
    assert.equal(gate.readPublicStatus().gateClosed,true);
    report.checks.previousReleaseReturned={pid:returned.pid,mode:returned.updateMode,childReceiptSha256:sha(JSON.stringify(child)),databaseInodePreserved:true,usersPreserved:true,gateClosed:true};
    report.state='prerequisite_passed';write();
} catch(error){report.state='failed';report.error=String(error.message).slice(0,300);write();process.exitCode=1;}
finally {handle?.release();try{pm2(['kill']);}catch{};}
