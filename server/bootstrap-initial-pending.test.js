import assert from 'node:assert/strict';
import test from 'node:test';

import {validateInitialStartupPendingResponse} from './bootstrap-startup-context.js';
const expected={uid:1000,pid:42,startTicks:'123',bootId:'12345678-1234-1234-1234-123456789012',challenge:'a'.repeat(64),releaseIdentitySha256:'b'.repeat(64),startupClosureSha256:'c'.repeat(64)};
const response=()=>({...expected,schema:'nassaj-bootstrap-admission-pending/v1',decision:'pending',reason:'initial_process_not_armed',authorityId:'transaction-one',transactionId:'transaction-one',generationEpoch:1,issuedAtBootMs:10000,expiresAtBootMs:40000,retryAfterMs:100,remainingMs:29000});
test('initial consumer fixes window identity and never returns a claim',()=>{
  const first=validateInitialStartupPendingResponse(response(),expected);
  assert.equal(first.expiresAtBootMs,40000);assert.equal(first.claimId,undefined);
  assert.deepEqual(validateInitialStartupPendingResponse({...response(),remainingMs:100},expected,first),first);
});
for(const [field,value] of [['operationId','managed-operation'],['claimId','fake'],['remainingMs',0],['expiresAtBootMs',50000],['generationEpoch',0],['transactionId','other'],['pid',999],['challenge','d'.repeat(64)]]) test(`initial consumer rejects ${field}`,()=>assert.throws(()=>validateInitialStartupPendingResponse({...response(),[field]:value},expected)));
test('initial consumer rejects changed root epoch or refreshed original window',()=>{
 const first=validateInitialStartupPendingResponse(response(),expected);
 for(const fields of [{generationEpoch:2},{issuedAtBootMs:11000,expiresAtBootMs:41000}]) assert.throws(()=>validateInitialStartupPendingResponse({...response(),...fields},expected,first),/pending_changed/);
});
