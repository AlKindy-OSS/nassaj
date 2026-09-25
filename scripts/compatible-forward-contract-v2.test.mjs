import test from 'node:test';
import assert from 'node:assert/strict';
import {createForwardDatabaseContract, FORWARD_PROFILE_ID} from './lib/compatible-forward-release-profile.mjs';
import {
 classifyForwardDatabaseContractArtifact, validateCompatibleForwardDatabaseContract,
 validateForwardDatabaseContractArtifact,
} from './lib/update-release-asset.mjs';
import {collectUpdateRuntimeClosure} from './lib/update-runtime-bundle.mjs';
import {validateDatabaseReleaseContract} from './lib/release-database-contract.mjs';
import {
 canonicalReleaseSchemaJson, computeReleaseSchemaTransitionId, COMPOSITE_DATABASE_MIGRATION_ID,
 COMPOSITE_DATABASE_OBSERVATION_POLICY, RELEASE_SCHEMA_PLAN, RELEASE_SCHEMA_TRANSITIONS,
} from './lib/release-schema-contract.mjs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const hash = c => c.repeat(64);
const sha = value => createHash('sha256').update(canonicalReleaseSchemaJson(value)).digest('hex');
function contract() { return createForwardDatabaseContract({releaseIdentitySha256:hash('a'),migrationEntrySha256:hash('b'),migrationClosure:{sha256:hash('c')},startupClosureSha256:hash('d'),observation:{source:{schemaDigest:hash('1'),compatibilityShapeDigest:hash('2'),migrationStateDigest:hash('3')},target:{schemaDigest:hash('4'),compatibilityShapeDigest:hash('5'),migrationStateDigest:hash('6')}}}); }
test('v2 profile and finite migration IDs are bound together; no nonce-only alias',()=>{
 assert.equal(FORWARD_PROFILE_ID,'local-forward-349/v2');
 const value=contract();assert.equal(value.migrationId,'permission-receipt-forward/v1');assert.equal(value.observationPolicy,'permission-receipt-metadata/v1');
 assert.equal(validateCompatibleForwardDatabaseContract(value,hash('a'),hash('d')).migrationId,value.migrationId);
 for(const change of [{migrationId:'pending-server-action-attempt-nonce/v1'},{observationPolicy:'nonce-metadata-presence/v1'},{migrationId:'future'},{observationPolicy:'future'}]){
  assert.throws(()=>validateCompatibleForwardDatabaseContract({...value,...change},hash('a'),hash('d')),/database_release_contract_invalid/);
 }
});

function compositeContract() {
 const schemaPlan={schema:RELEASE_SCHEMA_PLAN,components:[{componentId:'permission-receipt',version:1,order:0,
  dependencies:[],implementationSha256:hash('1'),ddlManifestSha256:hash('2'),sourceStateDigests:[hash('3')],targetStateDigest:hash('4')}]};
 const schemaPlanSha256=sha(schemaPlan),source={schemaDigest:hash('5'),compatibilityShapeDigest:hash('6'),migrationStateDigest:hash('7')};
 const target={schemaDigest:hash('8'),compatibilityShapeDigest:hash('9'),migrationStateDigest:hash('a')};
 const pair={transitionId:computeReleaseSchemaTransitionId(schemaPlanSha256,source,target),source,target};
 const schemaTransitions={schema:RELEASE_SCHEMA_TRANSITIONS,pairs:[pair]};
 return {schema:'nassaj-database-release-contract/v2',releaseIdentitySha256:hash('b'),migrationEntrySha256:hash('c'),
  migrationClosureSha256:hash('d'),migrationClosure:{schema:'nassaj-database-migration-closure/v2',assetManifestBound:true,sha256:hash('d')},
  activationPolicy:'compatible-forward',failurePolicy:'maintenance-preserve-current-db',databasePolicy:'existing-inode-no-restore',
  migrationId:COMPOSITE_DATABASE_MIGRATION_ID,observationPolicy:COMPOSITE_DATABASE_OBSERVATION_POLICY,
  schemaPlan,schemaPlanSha256,schemaTransitions,schemaTransitionsSha256:sha(schemaTransitions),
  startup:{policyId:'existing-security-state/v1',closureSha256:hash('e')}};
}

test('composite contract is immutable artifact material but remains unsupported by activation consumers',()=>{
 const value=compositeContract();
 const validated=validateForwardDatabaseContractArtifact(value,hash('b'),hash('e'));
 const classification=classifyForwardDatabaseContractArtifact(value,hash('b'),hash('e'));
 assert.deepEqual({kind:classification.kind,activation:classification.activation},
  {kind:'composite-release-schema-v2',activation:'unsupported'});
 assert.equal(validated.schemaPlanSha256,value.schemaPlanSha256);
 assert.equal(Object.isFrozen(validated.schemaPlan.components[0]),true);
 assert.throws(()=>validateCompatibleForwardDatabaseContract(value,hash('b'),hash('e')),/database_release_contract_invalid/);
 assert.throws(()=>validateDatabaseReleaseContract({databaseContract:value},hash('b'),hash('e')),/database_release_contract_invalid/);
});

test('composite artifact validation rejects hash, transition and legacy-envelope mutation',()=>{
 const value=compositeContract();
 for(const changed of [
  {...value,schemaPlanSha256:hash('f')},
  {...value,schemaTransitionsSha256:hash('f')},
  {...value,schemaTransitions:{...value.schemaTransitions,pairs:[{...value.schemaTransitions.pairs[0],transitionId:hash('f')}]}},
  {...value,source:value.schemaTransitions.pairs[0].source},
  {...value,migrationId:'permission-receipt-forward/v1'},
 ]) assert.throws(()=>validateForwardDatabaseContractArtifact(changed,hash('b'),hash('e')));
 const legacy=contract();
 assert.deepEqual({kind:classifyForwardDatabaseContractArtifact(legacy,hash('a'),hash('d')).kind,
  activation:classifyForwardDatabaseContractArtifact(legacy,hash('a'),hash('d')).activation},
 {kind:'sealed-permission-receipt-v1',activation:'supported'});
 assert.deepEqual(validateForwardDatabaseContractArtifact(legacy,hash('a'),hash('d')),validateCompatibleForwardDatabaseContract(legacy,hash('a'),hash('d')));
 assert.throws(()=>validateCompatibleForwardDatabaseContract({...legacy,schemaPlan:value.schemaPlan},hash('a'),hash('d')),/database_release_contract_invalid/);
 assert.throws(()=>validateForwardDatabaseContractArtifact({...legacy,migrationId:COMPOSITE_DATABASE_MIGRATION_ID},hash('a'),hash('d')),
  /release_schema_database_contract_invalid/);
});

test('immutable update-runtime closure carries the shared validator beside its consumer',()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const closure=collectUpdateRuntimeClosure(root);
 assert.equal(closure.includes('scripts/lib/update-release-asset.mjs'),true);
 assert.equal(closure.includes('scripts/lib/release-schema-contract.mjs'),true);
});
