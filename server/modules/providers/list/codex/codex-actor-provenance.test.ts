import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { bindNativeChild, childOwnedBoundary, nativeLaunches, ownContextCandidates, resolveNativeActorFields } from './codex-actor-native-evidence.js';
import { actorStatDecimal, openActorSource, type ActorSource } from './codex-actor-source.js';

const meta = (id: string, parent: string | null = null) => ({type:'session_meta',payload:{id,session_id:'root',parent_thread_id:parent,thread_source:parent?'subagent':'user',source:parent?{subagent:{}}:'cli'}});
const call = (id='call1', args: unknown={agent_type:'tester'}) => ({type:'response_item',payload:{type:'function_call',name:'spawn_agent',namespace:'multi_agent_v1',call_id:id,arguments:JSON.stringify(args)}});
const output = (id='call1',child='child') => ({type:'response_item',payload:{type:'function_call_output',call_id:id,output:JSON.stringify({agent_id:child})}});
const turns = (models=['A','B','A']) => models.flatMap((model,i)=>[
  {type:'event_msg',payload:{type:'task_started',turn_id:'turn'+i}},
  {type:'turn_context',payload:{turn_id:'turn'+i,model}},
  {type:'event_msg',payload:{type:'task_complete',turn_id:'turn'+i}},
]);
async function fixture(run:(root:string,write:(name:string,rows:unknown[])=>string,pin:(file:string)=>Promise<ActorSource>)=>Promise<void>) {
  const base=path.resolve('.artifacts');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'r3b-'));
  const opened:ActorSource[]=[];
  const write=(name:string,rows:unknown[])=>{const file=path.join(root,name+'.jsonl');writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return file;};
  try{await run(root,write,async file=>{const p=await openActorSource(root,file);opened.push(p);return p;});}
  finally{for(const p of opened)await p.close();rmSync(root,{recursive:true,force:true});}
}
test('exact native child binding, inherited boundary and own A-B-A survive without timestamp evidence',async()=>fixture(async(_r,write,pin)=>{
  const root=meta('root');const parent=await pin(write('root',[root,call(),output()]));
  const child=await pin(write('child',[meta('child','root'),...turns(['PARENT']),root,...turns()]));
  const boundary=childOwnedBoundary(child,[parent]);assert.equal(boundary,4);
  const launches=nativeLaunches(parent,0);const link=bindNativeChild(parent,child,launches[0],0);
  assert.match(link.actorId,/^act_[a-f0-9]{64}$/);
  assert.deepEqual(ownContextCandidates(child,boundary).contexts.map(x=>x.model),['A','B','A']);
  assert.equal(ownContextCandidates(child,boundary).turnEvidenceConflict,false);
  await parent.verify();await child.verify();
}));
for(const variant of ['wrong-parent','wrong-session','later-child','unknown-meta','edited-ancestor'])test(`native lineage rejects ${variant}`,async()=>fixture(async(_r,write,pin)=>{
  const root=meta('root'),parent=await pin(write('root',[root,call(),output()]));
  const own=meta('child','root');if(variant==='wrong-parent')own.payload.parent_thread_id='other';if(variant==='wrong-session')own.payload.session_id='other';
  const later=variant==='later-child'?own:variant==='unknown-meta'?meta('stranger'):variant==='edited-ancestor'?{...root,extra:true}:root;
  const child=await pin(write('child',[own,later,...turns()]));
  assert.throws(()=>{bindNativeChild(parent,child,nativeLaunches(parent,0)[0],0);childOwnedBoundary(child,[parent]);});
}));
for(const variant of ['duplicate-call','duplicate-output','missing-output','output-before-call','path-only','wrong-namespace'])test(`native linkage rejects ${variant}`,async()=>fixture(async(_r,write,pin)=>{
  const c=call(),o=output();if(variant==='wrong-namespace')c.payload.namespace='collaboration';if(variant==='path-only')o.payload.output=JSON.stringify({task_name:'/root/task'});
  const rows=variant==='duplicate-call'?[c,c,o]:variant==='duplicate-output'?[c,o,o]:variant==='missing-output'?[c]:variant==='output-before-call'?[o,c]:[c,o];
  const parent=await pin(write('root',[meta('root'),...rows]));assert.throws(()=>nativeLaunches(parent,0));
}));
for(const variant of ['abort','missing-start','missing-complete','duplicate-context','duplicate-turn'])test(`own turns exclude ${variant} evidence`,async()=>fixture(async(_r,write,pin)=>{
  let rows=turns(['A']);if(variant==='abort')rows[2]={type:'event_msg',payload:{type:'turn_aborted',turn_id:'turn0'}};
  if(variant==='missing-start')rows=rows.slice(1);if(variant==='missing-complete')rows=rows.slice(0,-1);
  if(variant==='duplicate-context')rows.splice(2,0,rows[1]);if(variant==='duplicate-turn')rows.push(...turns(['B']));
  const child=await pin(write('child',[meta('child','root'),...rows]));const result=ownContextCandidates(child,0);
  assert.equal(result.contexts.length,0);assert.equal(result.turnEvidenceConflict,true);
}));
for(const variant of ['append','same-size-edit','replacement','shrink'])test(`same-FD verification rejects ${variant}`,async()=>fixture(async(_r,write,pin)=>{
  const file=write('root',[meta('root')]),source=await pin(file);const before=readFileSync(file);
  if(variant==='append')appendFileSync(file,'{}\n');if(variant==='shrink')writeFileSync(file,'{}\n');
  if(variant==='same-size-edit'){writeFileSync(file,before.toString().replace('cli','bad'));utimesSync(file,new Date(0),new Date(0));}
  if(variant==='replacement'){renameSync(file,file+'.old');writeFileSync(file,before);}
  await assert.rejects(source.verify);
}));
test('symlink, hardlink, partial JSON and invalid UTF8 sources reject',async()=>fixture(async(root,write,_pin)=>{
  const file=write('root',[meta('root')]);symlinkSync(file,path.join(root,'link'));await assert.rejects(openActorSource(root,path.join(root,'link')));
  linkSync(file,path.join(root,'hard'));await assert.rejects(openActorSource(root,file));
  writeFileSync(path.join(root,'fragment'),'{');await assert.rejects(openActorSource(root,path.join(root,'fragment')));
  writeFileSync(path.join(root,'bad'),Buffer.from([0xff,10]));await assert.rejects(openActorSource(root,path.join(root,'bad')));
}));
test('bigint identities retain precision and reject coercion',()=>{
  assert.notEqual(actorStatDecimal(9007199254740992n),actorStatDecimal(9007199254740993n));
  assert.equal(actorStatDecimal(0n),'0');assert.throws(()=>actorStatDecimal(-1n));assert.throws(()=>actorStatDecimal(1 as never));
});
test('fabricated source containers cannot mint native evidence',()=>{
  assert.throws(()=>nativeLaunches({records:[]} as never,0));
});
test('closed descriptor cannot be reused as live pinned evidence',async()=>fixture(async(_r,write,pin)=>{
  const source=await pin(write('root',[meta('root')]));await source.close();await source.close();
  assert.throws(()=>nativeLaunches(source,0));await assert.rejects(source.verify);
}));
test('root replacement and pre-aborted reads fail closed',async()=>fixture(async(root,write,pin)=>{
  const file=write('root',[meta('root')]);const signal=AbortSignal.abort();
  await assert.rejects(openActorSource(root,file,signal));
  const source=await pin(file);renameSync(root,root+'.moved');mkdirSync(root);write('root',[meta('root')]);
  try{await assert.rejects(source.verify);}finally{rmSync(root+'.moved',{recursive:true,force:true});}
}));
for(const mode of ['matched','invalid-role','invalid-model','no-model','missing-role'])test(`resolved bound fields ${mode} preserve independent evidence dimensions`,async()=>fixture(async(_r,write,pin)=>{
  const request={agent_type:'tester' as unknown,model:'B' as unknown};
  if(mode==='invalid-role')request.agent_type=null;
  if(mode==='invalid-model'){request.model=null;request.agent_type='architect';}
  if(mode==='matched')request.model='A';
  const parent=await pin(write('root',[meta('root'),call('call1',request),output()]));
  const own=meta('child','root');if(mode!=='missing-role')Object.assign(own.payload,{agent_role:'tester'});
  const child=await pin(write('child',[own,...(mode==='no-model'?[]:turns())]));
  const result=await resolveNativeActorFields(parent,child,nativeLaunches(parent,0)[0],[]);
  if(mode==='matched'){assert.equal(result.evidence_status,'complete');assert.deepEqual(result.observations.map(x=>x.model),['A','B','A']);}
  if(mode==='invalid-role'){assert.equal(result.evidence_code,'requested_invalid');assert.equal(result.role_mismatch,0);assert.equal(result.model_mismatch,1);}
  if(mode==='invalid-model'){assert.equal(result.evidence_code,'requested_invalid');assert.equal(result.role_mismatch,1);assert.equal(result.model_mismatch,0);}
  if(mode==='no-model'){assert.equal(result.evidence_code,'model_missing');assert.equal(result.model_mismatch,0);}
  if(mode==='missing-role'){assert.equal(result.observed_role,null);assert.equal(result.evidence_code,'model_mismatch');}
  assert.equal('supported' in result,false);
}));
test('invalid completed own model becomes conflict rather than fabricated complete',async()=>fixture(async(_r,write,pin)=>{
  const parent=await pin(write('root',[meta('root'),call(),output()]));const own=meta('child','root');Object.assign(own.payload,{agent_role:'tester'});
  const child=await pin(write('child',[own,...turns(['A\u200B'])]));
  const result=await resolveNativeActorFields(parent,child,nativeLaunches(parent,0)[0],[]);
  assert.equal(result.evidence_code,'turn_evidence_conflict');assert.equal(result.observations.length,0);
}));
for(const bytes of [63999,64000,64001])test(`native output cap ${bytes} applies before child evidence`,async()=>fixture(async(_r,write,pin)=>{
  const row=output();const base='{"agent_id":"child","padding":"';row.payload.output=base+' '.repeat(bytes-Buffer.byteLength(base+'"}'))+'"}';
  const parent=await pin(write('root',[meta('root'),call(),row]));
  if(bytes<=64000)assert.equal(nativeLaunches(parent,0).length,1);else assert.throws(()=>nativeLaunches(parent,0));
}));
