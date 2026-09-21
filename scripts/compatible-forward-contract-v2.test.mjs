import test from 'node:test';
import assert from 'node:assert/strict';
import {createForwardDatabaseContract, FORWARD_PROFILE_ID} from './lib/compatible-forward-release-profile.mjs';
import {validateCompatibleForwardDatabaseContract} from './lib/update-release-asset.mjs';
const hash = c => c.repeat(64);
function contract() { return createForwardDatabaseContract({releaseIdentitySha256:hash('a'),migrationEntrySha256:hash('b'),migrationClosure:{sha256:hash('c')},startupClosureSha256:hash('d'),observation:{source:{schemaDigest:hash('1'),compatibilityShapeDigest:hash('2'),migrationStateDigest:hash('3')},target:{schemaDigest:hash('4'),compatibilityShapeDigest:hash('5'),migrationStateDigest:hash('6')}}}); }
test('v2 profile and finite migration IDs are bound together; no nonce-only alias',()=>{
 assert.equal(FORWARD_PROFILE_ID,'local-forward-349/v2');
 const value=contract();assert.equal(value.migrationId,'permission-receipt-forward/v1');assert.equal(value.observationPolicy,'permission-receipt-metadata/v1');
 assert.equal(validateCompatibleForwardDatabaseContract(value,hash('a'),hash('d')).migrationId,value.migrationId);
 for(const change of [{migrationId:'pending-server-action-attempt-nonce/v1'},{observationPolicy:'nonce-metadata-presence/v1'},{migrationId:'future'},{observationPolicy:'future'}]){
  assert.throws(()=>validateCompatibleForwardDatabaseContract({...value,...change},hash('a'),hash('d')),/database_release_contract_invalid/);
 }
});
