/** Exact recovery implementation with scratch journal I/O; no process/generation/DB effects. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import * as capsule from './oid-control-capsule.mjs';
const source=fs.readFileSync(new URL('./oid-control-capsule.source.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function recoverOidTripleOwnedFailure('),source.indexOf('\nasync function attestOidTripleExistingChild('));
const base=()=>({schema:'nassaj-oid-control-transaction/v2',sequence:1,actionId:'owned',transactionNonce:'a'.repeat(64),state:'triple_candidate_start_intent',pair:{targetDigest:'b'.repeat(64),databaseState:'UNKNOWN'}});
for(const driftAt of [1,2])test(`recovery refuses foreign binding on read ${driftAt} without writing or opening`,async()=>{
 const dir=fs.mkdtempSync(path.resolve('.artifacts/oid-recovery-binding-')),file=path.join(dir,'journal.json'),expected=base(),foreign={...expected,actionId:'foreign'};let reads=0,writes=0,transitions=0;
 try{
  fs.writeFileSync(file,JSON.stringify(driftAt===1?foreign:expected));
  const read=()=>{reads++;if(reads===driftAt)fs.writeFileSync(file,JSON.stringify(foreign));return JSON.parse(fs.readFileSync(file));};
  const recover=new Function('pinnedJson','durable','assertOidTripleFailureBinding',`return (${body});`)(read,()=>{writes++;},capsule.assertOidTripleFailureBinding);
  await assert.rejects(recover(dir,{},Buffer.alloc(0),{transition:()=>{transitions++;}},file,expected,Error('oid_triple_health_unverified')),/binding_changed/);
  assert.equal(writes,0);assert.equal(transitions,0);assert.deepEqual(JSON.parse(fs.readFileSync(file)),foreign);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function preRecovery(read, attest, effects) {
 const dependencies={pinnedJson:read,durable:()=>effects.push('write'),assertOidTripleFailureBinding:capsule.assertOidTripleFailureBinding,
  path,lstatSync:()=>{throw Object.assign(Error(),{code:'ENOENT'});},pairVerifyLive:()=>{},pairOwnerAlive:()=>true,
  assertOidPairPreviousRuntime:attest,gitControlRoot:()=>'/scratch',pairRecordEvent:()=>effects.push('event'),
  injectFailure:()=>{},releaseFullWaiterBeforeEffects:capsule.releaseFullWaiterBeforeEffects};
 return new Function(...Object.keys(dependencies),`return (${body});`)(...Object.values(dependencies));
}
for(const drift of ['actionId','databaseState'])test(`PRE rechecks ${drift} after previous health await before any effect`,async()=>{
 const expected={...base(),state:'triple_prepared',pair:{...base().pair,databaseState:'PRE_CANDIDATE',previous:{runtime:{}}}};
 let current=structuredClone(expected);const effects=[];
 const recover=preRecovery(()=>structuredClone(current),async()=>{if(drift==='actionId')current.actionId='foreign';else current.pair.databaseState='UNKNOWN';current.childEvidence='newest';},effects);
 await assert.rejects(recover('/scratch',{},Buffer.alloc(0),{paths:{controlRoot:'/scratch'},transition:()=>effects.push('open')},'/journal',expected,Error('failure')),/binding_changed/);
 assert.deepEqual(effects,[]);assert.equal(current.childEvidence,'newest');
});
test('PRE recovery preserves latest child fields rather than its pre-await frame',async()=>{
 const expected={...base(),state:'triple_prepared',pair:{...base().pair,databaseState:'PRE_CANDIDATE',previous:{runtime:{}}}};
 let current=structuredClone(expected);const effects=[];
 const dependencies={pinnedJson:(_file,label)=>label==='triple_not_started_event'?{localUpdate:{targetDigest:expected.pair.targetDigest}}:structuredClone(current),
  durable:(_file,value)=>{current=value;effects.push('write');},assertOidTripleFailureBinding:capsule.assertOidTripleFailureBinding,path,
  lstatSync:()=>{throw Object.assign(Error(),{code:'ENOENT'});},pairVerifyLive:()=>{},pairOwnerAlive:()=>true,
  assertOidPairPreviousRuntime:async()=>{current.childEvidence='latest';},gitControlRoot:()=>'/scratch',pairRecordEvent:()=>effects.push('event'),
  injectFailure:()=>{},releaseFullWaiterBeforeEffects:capsule.releaseFullWaiterBeforeEffects};
 const recover=new Function(...Object.keys(dependencies),`return (${body});`)(...Object.values(dependencies));
 const result=await recover('/scratch',{},Buffer.alloc(0),{original:{state:'OPEN'},paths:{controlRoot:'/scratch'},transition:()=>effects.push('open')},'/journal',expected,Error('failure'));
 assert.equal(result.restored,true);assert.equal(current.childEvidence,'latest');assert.deepEqual(effects,['event','write','open']);
});
test('actual transaction catch attempts recovery even when diagnostic write fails',async()=>{
 const start=source.indexOf('        try { recordOidTripleOriginFailure(file, transaction, error); }');
 assert.ok(start>0);const segment=source.slice(start,source.indexOf('\n    } finally { handle.release(); }',start));
 const calls=[];const failure=Object.assign(Error('diagnostic_write_failed'),{code:'EACCES'});
 const run=new Function('recordOidTripleOriginFailure','recoverOidTripleOwnedFailure',`return async (root,record,safeBytes,handle,file,transaction,error)=>{${segment}};`)(
  ()=>{calls.push('diagnostic');throw failure;},async()=>{calls.push('guarded-recovery');});
 await assert.rejects(run('',{},null,{},'',base(),Error('original')),error=>error===failure);
 assert.deepEqual(calls,['diagnostic','guarded-recovery']);
});
test('pre-journal failure retains prior fallback recovery without diagnostic authority',async()=>{
 const expected={...base(),state:'pair_admission_intent',pair:{...base().pair,databaseState:'PRE_CANDIDATE',activationNotClaimed:true,previous:{runtime:{}}}};const effects=[];
 const read=(_file,label)=>{if(label==='triple_not_started_event')return {localUpdate:{targetDigest:expected.pair.targetDigest}};throw Object.assign(Error(),{code:'ENOENT'});};
 const recover=preRecovery(read,async()=>{},effects);
 const result=await recover('/scratch',{},null,{original:{state:'OPEN'},paths:{controlRoot:'/scratch'},transition:()=>effects.push('open')},'/journal',expected,Error('before-create'));
 assert.equal(result.restored,true);assert.deepEqual(effects,['event','write','open']);
});
test('a previously observed journal disappearing never falls back to stale evidence',async()=>{
 const expected=base();let reads=0;const effects=[];
 const read=()=>{if(++reads===1)return expected;throw Object.assign(Error(),{code:'ENOENT'});};
 const recover=new Function('pinnedJson','durable','assertOidTripleFailureBinding',`return (${body});`)(read,()=>effects.push('write'),capsule.assertOidTripleFailureBinding);
 await assert.rejects(recover('',{},null,{transition:()=>effects.push('open')},'',expected,Error('failure')),{code:'ENOENT'});
 assert.deepEqual(effects,[]);
});
for(const foreign of [false,true])test(`diagnostic failure invokes actual recovery with ${foreign?'foreign':'valid UNKNOWN'} binding`,async()=>{
 const expected=base(),latest={...expected,actionId:foreign?'foreign':expected.actionId,childEvidence:'latest'};const effects=[];
 const recover=new Function('pinnedJson','durable','assertOidTripleFailureBinding',`return (${body});`)(()=>latest,(_file,value)=>{effects.push('write');assert.equal(value.childEvidence,'latest');assert.equal(value.pair.databaseState,'UNKNOWN');},capsule.assertOidTripleFailureBinding);
 const start=source.indexOf('        try { recordOidTripleOriginFailure(file, transaction, error); }'),segment=source.slice(start,source.indexOf('\n    } finally { handle.release(); }',start));
 const run=new Function('recordOidTripleOriginFailure','recoverOidTripleOwnedFailure',`return async (root,record,safeBytes,handle,file,transaction,error)=>{${segment}};`)(()=>{throw Object.assign(Error('diagnostic_write_failed'),{code:'EACCES'});},recover);
 await assert.rejects(run('',{},null,{transition:value=>{effects.push('transition');assert.equal(value.state,'MANUAL');assert.equal(value.gateClosed,true);}},'',expected,Error('original')),foreign?/binding_changed/:/diagnostic_write_failed/);
 assert.deepEqual(effects,foreign?[]:['write','transition']);
});

test('post-create journal absent on first read cannot use a stale prepared frame',async()=>{
 const expected={...base(),state:'triple_prepared'};const effects=[];
 const recover=new Function('pinnedJson','durable','assertOidTripleFailureBinding',`return (${body});`)(()=>{throw Object.assign(Error(),{code:'ENOENT'});},()=>effects.push('write'),capsule.assertOidTripleFailureBinding);
 await assert.rejects(recover('',{},null,{transition:()=>effects.push('open')},'',expected,Error('failure')),{code:'ENOENT'});
 assert.deepEqual(effects,[]);
});
