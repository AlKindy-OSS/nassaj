/** Prepare a synthetic owner-approved OID request, then invoke the actual old application action route. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {prepareBridgeConfig, applyBridgeConfig, checkBridgeConfig, restoreBridgeConfig} from '../prepare-local-update-bridge-config.mjs';

/** Populate lab-only control state for an already built exact candidate; no build or activation is performed here. */
export async function prepareBridgeAction(lab,target) {
    assert.equal(process.pid,1);assert.equal(process.env.PM2_HOME,path.join(process.env.HOME,'.pm2'));
    const app=path.join(lab,'app'),group='event-0000000000000001';
    const pipeline=await import(pathToFileURL(path.join(app,'dist-server/scripts/preview-oid-pipeline.mjs')));
    const git=args=>{const r=spawnSync('/usr/bin/git',args,{cwd:app,encoding:'utf8'});if(r.status!==0)throw Error('bridge_fixture_ref_failed:'+r.stderr);};
    git(['update-ref','refs/heads/main',target.oid]);
    pipeline.requestPreview(app,{group,oid:target.oid,domains:target.clientBuildId?['client','server']:['server']});
    pipeline.advancePreview(app,{group,oid:target.oid,domain:'server',state:'candidate'});
    for(const name of ['event','server'])git(['update-ref',`refs/nassaj/previews/v1/events/0000000000000001/${name}`,target.oid]);
    if(target.clientBuildId){
        pipeline.advancePreview(app,{group,oid:target.oid,domain:'client',state:'candidate'});
        git(['update-ref','refs/nassaj/previews/v1/events/0000000000000001/client',target.oid]);
    }
    const identity={sequence:1,group,oid:target.oid,snapshotOid:target.oid,buildId:target.buildId,controlManifestSha256:target.controlManifestSha256};
    const write=(name,value)=>fs.writeFileSync(path.join(app,'.git',name),JSON.stringify(value),{mode:0o600});
    write('nassaj-preview-oid-control-request-v1.json',{schemaVersion:1,action:'promote-and-safe-restart',...identity});
    write('nassaj-preview-oid-event-control-0000000000000001.json',{schema:'nassaj-oid-control-event/v1',...identity});
    write('nassaj-preview-oid-consumer-v1.json',{schemaVersion:1,acceptedSequence:1,acceptedOid:target.oid,server:{...identity,phase:'awaiting_owner'}});
    const inspect=await import(pathToFileURL(path.join(app,'dist-server/scripts/preview-oid-owner-action.mjs')));
    inspect.inspectOwnerControlRequest(app);
    if(target.clientBuildId){
        const publisher=await import(pathToFileURL(path.join(app,'.nassaj-local-preview/oid-snapshots',target.oid,'scripts/client-preview-from-oid.mjs')));
        await publisher.promoteClientPreviewFromOid({root:app,group,expectedOid:target.oid,buildId:target.clientBuildId});
        const provenance=JSON.parse(fs.readFileSync(path.join(app,'dist/BUILD_PROVENANCE.json')));
        assert.equal(provenance.commit,target.oid);assert.equal(provenance.buildId,target.clientBuildId);
    }
}

/** Use the real application to spawn its loaded launcher, preserving the old parent PID/start identity. */
export async function startBridgeAction(lab,meta) {
    const envPath=path.join(lab,'app/.env'),before=fs.readFileSync(envPath,'utf8');
    assert.ok(!/^NASSAJ_UPDATE_MODE=/m.test(before));
    const password=before.split('\n').find(line=>line.startsWith('BOOTSTRAP_OWNER_PASSWORD=')).slice('BOOTSTRAP_OWNER_PASSWORD='.length);
    const login=await fetch(`http://127.0.0.1:${meta.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'bridgeowner',password})});
    assert.equal(login.status,200);const token=(await login.json()).token;
    assert.equal(fs.readFileSync(envPath,'utf8'),before);
    const queued=await fetch(`http://127.0.0.1:${meta.port}/api/system/pending`,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({actionType:'safe-restart',expectedServerBuildId:meta.target.buildId,reason:'isolated bridge rehearsal'})});
    assert.ok(queued.ok);const action=(await queued.json()).action;assert.ok(action.id);
    const app=path.join(lab,'app'),id='isolated-bridge-config';
    const prepared=prepareBridgeConfig(app,{schema:'nassaj-local-bridge-config-request/v1',id,nodeIdentity:'private-lab',
        approvalReference:'lab-only:not-live-authorization',reservationReference:'lab-only:exclusive-namespace',
        oldLoadedBuildId:meta.old.buildId,oldCapsuleSha256:meta.old.capsuleSha256,oldSafeRestartSha256:meta.old.safeRestartSha256,
        serverBuildId:meta.target.buildId,clientBuildId:meta.target.clientBuildId,controlManifestSha256:meta.target.controlManifestSha256,
        rehearsalReportSha256:createHash('sha256').update(fs.readFileSync(path.join(lab,'scenario.json'))).digest('hex'),
        sourceOid:meta.target.oid,actionId:action.id,expectedServerBuildId:meta.target.buildId});
    const configured=applyBridgeConfig(app,id,{schema:'nassaj-local-bridge-config-observation/v1',root:app,id,
        bindingSha256:prepared.bindingSha256,observedAt:Date.now(),reservationReference:prepared.binding.reservationReference,
        configWritersReserved:true,publishersQuiescent:true,noCompetingActivation:true,oldEffectiveModeAbsent:true,pm2SavedModeAbsent:true});
    assert.equal(configured.physicalState,'configured');
    fs.writeFileSync(path.join(lab,'bridge-config-report.json'),JSON.stringify(configured),{mode:0o600});
    const completion=(async()=>{
    let response;
    try {response=await fetch(`http://127.0.0.1:${meta.port}/api/system/actions/safe-restart/run`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({expectedServerBuildId:meta.target.buildId,reason:'isolated bridge rehearsal'}),signal:AbortSignal.timeout(15000)});}
    catch(error){
        const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});
        try {const row=db.prepare('SELECT status FROM pending_server_actions WHERE id=?').get(action.id);
            if(!row || !['executing','executed'].includes(row.status))throw error;
            return {httpStatus:null,status:'connection_closed_during_recorded_action',rowStatus:row.status};
        } finally {db.close();}
    }
    const body=await response.json();
    if(!response.ok)throw Error(`bridge_action_refused:${response.status}:${body.code||body.status}`);
    return {httpStatus:response.status,status:body.status};
    })();
    // The old application may disappear before returning HTTP. Observe the new
    // process concurrently so inspect-brk cannot manufacture a startup timeout.
    void completion.catch(()=>{});
    return {completion};
}

/** Observe the real legacy terminal receipt and bind it to the running child's full health identity. */
export async function assertBridgeTerminal(lab,meta,health) {
    assert.equal(health.normalAdmissionReady,true);
    assert.equal(health.updateMode,'local-main');
    assert.equal(health.serverLoadedOid,meta.target.oid);
    assert.equal(health.serverLoadedBuildId,meta.target.buildId);
    const git=path.join(lab,'app/.git'),deadline=Date.now()+60000;
    let terminal;
    while(Date.now()<deadline){
        const names=fs.readdirSync(git).filter(name=>/^nassaj-oid-control-transaction-1-[a-f0-9]{64}\.json$/.test(name));
        assert.equal(names.length,1);
        const file=path.join(git,names[0]);assert.ok(fs.lstatSync(file).isFile());
        const journal=JSON.parse(fs.readFileSync(file));
        if(journal.state==='served'){terminal=journal;break;}
        if(['rolled_back','manual_recovery_required','previous_attestation_failed'].includes(journal.state))throw Error('bridge_terminal_not_served:'+journal.state);
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(terminal,'legacy capsule must durably attest served');
    assert.equal(terminal.oid,meta.target.oid);assert.equal(terminal.buildId,meta.target.buildId);
    assert.equal(terminal.controlManifestSha256,meta.target.controlManifestSha256);
    assert.equal(terminal.transactionNonce,health.serverTransactionNonce);assert.equal(terminal.bootNonce,health.serverBootNonce);
    assert.equal(terminal.newPid,health.pid);assert.equal(String(terminal.newStartTicks),String(health.serverProcessStartTicks));
    assert.notEqual(terminal.oldPid,terminal.newPid);assert.ok(terminal.actionId);
    const config=checkBridgeConfig(path.join(lab,'app'),'isolated-bridge-config');
    assert.equal(config.physicalState,'configured');assert.equal(config.binding.actionId,terminal.actionId);
    assert.equal(config.binding.serverBuildId,terminal.buildId);assert.equal(config.binding.sourceOid,terminal.oid);
    const configuration=fs.readFileSync(path.join(lab,'app/.env'),'utf8');
    assert.equal(configuration.split('\n').filter(line=>line.startsWith('NASSAJ_UPDATE_MODE=')).join(''),'NASSAJ_UPDATE_MODE=local-main');
    return {state:terminal.state,actionId:terminal.actionId,transactionNonce:terminal.transactionNonce,
        serverBuildId:terminal.buildId,normalAdmissionReady:true,mode:'local-main',newPid:terminal.newPid,configBindingSha256:config.bindingSha256};
}

/** Verify that the actual HTTP application serves the pinned client entry assets before and after bridge startup. */
export async function assertBridgeClientAssets(lab,meta) {
    if(!meta.target.clientBuildId)return {verified:false,reason:'client_target_not_supplied'};
    const directory=path.join(lab,'app/dist');
    const index=await fetch(`http://127.0.0.1:${meta.port}/`,{signal:AbortSignal.timeout(5000)});
    assert.equal(index.status,200);const html=await index.text();
    const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match=>match[1]);
    assert.ok(assets.some(asset=>asset.endsWith('.js')));
    const evidence=[];
    for(const asset of [...new Set(assets)]){
        assert.ok(!asset.includes('..'));
        const file=path.join(directory,asset.slice(1));assert.ok(fs.lstatSync(file).isFile());
        const response=await fetch(`http://127.0.0.1:${meta.port}${asset}`,{signal:AbortSignal.timeout(5000)});
        assert.equal(response.status,200);
        const expected=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected);
        evidence.push({asset,sha256:expected});
    }
    return {verified:true,buildId:meta.target.clientBuildId,assets:evidence};
}

/** Verify an actual old-capsule rollback receipt after the previous generation has re-attested the resulting database. */
export async function assertBridgeRollbackTerminal(lab,meta,health) {
    assert.equal(health.serverLoadedOid,meta.old.oid);assert.equal(health.serverLoadedBuildId,meta.old.buildId);
    const git=path.join(lab,'app/.git'),deadline=Date.now()+15000;
    while(Date.now()<deadline){
        const names=fs.readdirSync(git).filter(name=>/^nassaj-oid-control-transaction-1-[a-f0-9]{64}\.json$/.test(name));
        assert.equal(names.length,1);
        const journal=JSON.parse(fs.readFileSync(path.join(git,names[0])));
        if(journal.state==='rolled_back'){
            assert.equal(journal.previousBuildId,meta.old.buildId);assert.equal(journal.buildId,meta.target.buildId);
            assert.equal(journal.transactionNonce,health.serverTransactionNonce);assert.equal(journal.rollbackBootNonce,health.serverBootNonce);
            assert.equal(journal.newPid,health.pid);assert.equal(String(journal.newStartTicks),String(health.serverProcessStartTicks));
            const app=path.join(lab,'app'),id='isolated-bridge-config',configured=checkBridgeConfig(app,id);
            assert.equal(configured.binding.actionId,journal.actionId);
            const restored=restoreBridgeConfig(app,id,{schema:'nassaj-local-bridge-config-observation/v1',root:app,id,
                bindingSha256:configured.bindingSha256,observedAt:Date.now(),reservationReference:configured.binding.reservationReference,
                configWritersReserved:true,publishersQuiescent:true,noCompetingActivation:true,noPendingRuntimeStart:true});
            assert.equal(restored.physicalState,'original');
            assert.equal(createHash('sha256').update(fs.readFileSync(path.join(app,'.env'))).digest('hex'),restored.originalSha256);
            fs.writeFileSync(path.join(lab,'bridge-config-restored.json'),JSON.stringify(restored),{mode:0o600});
            return {state:'rolled_back',transactionNonce:journal.transactionNonce,oldBuildId:meta.old.buildId,databaseRestored:false,
                configRestored:true,configBindingSha256:restored.bindingSha256};
        }
        if(journal.state==='manual_recovery_required')throw Error('bridge_rollback_manual:'+journal.reason);
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('bridge_rollback_receipt_missing');
}
