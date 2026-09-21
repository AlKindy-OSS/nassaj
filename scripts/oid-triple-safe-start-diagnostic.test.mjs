/** Failure-path orchestration with explicit supervisor/transport doubles; real journal persistence. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {recordOidTripleSafeStartFailure,recordOidTripleOriginFailure,createOidTripleSafeDiagnostic} from './oid-control-capsule.mjs';
const source=fs.readFileSync(new URL('./oid-control-capsule.source.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function startAndAttestOidTriple('),source.indexOf('\n/** A durable claimed executor',source.indexOf('async function startAndAttestOidTriple(')));
const transaction=()=>({schema:'nassaj-oid-control-transaction/v2',sequence:7,actionId:'synthetic-action',transactionNonce:'a'.repeat(64),state:'triple_forward_client_done',supervisor:{synthetic:true},pair:{targetDigest:'b'.repeat(64),databaseState:'PRE_CANDIDATE'}});
for(const rollback of [false,true])test(`start ${rollback?'previous':'target'} failure persists before recovery without losing latest child fields`,async()=>{
 const dir=fs.mkdtempSync(path.resolve('.artifacts/oid-start-diagnostic-')),file=path.join(dir,'journal.json'),writes=[];
 try{
  const durable=(f,v)=>{writes.push(v.state);fs.writeFileSync(f,JSON.stringify(v),{mode:0o600});};
  const runSafe=async(_bytes,args)=>{assert.equal(args[1],rollback?'start-previous':'start-target');const latest=JSON.parse(fs.readFileSync(file));latest.childEvidence={pinned:true};latest.pair.childProofRetained='yes';fs.writeFileSync(file,JSON.stringify(latest));return {status:1,pipeError:null,diagnostic:{exitCode:1,signal:null,reason:'oid_triple_saved_environment_drift'}};};
  const start=new Function('validateOidTriplePm2Slot','triplePm2Read','assertOidTripleEffectiveMode','randomBytes','durable','injectFailure','runSafe','path','recordOidTripleSafeStartFailure',`return (${body});`)(()=>({pm2_env:{env:{}}}),()=>[],()=>{},randomBytes,durable,()=>{},runSafe,path,recordOidTripleSafeStartFailure);
  let transitioned;await assert.rejects(start(dir,{},Buffer.alloc(0),{transition:v=>{transitioned=v;}},file,transaction(),rollback),error=>{recordOidTripleOriginFailure(file,transaction(),error);const j=JSON.parse(fs.readFileSync(file));assert.equal(j.originFailureCode,'oid_triple_start_unverified');assert.equal(j.safeStartFailure.reason,'oid_triple_saved_environment_drift');return error.message==='oid_triple_start_unverified';});
  const j=JSON.parse(fs.readFileSync(file));assert.equal(j.pair.databaseState,rollback?'PRE_CANDIDATE':'UNKNOWN');assert.equal(transitioned.databaseState,j.pair.databaseState);assert.deepEqual(j.childEvidence,{pinned:true});assert.equal(j.pair.childProofRetained,'yes');assert.equal(j.safeStartFailure.phase,rollback?'start-previous':'start-target');assert.deepEqual(fs.readdirSync(dir),['journal.json']);assert.equal(writes.length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('latest advanced database state is preserved, binding mismatch refuses and unknown/flood stays bounded',()=>{
 const dir=fs.mkdtempSync(path.resolve('.artifacts/oid-start-diagnostic-')),file=path.join(dir,'journal.json');
 try{
  const expected={...transaction(),bootNonce:'c'.repeat(64),bootDirection:'target'};const latest={...expected,pair:{...expected.pair,databaseState:'TARGET_VERIFIED'},childField:'preserve'};fs.writeFileSync(file,JSON.stringify(latest));
  const collector=createOidTripleSafeDiagnostic();collector.capture('stderr',Buffer.from('private'.repeat(5000)+'\noid_triple_saved_environment_drift\n'));
  const updated=recordOidTripleSafeStartFailure(file,expected,'start-target',{diagnostic:collector.summarize(1,null)});assert.equal(updated.safeStartFailure.reason,'unknown');assert.equal(updated.pair.databaseState,'TARGET_VERIFIED');assert.equal(updated.childField,'preserve');assert.ok(!JSON.stringify(updated).includes('private'));
  const before=fs.readFileSync(file);assert.throws(()=>recordOidTripleSafeStartFailure(file,{...expected,actionId:'other'},'start-target',{}),/binding_changed/);assert.deepEqual(fs.readFileSync(file),before);
  fs.chmodSync(dir,0o500);assert.throws(()=>recordOidTripleSafeStartFailure(file,expected,'start-target',{diagnostic:{exitCode:1,reason:'unknown'}}),{code:'EACCES'});assert.deepEqual(fs.readFileSync(file),before);
 }finally{fs.chmodSync(dir,0o700);fs.rmSync(dir,{recursive:true,force:true});}
});

test('start succeeds but health fails: origin differs and safeStartFailure is absent',async()=>{
 const {recordOidTripleOriginFailure}=await import('./oid-control-capsule.mjs');
 const dir=fs.mkdtempSync(path.resolve('.artifacts/oid-origin-diagnostic-')),file=path.join(dir,'journal.json'),initial=transaction();
 initial.pair.target={clientBuildId:'target-client',serverBuildId:'target-server',nodeModulesTreeSha256:'target-deps'};
 try{
  const durable=(f,v)=>fs.writeFileSync(f,JSON.stringify(v),{mode:0o600});
  const start=new Function('validateOidTriplePm2Slot','triplePm2Read','assertOidTripleEffectiveMode','randomBytes','durable','injectFailure','runSafe','path','recordOidTripleSafeStartFailure','health',`return (${body});`)(()=>({pm2_env:{env:{}}}),()=>[],()=>{},randomBytes,durable,()=>{},async()=>({status:0,pipeError:null}),path,recordOidTripleSafeStartFailure,async()=>false);
  await assert.rejects(start(dir,{},Buffer.alloc(0),{transition:()=>{}},file,initial),error=>{
   recordOidTripleOriginFailure(file,initial,error);return error.message==='oid_triple_health_unverified';
  });
  const latest=JSON.parse(fs.readFileSync(file));assert.equal(latest.originFailureCode,'oid_triple_health_unverified');assert.equal(latest.safeStartFailure,undefined);assert.equal(latest.pair.databaseState,'UNKNOWN');
  recordOidTripleOriginFailure(file,initial,Error('oid_triple_start_unverified'));assert.equal(JSON.parse(fs.readFileSync(file)).originFailureCode,'oid_triple_health_unverified');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('origin never creates a missing transaction, refuses foreign binding, and records only a closed first code',async()=>{
 const {recordOidTripleOriginFailure}=await import('./oid-control-capsule.mjs');const dir=fs.mkdtempSync(path.resolve('.artifacts/oid-origin-diagnostic-')),file=path.join(dir,'journal.json'),initial=transaction();
 try{
  assert.equal(recordOidTripleOriginFailure(file,initial,Error('oid_triple_start_unverified')),null);assert.deepEqual(fs.readdirSync(dir),[]);
  fs.writeFileSync(file,JSON.stringify(initial));const before=fs.readFileSync(file);assert.throws(()=>recordOidTripleOriginFailure(file,{...initial,actionId:'foreign'},Error('oid_triple_start_unverified')),/binding_changed/);assert.deepEqual(fs.readFileSync(file),before);
  recordOidTripleOriginFailure(file,initial,Error('private-value\n'.repeat(10000)));const latest=JSON.parse(fs.readFileSync(file));assert.equal(latest.originFailureCode,'unknown');assert.ok(!JSON.stringify(latest).includes('private-value'));assert.equal(latest.pair.databaseState,'PRE_CANDIDATE');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
