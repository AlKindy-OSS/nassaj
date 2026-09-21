/** Actual private PM2/application baseline; this entry refuses the host namespaces. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {seedBridgeData,assertBridgeData,assertBridgeAuthentication,seedBridgeWriterPredicates,readBridgeWriterPredicates} from './bridge-data-fixture.mjs';
import {observeBridgeStartup} from './bridge-startup-observer.mjs';
import {seedBridgeStrandedJob,readBridgeStrandedJob} from './bridge-source-job-fixture.mjs';
import {prepareBridgeAction,startBridgeAction,assertBridgeTerminal,assertBridgeClientAssets,assertBridgeRollbackTerminal} from './bridge-action-fixture.mjs';
const lab=process.cwd(),meta=JSON.parse(fs.readFileSync(path.join(lab,'scenario.json')));
if(process.pid!==1 || process.env.PM2_HOME!==path.join(process.env.HOME,'.pm2') || !lab.includes('/.artifacts/t1772-bridge-rehearsal/run-'))throw Error('bridge_child_not_isolated');
const call=args=>{
    const result=spawnSync('/usr/bin/pm2',args,{encoding:'utf8',timeout:20000,env:process.env});
    if(result.status!==0)throw Error(`bridge_pm2_failed:${args[0]}:${String(result.stderr).slice(-1000)}`);
    return result.stdout;
};
async function waitHealth(expected=null) {
    let observer;
    let heldPid=null;
    let listenerProbe=null;
    if(meta.observed){
        const application=path.join(lab,'app/dist-server/server/application.js');
        const file=fs.existsSync(application)?application:path.join(lab,'app/dist-server/server/index.js'),bytes=fs.readFileSync(file);
        const line=bytes.toString().split('\n').findIndex(value=>value.includes('await initializeDatabase();'))+1;
        const checkpoints=[{name:'before-initialize-database',url:pathToFileURL(file).href,line,sha256:createHash('sha256').update(bytes).digest('hex')}];
        if(expected?.buildId===meta.target?.buildId){
            for(const [name,relative,marker] of [['before-application-import','index.js','return await loadServer();'],
                ['after-startup-reconciliation','application.js','for (const job of sourceUpdateJobsDb.listRuntimeVerifying())'],
                ['listener-before-background','application.js','await backgroundLifecycle.start();']]){
                const source=path.join(lab,'app/dist-server/server',relative),content=fs.readFileSync(source);
                checkpoints.push({name,url:pathToFileURL(source).href,line:content.toString().split('\n').findIndex(row=>row.includes(marker))+1,sha256:createHash('sha256').update(content).digest('hex')});
            }
        }
        const until=Date.now()+10000;
        while(!observer && Date.now()<until){try{observer=await observeBridgeStartup({port:9237,checkpoints,onPause:evidence=>{
            if(evidence.name==='listener-before-background'){
                listenerProbe=fetch(`http://127.0.0.1:${meta.port}/health`,{signal:AbortSignal.timeout(5000)})
                    .then(async response=>({status:response.status,body:await response.json()}))
                    .catch(error=>({status:null,error:error.message}));
            }
            if(evidence.name===meta.failure && expected?.buildId===meta.target?.buildId){
                heldPid=JSON.parse(call(['jlist'])).find(value=>value.name===meta.processName).pid;
                const predicates=readBridgeWriterPredicates(lab);
                assert.deepEqual(predicates,evidence.name==='before-application-import'
                    ? {oldAudit:1,orphanAuthors:1,orphanStars:1,targetLease:'issued',targetOutcome:null}
                    : {oldAudit:0,orphanAuthors:0,orphanStars:0,targetLease:'revoked',targetOutcome:'not_started'});
                result.failureCheckpoint={...evidence,heldPid,predicates};return 'hold';
            }return 'resume';}});}
        catch(error){if(!String(error.message).includes('fetch failed'))throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
        if(!observer)throw Error('bridge_inspector_unavailable');
    }
    const deadline=Date.now()+60000;
    let health;
    let checkedAt=0;
    while(Date.now()<deadline){
        if(heldPid){
            result.observations??=[];result.observations.push(...observer.events);
            return await waitRollbackProcess(heldPid,observer);
        }
        if(Date.now()-checkedAt>1000){
            checkedAt=Date.now();
            const running=JSON.parse(call(['jlist'])).find(value=>value.name===meta.processName);
            if(running && ['errored','stopped'].includes(running.pm2_env.status))throw Error('bridge_old_process_stopped');
        }
        try {const response=await fetch(`http://127.0.0.1:${meta.port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){const body=await response.json();if(!expected || body.serverLoadedBuildId===expected.buildId){health=body;break;}}}catch{}
        await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!health)throw Error('bridge_health_timeout');
    if(listenerProbe){const probe=await listenerProbe;result.listenerProbe={status:probe.status,
        observed503:probe.status===503,normalReadyAtResponse:probe.body?.normalAdmissionReady??null,error:probe.error};}
    if(observer){try {observer.assertHealthy();if(!observer.events.some(event=>event.kind==='checkpoint'))throw Error('bridge_startup_checkpoint_not_observed');
        result.observations??=[];result.observations.push(...observer.events);}finally{observer.close();}}
    if(meta.observed && expected?.buildId===meta.target?.buildId && !meta.failure){
        assert.equal(result.listenerProbe?.status,503,'target must reject public health before background readiness');
        assert.notEqual(result.listenerProbe?.normalReadyAtResponse,true);
    }
    return health;
}

async function waitRollbackProcess(heldPid,observer) {
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
        observer.assertHealthy();
        const current=JSON.parse(call(['jlist'])).find(value=>value.name===meta.processName);
        const provenance=JSON.parse(fs.readFileSync(path.join(lab,'app/dist-server/BUILD_PROVENANCE.json')));
        if(current?.pid>0 && current.pid!==heldPid && provenance.buildId===meta.old.buildId){
            if(fs.existsSync(`/proc/${heldPid}/stat`))throw Error('bridge_failed_candidate_still_alive');
            observer.close();
            const health=await waitHealth(meta.old);
            return {...health,rehearsalRollback:true};
        }
        await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('bridge_rollback_process_timeout');
}
const result={schema:'nassaj-bridge-rehearsal/v1',phase:'old-baseline',state:'running',old:meta.old};
try {
    call(['start',path.join(lab,'ecosystem.config.cjs')]);
    const health=await waitHealth();
    if(!health)throw Error('bridge_old_baseline_no_health');
    if(health.serverLoadedBuildId!==meta.old.buildId || health.serverLoadedOid!==meta.old.oid)throw Error('bridge_old_baseline_identity_mismatch');
    const list=JSON.parse(call(['jlist'])),processInfo=list.find(value=>value.name===meta.processName);
    if(!processInfo || processInfo.pm2_env.pm_exec_path!==path.join(lab,'app/dist-server/server/index.js'))throw Error('bridge_old_entry_mismatch');
    if(processInfo.pm2_env.NASSAJ_UPDATE_MODE!==undefined)throw Error('bridge_old_mode_not_absent');
    if(processInfo.pm2_env.treekill!==false || processInfo.pm2_env.kill_timeout!==86400000)throw Error('bridge_pm2_shutdown_contract_mismatch');
    call(['save']);
    const saved=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.pm2/dump.pm2'))).find(value=>value.name===meta.processName);
    if(!saved || saved.NASSAJ_UPDATE_MODE!==undefined)throw Error('bridge_saved_mode_not_absent');
    result.pm2Contract={treekill:false,killTimeout:86400000,oldSavedModeAbsent:true};
    result.state='baseline_ready';result.health={pid:health.pid,serverLoadedOid:health.serverLoadedOid,serverLoadedBuildId:health.serverLoadedBuildId};
    result.entry=processInfo.pm2_env.pm_exec_path;
    call(['stop',meta.processName]);
    await seedBridgeData(lab,{externalUnknown:meta.externalUnknown===true});
    call(['restart',meta.processName]);
    if(meta.externalUnknown) {
    try {await waitHealth();throw Error('bridge_external_unknown_did_not_block');}
    catch(error) {
        if(error.message!=='bridge_old_process_stopped')throw error;
        const log=fs.readFileSync(path.join(lab,'logs/old-error-0.log'),'utf8');
        if(!log.includes('PERMISSION_RECONCILIATION_BLOCKED:') || !log.includes('"unknownExternal":1'))throw Error('bridge_unexpected_old_start_failure');
        result.externalUnknown={firstBoot:'blocked',databaseRestored:false};
        const transactions=fs.readdirSync(path.join(lab,'app/.git')).filter(name=>name.startsWith('nassaj-oid-control-transaction-'));
        assert.deepEqual(transactions,[]);
        result.externalUnknown.activationStarted=false;
        throw Error('bridge_expected_admission_rejection');
    }
    } else await waitHealth();
    result.fixture=await assertBridgeData(lab,{externalUnknown:meta.externalUnknown===true});
    result.authentication=await assertBridgeAuthentication(lab,meta.port);
    if(meta.target){
        await prepareBridgeAction(lab,meta.target);
        result.clientOnOld=await assertBridgeClientAssets(lab,meta);
        result.writerPredicatesBeforeBridge=await seedBridgeWriterPredicates(lab);
        if(meta.strandedSourceJob)result.sourceJobBeforeBridge=await seedBridgeStrandedJob(lab,meta.target);
        assert.deepEqual(result.writerPredicatesBeforeBridge,{oldAudit:1,orphanAuthors:1,orphanStars:1,targetLease:'issued',targetOutcome:null});
        fs.writeFileSync(path.join(lab,'writer-predicates-before.json'),JSON.stringify(result.writerPredicatesBeforeBridge));
        const oldProcess=JSON.parse(call(['jlist'])).find(value=>value.name===meta.processName);
        const action=await startBridgeAction(lab,meta);
        const deadline=Date.now()+45000;
        let replaced=false;
        while(Date.now()<deadline){const current=JSON.parse(call(['jlist'])).find(value=>value.name===meta.processName);
            if(current?.pid>0 && current.pid!==oldProcess.pid){replaced=true;break;}await new Promise(resolve=>setTimeout(resolve,200));}
        if(!replaced)throw Error('bridge_action_did_not_replace_old_process');
        const bridgeHealth=await waitHealth(meta.target);
        if(meta.failure && !bridgeHealth.rehearsalRollback)throw Error('bridge_requested_failure_not_exercised');
        result.action=await action.completion.catch(error=>({status:'connection_closed',error:error.message}));
        result.bridge=Object.fromEntries(['serverLoadedOid','serverLoadedBuildId','serverTransactionNonce','serverBootNonce','serverProcessStartTicks','pid','normalAdmissionReady','updateMode'].map(key=>[key,bridgeHealth[key]]));
        fs.writeFileSync(path.join(lab,'bridge-health.json'),JSON.stringify(result.bridge),{mode:0o600});
        if(bridgeHealth.rehearsalRollback){
            result.rollbackHealth=result.bridge;
            result.rollbackTerminal=await assertBridgeRollbackTerminal(lab,meta,bridgeHealth);
            result.state='rollback_served_verified';
        } else result.terminal=await assertBridgeTerminal(lab,meta,bridgeHealth);
        result.bridgeFixture=await assertBridgeData(lab);
        result.writerPredicatesAfterBridge=readBridgeWriterPredicates(lab);
        assert.deepEqual(result.writerPredicatesAfterBridge,{oldAudit:0,orphanAuthors:0,orphanStars:0,targetLease:'revoked',targetOutcome:'not_started'});
        result.bridgeAuthentication=await assertBridgeAuthentication(lab,meta.port);
        if(meta.strandedSourceJob){result.sourceJobAfterBridge=readBridgeStrandedJob(lab);
            assert.equal(result.sourceJobAfterBridge.state,'failed');assert.equal(result.sourceJobAfterBridge.activeJobId,null);
            assert.ok(result.sourceJobAfterBridge.receipts.some(receipt=>receipt.kind==='recovery' && receipt.code==='source_update_activation_interrupted'));}
        result.clientOnBridge=await assertBridgeClientAssets(lab,meta);
        if(!bridgeHealth.rehearsalRollback)result.state='bridge_served_verified';
    }
} catch(error){
    if(error.message==='bridge_expected_admission_rejection' && meta.externalUnknown)result.state='admission_rejected_as_expected';
    else {result.state='failed';result.error=error.message;process.exitCode=1;}
}
finally {
    fs.writeFileSync(path.join(lab,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
    try{call(['kill']);}catch{}
    console.log(JSON.stringify(result));
}
