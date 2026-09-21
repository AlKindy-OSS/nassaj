import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, sign } from 'node:crypto';
import { fixture } from './fixtures/startup-admission-fixture.mjs';
import { dispatchReleaseRuntimeHostOperation } from './lib/release-runtime-host-operations.mjs';
import { canonicalForwardValue as canonical, forwardValueSha256 as digest } from './lib/release-runtime-forward-child-protocol.mjs';
const bytesSha=bytes=>createHash('sha256').update(bytes).digest('hex');
function setup(t){
    const f=fixture(t,'steady'); const operationId='managed-dispatch-fixture-123';
    const parent=path.join(f.root,'parent.mjs'),wrapper=path.join(f.root,'wrapper.mjs'),node='/pinned/node';
    const pin=file=>({path:file,sha256:'a'.repeat(64)});
    const closure={schema:'nassaj-forward-child-closure/v1',files:[parent,wrapper,path.join(f.root,'lib/release-runtime-forward-parent.mjs'),path.join(f.root,'lib/release-runtime-forward-child-protocol.mjs')].sort().map(pin)};
    const closurePath=path.join(f.root,'closure.json'); fs.writeFileSync(closurePath,JSON.stringify(closure),{mode:0o600});
    f.config.forwardMigration={...f.config.forwardMigration,node:pin(node),parent:pin(parent),wrapper:pin(wrapper),closure:{path:closurePath,sha256:bytesSha(fs.readFileSync(closurePath))}};
    f.config.managedRestart={nodeExecutable:node,nodeSha256:'a'.repeat(64),parent:pin(parent)};
    const target={schema:'nassaj-managed-restart-approval-target/v1',operationId,nodeInstanceId:f.config.expected.nodeInstanceId,
        generationId:f.config.expected.generationId,releaseIdentitySha256:f.identity.releaseIdentitySha256,databaseContractSha256:f.identity.databaseContractSha256,
        startupClosureSha256:f.identity.startupClosureSha256,commitReceiptSha256:f.read('startup-admission.json').commitReceiptSha256,
        ownerApprovalKeySha256:f.config.expected.ownerApprovalKeySha256,expectedSha256:digest(f.config.expected),managedConfigurationSha256:digest(f.config.managedRestart)};
    const payload={schema:'nassaj-owner-managed-restart-approval/v1',action:'restartCommittedGeneration',scope:'same-generation-managed-restart/v1',target,
        ownerId:'fixture-owner',nonce:'b'.repeat(48),issuedAt:Date.now()-1000,expiresAt:Date.now()+30000};
    f.write('managed-restart-approval.json',{...payload,signature:sign(null,Buffer.from(canonical(payload)),f.keys.privateKey).toString('base64url')});
    // Metadata/exec seams only: actual canonical closure and real owner signature are checked.
    const lstat=fs.lstatSync,fstat=fs.fstatSync; const ids=new Set();
    t.mock.method(fs,'lstatSync',(file,...args)=>{const info=lstat(file,...args); info.uid=0; if(info.isDirectory())info.mode &= ~0o022; ids.add(info.ino); return info;});
    t.mock.method(fs,'fstatSync',(...args)=>{const info=fstat(...args); if(ids.has(info.ino))info.uid=0; return info;});
    syncBuiltinESMExports(); t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
    const calls=[]; const deps={verifyPinnedExecutable:()=>{},exec:(file,args,options)=>{calls.push({file,args,options}); return JSON.stringify({schema:'nassaj-managed-restart-result/v1',operationId,decision:'deferred'});}};
    return {...f,operationId,parent,node,deps,calls,request:{schema:'nassaj-managed-restart-request/v1',operationId}};
}
test('signed locator routes to pinned root facade without a long-lock acquisition in dispatcher',async t=>{
    const f=setup(t); const result=await dispatchReleaseRuntimeHostOperation(f.config,'restartCommittedGeneration',f.request,f.deps);
    assert.equal(result.operationId,f.operationId); assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0].args,[f.parent,'--managed-operation','restartCommittedGeneration']);
    assert.deepEqual(JSON.parse(f.calls[0].options.input),f.request);
    assert.equal(f.calls[0].options.timeout,300000);
});
for(const failure of ['request','pin','signature','closure'])test(`managed dispatch ${failure} denies before exec`,async t=>{
    const f=setup(t);
    if(failure==='request')f.request.path='/caller/command';
    if(failure==='pin')f.config.managedRestart.parent.path='/other/parent';
    if(failure==='signature'){const approval=f.read('managed-restart-approval.json');approval.signature='x'.repeat(86);f.write('managed-restart-approval.json',approval);}
    if(failure==='closure')fs.writeFileSync(f.config.forwardMigration.closure.path,'{}');
    await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config,'restartCommittedGeneration',f.request,f.deps));assert.equal(f.calls.length,0);
});
