import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './fixtures/startup-admission-fixture.mjs';
import {invalidateCutoverStartupAdmission} from './lib/release-runtime-cutover.mjs';
function pending(f) {
  const journal=f.read('first-cutover.json'); delete journal.initialTargetProcess;
  journal.phase='target_start_intent';journal.startupClaim={state:'awaiting_process'};f.write('first-cutover.json',journal);
  const state=f.read('startup-admission.json');delete state.initialTargetProcessSha256;f.write('startup-admission.json',state);
}
test('actual initial pending is read-only and fixed boot expiry cannot be renewed',t=>{
  const f=fixture(t,'cutover');pending(f);
  const before=['startup-admission.json','first-cutover.json'].map(f.read);
  const first=f.call(f.request());assert.equal(first.reason,'initial_process_not_armed');assert.equal(first.remainingMs,29000);
  assert.equal(first.offerId,undefined);assert.equal(first.claimId,undefined);
  f.deps.bootMs=()=>38000;const next=f.call(f.request());assert.equal(next.remainingMs,1000);
  assert.equal(next.expiresAtBootMs,first.expiresAtBootMs);
  assert.deepEqual(['startup-admission.json','first-cutover.json'].map(f.read),before);
  f.deps.bootMs=()=>39000;assert.throws(()=>f.call(f.request()),/initial_window_invalid/);
});
for(const variant of ['pid','start','epoch','receipt','partial','gate','reboot','expiry','invalidator','gid','groups','operator','slot','intent']) test(`actual consume rejects ${variant}`,t=>{
  const f=fixture(t,'cutover');const offer=f.call(f.request());
  if(variant==='pid') f.caller.pid++;
  if(variant==='start') f.caller.startTicks='999';
  if(variant==='reboot') f.caller.bootId='22345678-1234-1234-1234-123456789012';
  if(variant==='expiry') f.deps.bootMs=()=>39000;
  if(variant==='invalidator') invalidateCutoverStartupAdmission(f.root,'fixture_actual_invalidation');
  if(variant==='epoch'||variant==='partial') {const state=f.read('startup-admission.json');if(variant==='epoch')state.generationEpoch++;else delete state.initialTargetProcessSha256;f.write('startup-admission.json',state);}
  if(variant==='operator'){const original=f.deps.inspectProcess;f.deps.inspectProcess=pid=>pid===43?{...original(pid),startTicks:'changed'}:original(pid);}
  if(variant==='slot'||variant==='intent'){const journal=f.read('first-cutover.json');if(variant==='slot')journal.targetSlotBinding.allocatedPmId++;else journal.forwardSupervisorAttempts[0].steps[0].intent.requestId='d'.repeat(32);f.write('first-cutover.json',journal);}
  if(variant==='receipt'){const journal=f.read('first-cutover.json');journal.initialTargetProcess.process.pid++;f.write('first-cutover.json',journal);}
  if(variant==='gate'){const host=f.read('host-dispatch-state.json');host.gateActive=false;f.write('host-dispatch-state.json',host);}
  if(['gid','groups'].includes(variant)){const inspect=f.deps.inspectProcess;f.deps.inspectProcess=pid=>{const actual=inspect(pid);return pid===43?actual:{...actual,...(variant==='gid'?{gids:[0,0,0,0]}:{supplementaryGids:[999]})};};}
  assert.throws(()=>f.call(f.consume(offer)));
  assert.equal(f.read('first-cutover.json').startupClaim.state,'pending');
});
test('armed actual caller consumes hashes and fixed deadline; unrelated PID cannot reserve offer',t=>{
  const f=fixture(t,'cutover');f.caller.pid=999;assert.throws(()=>f.call(f.request()),/initial_caller_changed/);
  assert.equal(f.read('startup-admission.json').offer,null);f.caller.pid=42;
  const offer=f.call(f.request());assert.equal(offer.expiresAtBootMs,39000);
  const claim=f.call(f.consume(offer));assert.equal(claim.initialTargetProcessSha256,offer.initialTargetProcessSha256);
  assert.equal(claim.startIntentSha256,offer.startIntentSha256);
  f.deps.bootMs=()=>100000;assert.equal(f.phase('security').decision,'security_startup_authorized');
});
test('expiry during second identity observation denies before persistence',t=>{
  const f=fixture(t,'cutover');let calls=0;f.deps.bootMs=()=>++calls<3?10000:39000;
  assert.throws(()=>f.call(f.request()),/initial_window_invalid/);
  assert.equal(f.read('startup-admission.json').offer,null);
});
