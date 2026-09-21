import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sign,createHash } from 'node:crypto';
import { setupInitialArmFixture } from './fixtures/initial-arm-fixture.mjs';
import { persistVerifiedForwardTargetDefinitions } from './lib/release-runtime-forward-supervisor.mjs';
import { retireForwardSavedDefinition } from './lib/release-runtime-forward-saved-definitions.mjs';
import { canonicalForwardValue as canonical,forwardValueSha256 as sha } from './lib/release-runtime-forward-child-protocol.mjs';
const bytesSha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function setup(t){
    const f=await setupInitialArmFixture(t); const sources=[];const receipts=[];
    const sourceRoot=fs.mkdtempSync(path.resolve('.artifacts/target-definition-sources-'));t.after(()=>fs.rmSync(sourceRoot,{recursive:true,force:true}));
    for(let i=0;i<2;i++){
        const file=path.join(sourceRoot,`fallback-${i}.json`);fs.writeFileSync(file,JSON.stringify([{name:`sibling-${i}`},{name:'fixture',namespace:'fixture'}]),{mode:0o600});
        const source={sourceId:`source-${i}`,path:file,format:'pm2-dump-json',beforeSha256:bytesSha(fs.readFileSync(file))};sources.push(source);
        receipts.push(retireForwardSavedDefinition(source,{name:'fixture',namespace:'fixture'}));
    }
    const plan={sources,slot:{name:'fixture',namespace:'fixture'},pm2:{observer:{}},mutation:{targetDescriptor:f.context.targetDescriptor,metadata:{}}};
    f.config.forwardActivation={supervisorPlan:plan,mutatorPlan:{sources:[]}};
    f.config.expected.supervisorPlanSha256=sha(plan);f.config.expected.mutatorPlanSha256=sha(f.config.forwardActivation.mutatorPlan);
    // Fixture approval is signed before arm. Health/start observations below are typed boundary data;
    // this test measures the actual persistence producer, not PM2 or the earlier migration.
    const {signature:_signature,...payload}=f.read('approval.json');payload.expectedSha256=sha(f.config.expected);
    const approval={...payload,signature:sign(null,Buffer.from(canonical(payload)),f.keys.privateKey).toString('base64url')};f.write('approval.json',approval);
    f.write('first-cutover.json',{...f.read('first-cutover.json'),expected:f.config.expected,approvalSha256:sha(approval)});
    f.write('startup-admission.json',{...f.read('startup-admission.json'),approvalSha256:sha(approval)});
    await f.arm();const offer=f.call(f.request());f.call(f.consume(offer));f.phase('security');
    const journal=f.read('first-cutover.json');const attempt=journal.forwardSupervisorAttempts[0];
    const rootWindow={wallBefore:f.clock.wall,wallAfter:Date.now(),monotonicBefore:f.clock.monotonic,monotonicAfter:String(process.hrtime.bigint()),bootBefore:f.clock.boot,bootAfter:f.clock.boot};
    attempt.steps=[{step:'configure-target-stopped',state:'observed',result:{targetSlotBinding:journal.targetSlotBinding}},
        {step:'start-target',state:'observed',rootWindow,result:{slotDigest:sha(f.response.privateEntries[0].pm2_env)}}];
    f.write('first-cutover.json',{...journal,phase:'target_verified',forwardRetirement:{sources:receipts},forwardReceipts:{...journal.forwardReceipts,private:{claimId:journal.startupClaim.claimId}}});
    return {...f,sources,deps:{effectiveUid:()=>0,observePrivateRuntime:async()=>f.response,readMetadata:()=>f.context.metadata,observeInhibitors:()=>{}}};
}
test('actual target persistence producer updates independent fallbacks before yielding a durable receipt',async t=>{
    const f=await setup(t);const proof=await persistVerifiedForwardTargetDefinitions(f.config,f.deps);
    assert.equal(proof.state,'durable');assert.equal(proof.sourceReceipts.length,2);
    for(const [i,source]of f.sources.entries()){const rows=JSON.parse(fs.readFileSync(source.path));assert.equal(rows[0].name,`sibling-${i}`);assert.equal(rows[1].pm_exec_path,f.context.targetDescriptor.pm_exec_path);assert.equal(rows[1].pm_id,undefined);}
    await assert.rejects(persistVerifiedForwardTargetDefinitions(f.config,f.deps),/target_definition_cas/);
});
test('failure on second fallback keeps the first receipt and second intent without claiming durability',async t=>{
    const f=await setup(t);const rename=fs.renameSync;
    t.mock.method(fs,'renameSync',(from,to)=>{if(to===f.sources[1].path)throw Error('fixture second write interrupted');return rename(from,to);});
    await assert.rejects(persistVerifiedForwardTargetDefinitions(f.config,f.deps),/interrupted/);
    const proof=f.read('first-cutover.json').forwardTargetDefinitions;
    assert.equal(proof.state,'writing');assert.equal(proof.sourceReceipts.length,1);assert.equal(proof.currentIntent.sourceId,f.sources[1].sourceId);
});
