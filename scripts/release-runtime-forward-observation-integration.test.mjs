import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const project = path.resolve(import.meta.dirname, '..');

test('reconcile facade observes through actual service child before transferring abandoned lock (B899)', t => {
    const sandbox = fs.mkdtempSync(path.join(project, '.artifacts', 'observation-integration-isolation-'));
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
    const launcher = path.join(sandbox, 'isolate');
    const compile = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror',
        path.join(project, 'scripts/fixtures/cold-startup-mount-isolation.c'), '-o', launcher],
    { encoding: 'utf8', env: { ...process.env, TMPDIR: sandbox } });
    assert.equal(compile.status, 0, compile.stderr);
    const entry = path.join(sandbox, 'entry.mjs');
    fs.writeFileSync(entry, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {setupObservationIntegration} from ${JSON.stringify(new URL('./fixtures/forward-observation-integration.fixture.mjs', import.meta.url).href)};
import {forwardValueSha256,inspectForwardChildIdentity} from ${JSON.stringify(new URL('./lib/release-runtime-forward-child-protocol.mjs', import.meta.url).href)};
assert.equal(process.pid,1);
assert.equal(process.cwd(),${JSON.stringify(sandbox)});
assert.notEqual(fs.readlinkSync('/proc/self/ns/mnt'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/mnt'))});
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/net'))});
for(const line of fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n')){
 const fields=line.split(' ');assert.equal(fields[5].split(',').includes('rw'),fields[4]===${JSON.stringify(sandbox)});
}
const status=fs.readFileSync('/proc/self/status','utf8');
for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+field+':\\\\s+0+$','m'));
assert.match(status,/^NoNewPrivs:\\s+1$/m);assert.match(status,/^Seccomp:\\s+2$/m);
for(const scenario of ['success','target-drift','child-crash','expiry-before-permit','wrong-purpose','wrong-nonce','live-owner','revoke-transfer','host-transfer','expiry-transfer','nonce-transfer','database-transfer']){
 test(scenario,async t=>{
  const fixture=await setupObservationIntegration(t,scenario);
  const child=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr+'\\n'+child.stdout);
  const result=JSON.parse(child.stdout);
  assert.equal(result.decision,scenario==='success'?'reconciled':'diagnosis_only');
  assert.equal(result.transfers,scenario==='success'?1:0);
  assert.equal(result.lockPresent,scenario!=='success');
  assert.equal(result.maintenance,true);
  assert.equal(result.acceptedAtPreserved,true);
  if(scenario==='success'){assert.equal(result.observedWrites,1);assert.equal(result.childDeadBeforeTransfer,true);}
 });
}
for(const scenario of ['crash-before-rename','crash-after-rename','interrupted-before-rename','interrupted-after-rename']){
 test(scenario+' explicit re-entry uses kernel-released mutex and fresh observation',async t=>{
  const fixture=await setupObservationIntegration(t,scenario);
  const crashed=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(crashed.status,scenario.startsWith('crash-')?79:0,crashed.stderr+'\\n'+crashed.stdout);
  const journalFile=fixture.control+'/first-cutover.json';
  const journal=JSON.parse(fs.readFileSync(journalFile));
  assert.equal(journal.forwardLockReconciliation.phase,'intent');
  assert.equal(journal.forwardLockReconciliation.eligiblePhase,'migration_observed');
  const oldTombstone=fs.readFileSync(fixture.control+'/'+journal.forwardLockReconciliation.tombstone);
  const resumed=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(resumed.status,0,resumed.stderr+'\\n'+resumed.stdout);
  const result=JSON.parse(resumed.stdout);
  assert.equal(result.decision,'reconciled',resumed.stderr);
  assert.equal(result.maintenance,true);
  assert.deepEqual(fs.readFileSync(fixture.control+'/'+journal.forwardLockReconciliation.tombstone),oldTombstone);
 });
}
for(const scenario of ['repeat-after','repeat-mixed','repeat-drift']){
 test(scenario+' validates every previousIntent back to the original lock',async t=>{
  const fixture=await setupObservationIntegration(t,scenario);
  const attempts=scenario==='repeat-mixed'?4:3;
  const mutex=fixture.control+'/first-cutover-state.flock';let inode;
  for(let n=0;n<attempts;n++){
   const crashed=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
   assert.equal(crashed.status,79,crashed.stderr+'\\n'+crashed.stdout);
   inode??=fs.lstatSync(mutex).ino;assert.equal(fs.lstatSync(mutex).ino,inode);
   let chain=JSON.parse(fs.readFileSync(fixture.control+'/first-cutover.json')).forwardLockReconciliation;
   let count=0;while(chain){count++;chain=chain.previousIntent;}assert.equal(count,n+1);
  }
  const final=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(final.status,0,final.stderr+'\\n'+final.stdout);
  const result=JSON.parse(final.stdout);
  assert.equal(result.decision,scenario==='repeat-drift'?'diagnosis_only':'reconciled',final.stderr);
  assert.equal(result.maintenance,true);assert.equal(fs.lstatSync(mutex).ino,inode);
 });
}
for(const mutation of ['old-tombstone','truncated-chain','replayed-receipt','depth-nine']){
 test('repeated replacement refuses '+mutation,async t=>{
  const fixture=await setupObservationIntegration(t,'repeat-after');
  for(let n=0;n<3;n++){
   const crashed=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
   assert.equal(crashed.status,79,crashed.stderr);
  }
  const file=fixture.control+'/first-cutover.json';const journal=JSON.parse(fs.readFileSync(file));
  let oldest=journal.forwardLockReconciliation;while(oldest.previousIntent)oldest=oldest.previousIntent;
  if(mutation==='old-tombstone')fs.writeFileSync(fixture.control+'/'+oldest.tombstone,'{}');
  if(mutation==='truncated-chain')delete journal.forwardLockReconciliation.previousIntent;
  if(mutation==='replayed-receipt')journal.forwardLockReconciliation.previousIntent.observation=structuredClone(journal.forwardLockReconciliation.observation);
  if(mutation==='depth-nine'){
   let tail=journal.forwardLockReconciliation;
   for(let n=0;n<8;n++){
    tail.previousIntent={...oldest,observation:{nonce:String(n+1).repeat(64),receiptSha256:String(n+1).repeat(64)}};
    delete tail.previousIntent.previousIntent;tail=tail.previousIntent;
   }
  }
  fs.writeFileSync(file,JSON.stringify(journal));const before=fs.readFileSync(fixture.control+'/first-cutover.lock');
  const denied=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(denied.status,0,denied.stderr);const result=JSON.parse(denied.stdout);
  assert.equal(result.decision,'diagnosis_only');assert.equal(result.observedWrites,0);assert.equal(result.transfers,0);
  assert.deepEqual(fs.readFileSync(fixture.control+'/first-cutover.lock'),before);
 });
}
for(const mutation of ['tombstone','nonce','live-pending']){
 test('partial replacement rejects '+mutation,async t=>{
  const fixture=await setupObservationIntegration(t,'interrupted-after-rename');
  const first=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(first.status,0,first.stderr);
  const file=fixture.control+'/first-cutover.json';
  const journal=JSON.parse(fs.readFileSync(file));
  assert.equal(journal.forwardLockReconciliation.phase,'intent');
  if(mutation==='tombstone')fs.writeFileSync(fixture.control+'/'+journal.forwardLockReconciliation.tombstone,'{}');
  if(mutation==='nonce')journal.forwardLockReconciliation.observation.nonce='0'.repeat(64);
  if(mutation==='live-pending'){
   const actual=inspectForwardChildIdentity(process.pid);
   const owner={pid:actual.pid,startTicks:actual.startTicks,bootId:actual.bootId};
   journal.forwardLockReconciliation.operator=owner;
   journal.forwardObservationReconciliation.owner=owner;
   journal.forwardLockReconciliation.observation.receiptSha256=forwardValueSha256(journal.forwardObservationReconciliation);
   fs.writeFileSync(fixture.control+'/first-cutover.lock',JSON.stringify({schema:'nassaj-cutover-lock/v1',pid:owner.pid,startTime:owner.startTicks}));
  }
  fs.writeFileSync(file,JSON.stringify(journal));
  const before=fs.readFileSync(fixture.control+'/first-cutover.lock');
  const second=spawnSync(process.execPath,[fixture.runner],{cwd:fixture.generation,encoding:'utf8',timeout:20000});
  assert.equal(second.status,0,second.stderr);
  const result=JSON.parse(second.stdout);
  assert.equal(result.decision,'diagnosis_only');assert.equal(result.transfers,0);assert.equal(result.observedWrites,0);
  assert.equal(result.maintenance,true);
  assert.deepEqual(fs.readFileSync(fixture.control+'/first-cutover.lock'),before);
 });
}
`);
    const env = { ...process.env, TMPDIR: sandbox, NASSAJ_TEST_TMP: sandbox };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('/usr/bin/unshare', ['--user', '--map-current-user', '--mount', '--net', '--pid',
        '--keep-caps', '--fork', '--kill-child', launcher, fs.readlinkSync('/proc/self/ns/mnt'), sandbox, process.execPath, entry],
    { encoding: 'utf8', timeout:120000, maxBuffer: 4 * 1024 * 1024, env });
    fs.writeFileSync(path.join(project, '.artifacts', 'forward-observation-integration.log'), result.stdout + '\n' + result.stderr);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});
