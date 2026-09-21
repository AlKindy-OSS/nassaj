import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupInitialArmFixture } from './fixtures/initial-arm-fixture.mjs';
import { mintCutoverApproval,parseArguments } from './mint-cutover-approval.mjs';
import { verifyForwardOwner } from './lib/release-runtime-forward-parent.mjs';
import { forwardValueSha256 as sha } from './lib/release-runtime-forward-child-protocol.mjs';

test('actual explicit forward mint verifies through root owner authority and real startup claim',async t=>{
    const f=await setupInitialArmFixture(t);const key=path.join(f.root,'fixture-owner.key');
    fs.writeFileSync(key,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    f.config.forwardActivation={supervisorPlan:{fixture:'reviewed-supervisor'},mutatorPlan:{fixture:'reviewed-inhibitors'}};
    f.config.forwardMigration.closure={path:path.join(f.root,'closure.json'),sha256:'a'.repeat(64)};
    Object.assign(f.config.expected,{supervisorPlanSha256:sha(f.config.forwardActivation.supervisorPlan),mutatorPlanSha256:sha(f.config.forwardActivation.mutatorPlan),forwardExecutableClosureSha256:'a'.repeat(64)});
    f.write('host.json',f.config);
    const args=parseArguments(['--forward-config',path.join(f.root,'host.json'),'--private-key',key,'--owner-id','fixture-owner','--force']);
    const result=mintCutoverApproval(args);assert.equal(result.file,f.config.bootstrapClaim.approvalFile);
    const approval=f.read('approval.json');assert.deepEqual(approval.startupAdmission,f.config.bootstrapClaim.identity);
    const acceptedAt=Date.now(); f.deps.now=()=>Date.now();
    f.write('first-cutover.json',{...f.read('first-cutover.json'),expected:f.config.expected,approvalSha256:sha(approval),approvalAcceptedAt:acceptedAt});
    f.write('startup-admission.json',{...f.read('startup-admission.json'),approvalSha256:sha(approval)});
    verifyForwardOwner(f.config,f.read('first-cutover.json'));
    await f.arm();const offer=f.call(f.request());const consumed=f.call(f.consume(offer));
    assert.equal(consumed.initialTargetProcessSha256,sha(f.read('first-cutover.json').initialTargetProcess));
});
test('forward mint rejects a mismatched startup binding without writing any approval',async t=>{
    const f=await setupInitialArmFixture(t);const key=path.join(f.root,'fixture-owner.key');
    fs.writeFileSync(key,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    f.config.forwardActivation={supervisorPlan:{},mutatorPlan:{}};f.config.forwardMigration.closure={sha256:'a'.repeat(64)};
    Object.assign(f.config.expected,{supervisorPlanSha256:sha({}),mutatorPlanSha256:sha({}),forwardExecutableClosureSha256:'a'.repeat(64)});
    f.config.bootstrapClaim.identity.databaseContractSha256='f'.repeat(64);f.write('host.json',f.config);
    const before=fs.readFileSync(f.config.bootstrapClaim.approvalFile);
    assert.throws(()=>mintCutoverApproval({forwardConfig:path.join(f.root,'host.json'),privateKeyFile:key,force:true}),/startup_identity/);
    assert.deepEqual(fs.readFileSync(f.config.bootstrapClaim.approvalFile),before);
});
