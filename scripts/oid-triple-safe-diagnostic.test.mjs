/** Red-first contract for bounded safe-stop diagnostics; no command authority or state mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import * as capsule from './oid-control-capsule.mjs';
const create=()=>{assert.equal(typeof capsule.createOidTripleSafeDiagnostic,'function');return capsule.createOidTripleSafeDiagnostic();};
test('safe-stop diagnostic retains only explicit reason, exit and signal',()=>{
    const d=create();d.capture('stderr',Buffer.from('sensitive-value-do-not-retain\nError: oid_triple_safe_phase_foreign_process\n    at /secret/path\n'));
    assert.deepEqual(d.summarize(7,null),{schema:'nassaj-oid-safe-stop-diagnostic/v1',exitCode:7,signal:null,reason:'oid_triple_safe_phase_foreign_process'});
});
test('unknown text, path suffix and arbitrary signals never reach the receipt',()=>{
    const d=create();d.capture('stderr',Buffer.from('Error: oid_triple_safe_phase_foreign_process /secret/value\nError: arbitrary-secret\n'));
    assert.deepEqual(d.summarize(null,'secret-signal'),{schema:'nassaj-oid-safe-stop-diagnostic/v1',exitCode:null,signal:null,reason:'unknown'});
});
test('large stderr is drained, while a code after the fixed prefix is not retained',async()=>{
    const d=create();const child=spawn(process.execPath,['-e',"process.stderr.write('x'.repeat(2*1024*1024)+'\\nError: oid_triple_stop_not_intended\\n');"],{stdio:['ignore','pipe','pipe']});
    let bytes=0;child.stdout.on('data',b=>d.capture('stdout',b));child.stderr.on('data',b=>{bytes+=b.length;d.capture('stderr',b);});
    const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    assert.ok(bytes>2*1024*1024);assert.equal(status.code,0);assert.equal(d.summarize(status.code,status.signal).reason,'unknown');
});

test('a cutoff never turns a longer secret-bearing line into an allowed code',()=>{
    const d=create(),line='Error: oid_triple_stop_not_intended';
    d.capture('stderr',Buffer.from('x'.repeat(8192-line.length-1)+'\n'+line+' /private-suffix'));
    assert.equal(d.summarize(7,null).reason,'unknown');
});

test('stage is independent from a closed-list reason; metadata and unknown stay bounded',()=>{
    const d=create();d.capture('stderr',Buffer.from('pair_journal_changed\nOID_TRIPLE_STOP_STAGE:validate_stop_failed\n'));
    assert.equal(d.summarize(7,null).stage,'validate_stop_failed');assert.equal(d.summarize(7,null).reason,'pair_journal_changed');
    assert.equal(capsule.oidTripleSafeDiagnosticReason({code:'EACCES',message:'/secret/path'}),'EACCES');
    assert.equal(capsule.oidTripleSafeDiagnosticReason({message:'oid_pair_counterpart_mismatch'}),'oid_pair_counterpart_mismatch');
    assert.equal(capsule.oidTripleSafeDiagnosticReason({message:'oid_pair_counterpart_mismatch /secret'}),'unknown');
    const unknown=create();unknown.capture('stderr',Buffer.from('unknown\nOID_TRIPLE_STOP_STAGE:native_open_failed\nOID_TRIPLE_STOP_STAGE:secret\n'));
    assert.equal(unknown.summarize(7,null).stage,'native_open_failed');assert.equal(unknown.summarize(7,null).reason,'unknown');
});

test('stage cutoff cannot admit a secret suffix',()=>{
    const d=create(),marker='OID_TRIPLE_STOP_STAGE:options_invalid';
    d.capture('stderr',Buffer.from('x'.repeat(8192-marker.length-1)+'\n'+marker+' private'));
    assert.equal(d.summarize(7,null).stage,undefined);
});
