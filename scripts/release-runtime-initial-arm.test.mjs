import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSupervisorMutationHandler, attachSupervisorMutationChannel } from './lib/release-runtime-forward-supervisor.mjs';
import { forwardValueSha256 as sha } from './lib/release-runtime-forward-child-protocol.mjs';
import { preparePm2TypedStep } from './lib/pm2-typed-mutation.mjs';
import { invalidateCutoverStartupAdmission } from './lib/release-runtime-cutover.mjs';

import { installFixedStateMutexAuthority } from './fixtures/fixed-state-mutex-authority.mjs';
import { setupInitialArmFixture } from './fixtures/initial-arm-fixture.mjs';

// The production state mutex is root-only; install the measured fixture authority at the
// fixed config path so every lock below runs the real flock/CAS path under this test root.
const setup = async (t, options) => { const f = await setupInitialArmFixture(t, options); installFixedStateMutexAuthority(t, f.root, f.config); return f; };

test('production arm writes both durable bindings before real admission offer and consume', async t => {
    const f=await setup(t); const pending=f.call(f.request());
    assert.equal(pending.reason,'initial_process_not_armed');
    const receipt=await f.arm(); assert.equal(receipt.process.pid,f.target.pid);
    assert.equal(f.read('startup-admission.json').initialTargetProcessSha256,sha(receipt));
    const offer=f.call(f.request()); const consumed=f.call(f.consume(offer));
    assert.equal(consumed.initialTargetProcessSha256,sha(receipt));
    assert.equal(f.read('first-cutover.json').phase,'startup_claimed');
});
test('actual invalidation during private observation prevents root arm',async t=>{
    const f=await setup(t); let reads=0;
    await assert.rejects(f.arm(async()=>{if(++reads===1) invalidateCutoverStartupAdmission(f.root,'maintenance'); return f.response;}));
    assert.equal(f.read('first-cutover.json').initialTargetProcess,undefined);
});
test('expired fixed boot window denies before PM2 observation',async t=>{
    const f=await setup(t); f.window.issuedAtBootMs-=31000; f.window.expiresAtBootMs-=31000;
    f.write('first-cutover.json',{...f.read('first-cutover.json'),initialStartWindow:f.window});
    await assert.rejects(f.arm(async()=>{assert.fail('must not query PM2');}),/initial_window/);
});
test('changed PID between private observations cannot arm',async t=>{
    const f=await setup(t); let reads=0;
    await assert.rejects(f.arm(async()=>++reads===1?f.response:{...f.response,privateEntries:[{...f.response.privateEntries[0],pid:f.worker.pid}]}),/initial_observation_changed/);
});
test('journal-only arm after admission rename failure remains unclaimable and cannot rearm',async t=>{
    const f=await setup(t); const rename=fs.renameSync;
    const mock=t.mock.method(fs,'renameSync',(from,to)=>{
        if(to===`${f.root}/startup-admission.json`) throw Error('fixture admission rename interruption');
        return rename(from,to);
    });
    await assert.rejects(f.arm(),/rename interruption/); mock.mock.restore();
    assert.ok(f.read('first-cutover.json').initialTargetProcess);
    assert.equal(f.read('startup-admission.json').initialTargetProcessSha256,undefined);
    assert.throws(()=>f.call(f.request()));
    await assert.rejects(f.arm(),/initial_arm_phase/);
});
test('admission fsync failure does not report arm success even after atomic rename',async t=>{
    const f=await setup(t); const fsync=fs.fsyncSync; let renamed=false;
    const rename=fs.renameSync;
    t.mock.method(fs,'renameSync',(from,to)=>{const result=rename(from,to); if(to===`${f.root}/startup-admission.json`) renamed=true; return result;});
    t.mock.method(fs,'fsyncSync',fd=>{if(renamed) throw Error('fixture directory fsync interruption'); return fsync(fd);});
    await assert.rejects(f.arm(),/fsync interruption/);
});

for (const order of ['claim-before-result','result-before-arm','deadline-before-ack','deadline-after-write','deadline-after-result','deadline-after-result-write']) test(`production per-step handler: ${order}`,async t=>{
    const worker=spawn(process.execPath,['-e',`const fs=require('node:fs'),net=require('node:net');let text='';const input=new net.Socket({fd:6,readable:true,writable:false});input.on('data',chunk=>{text+=chunk;const at=text.indexOf('\\n');if(at>=0){process.send(JSON.parse(text.slice(0,at)));text=text.slice(at+1);}});process.on('message',frame=>fs.writeSync(5,JSON.stringify(frame)+'\\n'));`],{stdio:['ignore','ignore','ignore','ignore','ignore','pipe','pipe','ipc']});
    await once(worker,'spawn');
    t.after(async()=>{if(worker.exitCode===null&&worker.signalCode===null){const closed=once(worker,'close');worker.kill();await closed;}});
    const f=await setup(t,{workerChild:worker}); const descriptor=f.context.targetDescriptor;
    const baseline=f.context.slot.baseline; const daemon=f.response.observation.daemon;
    let entries=[]; let blocked; let release; let expired=false;
    f.config.forwardActivation={supervisorPlan:{pm2:{observer:{}},mutation:{oldSlot:{},targetDescriptor:descriptor,metadata:{}}},mutatorPlan:{}};
    const journal=f.read('first-cutover.json');
    journal.phase='supervisor_start_authorized'; journal.startupClaim={state:'awaiting_process'};
    journal.forwardSupervisorAttempts[0].steps=[];
    delete journal.initialStartWindow; delete journal.targetSlotBinding;
    f.write('first-cutover.json',journal);
    const observe=async()=>{if(blocked) await blocked; return {observation:f.response.observation,privateEntries:structuredClone(entries)};};
    const handler=createSupervisorMutationHandler(f.config,f.intent,f.worker,{observePrivateRuntime:observe,observeInhibitors:()=>{},readMetadata:()=>f.context.metadata,checkDeadline:()=>{if(expired)throw Error('forward_supervisor_deadline');}});
    let channelFailure;
    const detach=attachSupervisorMutationChannel(worker,handler,error=>{channelFailure=error;worker.kill();});t.after(detach);
    const exchange=frame=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(Error('fixture FD response timeout')),2000);
        const receive=value=>finish(null,value);const closed=()=>finish(channelFailure||Error('fixture FD child closed'));
        const finish=(error,value)=>{clearTimeout(timer);worker.off('message',receive);worker.off('close',closed);error?reject(error):resolve(value);};
        worker.once('message',receive);worker.once('close',closed);worker.send(frame);
    });
    const preparedRequest={operationId:'transaction-one',attemptId:f.intent.attemptId,step:'configure-target-stopped',expectedSlotDigest:sha({absent:true,name:descriptor.name,namespace:descriptor.namespace})};
    const prep=preparePm2TypedStep(preparedRequest,{attemptNonce:f.intent.attemptNonce,targetDescriptor:descriptor},[],daemon).intent;
    if(order==='deadline-before-ack') expired=true;
    if(order==='deadline-after-write') {
        const rename=fs.renameSync;t.mock.method(fs,'renameSync',(from,to)=>{const value=rename(from,to);if(to===`${f.root}/first-cutover.json`)expired=true;return value;});
    }
    if(order==='deadline-before-ack'||order==='deadline-after-write') {
        await assert.rejects(exchange(prep),/forward_supervisor_deadline/);
        const steps=f.read('first-cutover.json').forwardSupervisorAttempts[0].steps;
        assert.equal(steps.length,order==='deadline-before-ack'?0:1);
        if(steps.length)assert.equal(steps[0].state,'possibly_sent');
        assert.equal(f.read('first-cutover.json').targetSlotBinding,undefined);return;
    }
    const ack=await exchange(prep); assert.equal(ack.decision,'authorized');
    entries=[{pid:0,pm_id:44,pm2_env:baseline}];
    const binding={schema:'nassaj-prepared-pm2-slot/v1',operationId:'transaction-one',attemptId:f.intent.attemptId,prepareIntentSha256:sha(prep),
        daemonIdentitySha256:sha(daemon),namespaceSha256:sha(descriptor.namespace),targetDescriptorSha256:sha(descriptor),allocatedPmId:44,preparedEntrySha256:sha(baseline),observationSha256:f.response.observation.observationSha256};
    const result=(step,intent,slotDigest,targetSlotBinding)=>({schema:'nassaj-pm2-step-result/v1',operationId:'transaction-one',attemptId:f.intent.attemptId,
        attemptNonce:f.intent.attemptNonce,step,requestId:intent.requestId,dispatchState:'observed',observationSha256:f.response.observation.observationSha256,slotDigest,targetSlotBinding});
    const prepResult=result('configure-target-stopped',prep,sha(baseline),binding);
    if(order==='deadline-after-result') {
        const hr=process.hrtime.bigint.bind(process.hrtime);
        t.mock.method(process.hrtime,'bigint',()=>{if(new Error().stack.includes('samplePm2Clock'))expired=true;return hr();});
        const startClock=structuredClone(f.read('first-cutover.json').forwardSupervisorAttempts[0].steps[0].beforeClock);
        await assert.rejects(exchange(prepResult),/forward_supervisor_deadline/);
        const steps=f.read('first-cutover.json').forwardSupervisorAttempts[0].steps;
        assert.equal(steps.length,1);assert.equal(steps[0].state,'possibly_sent');assert.deepEqual(steps[0].beforeClock,startClock);
        assert.equal(f.read('first-cutover.json').targetSlotBinding,undefined);return;
    }
    if(order==='deadline-after-result-write') {
        const rename=fs.renameSync;t.mock.method(fs,'renameSync',(from,to)=>{const value=rename(from,to);if(to===`${f.root}/first-cutover.json`)expired=true;return value;});
        await assert.rejects(exchange(prepResult),/forward_supervisor_deadline/);
        const steps=f.read('first-cutover.json').forwardSupervisorAttempts[0].steps;
        assert.equal(steps.length,1);assert.equal(steps[0].state,'observed');
        // Durable observation is retained for recovery, but no recorded ACK can authorize the next operation.
        assert.equal(worker.exitCode!==null||worker.signalCode!==null,true);return;
    }
    assert.equal((await exchange(prepResult)).decision,'recorded');
    assert.deepEqual(f.read('first-cutover.json').targetSlotBinding,binding);
    const start=preparePm2TypedStep({operationId:'transaction-one',attemptId:f.intent.attemptId,step:'start-target',expectedSlotDigest:sha(baseline)},
        {...f.context,attemptNonce:f.intent.attemptNonce,slot:{pmId:44,baseline,descriptor,entrySha256:sha(baseline)},targetSlotBinding:binding},entries,daemon).intent;
    await exchange(start);
    const now=Date.now(); entries=[{...f.response.privateEntries[0],pm2_env:{...f.response.privateEntries[0].pm2_env,created_at:now,pm_uptime:now}}];
    if(order==='result-before-arm') blocked=new Promise(resolve=>{release=resolve;});
    const startResult=result('start-target',start,sha(entries[0].pm2_env),null);
    let resultPromise;
    if(order==='result-before-arm') { resultPromise=exchange(startResult); assert.equal(f.read('first-cutover.json').phase,'target_start_intent'); release(); blocked=null; }
    else {
        const deadline=Date.now()+1000;
        while(!f.read('first-cutover.json').initialTargetProcess && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,1));
        const offer=f.call(f.request()); f.call(f.consume(offer));
        resultPromise=exchange(startResult);
    }
    assert.equal((await resultPromise).decision,'recorded');
    if(order==='result-before-arm') { const offer=f.call(f.request()); f.call(f.consume(offer)); }
    assert.equal(f.read('first-cutover.json').phase,'startup_claimed');
    assert.deepEqual(f.read('first-cutover.json').forwardSupervisorAttempts[0].steps.map(value=>value.state),['observed','observed']);
});
