import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { build } from 'esbuild';
import { collectForwardExecutableClosure } from '../build-release-asset.mjs';
import { canonicalForwardValue as canonical, forwardValueSha256 as sha } from '../lib/release-runtime-forward-child-protocol.mjs';
import { installFixedStateMutexAuthority } from './fixed-state-mutex-authority.mjs';
import { FIXTURE_OPERATOR_ROOT, FIXTURE_ATTESTATION, FIXTURE_PUBLIC } from './installed-config-authority.mjs';
const project = path.resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => ({ path:file, sha256:hash(fs.readFileSync(file)) });
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value), {mode:0o600});
const sealForwardFixtureFile = (file, mode = 0o644) => fs.chmodSync(file, mode);

// Root credentials/file ownership and retired PM2/systemd facts are explicit seams.
// The actual source parent and source child exchange FD3/4; the child imports the compiled
// real A entry, runs its readonly method on an actual fixture DB, then exits normally.
// Cross-process holder inspection is a declared retirement seam: the known seed process must be dead
// and the actual root process FD inventory must contain no DB handle. Production EACCES remains fatal.
// This exercises reconciliation using actual observation and durable transfer code.
// Initial host retirement is an explicit fixture precondition, not a claimed effect.
export async function setupObservationIntegration(t, scenario = 'success') {
    const root = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || path.join(project, '.artifacts'), 'observation-integration-'));
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const generation = path.join(root,'generation'), control = path.join(root,'control'), database = path.join(root,'database');
    for (const directory of [generation,control,database]) fs.mkdirSync(directory,{mode:0o700});
    for (const file of collectForwardExecutableClosure(project).files) {
        const target=path.join(generation,file.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});fs.copyFileSync(path.join(project,file.path),target);sealForwardFixtureFile(target,file.mode);
    }
    const facade=path.join(generation,'scripts/release-runtime-forward-parent.mjs');
    fs.writeFileSync(facade,fs.readFileSync(facade,'utf8').replaceAll("catch { return { schema: 'nassaj-forward-lock-reconciliation/v1'","catch (error) { process.stderr.write(error.message+'\\n'); return { schema: 'nassaj-forward-lock-reconciliation/v1'"));
    sealForwardFixtureFile(facade);
    fs.symlinkSync(path.join(project,'node_modules'),path.join(generation,'node_modules'));
    const entry=path.join(generation,'dist-server/server/scripts/release-database-migration.js');fs.mkdirSync(path.dirname(entry),{recursive:true,mode:0o755});
    await build({entryPoints:[path.join(project,'server/scripts/release-database-migration.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',
        packages:'external',tsconfig:path.join(project,'server/tsconfig.json'),logLevel:'silent'});
    const compiled=fs.readFileSync(entry,'utf8');const aMarker='function runCompatibleForwardMigration(request, verifyTrustedContext) {';
    assert.equal(compiled.split(aMarker).length,2);
    fs.writeFileSync(entry,"if(process.geteuid()===0)throw Error('fixture_root_must_not_import_DB_entry');\n"+compiled.replace(aMarker,aMarker+" throw Error('fixture_A_must_not_run_in_observation');"));
    sealForwardFixtureFile(entry);
    const seeded=spawnSync(process.execPath,['--import','tsx','server/scripts/fixtures/compatible-forward-child.test.ts','observation-seed',database],
        {cwd:project,env:{...process.env,TSX_TSCONFIG_PATH:path.join(project,'server/tsconfig.json')},encoding:'utf8',timeout:20000});
    assert.equal(seeded.status,0,seeded.stderr);
    if(scenario==='target-drift'){
        const changed=spawnSync(process.execPath,['--input-type=module','-e',
            "import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.exec('CREATE TABLE unexpected_fixture_drift(value INTEGER)');db.close();",
            JSON.parse(fs.readFileSync(path.join(database,'context.json'))).request.database.realpath],{cwd:project,encoding:'utf8',timeout:10000});
        assert.equal(changed.status,0,changed.stderr);
    }

    const {request,contract}=JSON.parse(fs.readFileSync(path.join(database,'context.json')));
    const seed=JSON.parse(fs.readFileSync(path.join(database,'seed-result.json')));
    const file=path.join(control,'config.json'), marker=path.join(control,'parent.pid');
    const hook=path.join(generation,'fixture-hook.mjs');
    fs.writeFileSync(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const database=${JSON.stringify(database)},control=${JSON.stringify(control)},generation=${JSON.stringify(generation)},fixed='/etc/nassaj/release-runtime-host.json',local=${JSON.stringify(file)};
const uid=process.getuid(),gid=process.getgid(),groups=[...new Set(process.getgroups())].sort((a,b)=>a-b);let dropped=false;
const operator=${JSON.stringify(FIXTURE_OPERATOR_ROOT)},attestation=${JSON.stringify(FIXTURE_ATTESTATION)},descriptorPath=${JSON.stringify(FIXTURE_PUBLIC)},support=control+'/installed-support';
const original={lstat:fs.lstatSync,fstat:fs.fstatSync,open:fs.openSync,realpath:fs.realpathSync,read:fs.readFileSync};const ids=new Set();
const map=p=>p===fixed?local:p==='/etc/nassaj'?control:p===attestation?control+'/release-host-support-attestation.json':p===descriptorPath?control+'/descriptor.json'
    :(typeof p==='string'&&(p===operator||p.startsWith(operator+'/')))?support+p.slice(operator.length):p;
fs.lstatSync=(p,...a)=>{const s=original.lstat(map(p),...a);if(!String(p).startsWith(database)){s.uid=typeof s.uid==='bigint'?0n:0;if(s.isDirectory())s.mode=typeof s.mode==='bigint'?s.mode&~18n:s.mode&~18;ids.add(String(s.ino));}return s;};
fs.fstatSync=(...a)=>{const s=original.fstat(...a);if(ids.has(String(s.ino)))s.uid=typeof s.uid==='bigint'?0n:0;return s;};
fs.openSync=(p,...a)=>{const fd=original.open(map(p),...a);if(!String(p).startsWith(database))ids.add(String(original.fstat(fd).ino));return fd;};fs.realpathSync=(p,...a)=>map(p)!==p?p:original.realpath(p,...a);
fs.readFileSync=(p,...a)=>{const value=original.read(p,...a);const parent=Number(original.read(${JSON.stringify(marker)},'utf8'));if(p==='/proc/'+parent+'/status'||p==='/proc/'+process.pid+'/status'||(typeof p==='string'&&p.endsWith('/status')&&value.toString().split('\\n').some(line=>line.startsWith('PPid:')&&Number(line.slice(5))===parent))){let text=value.toString().replace(/^Groups:.*$/m,'Groups:\\t'+groups.join(' '));if(p==='/proc/'+parent+'/status')text=text.replace(/^Uid:.*$/m,'Uid:\\t0\\t0\\t0\\t0');return Buffer.isBuffer(value)?Buffer.from(text):text;}return value;};
const createStream=fs.createWriteStream;fs.createWriteStream=(p,o)=>{const stream=createStream(p,o);if(o?.fd===4){const write=stream.write.bind(stream);stream.write=(bytes,...args)=>{if(${JSON.stringify(scenario)}==='child-crash')process.exit(79);if(${JSON.stringify(scenario)}==='wrong-purpose'||${JSON.stringify(scenario)}==='wrong-nonce'){const frame=JSON.parse(bytes);if(${JSON.stringify(scenario)}==='wrong-purpose')frame.observationAuthority.purpose='migration';else frame.attemptNonce='0'.repeat(64);bytes=JSON.stringify(frame)+'\\n';}return write(bytes,...args);};if(['revoke-result','host-result','expiry-result'].includes(${JSON.stringify(scenario)})){const end=stream.end.bind(stream);stream.end=(bytes,...args)=>{fs.writeFileSync(control+'/result-ready','ready');setTimeout(()=>end(bytes,...args),100);return stream;};}}return stream;};
process.getuid=()=>dropped?uid:0;process.geteuid=()=>dropped?uid:0;process.setgroups=value=>{if(JSON.stringify(value)!==JSON.stringify(groups))throw Error('fixture groups mismatch');};process.setgid=value=>{if(value!==gid)throw Error('fixture gid mismatch');};process.setuid=value=>{if(value!==uid)throw Error('fixture uid mismatch');dropped=true;};syncBuiltinESMExports();
`);
    sealForwardFixtureFile(hook);
    const wrapper=path.join(generation,'scripts/release-runtime-forward-child.mjs');fs.writeFileSync(wrapper,"import '../fixture-hook.mjs';\n"+fs.readFileSync(wrapper,'utf8').replace(/^#![^\n]*\n/,''));sealForwardFixtureFile(wrapper);
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
        stateLock:{schema:'nassaj-cutover-state-lock/v2',flock:pin('/usr/bin/flock')},
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
    // The fixed host config is read as a completed, measured installation; stage and attest one.
    installFixedStateMutexAuthority(t,control,config,{file});
    const runner=path.join(generation,'runner.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
await import('./fixture-hook.mjs');
const {runReconciledForwardOperator}=await import('./scripts/release-runtime-forward-parent.mjs');
const {inspectForwardChildIdentity}=await import('./scripts/lib/release-runtime-forward-child-protocol.mjs');
const {invalidateCutoverStartupAdmission}=await import('./scripts/lib/release-runtime-cutover.mjs');
const config=JSON.parse(fs.readFileSync(${JSON.stringify(file)}));
const scenario=${JSON.stringify(scenario)};
const control=config.controlRoot, journalFile=control+'/first-cutover.json', lockFile=control+'/first-cutover.lock';
const read=()=>JSON.parse(fs.readFileSync(journalFile));
const original=read(), lockBefore=fs.readFileSync(lockFile);
let observedWrites=0, transfers=0, childDeadBeforeTransfer=false;
const equalLock=()=>{if(!fs.readFileSync(lockFile).equals(lockBefore))throw Error('fixture early lock transfer');};
const actualRename=fs.renameSync;
fs.renameSync=(from,to)=>{
  let next;
  if(to===journalFile){
    next=JSON.parse(fs.readFileSync(from));
    if(['prepared','child_authorized','observed'].includes(next.forwardObservationReconciliation?.state)&&transfers===0)equalLock();
    if(next.forwardObservationReconciliation?.state==='observed'&&next.forwardLockReconciliation?.observation?.nonce!==next.forwardObservationReconciliation.nonce){
      const child=next.forwardObservationReconciliation.child;
      if(fs.existsSync('/proc/'+child.pid))throw Error('fixture child alive at observed receipt');
      observedWrites++;
    }
  }
  if(to===lockFile){
    if(observedWrites!==1)throw Error('fixture no fresh observation');
    const child=read().forwardObservationReconciliation.child;
    childDeadBeforeTransfer=!fs.existsSync('/proc/'+child.pid);
    if(!childDeadBeforeTransfer)throw Error('fixture live child transfer');
    transfers++;
  }
  const repeated=scenario.startsWith('repeat-');
  const stages=scenario==='repeat-mixed'?['before','after','before','after']:Array(3).fill('after');
  const index=fs.existsSync(control+'/crash-count')?Number(fs.readFileSync(control+'/crash-count','utf8')):0;
  if(to===lockFile&&repeated&&stages[index]==='before'){
    fs.writeFileSync(control+'/crash-count',String(index+1));process.exit(79);
  }
  if(to===lockFile&&scenario==='crash-before-rename'&&!fs.existsSync(control+'/crashed')){
    fs.writeFileSync(control+'/crashed','yes');process.exit(79);
  }
  if(to===lockFile&&scenario==='interrupted-before-rename'&&!fs.existsSync(control+'/crashed')){
    fs.writeFileSync(control+'/crashed','yes');throw Error('fixture before rename interruption');
  }
  const value=actualRename(from,to);
  if(to===lockFile&&repeated&&stages[index]==='after'){
    fs.writeFileSync(control+'/crash-count',String(index+1));process.exit(79);
  }
  if(to===lockFile&&scenario==='interrupted-after-rename'&&!fs.existsSync(control+'/crashed')){
    fs.writeFileSync(control+'/crashed','yes');throw Error('fixture after rename interruption');
  }
  if(next?.forwardObservationReconciliation?.state==='prepared'&&scenario==='expiry-before-permit'){
    const expired=read();expired.forwardObservationReconciliation.expiresAtBootMs=0;fs.writeFileSync(journalFile,JSON.stringify(expired));
  }
  if(to===lockFile&&scenario==='crash-after-rename'&&!fs.existsSync(control+'/crashed')){
    fs.writeFileSync(control+'/crashed','yes');process.exit(79);
  }
  if(next?.forwardObservationReconciliation?.state==='observed'&&next.forwardLockReconciliation?.observation?.nonce!==next.forwardObservationReconciliation.nonce){
    if(scenario==='repeat-drift'&&index===3){
      let oldest=read().forwardLockReconciliation;while(oldest.previousIntent)oldest=oldest.previousIntent;
      fs.writeFileSync(control+'/'+oldest.tombstone,'{}');
    }
    if(scenario==='revoke-transfer')invalidateCutoverStartupAdmission(control,'fixture-revocation');
    if(scenario==='host-transfer')fs.writeFileSync(control+'/host-dispatch-state.json',JSON.stringify({gateActive:true,nonce:'drift'}));
    if(scenario==='expiry-transfer'||scenario==='nonce-transfer'){
      const changed=read();
      if(scenario==='expiry-transfer')changed.forwardObservationReconciliation.expiresAtBootMs=0;
      else changed.forwardObservationReconciliation.nonce='0'.repeat(64);
      fs.writeFileSync(journalFile,JSON.stringify(changed));
    }
    if(scenario==='database-transfer'){
      actualRename(config.databaseFile,config.databaseFile+'.retained');
      fs.writeFileSync(config.databaseFile,'');
    }
  }
  return value;
};
const retirement={observeRuntime:async()=>({entries:[],observationSha256:'${'d'.repeat(64)}'}),verifyNoHolders:()=>{
  if(fs.existsSync('/proc/${seed.process.pid}'))throw Error('fixture seed remains alive');
  for(const name of fs.readdirSync('/proc/self/fd')){try{const info=fs.fstatSync(Number(name));
    if(String(info.ino)===${JSON.stringify(request.database.inode)})throw Error('fixture root DB handle');
  }catch(error){if(error.code!=='EBADF')throw error;}}
}};
if(scenario==='live-owner'){
 const own=inspectForwardChildIdentity(process.pid);const j=read();j.operator={pid:own.pid,startTicks:own.startTicks,bootId:own.bootId};
 fs.writeFileSync(journalFile,JSON.stringify(j));fs.writeFileSync(lockFile,JSON.stringify({schema:'nassaj-cutover-lock/v1',pid:own.pid,startTime:own.startTicks}));
}
const result=await runReconciledForwardOperator({schema:'nassaj-forward-activation-operation/v1',operationId:${JSON.stringify(request.transactionId)}},{runtime:{retirement}});
const after=read();
if(after.approvalAcceptedAt!==original.approvalAcceptedAt||JSON.stringify(after.forwardMigrationResult)!==JSON.stringify(original.forwardMigrationResult))throw Error('fixture original proof changed');
if(result.decision==='diagnosis_only'&&scenario!=='live-owner'&&!scenario.startsWith('interrupted-'))equalLock();
const tombstone=after.forwardLockReconciliation?.tombstone;
if(result.decision==='reconciled'&&tombstone&&!fs.readFileSync(control+'/'+tombstone).equals(lockBefore))throw Error('fixture tombstone mismatch');
process.stdout.write(JSON.stringify({decision:result.decision,observedWrites,transfers,childDeadBeforeTransfer,
 maintenance:JSON.parse(fs.readFileSync(control+'/host-dispatch-state.json')).gateActive,
 lockPresent:fs.existsSync(lockFile),state:after.forwardObservationReconciliation?.state||null,
 acceptedAtPreserved:after.approvalAcceptedAt===original.approvalAcceptedAt}));
`);
    return {root,generation,control,database,runner};
}
