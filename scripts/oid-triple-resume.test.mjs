import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createUpdateMaintenanceGate } from '../server/services/update-maintenance-gate.js';
import { beginOidPairAdmission, hashOidPairTree, runOidPairTransaction, inspectConfirmedOidPair, prepareOidTripleDependencyExchange, oidTripleDependencySlot } from './oid-control-capsule.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
import { computeOidTripleTargetDigest } from './lib/oid-triple-target.mjs';
import { oidTriplePm2TransportFixture, attachOidTripleSocketFixture } from './oid-triple-test-fixtures.mjs';
import { retainOidTripleExecutor } from './preview-oid-capsule-launcher.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,...args)=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8'}).trim();
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

function targetFixture(root,oid) {
    const target={schema:'nassaj-oid-triple-target/v2',generationNames:['nodeModules','server','client'],installRuntime:{
        nodeBinarySha256:sha(fs.readFileSync(process.execPath)),nodeVersion:process.version,nodeModuleAbi:process.versions.modules,
        napi:process.versions.napi,platform:process.platform,arch:process.arch,npmVersion:'12.0.2',npmCliSha256:'a'.repeat(64)}};
    for(const key of ['clientBuildId','serverBuildId','dependencyContractSha256','packageJsonSha256','packageLockSha256','installPolicySha256','controlManifestSha256'])target[key]='b'.repeat(64);
    const previous={schema:'nassaj-oid-triple-previous/v2',clientBuildId:'c'.repeat(64),serverBuildId:'d'.repeat(64)};
    const locations=[];
    for(const [name,directory]of[['nodeModules','node_modules'],['server','dist-server'],['client','dist']]){
        const live=path.join(root,directory),old=path.join(root,`old-${name}`);fs.mkdirSync(live,{mode:0o700});fs.mkdirSync(old,{mode:0o700});
        fs.writeFileSync(path.join(live,'generation'),'new',{mode:0o444});fs.writeFileSync(path.join(old,'generation'),'old',{mode:0o444});
        if(name!=='nodeModules')for(const [dir,buildId]of[[live,target[`${name}BuildId`]],[old,previous[`${name}BuildId`]]])fs.writeFileSync(path.join(dir,'BUILD_PROVENANCE.json'),JSON.stringify({commit:oid,baseCommit:oid,dirty:false,buildId}),{mode:0o444});
        const hash=name==='nodeModules'?dir=>hashDependencyTreeV2(dir).sha256:hashOidPairTree;
        target[`${name}TreeSha256`]=hash(live);previous[`${name}TreeSha256`]=hash(old);
        const parent=path.join(root,'.nassaj-local-preview',name==='nodeModules'?'dependency-candidates':`${name}-candidates`);fs.mkdirSync(parent,{recursive:true,mode:0o700});
        fs.chmodSync(path.join(root,'.nassaj-local-preview'),0o700);fs.chmodSync(parent,0o700);
        const candidate=name==='nodeModules'?old:path.join(parent,target[`${name}BuildId`]);
        if(name==='nodeModules'){fs.cpSync(live,path.join(parent,target.nodeModulesTreeSha256),{recursive:true,preserveTimestamps:true});fs.chmodSync(path.join(parent,target.nodeModulesTreeSha256),0o700);}else fs.renameSync(old,candidate);
        locations.push(live,candidate);
    }
    return {target,previous,locations};
}

for (const scenario of ['after-start','partial-clone']) test(`resume ${scenario}: no extra exchange and admission follows exact evidence`,async t=>{
    const root=fs.mkdtempSync(path.resolve('.artifacts/oid-triple-resume-'));
    const oldMode=process.env.NASSAJ_UPDATE_MODE,oldHealth=process.env.NASSAJ_PREVIEW_HEALTH_URL;
    let child, closePm2;
    t.after(async()=>{if(closePm2)await closePm2();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
        if(oldMode===undefined)delete process.env.NASSAJ_UPDATE_MODE;else process.env.NASSAJ_UPDATE_MODE=oldMode;
        if(oldHealth===undefined)delete process.env.NASSAJ_PREVIEW_HEALTH_URL;else process.env.NASSAJ_PREVIEW_HEALTH_URL=oldHealth;
        fs.rmSync(root,{recursive:true,force:true});});
    process.env.NASSAJ_UPDATE_MODE='local-main';git(root,'init','-q','-b','main');git(root,'config','user.name','Test');git(root,'config','user.email','test@example.invalid');
    fs.writeFileSync(path.join(root,'source'),'one');git(root,'add','source');git(root,'commit','-qm','one');const oid=git(root,'rev-parse','HEAD');
    const {target,previous,locations}=targetFixture(root,oid),nonce='e'.repeat(64),group='event-0000000000000001';
    const targetDigest=computeOidTripleTargetDigest({sequence:1,group,sourceOid:oid,target});
    const dead=spawnSync(process.execPath,['-e','process.stdout.write(require("node:fs").readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ")[19])'],{encoding:'utf8'});
    const owner={pid:dead.pid,startTime:dead.stdout,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
    previous.runtime=owner;
    const databasePath=path.join(root,'auth.db'),database=new DatabaseSync(databasePath);
    database.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT);INSERT INTO users VALUES(1,'owner',1,'active');");database.close();fs.chmodSync(databasePath,0o600);
    const record={repoRoot:root,liveRoot:path.join(root,'dist-server'),transactionNonce:nonce,actionId:'12345678-1234-1234-1234-123456789abc',oldPid:owner.pid,oldStartTicks:owner.startTime,
        pair:{sequence:1,ownerId:'1',targetDigest,databasePath}};
    const capsule=Buffer.from('transport fixture'),safeRestart=Buffer.from('unused safe bytes'),launcher=Buffer.from('transport fixture launcher');
    const manifest={capabilities:{oidTripleAdmissionV2:true}};
    for(const[name,bytes]of[['capsule',capsule],['safeRestart',safeRestart],['launcher',launcher]]){manifest[`${name}Sha256`]=sha(bytes);manifest[`${name}Size`]=bytes.length;}
    record.recoveryReference=retainOidTripleExecutor(root,{record,manifestBytes:Buffer.from(JSON.stringify(manifest)),capsule,safeRestart,launcher});
    const bootNonce='f'.repeat(64),ready=path.join(root,'child-ready.json');
    const fields={status:'ok',serverLoadedOid:oid,serverLoadedBuildId:target.serverBuildId,clientBuildIdServed:target.clientBuildId,serverTransactionNonce:nonce,
        serverBootNonce:bootNonce,oidPairTransactionNonce:nonce,oidPairTargetDigest:targetDigest,oidNodeModulesTreeSha256:target.nodeModulesTreeSha256};
    child=spawn(process.execPath,['-e',`const fs=require('node:fs'),http=require('node:http');const startTime=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19];const data={...JSON.parse(process.env.FIELDS),pid:process.pid,serverProcessStartTicks:startTime};const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.READY,JSON.stringify({pid:process.pid,startTime,port:server.address().port})));`],
        {env:{...process.env,FIELDS:JSON.stringify(fields),READY:ready},stdio:'ignore'});
    for(let attempt=0;attempt<100&&!fs.existsSync(ready);attempt++)await tick();assert.ok(fs.existsSync(ready));
    const running=JSON.parse(fs.readFileSync(ready));process.env.NASSAJ_PREVIEW_HEALTH_URL=`http://127.0.0.1:${running.port}/health`;
    const gate=createUpdateMaintenanceGate({projectPath:root});
    const identity={sequence:1,group,oid,transactionNonce:nonce,targetDigest,journalBasename:`nassaj-oid-control-transaction-1-${nonce}.json`,targetClientBuildId:target.clientBuildId,targetServerBuildId:target.serverBuildId};
    const handle=await beginOidPairAdmission(root,identity),control=path.join(root,'.git','nassaj-source-update');
    let transaction={schema:'nassaj-oid-control-transaction/v2',generationNames:target.generationNames,sequence:1,group,oid,transactionNonce:nonce,actionId:record.actionId,owner,
        state:'triple_candidate_start_intent',bootDirection:'target',bootNonce,recoveryReference:record.recoveryReference,pair:{targetDigest,target,previous,databaseState:'UNKNOWN',previousMaintenance:handle.original}};
    const journalFile=path.join(root,'.git',identity.journalBasename);
    const prepared=prepareOidTripleDependencyExchange(root,journalFile,{...transaction,bootDirection:undefined,pair:{...transaction.pair,databaseState:'PRE_CANDIDATE'}});
    const dependencySlot=oidTripleDependencySlot(root,prepared);
    assert.equal(spawnSync('/usr/bin/mv',['--exchange','--no-copy','-T',locations[1],dependencySlot]).status,0);
    locations[1]=dependencySlot;
    transaction={...transaction,dependencyExchange:prepared.dependencyExchange};
    transaction.supervisor=oidTriplePm2TransportFixture(root,running,transaction);
    closePm2=await attachOidTripleSocketFixture(transaction.supervisor);
    transaction.persistence={stopped:{dumpSha256:transaction.supervisor.dumpSha256}};
    if(scenario==='partial-clone') {
        transaction.state='triple_prepared';delete transaction.bootDirection;delete transaction.bootNonce;
        transaction.pair.databaseState='PRE_CANDIDATE';
        transaction.pair.previous={...target,schema:'nassaj-oid-triple-previous/v2',runtime:{pid:running.pid,startTime:running.startTime,bootId:owner.bootId,oid,serverBuildId:target.serverBuildId,clientBuildId:target.clientBuildId}};
        const partial=path.join(path.dirname(dependencySlot),'preparing');fs.renameSync(dependencySlot,partial);locations[1]=partial;
        transaction.dependencyExchange.phase='copying';
    }
    fs.writeFileSync(journalFile,JSON.stringify(transaction),{mode:0o600});
    if(scenario==='after-start') fs.writeFileSync(path.join(control,`oid-child-${nonce}.json`),JSON.stringify({schema:'nassaj-oid-triple-bootstrap/v2',rollback:false,generationNames:target.generationNames,
        nodeModulesTreeSha256:target.nodeModulesTreeSha256,pid:running.pid,startTime:running.startTime,bootId:owner.bootId,targetDigest}),{mode:0o600});
    handle.transition({phase:scenario==='after-start'?'OID_BOOTSTRAP_VERIFYING':'OID_QUIESCENT',databaseState:transaction.pair.databaseState,owner});handle.release();
    const state={schema:'nassaj-local-update/v1',mode:'local-main',sequence:1,group,oid,domains:['client','server'],phase:'activation_claimed',revision:1,target,targetDigest,
        consent:{ownerId:'1',targetDigest,expiresAt:Date.now()-1000},activation:{actionId:record.actionId,transactionNonce:nonce}};
    const event=path.join(root,'.git','nassaj-preview-oid-event-control-0000000000000001.json');fs.writeFileSync(event,JSON.stringify({oid,localUpdate:state}),{mode:0o600});
    fs.writeFileSync(path.join(root,'source'),'two');git(root,'add','source');git(root,'commit','-qm','two');const advanced=git(root,'rev-parse','HEAD');
    const revokedOwner=new DatabaseSync(databasePath);revokedOwner.exec('UPDATE users SET is_active=0');revokedOwner.close();
    const before=locations.map(dir=>fs.statSync(dir).ino),databaseHash=sha(fs.readFileSync(databasePath));
    const resumed={...record,resume:{operatorUid:process.getuid(),permissionRef:'test-explicit-resume',requestedAt:Date.now()}};
    const moduleUrl=new URL('./oid-control-capsule.mjs',import.meta.url).href;
    if(scenario==='partial-clone') {
        await runOidPairTransaction(resumed,safeRestart);
        assert.equal(gate.readPublicStatus().gateClosed,false);
        assert.equal(JSON.parse(fs.readFileSync(journalFile)).state,'restart_deferred_restored');
        assert.deepEqual(locations.map(dir=>fs.statSync(dir).ino),before);assert.equal(sha(fs.readFileSync(databasePath)),databaseHash);
        assert.equal(fs.existsSync(path.join(transaction.supervisor.pm2Home,'commands')),false);
        assert.equal(fs.existsSync(dependencySlot),false);
        return;
    }
    const failedResume=spawnSync(process.execPath,['--input-type=module','-e',`import {runOidPairTransaction} from ${JSON.stringify(moduleUrl)};try{await runOidPairTransaction(${JSON.stringify(resumed)},Buffer.from(${JSON.stringify(safeRestart.toString())}));process.exitCode=99;}catch(error){process.stdout.write(error.message);process.exitCode=3;}`],{env:{...process.env,NODE_ENV:'test',NASSAJ_OID_CAPSULE_FAIL_AT:'triple_before_dump_cas'},encoding:'utf8'});
    assert.equal(failedResume.status,3,failedResume.stderr);assert.match(failedResume.stdout,/injected_failure:triple_before_dump_cas/);
    assert.equal(gate.readPublicStatus().gateClosed,true);
    const failedJournal=JSON.parse(fs.readFileSync(journalFile));
    assert.equal(failedJournal.pair.databaseState,'UNKNOWN');assert.equal(failedJournal.persistence.online.state,'unknown');
    assert.deepEqual(locations.map(dir=>fs.statSync(dir).ino),before);
    await runOidPairTransaction({...record,resume:{operatorUid:process.getuid(),permissionRef:'test-explicit-resume',requestedAt:Date.now()}},safeRestart);
    assert.equal(fs.existsSync(path.join(transaction.supervisor.pm2Home,'commands')),false);
    assert.equal(gate.readPublicStatus().gateClosed,false);assert.equal(git(root,'rev-parse','HEAD'),advanced);
    assert.deepEqual(locations.map(dir=>fs.statSync(dir).ino),before);assert.equal(sha(fs.readFileSync(databasePath)),databaseHash);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.git',identity.journalBasename))).state,'pair_served');
    state.phase='awaiting_sessions';fs.writeFileSync(event,JSON.stringify({oid,localUpdate:state}));
    assert.throws(()=>inspectConfirmedOidPair(root,{sequence:1,targetDigest,ownerId:'1'}),/consent_invalid/);
    state.consent.expiresAt=Date.now()+60000;fs.writeFileSync(event,JSON.stringify({oid,localUpdate:state}));
    assert.throws(()=>inspectConfirmedOidPair(root,{sequence:1,targetDigest,ownerId:'1'}),/target_changed/);
});
