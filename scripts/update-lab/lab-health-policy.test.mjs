import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {applyLabHealthPolicy,assertFullLabHealthPolicy} from './lab-health-policy.mjs';
import {prepareBridgeBaseline} from './bridge-rehearsal.mjs';
test('full policy rejects inherited shortened knobs; fault policy remains explicit',()=>{
 const fault=applyLabHealthPolicy({},'bridge-fault');assert.equal(fault.NASSAJ_OID_HEALTH_ATTEMPTS,'2');assert.equal(fault.WARM_READY_TIMEOUT_S,'1');assert.throws(()=>assertFullLabHealthPolicy(fault),/mismatch/);
 const full=applyLabHealthPolicy(fault,'full');assert.equal(assertFullLabHealthPolicy(full).attempts,90);assert.throws(()=>assertFullLabHealthPolicy({...full,POST_RESTART_HEALTH_ATTEMPTS:'2'}),/mismatch/);assert.throws(()=>applyLabHealthPolicy({},'typo'),/invalid/);
});
const existing=path.resolve('.artifacts/t1772-bridge-rehearsal/run-xRossV/scenario.json');
test('actual baseline preparation writes matching full or fault policy into .env and ecosystem', {skip:!fs.existsSync(existing)},()=>{
 const baseline=JSON.parse(fs.readFileSync(existing)).baseline;const evidence=[];
 for(const policy of ['full','bridge-fault']){
  const {lab}=prepareBridgeBaseline(baseline,{healthPolicy:policy});
  const config=JSON.parse(fs.readFileSync(path.join(lab,'ecosystem.config.cjs'),'utf8').replace(/^module.exports=/,'').replace(/;\s*$/,''));
  const env=Object.fromEntries(fs.readFileSync(path.join(lab,'app/.env'),'utf8').trim().split('\n').map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  const keys=['NASSAJ_OID_HEALTH_ATTEMPTS','NASSAJ_OID_HEALTH_INTERVAL_MS','WARM_READY_TIMEOUT_S','POST_RESTART_HEALTH_ATTEMPTS','POST_RESTART_HEALTH_INTERVAL_S'];
  for(const key of keys)assert.equal(env[key],config.apps[0].env[key]);
  if(policy==='full'){assertFullLabHealthPolicy(env);assertFullLabHealthPolicy(config.apps[0].env);}else{assert.equal(env.NASSAJ_OID_HEALTH_ATTEMPTS,'2');assert.equal(env.NASSAJ_OID_HEALTH_INTERVAL_MS,'250');assert.equal(env.WARM_READY_TIMEOUT_S,'1');}
  evidence.push({lab,policy,keys:Object.fromEntries(keys.map(key=>[key,env[key]??null]))});
 }
 fs.writeFileSync('.artifacts/t1772-full-health-config-proof.json',JSON.stringify(evidence,null,2));
});
