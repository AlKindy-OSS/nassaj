import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { validateManagedRestartRequest, verifyManagedRestartApproval, observeManagedRestartSlot, observeManagedRestartCaller } from './lib/release-runtime-managed-restart.mjs';
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha = v => createHash('sha256').update(v).digest('hex');
const hash = 'a'.repeat(64); const operationId = 'managed-operation-12345';
function fixture() {
    const keys = generateKeyPairSync('ed25519');
    const config = { expected: { nodeInstanceId: 'node-123', generationId: 'generation-123', releaseIdentitySha256: hash,
        databaseContractSha256: hash, ownerApprovalKeySha256: sha(keys.publicKey.export({ type: 'spki', format: 'der' })) },
    bootstrapClaim: { identity: { startupClosureSha256: hash } }, managedRestart: { pm2Id: 1 } };
    const target = { schema: 'nassaj-managed-restart-approval-target/v1', operationId,
        ...config.expected, startupClosureSha256: hash, commitReceiptSha256: hash,
        expectedSha256: sha(canonical(config.expected)), managedConfigurationSha256: sha(canonical(config.managedRestart)) };
    const payload = { schema: 'nassaj-owner-managed-restart-approval/v1', action: 'restartCommittedGeneration',
        scope: 'same-generation-managed-restart/v1', target, ownerId: 'owner-1234', nonce: 'a'.repeat(48), issuedAt: 1000, expiresAt: 2000 };
    const signed = body => ({ ...body, signature: sign(null, Buffer.from(canonical(body)), keys.privateKey).toString('base64url') });
    return { config, payload, signed, key: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
}
test('managed request rejects unknown actions and extra or malformed locators', () => {
    const request = { schema: 'nassaj-managed-restart-request/v1', operationId };
    assert.equal(validateManagedRestartRequest('restartCommittedGeneration', request), operationId);
    for (const value of [{ ...request, force: true }, { ...request, operationId: '../escape' }, { ...request, schema: 'other' }])
        assert.throws(() => validateManagedRestartRequest('restartCommittedGeneration', value));
    assert.throws(() => validateManagedRestartRequest('arbitrary', request));
});
test('managed approval requires fresh signature and exact independent committed/config bindings', () => {
    const f = fixture(); const verify = (approval, config = f.config, receipt = hash) => verifyManagedRestartApproval(config, approval, operationId, receipt, f.key, 1500);
    assert.equal(verify(f.signed(f.payload)).operationId, operationId);
    for (const mutate of [p => { p.scope = 'same-generation-auto-restart/v1'; }, p => { p.target.operationId = 'other-operation-12345'; },
        p => { p.expiresAt = 1500; }, p => { p.issuedAt = 1501; }, p => { p.expiresAt = 999999; },
        p => { p.target.commitReceiptSha256 = 'b'.repeat(64); }, p => { p.extra = true; }]) {
        const changed = structuredClone(f.payload); mutate(changed); assert.throws(() => verify(f.signed(changed)));
    }
    const changed = structuredClone(f.config); changed.managedRestart.pm2Id = 2;
    assert.throws(() => verify(f.signed(f.payload), changed));
    assert.throws(() => verify(f.signed(f.payload), f.config, 'b'.repeat(64)));
    assert.throws(() => verify({ ...f.signed(f.payload), signature: 'a'.repeat(86) }));
});
test('managed slot requires name and numeric identity to select the same unique entry', () => {
    const settings = { processName: 'nassaj', pm2Id: 3, pm2Namespace: 'default', expectedPm2Cwd: '/pinned/workflow', nodeExecutable: '/usr/bin/node' };
    const entry = { name: 'nassaj', pm_id: 3, pid: 1234, pm2_env: { namespace: 'default', status: 'online', pm_cwd: '/pinned/workflow', exec_interpreter: '/usr/bin/node' } };
    let observations = 0;
    const inspect = pid => { observations++; return { pid, startTicks: '123', bootId: 'boot', state: 'S' }; };
    assert.equal(observeManagedRestartSlot(settings, [entry], inspect).process.pid, 1234);
    observations = 0;
    for (const entries of [[entry, { ...entry, pm_id: 4 }], [entry, { ...entry, name: 'other' }],
        [{ ...entry, pm2_env: { ...entry.pm2_env, namespace: 'other' } }], [{ ...entry, pm_id: 4 }],
        [{ ...entry, pm2_env: { ...entry.pm2_env, pm_cwd: '/generation' } }]]) assert.throws(() => observeManagedRestartSlot(settings, entries, inspect));
    assert.equal(observations, 0);
});

test('helper ancestry is bound to the recorded script launch and held root operator, never to server PID', () => {
    const config = { bootstrapClaim: { sudoExecutable: '/sudo', applicationUid: 1000 }, managedRestart: {
        wrapper: { path: '/wrapper' }, nodeExecutable: '/node', bashPath: '/bash', managedClientPath: '/client', safeRestartPath: '/script' } };
    const identity = (pid, parentPid, executable, argv, uid) => ({ pid, parentPid, executable, argv,
        uids: [uid, uid, uid, uid], startTicks: String(pid), bootId: 'boot' });
    const rows = new Map([
        [5, identity(5, 4, '/sudo', [], 0)], [4, identity(4, 3, '/node', ['/node', '/client', 'claim', operationId], 1000)],
        [3, identity(3, 2, '/bash', ['/bash', '/script', '--managed-operation', operationId, '--managed-child', '--exec'], 1000)],
        [2, identity(2, 1, '/node', ['/node', '/client', '--managed-operation', operationId, '--exec'], 1000)],
        [1, identity(1, 0, '/node', ['/node', '/parent'], 0)] ]);
    const inspect = pid => structuredClone(rows.get(pid)); const lock = { pid: 1, startTime: '1' };
    const run = () => observeManagedRestartCaller(config, operationId, rows.get(2), rows.get(1), lock, { parentPid: 5, inspect });
    assert.equal(run().pid, 4);
    lock.pid = 99; assert.throws(run, /operator_lock_mismatch/); lock.pid = 1;
    rows.get(3).parentPid = 1; assert.throws(run); rows.get(3).parentPid = 2;
    rows.get(4).argv[1] = '/untrusted-client'; assert.throws(run, /script_ancestry_invalid/);
});

test('durable acceptance preserves only the signed operation after expiry and rejects original-anchor or marker drift', async () => {
    const { readVerifiedManagedRestart } = await import('./lib/release-runtime-managed-admission.mjs');
    const f = fixture(); f.config.controlRoot = '/control';
    f.config.managedRestart.approvalFile = '/control/managed-restart-approval.json';
    f.config.bootstrapClaim.approvalFile = '/control/original-approval.json';
    f.config.bootstrapClaim.ownerApprovalPublicKeyFile = '/control/key';
    const originalPayload = { schema: 'nassaj-owner-cutover-approval/v1', action: 'release-runtime-first-cutover',
        expectedSha256: sha(canonical(f.config.expected)), startupAdmission: f.config.bootstrapClaim.identity,
        issuedAt: 1, expiresAt: 900 };
    const originalApproval = f.signed(originalPayload);
    const first = { state: 'committed', phase: 'committed', transactionId: 'original-transaction', expected: f.config.expected,
        startupClaim: { claimId: 'original-claim' }, approvalAcceptedAt: 500, approvalSha256: sha(canonical(originalApproval)) };
    const grant = { state: 'active', revision: 5, generationEpoch: 2, authorityId: first.transactionId,
        commitReceiptSha256: sha(canonical(first)), activationClaimSha256: sha(canonical(first.startupClaim)),
        identity: f.config.bootstrapClaim.identity, approvalSha256: first.approvalSha256 };
    f.payload.target.commitReceiptSha256 = grant.commitReceiptSha256;
    f.payload.target.managedConfigurationSha256 = sha(canonical(f.config.managedRestart));
    const approval = f.signed(f.payload);
    const journal = { schema: 'nassaj-managed-restart/v1', operationId, phase: 'prepared', revision: 1,
        originalGrant: grant, originalGrantSha256: sha(canonical(grant)), approvalAcceptedAt: 1500,
        approval, approvalNonce: approval.nonce, approvalSha256: sha(canonical(approval)) };
    const records = { '/control/managed-restart.json': journal, '/control/startup-admission.json': grant,
        '/control/first-cutover.json': first, '/control/managed-restart-approval.json': approval,
        '/control/original-approval.json': originalApproval };
    const readRootFile = file => file === '/control/key' ? f.key : Buffer.from(JSON.stringify(records[file]));
    const run = () => readVerifiedManagedRestart(f.config, operationId, { readRootFile, now: () => 99999 });
    assert.equal(run().approvalAcceptedAt, 1500);
    journal.approvalAcceptedAt = 99999; assert.throws(run, /approval_invalid/); journal.approvalAcceptedAt = 1500;
    records['/control/startup-admission.json'] = { ...grant, managedOperationId: 'different-operation-123' };
    assert.throws(run, /journal_authority_invalid/);
    records['/control/startup-admission.json'] = grant;
    first.startupClaim.claimId = 'forged'; assert.throws(run, /original_grant_invalid/);
});

import { fixture as admissionFixture } from './fixtures/startup-admission-fixture.mjs';
import { beginManagedRestartAdmission, armManagedReplacementAdmission, completeManagedRestartAdmission } from './lib/release-runtime-startup-admission.mjs';
function managedCoreFixture(t) {
    const f = admissionFixture(t,'cutover');
    installFixedStateMutexAuthority(t,f.root,f.config);
    f.deps.ownerUid=0;f.deps.effectiveUid=()=>0;
    // B-920: fixture kernel policy uses set membership for mapped overflow groups.
    f.config.forwardMigration.serviceIdentity.supplementaryGids=[...new Set(f.config.forwardMigration.serviceIdentity.supplementaryGids)];
    f.call(f.consume(f.call(f.request())));f.commit();
    f.caller.pid+=1;f.caller.startTicks='101';f.deps.processGone=()=>true;
    const grant = f.read('startup-admission.json');
    f.config.bootstrapClaim.applicationUid = f.caller.uid;
    const baseline={name:'nassaj',namespace:'default',status:'online',axm_actions:[],axm_monitor:{},axm_options:{},axm_dynamic:{},created_at:1,pm_uptime:1,restart_time:0,unstable_restarts:0,prev_restart_delay:0,version:'fixture'};
    f.config.managedRestart = { pm2Observer:{daemon:{pid:90}},mutation:{slot:{entrySha256:sha(canonical(baseline)),baseline}},approvalFile: `${f.root}/managed-restart-approval.json`, pm2Id: 3, pm2Namespace: 'default',
        serviceIdentity: { uid: f.caller.uid, gid: f.caller.uid, supplementaryGids: [f.caller.uid] },
        nodeExecutable:'/node',nodeSha256:hash,pm2Executable:'/pm2',pm2Sha256:hash,safeRestartPath:'/script',safeRestartSha256:hash,
        managedClientPath:'/client',managedClientSha256:hash,bashPath:'/bash',bashSha256:hash,
        processName:'nassaj',expectedPm2Cwd:'/cwd',home:'/home',nodeAbi:Number(process.versions.modules),pm2Home:'/pm2-home',workflowBase:'/workflows',privateHealthUrl:'http://127.0.0.1:3004/health',
        dispatcher:{path:'/dispatcher',sha256:hash},wrapper:{path:'/wrapper',sha256:hash},closure:{path:'/closure',sha256:hash},generationRoot:'/generation' };
    f.config.forwardMigration={serviceIdentity:f.config.managedRestart.serviceIdentity};
    const target = { schema: 'nassaj-managed-restart-approval-target/v1', operationId,
        nodeInstanceId: f.config.expected.nodeInstanceId, generationId: f.config.expected.generationId,
        releaseIdentitySha256: f.config.expected.releaseIdentitySha256, databaseContractSha256: f.config.expected.databaseContractSha256,
        startupClosureSha256: f.identity.startupClosureSha256, commitReceiptSha256: grant.commitReceiptSha256,
        ownerApprovalKeySha256: f.config.expected.ownerApprovalKeySha256, expectedSha256: sha(canonical(f.config.expected)),
        managedConfigurationSha256: sha(canonical(f.config.managedRestart)) };
    const payload = { schema: 'nassaj-owner-managed-restart-approval/v1', action: 'restartCommittedGeneration',
        scope: 'same-generation-managed-restart/v1', target, ownerId: 'owner-1234', nonce: 'a'.repeat(48),
        issuedAt: f.deps.now() - 1000, expiresAt: f.deps.now() + 1000 };
    const approval = { ...payload, signature: sign(null,Buffer.from(canonical(payload)),f.keys.privateKey).toString('base64url') };
    f.write('managed-restart-approval.json',approval);
    f.write('managed-restart.json',{ schema:'nassaj-managed-restart/v1',operationId,phase:'prepared',revision:1,
        originalGrant:grant,originalGrantSha256:sha(canonical(grant)),approvalAcceptedAt:f.deps.now(),approvalNonce:payload.nonce,
        approval,approvalSha256:sha(canonical(approval)),oldProcess:{uid:grant.lastClaim.uid,pid:grant.lastClaim.pid,startTicks:grant.lastClaim.startTicks,bootId:grant.lastClaim.bootId} });
    f.deps.inspectProcess = pid => ({ pid,startTicks:f.caller.startTicks,bootId:f.caller.bootId,
        uids:Array(4).fill(f.caller.uid),gids:Array(4).fill(f.caller.uid),supplementaryGids:[f.caller.uid],capabilities:['0','0','0'] });
    const patch = value => {const j=f.read('managed-restart.json');f.write('managed-restart.json',{...j,...value,revision:j.revision+1});};
    return {...f,grant,patch};
}
test('managed core fences steady claims, arms exact replacement, authorizes security and commits without changing activation anchor',t=>{
    const f=managedCoreFixture(t); const anchor=canonical(f.read('first-cutover.json'));
    const begun=beginManagedRestartAdmission(f.config,operationId,f.deps);
    assert.equal(begun.generationEpoch,f.grant.generationEpoch+1);
    assert.throws(()=>f.call(f.request()),/managed_replacement_mismatch/);
    const gate={operationId,generationEpoch:begun.generationEpoch,phase:'closed',closedAt:f.deps.now()};
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:gate});
    f.patch({phase:'restart_execution_intent',executionIntent:{launchAttemptNonce:hash},replacementProcess:{...f.caller,pm2Id:3,pm2Namespace:'default',launchAttemptNonce:hash}});
    const pending=f.call(f.request());assert.equal(pending.schema,'nassaj-bootstrap-admission-pending/v1');assert.equal(f.read('startup-admission.json').offer,null);
    f.deps.processGone=()=>false;assert.throws(()=>armManagedReplacementAdmission(f.config,operationId,f.deps),/replacement_unproved/);
    f.deps.processGone=()=>true;armManagedReplacementAdmission(f.config,operationId,f.deps);
    const claim=f.call(f.consume(f.call(f.request())));
    assert.equal(claim.mode,'steady');assert.equal(claim.authorityId,f.grant.authorityId);
    assert.throws(()=>f.call(f.request()),/offer_unavailable/);
    const security=f.phase('security',claim);
    assert.equal(security.decision,'security_startup_authorized');
    assert.equal(f.phase('serving',claim).decision,'pending');
    const receipt=visibility=>({schema:'nassaj-managed-health-receipt/v1',bodySha256:hash,clientBuildId:f.config.expected.clientBuildId,databaseContractSha256:f.config.expected.databaseContractSha256,operationId,visibility,claimId:claim.claimId,generationEpoch:claim.generationEpoch,
        process:f.caller,securityStartupSha256:sha(canonical(f.read('startup-admission.json').securityStartup)),
        releaseIdentitySha256:f.identity.releaseIdentitySha256,serverBuildId:f.config.expected.serverBuildId,observedAt:f.deps.now()});
    f.patch({phase:'public_verified',privateReceipt:receipt('private'),publicReceipt:receipt('public')});
    assert.throws(()=>completeManagedRestartAdmission(f.config,operationId,f.deps),/gate_not_open/);
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{...gate,phase:'opened'}});
    const committed=completeManagedRestartAdmission(f.config,operationId,f.deps);
    assert.equal(committed.state,'active');assert.equal(committed.managedOperationId,undefined);
    assert.equal(canonical(f.read('first-cutover.json')),anchor);
    assert.equal(f.phase('serving',claim).decision,'serving');
});

import { PassThrough } from 'node:stream';
import { runManagedRestartChild } from './release-runtime-managed-child.mjs';
test('managed wrapper drops before ready, requires EOF and exact permit, and never reuses ready pipe for results',async()=>{
    const serviceIdentity={uid:1000,gid:1000,supplementaryGids:[1000]};
    const identity={pid:55,parentPid:44,startTicks:'100',bootId:'boot',uids:[1000,1000,1000,1000],gids:[1000,1000,1000,1000],supplementaryGids:[1000],capabilities:['0','0','0']};
    for(const mutation of ['valid','wrong-operation','trailing']) {
        const input=new PassThrough();const output=new PassThrough();const events=[];const chunks=[];
        output.on('data',chunk=>chunks.push(chunk));
        const ended=new Promise(resolve=>output.on('end',resolve));
        const running=runManagedRestartChild({material:()=>({operationId,nonce:hash,launchIntentSha256:hash,serviceIdentity,operator:{pid:44,startTicks:'90',bootId:'boot'}}),
            drop:()=>{events.push('drop');return identity;},input,output,
            inspect:pid=>pid===55?identity:{pid:44,startTicks:'90',bootId:'boot'},runScript:()=>{events.push('script');return {code:0,signal:null};}});
        running.catch(()=>{}); await ended;
        assert.deepEqual(events,['drop']);
        const ready=JSON.parse(Buffer.concat(chunks));
        const permit={...ready,schema:'nassaj-managed-child-permit/v1',decision:'authorized'};
        if(mutation==='wrong-operation')permit.operationId='another-operation-12345';
        input.end(`${JSON.stringify(permit)}\n${mutation==='trailing'?'{}\n':''}`);
        if(mutation==='valid'){assert.equal((await running).code,0);assert.deepEqual(events,['drop','script']);}
        else {await assert.rejects(running);assert.deepEqual(events,['drop']);}
        assert.equal(Buffer.concat(chunks).toString().split('\n').length,2);
    }
});

test('managed core refuses replacement theft, namespace drift, stale epoch and repeated security authorization',t=>{
    const f=managedCoreFixture(t);const state=beginManagedRestartAdmission(f.config,operationId,f.deps);
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{operationId,generationEpoch:state.generationEpoch,phase:'closed',closedAt:f.deps.now()}});
    f.patch({phase:'restart_execution_intent',executionIntent:{launchAttemptNonce:hash},replacementProcess:{...f.caller,pm2Id:3,pm2Namespace:'other',launchAttemptNonce:hash}});
    assert.throws(()=>armManagedReplacementAdmission(f.config,operationId,f.deps),/arm_invalid/);
    f.patch({replacementProcess:{...f.caller,pm2Id:3,pm2Namespace:'default',launchAttemptNonce:hash}});
    armManagedReplacementAdmission(f.config,operationId,f.deps);
    f.caller.pid++;assert.throws(()=>f.call(f.request()),/replacement_mismatch/);f.caller.pid--;
    const offered=f.call(f.request());const consume=f.consume(offered);
    assert.throws(()=>f.call({...consume,generationEpoch:consume.generationEpoch+1}),/offer_stale/);
    f.call(consume);f.phase('security');assert.throws(()=>f.phase('security'),/security_invalid/);
    const request={...f.request(),schema:'nassaj-startup-serving-confirmation-request/v1',claimId:f.grant.lastClaim.claimId,
        generationEpoch:f.grant.generationEpoch,databaseContractSha256:f.identity.databaseContractSha256};
    assert.throws(()=>f.call(request),/managed_claim_mismatch/);
});

import { EventEmitter } from 'node:events';
import { runManagedRestartLaunch } from './lib/release-runtime-managed-restart.mjs';
test('parent persists kernel launch under CAS before permit and refuses a second launch of the same intent',async t=>{
    const f=managedCoreFixture(t);const identity={pid:5544,parentPid:process.pid,startTicks:'900',bootId:f.caller.bootId,
        uids:Array(4).fill(f.caller.uid),gids:Array(4).fill(f.caller.uid),supplementaryGids:[f.caller.uid],capabilities:['0','0','0']};
    const deps={...f.deps,verifyExecutable:()=>{},inspect:()=>identity,spawn:()=>{
        const child=new EventEmitter();child.pid=identity.pid;child.stdout=new PassThrough();child.stderr=new PassThrough();
        child.stdio=[null,child.stdout,child.stderr,new PassThrough(),new PassThrough(),new PassThrough(),new PassThrough()];
        const journal=f.read('managed-restart.json');assert.equal(journal.launch,undefined);
        const ready={schema:'nassaj-managed-child-ready/v1',operationId,nonce:journal.launchIntent.nonce,challenge:hash,
            launchIntentSha256:sha(canonical(journal.launchIntent)),pid:identity.pid,startTicks:identity.startTicks,bootId:identity.bootId};
        child.stdio[3].on('data',bytes=>{
            const permit=JSON.parse(bytes);const durable=f.read('managed-restart.json');
            assert.equal(durable.launch.pid,identity.pid);assert.equal(durable.permitIntent.nonce,permit.nonce);
        });
        child.stdio[3].on('end',()=>queueMicrotask(()=>child.emit('close',0,null)));
        child.stdio[4].end(`${JSON.stringify(ready)}\n`);return child;
    }};
    const launched=await runManagedRestartLaunch(f.config,operationId,'check',deps);assert.equal((await launched.exited).code,0);
    await assert.rejects(runManagedRestartLaunch(f.config,operationId,'check',deps),/launch_already_attempted/);
});

import { dispatchManagedRestartOperation } from './lib/release-runtime-managed-restart.mjs';
async function producerScenario(t,failure=false,busyFirst=false,rootDrift=false,siblingChange=null) {
    const f=managedCoreFixture(t);const original=canonical(f.read('first-cutover.json'));
    const operator={pid:process.pid,startTicks:'9000',bootId:f.caller.bootId};
    f.config.bootstrapClaim.sudoExecutable='/sudo';
    f.patch({operator,initiatingHelper:{...f.caller}});f.write('first-cutover.lock',{pid:operator.pid,startTime:operator.startTicks});
    let replacement=false;let launches=0;let executed=0;let script;const observed=[];
    const identity=(pid,parentPid,uid,startTicks,executable,argv=[])=>({pid,parentPid,startTicks,bootId:f.caller.bootId,
        uids:Array(4).fill(uid),gids:Array(4).fill(uid),supplementaryGids:[uid],capabilities:['0','0','0'],executable,argv});
    const inspect=pid=>{
        if(pid===operator.pid)return identity(pid,1,0,operator.startTicks,'/node',['/node','/parent']);
        if(pid===300)return identity(pid,301,0,'300','/sudo');
        if(pid===301)return identity(pid,302,f.caller.uid,'301','/node',['/node','/client','claim',operationId]);
        if(pid===302)return identity(pid,202,f.caller.uid,'302','/bash',['/bash','/script','--managed-operation',operationId]);
        if(pid>=201&&pid<=208)return identity(pid,operator.pid,f.caller.uid,String(pid),'/node',['/node','/wrapper']);
        if(replacement&&pid===f.grant.lastClaim.pid)throw Object.assign(Error('gone'),{code:'ENOENT'});
        const p=pid===f.grant.lastClaim.pid?f.grant.lastClaim:f.caller;
        return identity(pid,900,f.caller.uid,p.startTicks,'/node');
    };
    const siblings=()=>siblingChange?[{pm_id:99,pid:9090,pm2_env:{...f.config.managedRestart.mutation.slot.baseline,
        pm_id:99,name:'other-service',env:{PRIVATE_FIXTURE:replacement&&siblingChange==='control'?'changed':'private-only'},
        axm_monitor:{requests:replacement?1:0}}}]:[];
    const deps={...f.deps,monotonicNow:()=>0n,readMetadata:()=>({version:'fixture',nodeVersion:process.versions.node}),initiatingHelper:f.caller,parentPid:300,inspect,verifyExecutable:()=>{},
        observePrivate:async()=>({observation:{observationSha256:hash},privateEntries:[{pm_id:3,pid:replacement?f.caller.pid:f.grant.lastClaim.pid,pm2_env:{...f.config.managedRestart.mutation.slot.baseline,...(replacement?{created_at:f.deps.now(),pm_uptime:f.deps.now(),restart_time:1,...(rootDrift?{version:'untrusted'}:{})}:{} )}},...siblings()]}),
        observePm2:async()=>({state:'observed',entries:[{pmId:3,name:'nassaj',namespace:'default',pid:replacement?f.caller.pid:f.grant.lastClaim.pid,
            status:'online',cwd:'/cwd',interpreter:'/node'}]}),
        observeHealth:async(_config,claim,visibility)=>({body:{claimId:claim.claimId,visibility},observedAt:f.deps.now()}),
        execGate:(_node,args,_options,callback)=>({stdin:{end:bytes=>{
            const request=JSON.parse(bytes);const phase=args[1]==='closeCurrentOperationGate'?'closed':'opened';observed.push(phase);
            f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{operationId,generationEpoch:request.generationEpoch,phase,closedAt:f.deps.now()}});
            callback(null,JSON.stringify({schema:'nassaj-managed-ingress-receipt/v1',operationId,generationEpoch:request.generationEpoch,phase,
                observedAt:f.deps.now(),hostProofSha256:hash,claimId:phase==='opened'?f.read('startup-admission.json').lastClaim.claimId:null}));
        }}}),
        spawn:()=>{
            launches++;const child=new EventEmitter();child.pid=200+launches;child.stdout=new PassThrough();child.stderr=new PassThrough();
            child.stdio=[null,child.stdout,child.stderr,new PassThrough(),new PassThrough(),new PassThrough(),new PassThrough()];
            const j=f.read('managed-restart.json');const process=inspect(child.pid);
            const ready={schema:'nassaj-managed-child-ready/v1',operationId,nonce:j.launchIntent.nonce,challenge:hash,
                launchIntentSha256:sha(canonical(j.launchIntent)),pid:child.pid,startTicks:process.startTicks,bootId:process.bootId};
            child.stdio[3].resume();child.stdio[3].on('end',()=>{
                if(j.launchIntent.kind==='check'){child.stdout.write(JSON.stringify({schema:'nassaj-safe-operation-result/v1',operationId,attemptId:j.attempts.at(-1).attemptId,outcome:'ready',reason:'drained',effects:'none'}));child.emit('close',0,null);}
                else {
                    if(busyFirst&&launches===2){child.stdout.write(JSON.stringify({schema:'nassaj-safe-operation-result/v1',operationId,attemptId:j.attempts.at(-1).attemptId,outcome:'deferred',reason:'live_work',effects:'none'}));child.emit('close',75,null);return;}
                    const attempt=f.read('managed-restart.json').attempts.at(-1);
                    const intent={schema:'nassaj-pm2-execution-intent/v1',operationId,attemptId:attempt.attemptId,attemptNonce:attempt.attemptNonce,
                        step:'restart-same',expectedSlotDigest:f.config.managedRestart.mutation.slot.entrySha256,slotDigest:hash,
                        daemonIdentitySha256:sha(canonical(f.config.managedRestart.pm2Observer.daemon)),payloadDigest:sha(canonical({id:3})),requestId:'c'.repeat(32)};
                    child.stdio[6].once('data',bytes=>{
                        const ack=JSON.parse(bytes);assert.equal(ack.revision,f.read('managed-restart.json').revision);
                        executed++;replacement=true;
                        if(!failure)child.stdout.write(JSON.stringify({schema:'nassaj-managed-worker-result/v1',operationId,attemptId:attempt.attemptId,attemptNonce:attempt.attemptNonce,
                            drain:{schema:'nassaj-safe-operation-result/v1',operationId,attemptId:attempt.attemptId,outcome:'ready',reason:'drained',effects:'none'},
                            mutation:{schema:'nassaj-pm2-step-result/v1',operationId,attemptId:attempt.attemptId,attemptNonce:attempt.attemptNonce,step:'restart-same',requestId:intent.requestId,
                                dispatchState:'observed',observationSha256:hash,slotDigest:hash,targetSlotBinding:null}}));
                        child.emit('close',failure?1:0,null);
                    });
                    child.stdio[5].write(JSON.stringify(intent)+'\n');
                }
            });
            child.stdio[4].end(`${JSON.stringify(ready)}\n`);return child;
        }};
    let driverError;const driver=setInterval(async()=>{
        try {
            const j=f.read('managed-restart.json');
            if(j.phase==='replacement_claim_pending'){f.call(f.consume(f.call(f.request())));f.phase('security');}
            if(j.phase==='private_verified'&&script){const child=script;script=null;
                const ready=await dispatchManagedRestartOperation(f.config,'verifyManagedRestartPrivateReady',{schema:'nassaj-managed-restart-request/v1',operationId},deps);
                assert.equal(ready.decision,'ready');child.emit('close',0,null);}
        }catch(error){driverError=error;if(script)script.emit('error',error);}
    },10);t.after(()=>clearInterval(driver));
    let operation=dispatchManagedRestartOperation(f.config,'restartCommittedGeneration',{schema:'nassaj-managed-restart-request/v1',operationId},deps);
    if(siblingChange==='control'){await assert.rejects(operation,/legacy_control_drift/);assert.deepEqual(observed,['closed']);assert.equal(f.read('startup-admission.json').state,'switching');return;}
    if(rootDrift){await assert.rejects(operation,/version_drift/);assert.deepEqual(observed,['closed']);assert.equal(f.read('startup-admission.json').state,'switching');return;}
    if(busyFirst){
        assert.equal((await operation).decision,'deferred');const deferred=f.read('startup-admission.json');const journal=f.read('managed-restart.json');
        assert.equal(journal.phase,'deferred_after_begin');assert.equal(executed,0);assert.deepEqual(observed,['closed']);
        operation=dispatchManagedRestartOperation(f.config,'restartCommittedGeneration',{schema:'nassaj-managed-restart-request/v1',operationId},deps);
        await operation;assert.equal(f.read('managed-restart.json').approvalAcceptedAt,journal.approvalAcceptedAt);
        assert.equal(f.read('startup-admission.json').generationEpoch,deferred.generationEpoch);
    }
    if(failure) {
        await assert.rejects(operation,/worker_terminal_unknown/);assert.deepEqual(observed,['closed']);assert.equal(executed,1);
        assert.equal(f.read('startup-admission.json').state,'switching');
        await assert.rejects(dispatchManagedRestartOperation(f.config,'restartCommittedGeneration',{schema:'nassaj-managed-restart-request/v1',operationId},deps),/recovery_required/);
        assert.equal(executed,1);return;
    }
    const result=await operation;
    if(driverError)throw driverError;
    assert.equal(result.decision,'committed');assert.equal(launches,busyFirst?4:2);assert.equal(executed,1);
    assert.deepEqual(observed,['closed','opened']);assert.equal(f.read('startup-admission.json').state,'active');
    assert.equal(canonical(f.read('first-cutover.json')),original);
    if(siblingChange==='telemetry'){
        const journal=f.read('managed-restart.json');const record=journal.executionIntent.rootBeforeInventory;
        const inventoryFile=new URL(record.file,`file://${f.root}/`);const bytes=fs.readFileSync(inventoryFile);
        assert.equal(fs.lstatSync(inventoryFile).mode&0o777,0o600);assert.equal(sha(bytes),record.sha256);
        assert.equal(JSON.parse(bytes).entries[1].pm2_env.env.PRIVATE_FIXTURE,'private-only');
        assert.notEqual(journal.rootVerifiedMutation.unrelated.beforeSha256,journal.rootVerifiedMutation.unrelated.afterSha256);
        assert.equal(JSON.stringify(result).includes('private-only'),false);assert.equal(JSON.stringify(journal.rootVerifiedMutation).includes('private-only'),false);
    }

}
test('root completion independently permits unrelated telemetry changes and privately retains original inventory',t=>producerScenario(t,false,false,false,'telemetry'));
test('root completion rejects unrelated service environment drift before public opening despite worker success',t=>producerScenario(t,false,false,false,'control'));
test('producer drives fixed check/execute scripts, replacement admission and terminal commit with isolated host boundaries',t=>producerScenario(t));
test('provisional child success cannot open ingress when root private version proof fails',t=>producerScenario(t,false,false,true));
test('explicit resume after post-begin busy retains epoch and acceptance and launches one new bounded worker per attempt',t=>producerScenario(t,false,true));
test('unknown script effect after execution intent retains maintenance and refuses retry or public opening',t=>producerScenario(t,true));

test('three signed managed operations retain immutable terminals and preserve active authority while the next is prepared',t=>{
    const f=managedCoreFixture(t);const anchor=canonical(f.read('first-cutover.json'));const terminals=[];
    for(let index=0;index<3;index++) {
        const op=index===0?operationId:`managed-operation-round-${index}`;
        if(index>0) {
            const grant=f.read('startup-admission.json');const payload=structuredClone(f.read('managed-restart.json').approval);delete payload.signature;
            payload.target.operationId=op;payload.target.commitReceiptSha256=grant.managedCommitSha256;payload.nonce=String(index).repeat(48);
            const approval={...payload,signature:sign(null,Buffer.from(canonical(payload)),f.keys.privateKey).toString('base64url')};
            f.write('managed-restart-approval.json',approval);
            f.write('managed-restart.json',{schema:'nassaj-managed-restart/v1',operationId:op,phase:'prepared',revision:1,
                approvalAcceptedAt:f.deps.now(),approval,approvalSha256:sha(canonical(approval)),approvalNonce:approval.nonce,
                originalGrant:grant,originalGrantSha256:sha(canonical(grant)),oldProcess:{...f.caller}});
            assert.equal(f.phase('serving').decision,'serving','new prepared pointer must not destroy the previous active authority');
            f.caller.pid++;f.caller.startTicks=String(Number(f.caller.startTicks)+1);
        }
        const state=beginManagedRestartAdmission(f.config,op,f.deps);
        const gate={operationId:op,generationEpoch:state.generationEpoch,phase:'closed',closedAt:f.deps.now()};
        f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:gate});
        f.patch({phase:'restart_execution_intent',executionIntent:{launchAttemptNonce:hash},replacementProcess:{...f.caller,pm2Id:3,pm2Namespace:'default',launchAttemptNonce:hash}});
        armManagedReplacementAdmission(f.config,op,f.deps);const claim=f.call(f.consume(f.call(f.request())));f.phase('security');
        const receipt=visibility=>({schema:'nassaj-managed-health-receipt/v1',bodySha256:hash,clientBuildId:f.config.expected.clientBuildId,databaseContractSha256:f.config.expected.databaseContractSha256,operationId:op,visibility,claimId:claim.claimId,generationEpoch:claim.generationEpoch,process:{...f.caller},
            securityStartupSha256:sha(canonical(f.read('startup-admission.json').securityStartup)),releaseIdentitySha256:f.identity.releaseIdentitySha256,
            serverBuildId:f.config.expected.serverBuildId,observedAt:f.deps.now()});
        f.patch({phase:'public_verified',privateReceipt:receipt('private'),publicReceipt:receipt('public')});
        f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{...gate,phase:'opened'}});
        const active=completeManagedRestartAdmission(f.config,op,f.deps);
        assert.equal(active.managedCommittedOperationId,op);assert.equal(f.phase('serving').decision,'serving');
        const name=`managed-restart-terminal-${op}.json`;terminals.push([name,canonical(f.read(name))]);
        for(const [file,bytes] of terminals)assert.equal(canonical(f.read(file)),bytes);
        if(index>0)assert.throws(()=>completeManagedRestartAdmission(f.config,operationId,f.deps),/journal_authority_invalid/);
    }
    assert.equal(canonical(f.read('first-cutover.json')),anchor);
});

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
function readyToFinalize(t) {
    const f=managedCoreFixture(t);const state=beginManagedRestartAdmission(f.config,operationId,f.deps);
    const gate={operationId,generationEpoch:state.generationEpoch,phase:'closed',closedAt:f.deps.now()};
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:gate});
    f.patch({phase:'restart_execution_intent',executionIntent:{launchAttemptNonce:hash},replacementProcess:{...f.caller,pm2Id:3,pm2Namespace:'default',launchAttemptNonce:hash}});
    armManagedReplacementAdmission(f.config,operationId,f.deps);const claim=f.call(f.consume(f.call(f.request())));f.phase('security');
    const receipt=visibility=>({schema:'nassaj-managed-health-receipt/v1',bodySha256:hash,clientBuildId:f.config.expected.clientBuildId,databaseContractSha256:f.config.expected.databaseContractSha256,
        operationId,visibility,claimId:claim.claimId,generationEpoch:claim.generationEpoch,process:{...f.caller},securityStartupSha256:sha(canonical(f.read('startup-admission.json').securityStartup)),
        releaseIdentitySha256:f.identity.releaseIdentitySha256,serverBuildId:f.config.expected.serverBuildId,observedAt:f.deps.now()});
    f.patch({phase:'public_verified',privateReceipt:receipt('private'),publicReceipt:receipt('public')});
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{...gate,phase:'opened'}});return f;
}
test('every terminal/current/state fsync failure denies success and resumes the exact original terminal',async t=>{
    // Permanent flock adds file+directory durability; it has no legacy unlink fsync.
    await t.test('measured durability sequence covers mutex and all three records',child=>{
        const f=readyToFinalize(child),original=fs.fsyncSync,observed=[];
        fs.fsyncSync=fd=>{observed.push(fs.readlinkSync(`/proc/self/fd/${fd}`).replace(f.root,'ROOT').replace(/\.partial-[a-f0-9-]+$/,''));return original(fd);};syncBuiltinESMExports();
        try{completeManagedRestartAdmission(f.config,operationId,f.deps);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
        assert.deepEqual(observed,['ROOT/first-cutover-state.flock','ROOT',`ROOT/managed-restart-terminal-${operationId}.json`,'ROOT','ROOT/managed-restart.json','ROOT','ROOT/startup-admission.json','ROOT']);
    });
    for(let failAt=1;failAt<=8;failAt++)await t.test(`fsync ${failAt}`,child=>{
        const f=readyToFinalize(child);const original=fs.fsyncSync;let calls=0;
        fs.fsyncSync=(...args)=>{if(++calls===failAt)throw Error('injected_managed_fsync');return original(...args);};syncBuiltinESMExports();
        try {assert.throws(()=>completeManagedRestartAdmission(f.config,operationId,f.deps),/injected_managed_fsync/);}
        finally {fs.fsyncSync=original;syncBuiltinESMExports();}
        const terminalFile=`managed-restart-terminal-${operationId}.json`;
        const before=fs.existsSync(`${f.root}/${terminalFile}`)?canonical(f.read(terminalFile)):null;
        const active=completeManagedRestartAdmission(f.config,operationId,f.deps);assert.equal(active.state,'active');
        if(before)assert.equal(canonical(f.read(terminalFile)),before);
        assert.deepEqual(completeManagedRestartAdmission(f.config,operationId,f.deps),active);
    });
});
test('terminal collision, tamper and revocation cannot restore stale active authority',t=>{
    const f=readyToFinalize(t);const name=`managed-restart-terminal-${operationId}.json`;
    f.write(name,{schema:'forged'});assert.throws(()=>completeManagedRestartAdmission(f.config,operationId,f.deps),/terminal_collision/);
    fs.unlinkSync(`${f.root}/${name}`);completeManagedRestartAdmission(f.config,operationId,f.deps);
    const terminal=f.read(name);f.write(name,{...terminal,committedAt:terminal.committedAt+1});assert.throws(()=>f.phase('serving'),/journal_authority_invalid/);
    f.write(name,terminal);const state=f.read('startup-admission.json');f.write('startup-admission.json',{...state,revocation:{reason:'operator'}});
    assert.throws(()=>completeManagedRestartAdmission(f.config,operationId,f.deps),/journal_authority_invalid/);
});

import { createBootstrapContextHarness } from './fixtures/bootstrap-context-harness.mjs';
import {setupInitialArmFixture} from './fixtures/initial-arm-fixture.mjs';
import { pathToFileURL } from 'node:url';
test('compiled startup client rejects mixed managed-to-initial admission, changed operation or replay',async t=>{
    for(const variant of ['mixed','operation','challenge','extra','timeout'])await t.test(variant,async child=>{
        const f=createBootstrapContextHarness(child,{simulateInitialOperator:true});const endpoint=f.descriptor.dispatcher.path;
        let source=fs.readFileSync(endpoint,'utf8');
        source=source.replace("try { const result = {...handleBootstrapStartupAdmission",`try {
const request=await readHostDispatcherInput(process.stdin);
const counterFile=root+'/pending-fixture.json';let seen=[];try{seen=JSON.parse(fs.readFileSync(counterFile));}catch{}
if(request.schema==='nassaj-bootstrap-admission-offer-request/v1'&&seen.length<2){
 const previous=seen.at(-1);seen.push(request.challenge);fs.writeFileSync(counterFile,JSON.stringify(seen));
 const result={...request,schema:'nassaj-bootstrap-admission-pending/v1',decision:'pending',operationId:'managed-pending-operation',generationEpoch:1,uid:observe().uid};
 if(${JSON.stringify(variant)}==='operation'&&seen.length===2)result.operationId='another-pending-operation';
 if(${JSON.stringify(variant)}==='challenge'&&seen.length===2)result.challenge=previous;
 if(${JSON.stringify(variant)}==='extra')result.claimId='forged-claim';
 process.stdout.write(JSON.stringify(result));
}else {const result = {...handleBootstrapStartupAdmission`)
            .replace("await readHostDispatcherInput(process.stdin), observe,", "request, observe,")
            .replace("process.stdout.write(JSON.stringify(result)); }", "process.stdout.write(JSON.stringify(result)); }}");
        fs.writeFileSync(endpoint,source);f.descriptor.dispatcher.sha256=sha(fs.readFileSync(endpoint));f.write('descriptor.json',f.descriptor);
        const context=pathToFileURL(`${f.releaseRoot}/dist-server/server/bootstrap-startup-context.js`).href;
        const go=`${f.root}/pending-client-go`;
        const running=f.start(`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
        while(!fs.existsSync(${JSON.stringify(go)}))await delay(5);
        import {establishStartupAdmission} from ${JSON.stringify(context)}; ${variant==='timeout'?"const clock=process.hrtime.bigint;let ticks=0;process.hrtime.bigint=()=>clock()+BigInt(ticks++)*31000000000n;":''} await establishStartupAdmission();console.log('admitted');`);
        child.after(()=>running.child.kill('SIGKILL'));
        // Pending wire variants are unit fixtures; admission is still issued by actual initial root arm.
        const armed=await setupInitialArmFixture(child,{fixture:f,targetChild:running.child});
        installFixedStateMutexAuthority(child,f.root,f.config,{file:`${f.root}/config.json`});
        f.write('config.json',f.config);await armed.arm();fs.writeFileSync(go,'go');
        const result=await running.result;
        assert.notEqual(result.code,0);assert.equal(f.read('startup-admission.json').lastClaim,null);
        assert.match(result.stderr,/pending_invalid|pending_changed/);
        if(variant==='mixed'){const challenges=f.read('pending-fixture.json');assert.equal(new Set(challenges).size,2);}
    });
});

import { appendManagedAttempt, appendManagedStepIntent } from './lib/release-runtime-managed-restart.mjs';
test('managed ledger keeps eight distinct workers and rejects unresolved workers or exhausted history',()=>{
    let journal={operationId,attempts:[]};
    for(let index=0;index<8;index++) {
        const intent={nonce:String(index).padStart(64,'0'),kind:'check',at:index};
        journal.attempts=appendManagedAttempt(journal,intent);
        assert.equal(journal.attempts.at(-1).sequence,index+1);
        assert.throws(()=>appendManagedAttempt(journal,{...intent,nonce:hash}),/attempt_unresolved|budget_exhausted/);
        journal.attempts.at(-1).state='resolved_no_effect';
    }
    assert.throws(()=>appendManagedAttempt(journal,{nonce:hash}),/budget_exhausted/);
    assert.equal(journal.attempts.length,8);
    assert.equal(new Set(journal.attempts.map(item=>item.attemptId)).size,8);
});
test('managed step intents are independent and stale or potentially sent steps cannot be overwritten',()=>{
    let journal={operationId,attempts:appendManagedAttempt({operationId},{nonce:hash,kind:'execute',at:1})};
    journal.attempts[0].state='running';journal.attempts[0].worker={pid:10,startTicks:'20',bootId:'boot'};
    const request={operationId,attemptId:hash,attemptNonce:hash,step:'stop-old'};
    journal.attempts=appendManagedStepIntent(journal,request,{requestId:'one'});
    const before=canonical(journal);
    for(const bad of [request,{...request,step:'start-target'},{...request,attemptNonce:'b'.repeat(64)}])
        assert.throws(()=>appendManagedStepIntent(journal,bad,{requestId:'two'}));
    assert.equal(canonical(journal),before);
    journal.attempts[0].steps[0].dispatchState='observed';
    journal.attempts=appendManagedStepIntent(journal,{...request,step:'start-target'},{requestId:'two'});
    assert.equal(journal.attempts[0].steps.length,2);
    assert.equal(journal.attempts[0].steps[0].intent.requestId,'one');
    assert.notEqual(journal.attempts[0].steps[0].executionIntentDigest,journal.attempts[0].steps[1].executionIntentDigest);
});

import { recordManagedStepReceipt } from './lib/release-runtime-managed-restart.mjs';
test('managed callback pins current nonce and independent intent and never repeats a terminal receipt',()=>{
    const attempt={attemptId:hash,attemptNonce:hash,state:'running',worker:{pid:1},steps:[]};
    let journal={operationId,attempts:[attempt]};
    const request={operationId,attemptId:hash,attemptNonce:hash,step:'restart-same'};
    journal.attempts=appendManagedStepIntent(journal,request,{requestId:'fixed'});
    const callback={...request,executionIntentDigest:journal.attempts[0].steps[0].executionIntentDigest};
    const receipt={dispatchState:'possibly_sent',proofSha256:hash};
    for(const bad of [{...callback,attemptNonce:'b'.repeat(64)},{...callback,executionIntentDigest:hash},{...callback,step:'stop-old'}])
        assert.throws(()=>recordManagedStepReceipt(journal,bad,receipt));
    journal.attempts=recordManagedStepReceipt(journal,callback,receipt);
    assert.throws(()=>recordManagedStepReceipt(journal,callback,receipt),/callback_stale/);
    assert.throws(()=>appendManagedStepIntent(journal,{...request,step:'stop-old'},{}),/step_unresolved/);
    assert.throws(()=>appendManagedAttempt(journal,{nonce:'b'.repeat(64)}),/attempt_unresolved/);
});

import { validateManagedDrainResult } from './release-runtime-managed-child.mjs';
test('managed drain preserves typed busy and rejects numeric-only, stale worker and extra output',()=>{
    const material={operationId,attemptId:hash};
    const result={schema:'nassaj-safe-operation-result/v1',...material,outcome:'deferred',reason:'live_work',effects:'none'};
    assert.equal(validateManagedDrainResult(material,75,null,JSON.stringify(result)).outcome,'deferred');
    for(const [code,signal,body] of [[78,null,result],[75,'SIGKILL',result],[0,null,result],
        [75,null,{...result,attemptId:'b'.repeat(64)}],[75,null,{...result,effects:'unknown'}]])
        assert.throws(()=>validateManagedDrainResult(material,code,signal,JSON.stringify(body)));
    for(const output of ['',JSON.stringify(result)+'\n{}'])assert.throws(()=>validateManagedDrainResult(material,75,null,output));
});

import { acknowledgeManagedMutation } from './lib/release-runtime-managed-restart.mjs';
test('managed root ACK follows durable exact worker intent and rejects replay or payload drift',async t=>{
    const f=managedCoreFixture(t);const state=beginManagedRestartAdmission(f.config,operationId,f.deps);
    const worker={pid:901,parentPid:process.pid,startTicks:'555',bootId:f.caller.bootId,
        uids:Array(4).fill(f.caller.uid),gids:Array(4).fill(f.caller.uid),supplementaryGids:[f.caller.uid],capabilities:['0','0','0']};
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{operationId,generationEpoch:state.generationEpoch,phase:'closed'}});
    const service={uid:f.caller.uid,pid:worker.pid,startTicks:worker.startTicks,bootId:worker.bootId};
    f.patch({phase:'ingress_closed',launch:service,launchIntent:{kind:'execute',nonce:hash},attempts:[{attemptId:hash,attemptNonce:hash,sequence:1,worker:service,state:'running',steps:[]}]});
    const intent={schema:'nassaj-pm2-execution-intent/v1',operationId,attemptId:hash,attemptNonce:hash,step:'restart-same',
        expectedSlotDigest:f.config.managedRestart.mutation.slot.entrySha256,slotDigest:hash,daemonIdentitySha256:sha(canonical(f.config.managedRestart.pm2Observer.daemon)),
        payloadDigest:sha(canonical({id:3})),requestId:'c'.repeat(32)};
    const operator={pid:process.pid,startTicks:'9000',bootId:f.caller.bootId};f.patch({operator});
    f.write('first-cutover.lock',{pid:operator.pid,startTime:operator.startTicks});
    const old=f.grant.lastClaim;
    const deps={...f.deps,observePrivate:async()=>({observation:{observationSha256:hash},privateEntries:[{pm_id:3,pid:old.pid,pm2_env:f.config.managedRestart.mutation.slot.baseline}]}),
        inspect:pid=>pid===process.pid?{...operator,uids:[0,0,0,0]}:pid===old.pid?{...worker,...old}:worker};
    await assert.rejects(()=>acknowledgeManagedMutation(f.config,operationId,worker.pid,{...intent,payloadDigest:hash},deps),/descriptor_invalid/);
    assert.equal(f.read('managed-restart.json').attempts[0].steps.length,0);
    const ack=await acknowledgeManagedMutation(f.config,operationId,worker.pid,intent,deps);
    const durable=f.read('managed-restart.json');assert.equal(durable.revision,ack.revision);
    assert.equal(durable.attempts[0].steps[0].executionIntentDigest,sha(canonical(intent)));
    assert.equal(durable.phase,'restart_execution_intent');
    await assert.rejects(()=>acknowledgeManagedMutation(f.config,operationId,worker.pid,intent,deps),/worker_invalid/);
});

import { executeManagedWorker } from './release-runtime-managed-child.mjs';
test('same managed worker performs typed mutation only after successful drain and carries its exact receipt',async()=>{
    const material={operationId,attemptId:hash,nonce:hash,kind:'execute',mutation:{slot:{entrySha256:hash}}};
    const drain={schema:'nassaj-safe-operation-result/v1',operationId,attemptId:hash,outcome:'ready',reason:'drained',effects:'none'};
    const events=[];const deps={runScript:async()=>{events.push('drain');return {code:0,signal:null,result:drain};},
        applyMutation:async request=>{events.push('mutation');assert.deepEqual(request,{operationId,attemptId:hash,step:'restart-same',expectedSlotDigest:hash});return {receipt:'fixed'};}};
    const result=await executeManagedWorker(material,deps);assert.deepEqual(events,['drain','mutation']);assert.equal(result.result.mutation.receipt,'fixed');
    events.length=0;const busy=await executeManagedWorker(material,{...deps,runScript:async()=>({code:75,signal:null,result:{...drain,outcome:'deferred',reason:'live_work'}})});
    assert.equal(busy.code,75);assert.deepEqual(events,[]);
});

import { resolveManagedPostBeginDeferral, reconcileManagedOperatorLock } from './lib/release-runtime-managed-restart.mjs';
test('post-begin no-effect deferral preserves current epoch, original acceptance and worker evidence',async t=>{
    const f=managedCoreFixture(t);const state=beginManagedRestartAdmission(f.config,operationId,f.deps);
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{operationId,generationEpoch:state.generationEpoch,phase:'closed'}});
    const worker={uid:f.caller.uid,pid:99,startTicks:'123',bootId:f.caller.bootId};
    f.patch({phase:'ingress_closed',launch:worker,launchIntent:{kind:'execute',nonce:hash},attempts:[{sequence:1,attemptId:hash,attemptNonce:hash,worker,state:'running',steps:[]}]});
    const before=f.read('managed-restart.json');const completed={code:75,signal:null,output:JSON.stringify({schema:'nassaj-safe-operation-result/v1',operationId,attemptId:hash,outcome:'deferred',reason:'live_work',effects:'none'})};
    const deps={...f.deps,verifyExecutable:()=>{},observePm2:async()=>({state:'observed',entries:[{pmId:3,name:'nassaj',namespace:'default',pid:f.grant.lastClaim.pid,status:'online',cwd:'/cwd',interpreter:'/node'}]}),
        inspect:()=>({...f.grant.lastClaim,uids:Array(4).fill(f.caller.uid),gids:Array(4).fill(f.caller.uid),supplementaryGids:[f.caller.uid],capabilities:['0','0','0']})};
    assert.equal((await resolveManagedPostBeginDeferral(f.config,operationId,completed,deps)).decision,'deferred');
    const after=f.read('managed-restart.json');assert.equal(after.phase,'deferred_after_begin');assert.equal(after.approvalAcceptedAt,before.approvalAcceptedAt);
    assert.equal(after.attempts[0].state,'resolved_no_effect');assert.deepEqual(f.read('startup-admission.json'),state);
    assert.equal(appendManagedAttempt(after,{nonce:'b'.repeat(64),kind:'check'}).length,2);
    f.patch({phase:'ingress_closed',executionIntent:{sent:true}});
    await assert.rejects(resolveManagedPostBeginDeferral(f.config,operationId,completed,deps),/effect_unknown/);
});
test('abandoned lock retains tombstone and prevents mutation when any worker remains live or unreadable',t=>{
    for(const status of ['alive','unknown','gone']) {
        const f=managedCoreFixture(t);const old={pid:888,startTicks:'1',bootId:f.caller.bootId};
        const worker={uid:f.caller.uid,pid:889,startTicks:'2',bootId:f.caller.bootId};
        f.patch({operator:old,attempts:[{sequence:1,attemptId:hash,attemptNonce:hash,worker,state:status==='gone'?'resolved_no_effect':'running',steps:[]}]});
        f.write('first-cutover.lock',{schema:'nassaj-cutover-lock/v1',pid:old.pid,startTime:old.startTicks});
        const deps={...f.deps,effectiveUid:()=>f.deps.ownerUid,inspect:pid=>{
            if(pid===process.pid)return {pid,startTicks:'999',bootId:f.caller.bootId,uids:[0,0,0,0]};
            if(pid===worker.pid&&status==='alive')return worker;
            throw Object.assign(Error('observation'),{code:pid===worker.pid&&status==='unknown'?'EACCES':'ENOENT'});
        }};
        const result=reconcileManagedOperatorLock(f.config,operationId,deps);
        assert.equal(result.decision,status==='gone'?'reconciled':'diagnosis_only');
        const journal=f.read('managed-restart.json');assert.equal(journal.operator.pid,process.pid);
        assert.equal(journal.lockReconciliation.phase,'observed');assert.ok(f.read(journal.lockReconciliation.tombstone));
        if(status!=='gone')assert.equal(journal.phase,'manual_recovery');
        assert.throws(()=>reconcileManagedOperatorLock(f.config,operationId,deps),/owner_unproven/);
    }
});

test('abandoned lock crash after durable intent retains original bytes and resumes exact replacement',t=>{
    const f=managedCoreFixture(t);const old={pid:888,startTicks:'1',bootId:f.caller.bootId};f.patch({operator:old,attempts:[]});
    f.write('first-cutover.lock',{schema:'nassaj-cutover-lock/v1',pid:old.pid,startTime:old.startTicks});
    const deps={...f.deps,effectiveUid:()=>f.deps.ownerUid,inspect:pid=>{
        if(pid===process.pid)return {pid,startTicks:'999',bootId:f.caller.bootId,uids:[0,0,0,0]};
        throw Object.assign(Error('gone'),{code:'ENOENT'});
    }};
    const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to.endsWith('/first-cutover.lock'))throw Error('fixture_crash');return rename(from,to);};
    try{assert.throws(()=>reconcileManagedOperatorLock(f.config,operationId,deps),/fixture_crash/);}finally{fs.renameSync=rename;}
    const pending=f.read('managed-restart.json');assert.equal(pending.lockReconciliation.phase,'intent');
    assert.equal(f.read('first-cutover.lock').pid,old.pid);assert.equal(f.read(pending.lockReconciliation.tombstone).pid,old.pid);
    assert.equal(reconcileManagedOperatorLock(f.config,operationId,deps).decision,'reconciled');
    assert.equal(f.read('first-cutover.lock').pid,process.pid);
});

import { observeManagedInitiatingHelper } from './lib/release-runtime-managed-restart.mjs';
test('initial helper is derived from pinned dispatcher and kernel sudo ancestry, never request PID',()=>{
    const policy={uid:1000,gid:1000,supplementaryGids:[1000]};
    const config={bootstrapClaim:{applicationUid:1000,sudoExecutable:'/sudo'},managedRestart:{nodeExecutable:'/node',managedClientPath:'/client',dispatcher:{path:'/dispatcher'},serviceIdentity:policy}};
    const row=(pid,parentPid,uid,executable,argv)=>({pid,parentPid,startTicks:String(pid),bootId:'boot',uids:Array(4).fill(uid),gids:Array(4).fill(uid),supplementaryGids:[uid],capabilities:['0','0','0'],executable,argv});
    const rows=new Map([[10,row(10,11,0,'/node',['/node','/dispatcher'])],[11,{...row(11,12,0,'/sudo',['/sudo']),uids:[1000,0,0,0]}],[12,row(12,1,1000,'/node',['/node','/client'])]]);
    const deps={parentPid:10,inspect:pid=>rows.get(pid)};
    assert.equal(observeManagedInitiatingHelper(config,10,deps).pid,12);
    assert.throws(()=>observeManagedInitiatingHelper(config,12,deps),/parent_invalid/);
    rows.get(12).argv[1]='/arbitrary';assert.throws(()=>observeManagedInitiatingHelper(config,10,deps),/helper_invalid/);
    rows.get(12).argv[1]='/client';rows.get(11).uids=[1000,1000,1000,1000];assert.throws(()=>observeManagedInitiatingHelper(config,10,deps),/sudo_invalid/);
});

import { spawnSync } from 'node:child_process';
test('actual child invalidation between precheck and intent lock prevents ACK and every execution write',async t=>{
    const f=managedCoreFixture(t);const state=beginManagedRestartAdmission(f.config,operationId,f.deps);
    const operator={pid:process.pid,startTicks:'9000',bootId:f.caller.bootId};
    const worker={pid:901,parentPid:process.pid,startTicks:'555',bootId:f.caller.bootId,uids:Array(4).fill(f.caller.uid),
        gids:Array(4).fill(f.caller.uid),supplementaryGids:[f.caller.uid],capabilities:['0','0','0']};
    const service={uid:f.caller.uid,pid:worker.pid,startTicks:worker.startTicks,bootId:worker.bootId};
    f.write('host-dispatch-state.json',{...f.read('host-dispatch-state.json'),managedIngress:{operationId,generationEpoch:state.generationEpoch,phase:'closed'}});
    f.write('first-cutover.lock',{pid:operator.pid,startTime:operator.startTicks});
    f.patch({operator,phase:'ingress_closed',launch:service,launchIntent:{kind:'execute',nonce:hash},
        attempts:[{attemptId:hash,attemptNonce:hash,sequence:1,worker:service,state:'running',steps:[]}]});
    const old=f.grant.lastClaim;const intent={schema:'nassaj-pm2-execution-intent/v1',operationId,attemptId:hash,attemptNonce:hash,step:'restart-same',
        expectedSlotDigest:f.config.managedRestart.mutation.slot.entrySha256,slotDigest:hash,
        daemonIdentitySha256:sha(canonical(f.config.managedRestart.pm2Observer.daemon)),payloadDigest:sha(canonical({id:3})),requestId:'c'.repeat(32)};
    const deps={...f.deps,observePrivate:async()=>({observation:{observationSha256:hash},privateEntries:[{pm_id:3,pid:old.pid,pm2_env:f.config.managedRestart.mutation.slot.baseline}]}),
        inspect:pid=>pid===process.pid?{...operator,uids:[0,0,0,0]}:pid===old.pid?{...worker,...old}:worker};
    const open=fs.openSync;let invalidated=false;
    fs.openSync=(file,flags,...rest)=>{
        if(!invalidated&&file===`${f.root}/first-cutover-state.flock`&&typeof flags==='number'&&(flags&fs.constants.O_CREAT)!==0){
            invalidated=true;
            const child=spawnSync(process.execPath,['--input-type=module','-e',
                `import fs from 'node:fs';import {mock} from 'node:test';import {installFixedStateMutexAuthority} from ${JSON.stringify(new URL('./fixtures/fixed-state-mutex-authority.mjs',import.meta.url).href)};installFixedStateMutexAuthority({mock},${JSON.stringify(f.root)},JSON.parse(fs.readFileSync(${JSON.stringify(`${f.root}/mutex-host.json`)},'utf8')));import {invalidateCutoverStartupAdmission} from ${JSON.stringify(new URL('./lib/release-runtime-cutover.mjs',import.meta.url).href)}; invalidateCutoverStartupAdmission(${JSON.stringify(f.root)},'fixture_concurrent_transition');`],{encoding:'utf8'});
            assert.equal(child.status,0,child.stderr);
        }
        return open(file,flags,...rest);
    };syncBuiltinESMExports();
    try{await assert.rejects(acknowledgeManagedMutation(f.config,operationId,worker.pid,intent,deps),/locked_authority_changed/);}
    finally{fs.openSync=open;syncBuiltinESMExports();}
    assert.equal(invalidated,true);const journal=f.read('managed-restart.json');
    assert.equal(journal.executionIntent,undefined);assert.equal(journal.attempts[0].steps.length,0);
    assert.equal(f.read('startup-admission.json').generationEpoch,state.generationEpoch+1);
    assert.equal(f.read('startup-admission.json').transitionReason,'fixture_concurrent_transition');
});
