import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalEvidenceJson, evidenceContractHash, R3_RESOLVER_MANIFEST, R3_RESOLVER_MANIFEST_SHA256,
  validEvidenceModel, validEvidenceRole } from '../../../../shared/r3-evidence-lexical.js';

import { assertParserContract, resolveContextModel, resolveObservedRole, resolveRequestEvidence, strictEvidenceObject, R3_PARSER_CONTRACT, R3_PARSER_CONTRACT_SHA256 } from './codex-actor-resolvers.js';

test('exact accepted manifest digest and v3 payload binding',()=>{
  assert.equal(evidenceContractHash(R3_RESOLVER_MANIFEST),R3_RESOLVER_MANIFEST_SHA256);
  assert.equal(R3_RESOLVER_MANIFEST_SHA256,'4938b4cc9cbb984e039470e29b0a9bac46d43091a91d97d06219b4df09f9874b');
  assert.doesNotThrow(assertParserContract);assert.equal(R3_PARSER_CONTRACT.schema,'nassaj-r3-parser-contract/v3');
  const changed=JSON.parse(JSON.stringify(R3_PARSER_CONTRACT));changed.nativePayloadCaps.spawnArgumentsUtf8Bytes=65536;
  assert.notEqual(evidenceContractHash(changed),R3_PARSER_CONTRACT_SHA256);
  assert.equal(canonicalEvidenceJson({b:2,a:1}),canonicalEvidenceJson({a:1,b:2}));
  for(const value of [undefined,NaN,Infinity,1.1])assert.throws(()=>canonicalEvidenceJson(value));
});
test('ASCII role grammar exact bounds no trim or catalog',()=>{
  for(const v of ['A','a','BrandNew_Unlisted-9','A'.repeat(128)])assert.equal(validEvidenceRole(v),true);
  for(const v of ['',null,'1a',' A','A ','a.b','é','A'.repeat(129)])assert.equal(validEvidenceRole(v),false);
});
test('opaque models preserve exact scalars including decomposed forms',()=>{
  for(const v of ['A','brand-new model','é'.repeat(64),'e\u0301','🧵'.repeat(32)])assert.equal(validEvidenceModel(v),true);
  for(const v of ['',null,'é'.repeat(64)+'x','\uD800','\uDC00'])assert.equal(validEvidenceModel(v),false);
  assert.notEqual(resolveRequestEvidence('{"model":"e\\u0301"}').requestedModel,resolveRequestEvidence('{"model":"é"}').requestedModel);
});
test('every frozen forbidden range boundary rejects without runtime Unicode tables',()=>{
  const policy=R3_RESOLVER_MANIFEST.modelForbiddenScalars;
  const ranges=[...policy.Cc,...policy.Cf,...policy.bidiControls,...policy.lineAndParagraphSeparators,...policy.noncharacters]
    .map(s=>{const [a,b=a]=s.split('-').map(x=>parseInt(x.slice(2),16));return [a,b];});
  for(const [a,b] of ranges)for(const cp of [a,b]){
    const value=String.fromCodePoint(cp);assert.equal(validEvidenceModel(value),false,cp.toString(16));
    assert.equal(resolveRequestEvidence(JSON.stringify({model:value})).invalidModel,true);
    assert.equal(resolveRequestEvidence('{"model":"'+[...value].map(c=>{const p=c.codePointAt(0)!;return p<=65535?'\\u'+p.toString(16).padStart(4,'0'):c;}).join('')+'"}').invalidModel,true);
  }
  for(const [a,b] of ranges)for(const cp of [a-1,b+1])if(cp>=0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)&&!ranges.some(([lo,hi])=>cp>=lo&&cp<=hi))assert.equal(validEvidenceModel(String.fromCodePoint(cp)),true,cp.toString(16));
});
test('absent, null, aliases and independent invalid dimensions remain distinct',()=>{
  const absent=resolveRequestEvidence('{"role":"tester","model_id":"x","reasoningEffort":"high"}');
  assert.deepEqual(absent,{requestedRole:null,requestedModel:null,requestedReasoningEffort:null,invalidRole:false,invalidModel:false,invalidEffort:false});
  const invalid=resolveRequestEvidence('{"agent_type":null,"model":"new-model","reasoning_effort":"HIGH"}');
  assert.equal(invalid.invalidRole,true);assert.equal(invalid.requestedModel,'new-model');assert.equal(invalid.requestedReasoningEffort,'high');
});
for(const member of ['agent_type','model','reasoning_effort'])test(`literal/escaped duplicate ${member} rejects`,()=>{
  for(const second of [member,'\\u'+member.charCodeAt(0).toString(16).padStart(4,'0')+member.slice(1)]){
    const raw='{"'+member+'":"A","'+second+'":"B"}';
    assert.throws(()=>strictEvidenceObject(raw,64000,[member]));assert.equal(resolveRequestEvidence(raw).invalidRole,true);
  }
});
test('reasoning exact ASCII mapping',()=>{
  for(const [input,output] of [['minimal','minimal'],['LOW','low'],['medium','medium'],['high','high'],['xhigh','xhigh'],['MAX','xhigh'],['ultracode','xhigh'],['none',null]]){
    const r=resolveRequestEvidence(JSON.stringify({reasoning_effort:input}));assert.equal(r.requestedReasoningEffort,output);assert.equal(r.invalidEffort,false);
  }
  for(const input of [null,1,' max','ultra','hİgh'])assert.equal(resolveRequestEvidence(JSON.stringify({reasoning_effort:input})).invalidEffort,true);
});
test('loaded role uses only exact agreeing child metadata fields',()=>{
  const raw=(a:unknown,b:unknown)=>JSON.stringify({type:'session_meta',payload:{agent_role:a,source:{subagent:{thread_spawn:{agent_role:b}}},task_name:'tester'}});
  assert.deepEqual(resolveObservedRole(raw('tester','tester')),{role:'tester',invalid:false});
  assert.deepEqual(resolveObservedRole(raw('tester','Tester')),{role:null,invalid:true});
  assert.deepEqual(resolveObservedRole('{"type":"session_meta","payload":{"task_name":"tester","nickname":"qa-critic"}}'),{role:null,invalid:false});
  assert.equal(resolveObservedRole('{"type":"session_meta","payload":{"agent_role":"A","agent_\\u0072ole":"B"}}').invalid,true);
  assert.equal(resolveContextModel('{"type":"turn_context","payload":{"model":"A","mo\\u0064el":"B"}}'),null);
});
for(const bytes of [63999,64000,64001])test(`arguments/output exact ${bytes} decimal UTF8 byte gate`,()=>{
  for(const key of ['model','agent_id']){
    const prefix='{"'+key+'":"A","padding":"';const suffix='"}';
    const text=prefix+' '.repeat(bytes-Buffer.byteLength(prefix+suffix))+suffix;
    assert.equal(Buffer.byteLength(text),bytes);
    if(bytes<=64000)assert.doesNotThrow(()=>strictEvidenceObject(text,64000,[key]));else assert.throws(()=>strictEvidenceObject(text,64000,[key]));
    if(key==='model')assert.equal(resolveRequestEvidence(text).invalidModel,bytes>64000);
  }
});
