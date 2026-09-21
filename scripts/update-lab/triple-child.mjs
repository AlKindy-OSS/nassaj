/** Actual private PM2, HTTP owner request and the approved consumer/installer; no synthetic activation receipts. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assertFullLabHealthPolicy} from './lab-health-policy.mjs';
import {readTripleFailedTerminal} from './triple-terminal-observation.mjs';
import {seedBridgeData,assertBridgeData,assertBridgeAuthentication} from './bridge-data-fixture.mjs';
const lab=process.cwd(),app=path.join(lab,'app'),meta=JSON.parse(fs.readFileSync(path.join(lab,'scenario.json')));
assert.equal(process.pid,1);assert.equal(process.env.PM2_HOME,path.join(process.env.HOME,'.pm2'));assert.equal(meta.triple,true);
const report={schema:'nassaj-triple-actual-rehearsal/v1',state:'running',bridge:meta.bridge,targetOid:meta.targetOid};
const checkpoint=stage=>fs.writeFileSync(path.join(lab,'triple-checkpoint.json'),JSON.stringify({stage,observedAt:Date.now(),...report}),{mode:0o600});
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pm2=args=>{const r=spawnSync('/usr/bin/pm2',args,{env:process.env,encoding:'utf8',timeout:30000});if(r.status!==0)throw Error('triple_pm2_failed:'+args[0]);return r.stdout;};
const health=async(oid,timeout=90000,observeTerminal=()=>{})=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){observeTerminal();try{const r=await fetch(`http://127.0.0.1:${meta.port}/health`,{signal:AbortSignal.timeout(1000)});if(r.ok){const body=await r.json();if(body.serverLoadedOid===oid&&body.normalAdmissionReady===true)return body;}}catch{}await tick(250);}throw Error('triple_health_timeout');};
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let consumer,seedCacheTimer;
try {
    checkpoint('starting-baseline');
    pm2(['start',path.join(lab,'ecosystem.config.cjs')]);await health(meta.bridge.oid);
    pm2(['stop',meta.processName]);await seedBridgeData(lab);pm2(['restart',meta.processName]);
    const baselineHealth=await health(meta.bridge.oid);pm2(['save']);
    report.baseline={pid:baselineHealth.pid,oid:baselineHealth.serverLoadedOid,buildId:baselineHealth.serverLoadedBuildId,clientBuildIdServed:baselineHealth.clientBuildIdServed};
    assert.equal(baselineHealth.clientBuildIdServed,meta.bridge.clientBuildId,'baseline must serve the exact captured client');
    report.baselineData=await assertBridgeData(lab);report.baselineAuth=await assertBridgeAuthentication(lab,meta.port);
    const capsule=await import(pathToFileURL(path.join(app,'dist-server/OID_CONTROL_CAPSULE.mjs')).href);
    const oldStartTicks=fs.readFileSync('/proc/'+baselineHealth.pid+'/stat','utf8').split(') ')[1].split(' ')[19];
    process.env.PROC_NAME=meta.processName;
    const supervisor=await capsule.captureOidTripleSupervisor(app,{oldPid:baselineHealth.pid,oldStartTicks});
    const effectiveRows=JSON.parse(pm2(['jlist']));
    const effectiveSlot=effectiveRows.find(row=>row.pm_id===supervisor.pmId);
    assert.ok(effectiveSlot,'exact PM2 slot must remain present before prepare');
    capsule.validateOidTriplePm2Slot(effectiveRows,supervisor,'online');
    report.healthPolicy=assertFullLabHealthPolicy(effectiveSlot.pm2_env);
    if(effectiveSlot.pm2_env.env)assertFullLabHealthPolicy(effectiveSlot.pm2_env.env);
    report.supervisorPreflight={pm2Home:supervisor.pm2Home,daemon:supervisor.daemon,pm2TreeSha256:supervisor.pm2TreeSha256,daemonExecutableSha256:supervisor.daemonExecutableSha256,pid:supervisor.pid,startTime:supervisor.startTime};
    checkpoint('baseline-verified');
    const configuration=fs.readFileSync(path.join(app,'.env'),'utf8');
    const password=configuration.split('\n').find(line=>line.startsWith('BOOTSTRAP_OWNER_PASSWORD=')).slice('BOOTSTRAP_OWNER_PASSWORD='.length);
    const login=await fetch(`http://127.0.0.1:${meta.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'bridgeowner',password})});
    assert.equal(login.status,200);const token=(await login.json()).token;
    const headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
    const prepare=await fetch(`http://127.0.0.1:${meta.port}/api/system/update/local/prepare`,{method:'POST',headers:{...headers,'Idempotency-Key':'triple-actual-native-prepare-0001'},body:JSON.stringify({expectedOid:meta.targetOid})});
    const requested=await prepare.json();if(prepare.status!==202)throw Error('triple_prepare_refused:'+JSON.stringify(requested));
    checkpoint('preparation-requested');
    const sequence=requested.update.sequence,eventFile=path.join(app,'.git',`nassaj-preview-oid-event-control-${String(sequence).padStart(16,'0')}.json`);
    const seeded=new Set();
    seedCacheTimer=setInterval(()=>{
        const buildRoot=path.join(app,'.nassaj-local-preview/oid-builds',meta.targetOid);if(!fs.existsSync(buildRoot))return;
        for(const nonce of fs.readdirSync(buildRoot)) {
            if(!/^[a-f0-9]{64}$/.test(nonce)||seeded.has(nonce))continue;
            const temporary=path.join(buildRoot,nonce,'tmp');if(!fs.existsSync(temporary))continue;
            const destination=path.join(temporary,'vscode-ripgrep-cache-1.17.1');fs.mkdirSync(destination,{mode:0o700});
            const archive=path.join(destination,'ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz');
            fs.copyFileSync(path.join(lab,'public-material/ripgrep.tar.gz'),archive);assert.equal(sha(archive),meta.ripgrepSha256);seeded.add(nonce);
        }
    },50);
    const output=fs.openSync(path.join(lab,'logs/consumer.log'),'w');
    consumer=spawn(process.execPath,[path.join(app,'scripts/preview-oid-consumer.mjs'),'--repo',app],{cwd:app,
        env:{...process.env,NASSAJ_UPDATE_MODE:'local-main',NASSAJ_PREVIEW_OID_ENFORCEMENT:'1',NASSAJ_PREVIEW_OID_DOMAINS:'client,server'},stdio:['ignore',output,output]});fs.closeSync(output);
    let prepared;const deadline=Date.now()+900000;
    while(Date.now()<deadline) {
        if(consumer.exitCode!==null)throw Error('triple_consumer_exited:'+consumer.exitCode);
        const local=JSON.parse(fs.readFileSync(eventFile)).localUpdate;
        if(local.phase==='prepared'){prepared=local;break;}
        if(['failed','superseded','cancelled'].includes(local.phase))throw Error('triple_preparation_failed:'+local.phase);
        await tick(500);
    }
    if(!prepared)throw Error('triple_preparation_timeout');
    clearInterval(seedCacheTimer);seedCacheTimer=null;
    const stopped=new Promise(resolve=>consumer.once('exit',resolve));consumer.kill('SIGTERM');await stopped;consumer=null;
    report.prepared={sequence,targetDigest:prepared.targetDigest,target:prepared.target};
    fs.writeFileSync(path.join(lab,'prepared-target.json'),JSON.stringify(report.prepared),{mode:0o600});
    checkpoint('candidate-prepared');
    const confirmation=await fetch(`http://127.0.0.1:${meta.port}/api/system/update/local/${sequence}/confirm`,{method:'POST',headers,
        body:JSON.stringify({expectedRevision:prepared.revision,targetDigest:prepared.targetDigest})});
    const confirmed=await confirmation.json();if(confirmation.status!==202)throw Error('triple_confirm_refused:'+JSON.stringify(confirmed));
    report.confirmed=confirmed;
    checkpoint('consent-confirmed');
    const running=await health(meta.targetOid,900000,()=>{
        const terminal=readTripleFailedTerminal(path.join(app,'.git'),{sequence,targetDigest:prepared.targetDigest});
        if(terminal){report.terminalFailure=terminal;checkpoint('activation-terminal-failed');throw Error('triple_activation_terminal_failed:'+terminal.state);}
    });assert.equal(running.serverLoadedBuildId,prepared.target.serverBuildId);
    assert.equal(running.clientBuildIdServed,prepared.target.clientBuildId);
    assert.equal(running.oidNodeModulesTreeSha256,prepared.target.nodeModulesTreeSha256);
    report.targetHealth=Object.fromEntries(['pid','serverLoadedOid','serverLoadedBuildId','clientBuildIdServed','serverProcessStartTicks','normalAdmissionReady','oidNodeModulesTreeSha256'].map(key=>[key,running[key]]));
    const until=Date.now()+60000;let journal;
    while(Date.now()<until) {
        const local=JSON.parse(fs.readFileSync(eventFile)).localUpdate;
        if(local.phase==='activated'){
            const names=fs.readdirSync(path.join(app,'.git')).filter(name=>name.startsWith(`nassaj-oid-control-transaction-${sequence}-`)&&name.endsWith('.json'));
            assert.equal(names.length,1);journal=JSON.parse(fs.readFileSync(path.join(app,'.git',names[0])));break;
        }
        await tick(250);
    }
    assert.ok(journal,'typed serving must settle the event');assert.equal(journal.state,'pair_served');assert.equal(journal.persistence.online.state,'verified');
    const serving=JSON.parse(fs.readFileSync(path.join(app,'.git',`nassaj-oid-pair-serving-${journal.transactionNonce}.json`)));
    assert.equal(serving.schema,'nassaj-oid-triple-serving/v2');assert.equal(serving.nodeModulesTreeSha256,prepared.target.nodeModulesTreeSha256);
    assert.equal(journal.pair.receipt.pid,running.pid);assert.equal(journal.persistence.online.pid,running.pid);
    report.terminal={state:journal.state,transactionNonce:journal.transactionNonce,persistence:journal.persistence,serving};
    checkpoint('serving-verified');
    report.targetData=await assertBridgeData(lab);report.targetAuth=await assertBridgeAuthentication(lab,meta.port);
    const native=spawnSync(process.execPath,['-e',`const pkg=require('./node_modules/better-sqlite3/package.json');const Database=require('better-sqlite3');const db=new Database(':memory:');const ok=db.prepare('SELECT 1 AS ok').get().ok;db.close();console.log(JSON.stringify({version:pkg.version,abi:process.versions.modules,ok}));`],{cwd:app,encoding:'utf8'});
    assert.equal(native.status,0,native.stderr);report.native=JSON.parse(native.stdout);assert.equal(report.native.version,'12.8.0');assert.equal(report.native.ok,1);
    report.state='actual_triple_served_verified';
} catch(error) {report.state='failed';report.error=error.message;process.exitCode=1;}
finally {
    if(seedCacheTimer)clearInterval(seedCacheTimer);
    if(consumer)consumer.kill('SIGTERM');
    fs.writeFileSync(path.join(lab,'triple-result.json'),JSON.stringify(report,null,2),{mode:0o600});
    try{pm2(['kill']);}catch{}
    console.log(JSON.stringify(report));
}
