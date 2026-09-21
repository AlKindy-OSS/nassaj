import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { build } from 'esbuild';
import { collectForwardExecutableClosure } from './build-release-asset.mjs';
import { canonicalForwardValue as canonical, forwardValueSha256 as sha } from './lib/release-runtime-forward-child-protocol.mjs';
import { installFixedStateMutexAuthority } from './fixtures/fixed-state-mutex-authority.mjs';
import { FIXTURE_OPERATOR_ROOT, FIXTURE_ATTESTATION, FIXTURE_PUBLIC } from './fixtures/installed-config-authority.mjs';
const project = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => ({ path:file, sha256:hash(fs.readFileSync(file)) });
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value), {mode:0o600});

// Root credentials/file ownership and retired PM2/systemd facts are explicit seams.
// The actual source parent and source child exchange FD3/4; the child imports the compiled
// real A entry, runs its readonly method on an actual fixture DB, then exits normally.
// Cross-process holder inspection is a declared retirement seam: the known seed process must be dead
// and the actual root process FD inventory must contain no DB handle. Production EACCES remains fatal.
// This is an observation-channel test, not evidence that initial host retirement ran.
async function setup(t, scenario = 'success') {
    const root = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || path.join(project, '.artifacts'), 'observation-channel-'));
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const generation = path.join(root,'generation'), control = path.join(root,'control'), database = path.join(root,'database');
    for (const directory of [generation,control,database]) fs.mkdirSync(directory,{mode:0o700});
    for (const file of collectForwardExecutableClosure(project).files) {
        const target=path.join(generation,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(project,file.path),target);
        fs.chmodSync(target,file.mode);
    }
    fs.symlinkSync(path.join(project,'node_modules'),path.join(generation,'node_modules'));
    const entry=path.join(generation,'dist-server/server/scripts/release-database-migration.js');fs.mkdirSync(path.dirname(entry),{recursive:true});
    await build({entryPoints:[path.join(project,'server/scripts/release-database-migration.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',
        packages:'external',tsconfig:path.join(project,'server/tsconfig.json'),logLevel:'silent'});
    const compiled=fs.readFileSync(entry,'utf8');const aMarker='function runCompatibleForwardMigration(request, verifyTrustedContext) {';
    assert.equal(compiled.split(aMarker).length,2);
    fs.writeFileSync(entry,compiled.replace(aMarker,aMarker+" throw Error('fixture_A_must_not_run_in_observation');"));
    const seeded=spawnSync(process.execPath,['--import','tsx','server/scripts/fixtures/compatible-forward-child.test.ts','observation-seed',database],
        {cwd:project,env:{...process.env,TSX_TSCONFIG_PATH:path.join(project,'server/tsconfig.json')},encoding:'utf8',timeout:20000});
    assert.equal(seeded.status,0,seeded.stderr);
    const {request,contract}=JSON.parse(fs.readFileSync(path.join(database,'context.json')));
    const seed=JSON.parse(fs.readFileSync(path.join(database,'seed-result.json')));
    const file=path.join(control,'config.json'), marker=path.join(control,'parent.pid');
    const hook=path.join(generation,'fixture-hook.mjs');
    fs.writeFileSync(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const database=${JSON.stringify(database)},control=${JSON.stringify(control)},generation=${JSON.stringify(generation)},fixed='/etc/nassaj/release-runtime-host.json',local=${JSON.stringify(file)};
const uid=process.getuid(),gid=process.getgid(),groups=[...new Set(process.getgroups())].sort((a,b)=>a-b);let dropped=false;
const operator=${JSON.stringify(FIXTURE_OPERATOR_ROOT)},attestation=${JSON.stringify(FIXTURE_ATTESTATION)},descriptor=${JSON.stringify(FIXTURE_PUBLIC)},support=control+'/installed-support';
const original={lstat:fs.lstatSync,fstat:fs.fstatSync,open:fs.openSync,realpath:fs.realpathSync,read:fs.readFileSync};const ids=new Set();
const map=p=>p===fixed?local:p==='/etc/nassaj'?control:p===attestation?control+'/release-host-support-attestation.json':p===descriptor?control+'/descriptor.json'
    :(typeof p==='string'&&(p===operator||p.startsWith(operator+'/')))?support+p.slice(operator.length):p;
fs.lstatSync=(p,...a)=>{const s=original.lstat(map(p),...a);if(!String(p).startsWith(database)){s.uid=typeof s.uid==='bigint'?0n:0;if(s.isDirectory())s.mode=typeof s.mode==='bigint'?s.mode&~18n:s.mode&~18;ids.add(String(s.ino));}return s;};
fs.fstatSync=(...a)=>{const s=original.fstat(...a);if(ids.has(String(s.ino)))s.uid=typeof s.uid==='bigint'?0n:0;return s;};
fs.openSync=(p,...a)=>{const fd=original.open(map(p),...a);if(!String(map(p)).startsWith(database)){const s=original.fstat(fd);ids.add(String(s.ino));}return fd;};fs.realpathSync=(p,...a)=>map(p)!==p?p:original.realpath(p,...a);
fs.readFileSync=(p,...a)=>{const value=original.read(p,...a);const parent=Number(original.read(${JSON.stringify(marker)},'utf8'));if(p==='/proc/'+parent+'/status'||p==='/proc/'+process.pid+'/status'||(typeof p==='string'&&p.endsWith('/status')&&value.toString().split('\\n').some(line=>line.startsWith('PPid:')&&Number(line.slice(5))===parent))){let text=value.toString().replace(/^Groups:.*$/m,'Groups:\\t'+groups.join(' '));if(p==='/proc/'+parent+'/status')text=text.replace(/^Uid:.*$/m,'Uid:\\t0\\t0\\t0\\t0');return Buffer.isBuffer(value)?Buffer.from(text):text;}return value;};
const createStream=fs.createWriteStream;fs.createWriteStream=(p,o)=>{const stream=createStream(p,o);if(o?.fd===4){const write=stream.write.bind(stream);stream.write=(bytes,...args)=>{if(${JSON.stringify(scenario)}==='wrong-purpose'||${JSON.stringify(scenario)}==='wrong-nonce'){const frame=JSON.parse(bytes);if(${JSON.stringify(scenario)}==='wrong-purpose')frame.observationAuthority.purpose='migration';else frame.attemptNonce='0'.repeat(64);bytes=JSON.stringify(frame)+'\\n';}return write(bytes,...args);};if(['revoke-result','host-result','expiry-result'].includes(${JSON.stringify(scenario)})){const end=stream.end.bind(stream);stream.end=(bytes,...args)=>{fs.writeFileSync(control+'/result-ready','ready');setTimeout(()=>end(bytes,...args),100);return stream;};}}return stream;};
process.getuid=()=>dropped?uid:0;process.geteuid=()=>dropped?uid:0;process.setgroups=value=>{if(JSON.stringify(value)!==JSON.stringify(groups))throw Error('fixture groups mismatch');};process.setgid=value=>{if(value!==gid)throw Error('fixture gid mismatch');};process.setuid=value=>{if(value!==uid)throw Error('fixture uid mismatch');dropped=true;};syncBuiltinESMExports();
`);
    // Pinned closure files must not inherit a group-writable runner umask.
    fs.chmodSync(hook,0o644);fs.chmodSync(entry,0o644);
    const wrapper=path.join(generation,'scripts/release-runtime-forward-child.mjs');fs.writeFileSync(wrapper,"import '../fixture-hook.mjs';\n"+fs.readFileSync(wrapper,'utf8').replace(/^#![^\n]*\n/,''));
    const closure=path.join(control,'closure.json');const closureFiles=[hook,entry,...collectForwardExecutableClosure(project).files.map(f=>path.join(generation,f.path))].sort();
    put(closure,{schema:'nassaj-forward-child-closure/v1',files:closureFiles.map(pin)});
    put(path.join(control,'request.json'),request);put(path.join(control,'contract.json'),contract);
    const fallback=path.join(control,'dump.json');put(fallback,[]);
    const systemctl=path.join(control,'systemctl');fs.writeFileSync(systemctl,"#!/bin/sh\nprintf '%s\\n' 'Id=fixture.service' 'LoadState=masked' 'ActiveState=inactive' 'UnitFileState=masked' 'ControlGroup='\n",{mode:0o755});
    const source={sourceId:'dump',path:fallback,format:'pm2-dump-json'};
    const values={Id:'fixture.service',LoadState:'masked',ActiveState:'inactive',UnitFileState:'masked',ControlGroup:''};
    const mutatorPlan={systemctl:pin(systemctl),sources:[{sourceId:'unit',scope:'system',unit:'fixture.service'}],inventory:[{kind:'file',path:systemctl,sha256:pin(systemctl).sha256}]};
    const supervisorPlan={sources:[source],slot:{name:'fixture',namespace:'fixture'},pm2:{observer:{}}};
    const keys=generateKeyPairSync('ed25519');const key=path.join(control,'owner.pub');fs.writeFileSync(key,keys.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
    const expected={releaseIdentitySha256:request.releaseIdentitySha256,ownerApprovalKeySha256:hash(keys.publicKey.export({type:'spki',format:'der'})),
        supervisorPlanSha256:sha(supervisorPlan),mutatorPlanSha256:sha(mutatorPlan)};
    const identity={releaseIdentitySha256:request.releaseIdentitySha256};
    const config={schema:'nassaj-release-runtime-host-config/v1',controlRoot:control,databaseFile:request.database.realpath,expected,
        bootstrapClaim:{approvalFile:path.join(control,'approval.json'),ownerApprovalPublicKeyFile:key,identity},forwardActivation:{supervisorPlan,mutatorPlan},
        forwardMigration:{node:pin(fs.realpathSync(process.execPath)),wrapper:pin(wrapper),entry:pin(entry),closure:pin(closure),
            request:pin(path.join(control,'request.json')),contract:pin(path.join(control,'contract.json')),
            serviceIdentity:{uid:process.getuid(),gid:process.getgid(),supplementaryGids:[...new Set(process.getgroups())].sort((a,b)=>a-b)}}};
    const payload={schema:'nassaj-owner-cutover-approval/v1',action:'release-runtime-first-cutover',expectedSha256:sha(expected),startupAdmission:identity,issuedAt:Date.now()-1000,expiresAt:Date.now()+290000};
    const approval={...payload,signature:sign(null,Buffer.from(canonical(payload)),keys.privateKey).toString('base64url')};put(config.bootstrapClaim.approvalFile,approval);
    const originalIntent={schema:'nassaj-forward-migration-intent/v1',transactionId:request.transactionId,attemptNonce:'a'.repeat(64),requestSha256:sha(request),
        databaseContractSha256:sha(contract),rootExecutableClosureSha256:pin(closure).sha256,migrationClosureSha256:contract.migrationClosureSha256,retirementReceiptSha256:'b'.repeat(64)};
    const authorization={...seed.process,transactionId:request.transactionId,attemptNonce:originalIntent.attemptNonce,challenge:'c'.repeat(64),requestSha256:sha(request),originalIntentSha256:sha(originalIntent)};
    const result={schema:'nassaj-forward-child-result/v1',...authorization,result:seed.result};delete result.originalIntentSha256;
    const retirement={schema:'nassaj-forward-retirement/v1',transactionId:request.transactionId,supervisorPlanSha256:sha(supervisorPlan),mutatorPlanSha256:sha(mutatorPlan),
        sources:[{...source,afterSha256:pin(fallback).sha256,unaffectedEntriesSha256:sha([]),oldTargetAbsent:true,durable:true}],
        inhibitors:[{sourceId:'unit',proofSha256:sha({sourceId:'unit',scope:'system',user:null,values})}],runtime:{namespaceSha256:'d'.repeat(64)},retiredProcess:seed.process};
    retirement.factsSha256=sha(retirement);
    const attempt={attemptId:'stop-attempt',attemptNonce:'e'.repeat(64),state:'observed',worker:seed.process,steps:[]};
    for(const step of ['stop-old','delete-old']) {
        const bindings={operationId:request.transactionId,attemptId:attempt.attemptId,attemptNonce:attempt.attemptNonce,step,requestId:step};
        attempt.steps.push({step,state:'observed',intent:{schema:'nassaj-pm2-execution-intent/v1',...bindings},
            result:{schema:'nassaj-pm2-step-result/v1',...bindings,dispatchState:'observed'},rootWindow:{bootBefore:seed.process.bootId,bootAfter:seed.process.bootId}});
    }
    const supervisorHistory=[{intent:{phase:'stop',attemptId:attempt.attemptId,attemptNonce:attempt.attemptNonce},permit:seed.process,result:{result:{steps:attempt.steps.map(step=>step.result)}}}];
    const state={schema:'nassaj-startup-admission/v1',state:'switching',generationEpoch:1,revision:1};put(path.join(control,'startup-admission.json'),state);put(path.join(control,'host-dispatch-state.json'),{gateActive:true});
    put(path.join(control,'first-cutover.json'),{state:'running',phase:'migration_observed',transactionId:request.transactionId,revision:1,expected,
        approvalSha256:sha(approval),approvalAcceptedAt:Date.now(),operator:seed.process,forwardAdmission:{generationEpoch:1,revision:1,sha256:sha(state)},
        forwardMigrationIntent:originalIntent,forwardChildAuthorization:authorization,forwardMigrationResult:result,forwardSupervisorAttempts:[attempt],forwardSupervisorHistory:supervisorHistory,forwardRetirement:retirement});
    put(path.join(control,'first-cutover.lock'),{schema:'nassaj-cutover-lock/v1',pid:seed.process.pid,startTime:seed.process.startTicks});
    // The fixed host config is now read as a completed, measured installation; stage and attest one.
    installFixedStateMutexAuthority(t,control,config,{file});
    const runner=path.join(generation,'runner.mjs');fs.writeFileSync(runner,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
await import('./fixture-hook.mjs');const {prepareForwardObservationReconciliation,runForwardMigrationChild}=await import('./scripts/lib/release-runtime-forward-parent.mjs');
const config=JSON.parse(fs.readFileSync(${JSON.stringify(file)}));const deps={retirement:{observeRuntime:async()=>({entries:[],observationSha256:'${'d'.repeat(64)}'}),verifyNoHolders:()=>{if(fs.existsSync('/proc/${seed.process.pid}'))throw Error('fixture seed remains alive');for(const name of fs.readdirSync('/proc/self/fd')){try{const info=fs.fstatSync(Number(name));if(String(info.ino)===${JSON.stringify(request.database.inode)})throw Error('fixture root DB handle');}catch(error){if(error.code!=='EBADF')throw error;}}}}};
const before=fs.readFileSync(config.controlRoot+'/first-cutover.lock');
if(${JSON.stringify(scenario)}==='prepare-history'){const file=config.controlRoot+'/first-cutover.json';const j=JSON.parse(fs.readFileSync(file));j.forwardSupervisorAuthorization={phase:'start'};fs.writeFileSync(file,JSON.stringify(j));try{await prepareForwardObservationReconciliation(config,${JSON.stringify(request.transactionId)},deps);throw Error('fixture_prepare_unexpected_success');}catch(error){if(error.message==='fixture_prepare_unexpected_success')throw error;process.stdout.write(JSON.stringify({error:error.message,state:'unprepared',diagnostic:false}));process.exit(0);}}
await prepareForwardObservationReconciliation(config,${JSON.stringify(request.transactionId)},deps);
const scenario=${JSON.stringify(scenario)};let interval;let error=null;let result;
if(['history-intent','history-possibly-sent','history-extra','history-disguised','history-duplicate','host-drift','prepare-history','host-result','expiry-result'].includes(scenario)){const file=config.controlRoot+'/first-cutover.json';const j=JSON.parse(fs.readFileSync(file));if(scenario==='history-intent')j.forwardSupervisorIntent={phase:'start'};if(scenario==='history-possibly-sent')j.forwardSupervisorAttempts[0].steps[0].state='possibly_sent';if(scenario==='history-disguised')j.forwardSupervisorAttempts[0].state='deferred';if(scenario==='history-duplicate')j.forwardSupervisorAttempts.push(structuredClone(j.forwardSupervisorAttempts[0]));if(scenario==='history-extra')j.forwardSupervisorHistory.push({intent:{attemptId:'hidden'}});fs.writeFileSync(file,JSON.stringify(j));if(scenario==='host-drift')fs.writeFileSync(config.controlRoot+'/host-dispatch-state.json',JSON.stringify({gateActive:true,nonce:'changed'}));}
if(scenario==='expired'){const file=config.controlRoot+'/first-cutover.json';const j=JSON.parse(fs.readFileSync(file));j.forwardObservationReconciliation.expiresAtBootMs=0;fs.writeFileSync(file,JSON.stringify(j));}
if(['revoke-result','host-result','expiry-result'].includes(scenario)){const {invalidateCutoverStartupAdmission}=await import('./scripts/lib/release-runtime-cutover.mjs');interval=setInterval(()=>{if(fs.existsSync(config.controlRoot+'/result-ready')){clearInterval(interval);if(scenario==='revoke-result')invalidateCutoverStartupAdmission(config.controlRoot,'fixture-revocation');else if(scenario==='host-result')fs.writeFileSync(config.controlRoot+'/host-dispatch-state.json',JSON.stringify({gateActive:true,nonce:'late-change'}));else{const file=config.controlRoot+'/first-cutover.json';const j=JSON.parse(fs.readFileSync(file));j.forwardObservationReconciliation.expiresAtBootMs=0;fs.writeFileSync(file,JSON.stringify(j));}}},5);}
try{if(scenario==='concurrent')await prepareForwardObservationReconciliation(config,${JSON.stringify(request.transactionId)},deps);else result=await runForwardMigrationChild(config,'observe-target',deps);}catch(caught){error=caught.message;}finally{clearInterval(interval);}
if(!fs.readFileSync(config.controlRoot+'/first-cutover.lock').equals(before))throw Error('fixture lock changed');
process.stdout.write(JSON.stringify(error?{error,state:JSON.parse(fs.readFileSync(config.controlRoot+'/first-cutover.json')).forwardObservationReconciliation.state,diagnostic:!!JSON.parse(fs.readFileSync(config.controlRoot+'/first-cutover.json')).forwardObservationReconciliation.diagnostic}:{state:result.forwardObservationReconciliation.state,target:result.forwardObservationReconciliation.result.result.schema}));`);
    return {root,generation,control,database,runner};
}
test('actual root/service observation pipes leave the abandoned lock unchanged through readonly result and normal exit',async t=>{
    const f=await setup(t);const result=spawnSync(process.execPath,[f.runner],{cwd:f.generation,encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{state:'observed',target:'nassaj-compatible-forward-target-observation/v1'});
});

for(const scenario of ['wrong-purpose','wrong-nonce','expired','concurrent','revoke-result','history-intent','history-possibly-sent','history-extra','history-disguised','history-duplicate','host-drift','prepare-history','host-result','expiry-result'])test(`actual observation channel ${scenario} never yields transferable proof`,async t=>{
    const f=await setup(t,scenario);const result=spawnSync(process.execPath,[f.runner],{cwd:f.generation,encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert.ok(output.error);assert.notEqual(output.state,'observed');if(['revoke-result','host-result','expiry-result'].includes(scenario))assert.equal(output.diagnostic,true);
});
