import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {setupInitialArmFixture} from '../scripts/fixtures/initial-arm-fixture.mjs';
import { createBootstrapContextHarness } from '../scripts/fixtures/bootstrap-context-harness.mjs';
import { installFixedStateMutexAuthority } from '../scripts/fixtures/fixed-state-mutex-authority.mjs';

test('actual context obtains signed-root claim and security phase over a fresh child pipe before serving', async t => {
    const databaseRoot=fs.mkdtempSync('/var/tmp/nassaj-e5-positive-');t.after(()=>fs.rmSync(databaseRoot,{recursive:true,force:true}));
    const databasePath=path.join(databaseRoot,'auth.db');fs.writeFileSync(databasePath,'',{flag:'wx',mode:0o600});
    const f = createBootstrapContextHarness(t,{simulateInitialOperator:true,databasePath});
    const module = pathToFileURL(path.join(f.releaseRoot, 'dist-server/server/bootstrap-startup-context.js')).href;
    const serviceFile=path.join(f.releaseRoot,'dist-server/server/modules/providers/services/engine-switch-liveness.service.ts');
    fs.mkdirSync(path.dirname(serviceFile),{recursive:true});
    fs.copyFileSync(new URL('./modules/providers/services/engine-switch-liveness.service.ts',import.meta.url),serviceFile);
    const modelStoreFile=path.join(path.dirname(serviceFile),'engine-restamp-model-store.service.ts');
    fs.copyFileSync(new URL('./modules/providers/services/engine-restamp-model-store.service.ts',import.meta.url),modelStoreFile);
    const go=path.join(f.root,'context-go');
    const running = f.start(`import {setTimeout as delay} from 'node:timers/promises';import existsFs from 'node:fs';
        while(!existsFs.existsSync(${JSON.stringify(go)}))await delay(5);
        import {establishStartupAdmission,admitSecurityStartup,beginEngineRestampStartupRecoveryAttempt,
            confirmStartupServing,isEngineRestampStartupRecoveryAttemptCurrent,
            isEngineRestampStartupRecoveryPredecessorIntent,mintEngineRestampStartupRecoveryClaim,
            readVerifiedStartupContext,releaseEngineRestampStartupRecoveryClaim,requireStartupAdmission} from ${JSON.stringify(module)};
        const context=await establishStartupAdmission();
        if (!Object.isFrozen(context.databaseTarget) || !context.databaseTarget.schemaDigest) throw Error('target_missing');
        let early=false;try{mintEngineRestampStartupRecoveryClaim();}catch{early=true;}if(!early)throw Error('early_recovery_claim');
        const fs=await import('node:fs'); const read=fs.default.readFileSync;
        fs.default.readFileSync=function(file,...args){if(String(file).endsWith('RELEASE_ASSET_MANIFEST.json')) throw Error('manifest_hot_read');return read.call(this,file,...args)};
        for(let i=0;i<100;i++) requireStartupAdmission();
        await admitSecurityStartup();const claim=mintEngineRestampStartupRecoveryClaim();
        if(!Object.isFrozen(claim)||Object.keys(claim).length!==0||JSON.stringify(claim)!=='{}')throw Error('claim_exposed');
        let duplicate=false;try{mintEngineRestampStartupRecoveryClaim();}catch{duplicate=true;}if(!duplicate)throw Error('duplicate_claim');
        if(isEngineRestampStartupRecoveryAttemptCurrent(claim)||isEngineRestampStartupRecoveryAttemptCurrent({}))throw Error('premature_attempt');
        beginEngineRestampStartupRecoveryAttempt(claim);
        let replay=false;try{beginEngineRestampStartupRecoveryAttempt(claim);}catch{replay=true;}if(!replay)throw Error('attempt_replay');
        const owner={...context.process};if(isEngineRestampStartupRecoveryPredecessorIntent(claim,owner))throw Error('current_owner_accepted');
        owner.pid+=1;if(!isEngineRestampStartupRecoveryPredecessorIntent(claim,owner))throw Error('predecessor_owner_rejected');
        process.env.DATABASE_PATH=${JSON.stringify(databasePath)};
        const {register}=await import('tsx/esm/api');const unregister=register({tsconfig:${JSON.stringify(path.join(process.cwd(),'server/tsconfig.json'))}});
        const database=await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(),'server/modules/database/index.ts')).href)});
        const liveness=await import(${JSON.stringify(pathToFileURL(serviceFile).href)});
        globalThis[Symbol.for('nassaj.engine-restamp-model-store.test-deps')]={home:()=>${JSON.stringify(databaseRoot)},now:Date.now};
        const modelStore=await import(${JSON.stringify(pathToFileURL(modelStoreFile).href)});
        await database.initializeDatabase();let probeCalls=0;liveness.setEngineSwitchLivenessProbe(()=>{probeCalls+=1;return {busy:false,reason:null};});
        const makeIntent=(sessionId,ownerProcess,operationId)=>{const value={schema:'nassaj-engine-restamp-intent/v1',operationId,sessionId,
            ownerProcess,actor:{kind:'jwt',userId:1,authorizationGeneration:1},projectBinding:{kind:'projectless',workspaceId:'/fixture',authorityFenceSha256:'a'.repeat(64)},
            fromPin:{engine:'anthropic',source:'server_verdict'},toPin:{engine:'openai',source:'user_switch'},fromModel:{changed:true,model:'old'},
            toModel:{changed:true,model:'new'},turnsExported:0,acknowledgedExport:false,phase:'target_observed',revision:2,
            requestSha256:'0'.repeat(64),createdAt:'2026-09-24T12:00:00.000Z'};value.requestSha256=database.engineRestampRequestSha256(value);return value;};
        const predecessor=makeIntent('positive-predecessor',owner,'123e4567-e89b-42d3-a456-000000000901');database.engineRestampIntentsDb.prepare(predecessor);
        const restored=makeIntent('positive-restored',owner,'123e4567-e89b-42d3-a456-000000000903');database.engineRestampIntentsDb.prepare(restored);
        const ineligible=makeIntent('positive-ineligible',owner,'123e4567-e89b-42d3-a456-000000000904');database.engineRestampIntentsDb.prepare(ineligible);
        const currentOwner=makeIntent('current-owner',context.process,'123e4567-e89b-42d3-a456-000000000902');database.engineRestampIntentsDb.prepare(currentOwner);
        const now='2026-09-24T12:00:00.000Z';for(const value of [predecessor,restored,ineligible,currentOwner])database.getConnection().prepare(
          'INSERT INTO sessions(session_id,provider,project_path,isArchived,created_at,updated_at,engine_provider,engine_provider_source) VALUES (?,? ,NULL,0,?,?,?,?)'
        ).run(value.sessionId,'claude',now,now,value.fromPin.engine,value.fromPin.source);
        const scanned=database.engineRestampIntentsDb.scanRecoveryCandidates().candidates;
        const predecessorCandidate=scanned.find(value=>value.intent.sessionId===predecessor.sessionId);
        const restoredCandidate=scanned.find(value=>value.intent.sessionId===restored.sessionId);
        const ineligibleCandidate=scanned.find(value=>value.intent.sessionId===ineligible.sessionId);
        const currentCandidate=scanned.find(value=>value.intent.sessionId===currentOwner.sessionId);
        if(liveness.reserveEngineRestampRecovery(claim,{...predecessorCandidate})!==null)throw Error('clone_candidate_accepted');
        if(liveness.reserveEngineRestampRecovery(claim,currentCandidate)!==null)throw Error('current_process_accepted');
        const reservation=liveness.reserveEngineRestampRecovery(claim,predecessorCandidate);if(!reservation||probeCalls!==0)throw Error('positive_reservation_failed');
        const restoredReservation=liveness.reserveEngineRestampRecovery(claim,restoredCandidate);const ineligibleReservation=liveness.reserveEngineRestampRecovery(claim,ineligibleCandidate);
        if(!restoredReservation||!ineligibleReservation)throw Error('mixed_reservation_failed');
        const cloud=await import('node:path');const directory=cloud.default.join(${JSON.stringify(databaseRoot)},'.cloudcli');fs.default.mkdirSync(directory,{mode:0o700});
        const target=cloud.default.join(directory,'provider-session-active-model-changes.json');fs.default.writeFileSync(target,JSON.stringify({version:1,entries:{
          ['claude:'+predecessor.sessionId]:{provider:'claude',sessionId:predecessor.sessionId,supported:true,changed:true,model:'new',updatedAt:now},
          ['claude:'+restored.sessionId]:{provider:'claude',sessionId:restored.sessionId,supported:true,changed:true,model:'old',updatedAt:now},
          ['claude:'+ineligible.sessionId]:{provider:'claude',sessionId:ineligible.sessionId,supported:true,changed:true,model:'third',updatedAt:now},
          unrelated:{provider:'glm',sessionId:'unrelated',supported:false,changed:false,model:null,updatedAt:now}
        }}).replace('"unrelated":','"glm:unrelated":'),{mode:0o600});
        const member=(intent,reservation)=>({intent,canonical:database.engineRestampIntentsDb.read(intent.sessionId).canonical,reservation});
        const batch=await modelStore.runEngineRestampRecoveryModelBatch(claim,[member(ineligible,ineligibleReservation),member(predecessor,reservation),member(restored,restoredReservation)]);
        const statuses=Object.fromEntries(batch.members.map(value=>[value.sessionId,value.status]));
        if(statuses[predecessor.sessionId]!=='repaired'||statuses[restored.sessionId]!=='already_restored'||statuses[ineligible.sessionId]!=='ineligible'||batch.counters.contentReadCount!==3||batch.counters.promotionCount!==1||probeCalls!==0)throw Error('positive_batch_failed');
        const repaired=JSON.parse(fs.default.readFileSync(target,'utf8'));if(repaired.entries['claude:'+predecessor.sessionId].model!=='old'||repaired.entries['claude:'+restored.sessionId].model!=='old'||repaired.entries['claude:'+ineligible.sessionId].model!=='third'||!repaired.entries['glm:unrelated'])throw Error('positive_batch_readback');
        const stored=database.engineRestampIntentsDb.read(predecessor.sessionId);const changed={...stored.intent,revision:stored.intent.revision+1,phase:'compensating'};
        database.engineRestampIntentsDb.compareAndSet(predecessor.sessionId,stored.canonical,changed);
        if(liveness.isEngineRestampRecoveryReservationCurrent(reservation)||liveness.isEngineRestampReserved(predecessor.sessionId))throw Error('canonical_cas_not_pruned');
        const rescanned=database.engineRestampIntentsDb.scanRecoveryCandidates().candidates.find(value=>value.intent.sessionId===predecessor.sessionId);
        const servingReservation=liveness.reserveEngineRestampRecovery(claim,rescanned);if(!servingReservation)throw Error('serving_reservation_failed');
        if(!isEngineRestampStartupRecoveryAttemptCurrent(claim)||isEngineRestampStartupRecoveryAttemptCurrent({...claim}))throw Error('claim_identity');
        await confirmStartupServing();const revoked=!isEngineRestampStartupRecoveryAttemptCurrent(claim);
        const released=releaseEngineRestampStartupRecoveryClaim(claim)&&!releaseEngineRestampStartupRecoveryClaim(claim);
        const servingPruned=!liveness.isEngineRestampReserved(predecessor.sessionId);
        const ordinary=liveness.reserveEngineRestamp(predecessor.sessionId);const ordinaryWorked=!!ordinary&&liveness.releaseEngineRestamp(ordinary);
        unregister();database.closeConnection();
        console.log(JSON.stringify({phase:readVerifiedStartupContext().phase,pid:process.pid,revoked,released,servingPruned,ordinaryWorked,probeCalls}));`);
    t.after(()=>running.child.kill('SIGKILL'));
    const armed=await setupInitialArmFixture(t,{fixture:f,targetChild:running.child});
    // The root arm runs under the fixed state mutex, which measures the installed config path.
    installFixedStateMutexAuthority(t,f.root,f.config,{file:path.join(f.root,'config.json')});
    f.write('config.json',f.config);await armed.arm();fs.writeFileSync(go,'go');
    await f.waitForSecurity(); f.commit();
    const result = await running.result; assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim().split('\n').at(-1)); assert.equal(response.phase, 'serving'); assert.equal(response.pid, running.child.pid);
    assert.equal(response.revoked, true); assert.equal(response.released, true);
    assert.equal(response.servingPruned,true);assert.equal(response.ordinaryWorked,true);assert.equal(response.probeCalls,1);
    assert.equal(f.read('startup-admission.json').lastClaim.pid, running.child.pid);
});

test('missing mandatory manifest fails before any claim and cannot fall through to default startup', async t => {
    const f = createBootstrapContextHarness(t); fs.unlinkSync(path.join(f.releaseRoot, 'RELEASE_ASSET_MANIFEST.json'));
    const module = pathToFileURL(path.join(f.releaseRoot, 'dist-server/server/bootstrap-startup-context.js')).href;
    const result = await f.start(`import {establishStartupAdmission} from ${JSON.stringify(module)};await establishStartupAdmission();`).result;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /root_startup_manifest_required/);
    assert.equal(f.read('startup-admission.json').lastClaim, null);
});


test('local descriptor v2 reaches actual context claim and rejects a GitHub version label before admission', async t => {
    const f=createBootstrapContextHarness(t,{localBuild:true,simulateInitialOperator:true});
    const module=pathToFileURL(path.join(f.releaseRoot,'dist-server/server/bootstrap-startup-context.js')).href;
    const go=path.join(f.root,'local-go');
    const running=f.start(`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
        import {establishStartupAdmission} from ${JSON.stringify(module)};
        while(!fs.existsSync(${JSON.stringify(go)}))await delay(5);
        const value=await establishStartupAdmission();console.log(JSON.stringify({generationId:value.generationId}));`);
    t.after(()=>running.child.kill('SIGKILL'));
    const armed=await setupInitialArmFixture(t,{fixture:f,targetChild:running.child});
    installFixedStateMutexAuthority(t,f.root,f.config,{file:path.join(f.root,'config.json')});
    f.write('config.json',f.config);await armed.arm();fs.writeFileSync(go,'go');
    const result=await running.result;assert.equal(result.code,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).generationId,`local-forward-${f.descriptor.artifact.archiveSha256}`);
    const g=createBootstrapContextHarness(t,{localBuild:true});
    g.descriptor.schema='nassaj-startup-admission-client/v1';g.write('descriptor.json',g.descriptor);
    const other=pathToFileURL(path.join(g.releaseRoot,'dist-server/server/bootstrap-startup-context.js')).href;
    const denied=await g.start(`import {establishStartupAdmission} from ${JSON.stringify(other)};await establishStartupAdmission();`).result;
    assert.notEqual(denied.code,0);assert.equal(g.read('startup-admission.json').lastClaim,null);
});
