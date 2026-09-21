import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

import {createBootstrapContextHarness} from '../scripts/fixtures/bootstrap-context-harness.mjs';
import {setupInitialArmFixture} from '../scripts/fixtures/initial-arm-fixture.mjs';
import {installFixedStateMutexAuthority} from '../scripts/fixtures/fixed-state-mutex-authority.mjs';
import {invalidateCutoverStartupAdmission} from '../scripts/lib/release-runtime-cutover.mjs';

for(const variant of ['armed','invalidated','expired','expires-after-pending','wrong-mode','wrong-authority']) test(`actual context initial ${variant}: no application import before root arm`,async t=>{
  const f=createBootstrapContextHarness(t,{simulateInitialOperator:true,offerVariant:variant.startsWith('wrong-')?variant:undefined});
  const go=path.join(f.root,'go'), imported=path.join(f.root,'application-imported');
  const application=path.join(f.root,'application-probe.mjs');
  fs.writeFileSync(application,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(imported)},'imported');`);
  const context=pathToFileURL(path.join(f.releaseRoot,'dist-server/server/bootstrap-startup-context.js')).href;
  const running=f.start(`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
    while(!fs.existsSync(${JSON.stringify(go)}))await delay(5);
    const {establishStartupAdmission,readVerifiedStartupContext}=await import(${JSON.stringify(context)});
    if(readVerifiedStartupContext()!==null)throw Error('premature_context');
    const claim=await establishStartupAdmission();
    await import(${JSON.stringify(pathToFileURL(application).href)});
    process.stdout.write(JSON.stringify({phase:claim.phase,pid:process.pid,claimId:claim.claimId}));`);
  t.after(()=>running.child.kill('SIGKILL'));
  const armed=await setupInitialArmFixture(t,{fixture:f,targetChild:running.child});
  // The root arm and any root transition run under the fixed state mutex, which measures the
  // installed config path: install the authority there, not at the bare fixture default.
  installFixedStateMutexAuthority(t,f.root,f.config,{file:path.join(f.root,'config.json')});
  f.write('config.json',f.config);
  if(variant==='expired'||variant==='expires-after-pending') {
    const journal=f.read('first-cutover.json');const elapsed=variant==='expired'?31000:29000;journal.initialStartWindow.issuedAtBootMs-=elapsed;journal.initialStartWindow.expiresAtBootMs-=elapsed;
    f.write('first-cutover.json',journal);
  }
  const originalWindow=f.read('first-cutover.json').initialStartWindow;
  fs.writeFileSync(go,'go');
  if(variant!=='expired') {
    const marker=path.join(f.root,'initial-pending-observed.json');
    const until=Date.now()+2000;while(!fs.existsSync(marker)&&Date.now()<until)await delay(10);
    assert.ok(fs.existsSync(marker),'actual root pending response absent');
  } else await delay(100);
  assert.equal(fs.existsSync(imported),false);
  assert.equal(f.read('startup-admission.json').offer,null);
  assert.equal(f.read('startup-admission.json').lastClaim,null);
  if(variant==='armed'||variant.startsWith('wrong-')) await armed.arm();
  if(variant==='invalidated') invalidateCutoverStartupAdmission(f.root,'integration_invalidated');
  const result=await running.result;
  assert.deepEqual(f.read('first-cutover.json').initialStartWindow,originalWindow);
  assert.equal(f.read('host-dispatch-state.json').gateActive,true);
  if(variant==='armed') {
    assert.equal(result.code,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).phase,'claimed');
    assert.equal(f.read('first-cutover.json').startupClaim.pid,running.child.pid);
    assert.equal(fs.existsSync(imported),true);
  } else {
    assert.notEqual(result.code,0,result.stderr);
    if(variant.startsWith('wrong-'))assert.match(result.stderr,/root_startup_pending_changed/);
    assert.equal(fs.existsSync(imported),false);
    assert.equal(f.read('startup-admission.json').lastClaim,null);
  }
});
