import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseManagedRestartArguments, managedRestartAction, managedRestartEnvironment, runManagedRestart } from './managed-safe-restart-client.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const ID = 'approved-operation-0001'; const HASH = 'a'.repeat(64);
function fixture() {
    const descriptor = {schema:'nassaj-startup-admission-client/v1',profileId:'local-forward-349/v1',release:{generationId:'generation-1'},
        node:{path:process.execPath,sha256:sha('node')},sudo:{path:'/usr/bin/sudo',sha256:sha('sudo')},dispatcher:{path:'/root/dispatcher',sha256:sha('dispatcher')}};
    const proof = {schema:'nassaj-managed-restart-preparation/v1',operationId:ID,generationId:'generation-1',releaseIdentitySha256:HASH,
        commitReceiptSha256:HASH,processName:'nassaj-dev',pm2Id:7,pm2Namespace:'default',pm2Home:'/home/example/.pm2',workflowBase:'/workflows',nodeExecutable:process.execPath,
        nodeAbi:process.versions.modules,safeRestartSha256:sha('script'),managedClientSha256:sha('script'),expectedPm2Cwd:'/deploy',generationRoot:'/deploy/releases/generation-1',
        phase:'prepared',attemptId:HASH,serverPid:1234,home:'/home/example',pm2Executable:'/usr/bin/pm2',pm2Sha256:sha('pm2'),privateHealthUrl:'http://127.0.0.1:3004/health'};
    const calls = []; let next;
    const bytes = () => Buffer.from(JSON.stringify(descriptor));
    const deps = { readRootBytes:file=> file.endsWith('startup-admission-client.json') ? bytes()
        : Buffer.from(file===process.execPath?'node':file==='/usr/bin/sudo'?'sudo':file==='/usr/bin/pm2'?'pm2':'dispatcher'),
        readFile:()=>Buffer.from('script'), realpath:file=>file===path.dirname(path.dirname(fileURLToPath(import.meta.url)))
            ? '/deploy/releases/generation-1' : file,
        run:(executable,args,options)=>{calls.push({executable,args,options});return {status:0,stdout:JSON.stringify(next||proof)};},
        spawnScript:(executable,args,options)=>{calls.push({executable,args,options,script:true});return {status:0};}};
    return {descriptor,proof,deps,calls,setResponse:value=>{next=value;}};
}
test('managed locator is single, bounded and rejects injection/recovery/duplicate/unknown arguments',()=>{
    assert.deepEqual(parseManagedRestartArguments(['--managed-operation',ID,'--exec']),{operationId:ID,execute:true,json:false,child:false});
    for(const args of [['--force'],['--set','A=B'],['--rollback-recovery'],['--managed-operation',ID],['--unknown'],['--exec','--exec']]) {
        assert.throws(()=>parseManagedRestartArguments(['--managed-operation',ID,...args]),/arguments_invalid/);
    }
    for(const id of ['a','../operation','x'.repeat(129)]) assert.throws(()=>parseManagedRestartArguments(['--managed-operation',id]),/operation_invalid/);
});
test('root proof precedes spawn and discards ambient environment; approved cwd is independent from generation',()=>{
    const f=fixture(); assert.equal(runManagedRestart(['--managed-operation',ID,'--exec'],f.deps),0);
    assert.equal(f.calls[0].args.at(-1),'inspectManagedRestart');
    assert.deepEqual(JSON.parse(f.calls[0].options.input),{schema:'nassaj-managed-restart-request/v1',operationId:ID});
    const child=f.calls[1]; assert.equal(child.executable,'/bin/bash'); assert.equal(child.options.cwd,f.proof.generationRoot);
    assert.deepEqual(child.options.env,managedRestartEnvironment(f.proof));
    assert.equal(child.options.env.MANAGED_EXPECTED_PM2_CWD,'/deploy'); assert.notEqual(child.options.env.MANAGED_EXPECTED_PM2_CWD,child.options.cwd);
    assert.equal(child.options.env.NODE_OPTIONS,undefined); assert.equal(child.options.env.NASSAJ_CAPSULE_MODE_ABI,undefined);
});
test('invalid approval pins and tampered child environment never spawn a restart',()=>{
    for(const change of [{safeRestartSha256:HASH},{nodeAbi:'wrong'},{generationId:'wrong'},{pm2Sha256:HASH},
        {expectedPm2Cwd:'/deploy with spaces'},{privateHealthUrl:'http://evil/health'},{phase:'execution'},{pm2Id:-1},{pm2Namespace:''}]) {
        const f=fixture();Object.assign(f.proof,change);
        assert.throws(()=>runManagedRestart(['--managed-operation',ID,'--exec'],f.deps)); assert.equal(f.calls.some(c=>c.script),false);
    }
    const f=fixture(); const args=['--managed-operation',ID,'--managed-child','--exec'];
    assert.equal(runManagedRestart(args,{...f.deps,environment:managedRestartEnvironment(f.proof)}),0);
    for(const change of [{PROC_NAME:'other'},{MANAGED_PM2_ID:'8'},{MANAGED_PM2_NAMESPACE:'other'},{MANAGED_EXPECTED_PM2_CWD:'/other'},{NODE_OPTIONS:'--require evil'}]) {
        assert.throws(()=>runManagedRestart(args,{...f.deps,environment:{...managedRestartEnvironment(f.proof),...change}}),/environment/);
    }
});
test('execution and readiness accept exact root decisions only, with a distinct non-success pending result',()=>{
    const f=fixture();f.setResponse({schema:'nassaj-managed-restart-execution/v1',operationId:ID,decision:'claimed',revision:3});
    assert.equal(managedRestartAction('claim',ID,f.deps).revision,3);
    assert.equal(f.calls.at(-1).args.at(-1),'claimManagedRestartExecution');
    f.setResponse({status:'ok'});assert.throws(()=>managedRestartAction('ready',ID,f.deps),/private_ready_denied/);
    const ready={schema:'nassaj-managed-restart-private-ready/v1',operationId:ID,decision:'ready',claimId:'replacement-claim-0001',generationEpoch:3,
        pid:123,startTicks:'1234',bootId:'12345678-1234-1234-1234-123456789abc'};
    f.setResponse(ready); assert.equal(managedRestartAction('ready',ID,f.deps).pid,123);
    for(const change of [{operationId:'wrong-operation-0001'},{pid:0},{claimId:''},{startTicks:'0'}, {generationEpoch:0}]) {
        f.setResponse({...ready,...change});assert.throws(()=>managedRestartAction('ready',ID,f.deps),/private_ready_denied/);
    }
    f.setResponse({schema:ready.schema,operationId:ID,decision:'pending'});assert.equal(managedRestartAction('ready',ID,f.deps).decision,'pending');
});

test('invalid JSON, extra output and descriptor rotation fail before any script effect',()=>{
    for(const stdout of ['{bad','{} trailing','{}\n{}']) {
        const f=fixture(); assert.throws(()=>runManagedRestart(['--managed-operation',ID,'--exec'],
            {...f.deps,run:()=>({status:0,stdout})})); assert.equal(f.calls.some(c=>c.script),false);
    }
    const f=fixture(); assert.throws(()=>managedRestartAction('unknown',ID,f.deps),/request_invalid/);
    assert.equal(f.calls.length,0);
    const original=f.deps.run; f.deps.run=(...args)=>{const response=original(...args);f.descriptor.release.generationId='rotated';return response;};
    assert.throws(()=>runManagedRestart(['--managed-operation',ID,'--exec'],f.deps),/descriptor_changed/);
    assert.equal(f.calls.some(c=>c.script),false);
});

test('managed client rejects dist-server duplicate placement without fallback',()=>{
    const f=fixture(); const real=f.deps.realpath;
    f.deps.realpath=file=>file===path.dirname(path.dirname(fileURLToPath(import.meta.url)))
        ? `${f.proof.generationRoot}/dist-server` : real(file);
    assert.throws(()=>runManagedRestart(['--managed-operation',ID],f.deps),/preparation_pin_mismatch/);
    assert.equal(f.calls.some(call=>call.script),false);
});

test('fixed initial managed operation invokes only root dispatcher and never recursively launches safe script',()=>{
    const f=fixture();const result={schema:'nassaj-managed-restart-result/v1',operationId:ID,decision:'committed'};
    f.setResponse(result);assert.deepEqual(managedRestartAction('restartCommittedGeneration',ID,f.deps),result);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.at(-1),'restartCommittedGeneration');
    assert.deepEqual(JSON.parse(f.calls[0].options.input),{schema:'nassaj-managed-restart-request/v1',operationId:ID});
    f.setResponse({...result,decision:'deferred',reason:'live_work'});assert.equal(managedRestartAction('restartCommittedGeneration',ID,f.deps).decision,'deferred');
    f.setResponse({...result,force:true});assert.throws(()=>managedRestartAction('restartCommittedGeneration',ID,f.deps),/result_invalid/);
});

import { localBuildIdentitySha256, LOCAL_BUILD_KIND } from './lib/local-reviewed-build-identity.mjs';
test('managed client consumes local descriptor v2 and refuses mixed version/kind before root dispatch',()=>{
    const f=fixture();
    const build={kind:LOCAL_BUILD_KIND,projectId:'nassaj-dev',commit:'a'.repeat(40),version:'1.47.0.3',profileId:'local-forward-349/v1',
        sourceTreeSha256:HASH,inputManifestSha256:HASH,serverBuildId:HASH,clientBuildId:HASH,bundleBuildId:HASH};
    const artifact={kind:LOCAL_BUILD_KIND,buildIdentitySha256:localBuildIdentitySha256(build),archiveName:`nassaj-local-forward-${build.commit}.tar.gz`,
        archiveSha256:HASH,archiveSize:1,manifestName:'LOCAL_BUILD_MANIFEST.json',manifestSha256:HASH,manifestSize:1,
        startupClosureSha256:HASH,databaseContractSha256:HASH,build};
    delete f.descriptor.release;
    Object.assign(f.descriptor,{schema:'nassaj-startup-admission-client/v2',nodeInstanceId:'node-one',artifact,
        startupClosureSha256:HASH,databaseContractSha256:HASH,databasePath:'/database',databaseDev:'1',databaseIno:'2'});
    f.setResponse({schema:'nassaj-managed-restart-result/v1',operationId:ID,decision:'committed'});
    assert.equal(managedRestartAction('restartCommittedGeneration',ID,f.deps).decision,'committed');
    for(const transform of [d=>{d.schema='nassaj-startup-admission-client/v1';},d=>{d.artifact.releaseId=1;},
        d=>{d.artifact.kind='github';},d=>{delete d.artifact.kind;},d=>{d.release={generationId:'fake'};}]) {
        const prior=structuredClone(f.descriptor), count=f.calls.length;transform(f.descriptor);
        assert.throws(()=>managedRestartAction('restartCommittedGeneration',ID,f.deps));assert.equal(f.calls.length,count);
        for(const key of Object.keys(f.descriptor))delete f.descriptor[key];Object.assign(f.descriptor,prior);
    }
    const github=fixture();github.descriptor.schema='nassaj-startup-admission-client/v2';
    assert.throws(()=>managedRestartAction('restartCommittedGeneration',ID,github.deps));assert.equal(github.calls.length,0);
});
