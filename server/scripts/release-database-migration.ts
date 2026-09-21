import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import { COMPATIBLE_FORWARD_OBSERVATION_POLICY, observeCompatibleForwardDatabase } from '@/modules/database/compatible-forward-observation.js';
import { inspectExistingStartupFiles } from '@/modules/database/existing-startup-files.js';
import { canonicalDatabaseSchemaDigest } from '@/modules/database/canonical-schema-digest.js';
import { migrateConnectorAuthSchema } from '@/modules/database/connector-auth.migration.js';
import { migrateConnectorPolicyV2Substrate } from '@/modules/database/connector-policy-v2.migration.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';
import { migrateCompatibleForwardPermissionReceipt, PERMISSION_RECEIPT_FORWARD_MIGRATION_ID } from '@/modules/database/compatible-forward-permission-receipt.migration.js';

export { COMPATIBLE_FORWARD_OBSERVATION_POLICY, observeCompatibleForwardDatabase } from '@/modules/database/compatible-forward-observation.js';

type Observation = ReturnType<typeof observeCompatibleForwardDatabase>;
type ForwardRequest = {
  schema:'nassaj-compatible-forward-request/v1'; transactionId:string; releaseIdentitySha256:string;
  databaseContractSha256:string; database:{realpath:string; device:string; inode:string}; expectedPhase:'migration';
};
type ForwardContract = {
  schema:'nassaj-database-release-contract/v2'; releaseIdentitySha256:string; source:Observation; target:Observation;
  migrationId:'permission-receipt-forward/v1'; observationPolicy:'permission-receipt-metadata/v1';
  startup:{policyId:'existing-security-state/v1'; closureSha256:string};
};
/** Supplied only by the host verifier; reading a request JSON is not verification. */
export type VerifiedForwardContext = {
  contract:ForwardContract;
  requestSha256:string;
  /** Host verifies the original root-owned intent and approval, not just this field's shape. */
  priorAcceptedIntent?:{requestSha256:string; transactionId:string; databaseContractSha256:string};
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value:unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const exactKeys = (value:unknown, keys:string): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');

function assertForwardRequest(request: ForwardRequest): void {
  if (!exactKeys(request,'schema,transactionId,releaseIdentitySha256,databaseContractSha256,database,expectedPhase')
    || request.schema !== 'nassaj-compatible-forward-request/v1' || request.expectedPhase !== 'migration'
    || !/^[A-Za-z0-9_-]{16,128}$/.test(request.transactionId)
    || !/^[a-f0-9]{64}$/.test(request.releaseIdentitySha256) || !/^[a-f0-9]{64}$/.test(request.databaseContractSha256)
    || !exactKeys(request.database,'realpath,device,inode') || !path.isAbsolute(request.database.realpath)
    || !/^(0|[1-9][0-9]*)$/.test(request.database.device) || !/^[1-9][0-9]*$/.test(request.database.inode)) {
    throw new Error('compatible_forward_request_invalid');
  }
}

/** Observe actual descriptors, never open a second descriptor as a substitute for SQLite's handle. */
function descriptorInventory(): Map<number, fs.BigIntStats> {
  if (process.platform !== 'linux') throw new Error('compatible_forward_descriptor_platform_unsupported');
  const entries = fs.readdirSync('/proc/self/fd');
  const descriptors = new Map<number, fs.BigIntStats>();
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) throw new Error('compatible_forward_descriptor_invalid');
    try { descriptors.set(Number(entry), fs.fstatSync(Number(entry), {bigint:true})); }
    catch (error) {
      // readdir's own descriptor may already be closed. Other failures are not absence.
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  return descriptors;
}
function matchesIdentity(stat:fs.BigIntStats, expected:ForwardRequest['database']): boolean {
  return stat.isFile() && stat.dev.toString() === expected.device && stat.ino.toString() === expected.inode;
}
function assertDatabaseIdentity(expected:ForwardRequest['database'], fd?:number): void {
  if (fs.realpathSync(expected.realpath) !== expected.realpath
    || !matchesIdentity(fs.lstatSync(expected.realpath,{bigint:true}),expected)
    || (fd !== undefined && !matchesIdentity(fs.fstatSync(fd,{bigint:true}),expected))) {
    throw new Error('compatible_forward_database_identity_changed');
  }
}
function sqliteDescriptor(before:Map<number,fs.BigIntStats>, expected:ForwardRequest['database']): number {
  const candidates = [...descriptorInventory()].filter(([fd,metadata]) => !before.has(fd) && matchesIdentity(metadata,expected));
  if (candidates.length !== 1) throw new Error('compatible_forward_descriptor_ambiguous');
  return candidates[0][0];
}

/**
 * Dedicated-child integration seam, not a public CLI. The host must verify the
 * request/contract/closure and durable intent, and inhibit schema/path changers.
 * Descriptor attribution requires no other file-opening threads in this child.
 */
export function runCompatibleForwardMigration(
  request:ForwardRequest, verifyTrustedContext:(request:ForwardRequest) => VerifiedForwardContext,
) {
  assertForwardRequest(request);
  if (typeof verifyTrustedContext !== 'function') throw new Error('compatible_forward_trusted_verifier_required');
  const context = verifyTrustedContext(request);
  const contract = context.contract;
  if (context.requestSha256 !== digest(request) || digest(contract) !== request.databaseContractSha256
    || contract.releaseIdentitySha256 !== request.releaseIdentitySha256
    || contract.schema !== 'nassaj-database-release-contract/v2'
    || contract.migrationId !== PERMISSION_RECEIPT_FORWARD_MIGRATION_ID
    || contract.observationPolicy !== COMPATIBLE_FORWARD_OBSERVATION_POLICY) {
    throw new Error('compatible_forward_verified_context_mismatch');
  }
  assertDatabaseIdentity(request.database);
  const before = descriptorInventory();
  if ([...before.values()].some(stat => matchesIdentity(stat,request.database))) {
    throw new Error('compatible_forward_database_descriptor_preexisting');
  }
  const db = new BetterSqlite3(request.database.realpath,{fileMustExist:true,timeout:0});
  let transaction = false;
  try {
    const fd = sqliteDescriptor(before,request.database);
    assertDatabaseIdentity(request.database,fd);
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    const observedBefore = observeCompatibleForwardDatabase(db);
    let outcome:'applied'|'already_applied';
    if (digest(observedBefore) === digest(contract.source)) {
      migrateCompatibleForwardPermissionReceipt(db);
      outcome = 'applied';
    } else if (digest(observedBefore) === digest(contract.target)) {
      const intent = context.priorAcceptedIntent;
      if (!intent || intent.requestSha256 !== context.requestSha256
        || intent.transactionId !== request.transactionId || intent.databaseContractSha256 !== request.databaseContractSha256) {
        throw new Error('compatible_forward_target_without_original_intent');
      }
      outcome = 'already_applied';
    } else throw new Error('compatible_forward_source_drift');
    const observedAfter = observeCompatibleForwardDatabase(db);
    if (digest(observedAfter) !== digest(contract.target)) throw new Error('compatible_forward_target_drift');
    assertDatabaseIdentity(request.database,fd);
    db.exec('COMMIT'); transaction = false;
    return Object.freeze({schema:'nassaj-compatible-forward-migration-result/v1',transactionId:request.transactionId,
      databaseContractSha256:request.databaseContractSha256,observedBefore,observedAfter,outcome});
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if ((error as {code?:string}).code === 'SQLITE_BUSY') throw new Error('compatible_forward_migration_deferred');
    throw error;
  } finally {db.close();}
}

/** Dedicated service-child observation. This opens read-only and never invokes migration A. */
export function readCompatibleForwardTarget(
  request:ForwardRequest, verifyTrustedContext:(request:ForwardRequest) => VerifiedForwardContext,
) {
  assertForwardRequest(request);
  if (process.geteuid?.() === 0) throw new Error('compatible_forward_observation_root_forbidden');
  const context = verifyTrustedContext(request);
  if (context.requestSha256 !== digest(request) || digest(context.contract) !== request.databaseContractSha256
    || context.contract.releaseIdentitySha256 !== request.releaseIdentitySha256
    || context.contract.schema !== 'nassaj-database-release-contract/v2'
    || context.contract.migrationId !== PERMISSION_RECEIPT_FORWARD_MIGRATION_ID
    || context.contract.observationPolicy !== COMPATIBLE_FORWARD_OBSERVATION_POLICY) {
    throw new Error('compatible_forward_verified_context_mismatch');
  }
  assertDatabaseIdentity(request.database);
  const recheckFiles = inspectExistingStartupFiles(request.database);
  const before = descriptorInventory();
  if ([...before.values()].some(stat => matchesIdentity(stat, request.database))) {
    throw new Error('compatible_forward_database_descriptor_preexisting');
  }
  const db = new BetterSqlite3(request.database.realpath, { readonly:true, fileMustExist:true, timeout:0 });
  try {
    const fd = sqliteDescriptor(before, request.database);
    assertDatabaseIdentity(request.database, fd);
    const observedTarget = observeCompatibleForwardDatabase(db);
    recheckFiles();
    if (digest(observedTarget) !== digest(context.contract.target)) throw new Error('compatible_forward_target_drift');
    assertDatabaseIdentity(request.database, fd);
    return Object.freeze({schema:'nassaj-compatible-forward-target-observation/v1', transactionId:request.transactionId,
      databaseContractSha256:request.databaseContractSha256, database:request.database, observedTarget});
  } finally { db.close(); recheckFiles(); }
}

/** Existing v1 migration CLI; compatible-forward execution is deliberately not wired here. */
function runLegacyMigrationCli(): void {
  const databaseFlag = process.argv.indexOf('--database');
  const databasePath = databaseFlag >= 0 ? process.argv[databaseFlag + 1] : '';
  if (!path.isAbsolute(databasePath) || fs.lstatSync(databasePath).isSymbolicLink()) {
    throw new Error('migration-only database path is unsafe');
  }

  const db = new BetterSqlite3(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    migrateConnectorAuthSchema(db);
    migrateConnectorPolicyV2Substrate(db);
    const integrity = String(db.pragma('integrity_check', { simple: true }));
    const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;
    const targetSchemaDigest = canonicalDatabaseSchemaDigest(db);
    process.stdout.write(`${JSON.stringify({ schema: 'nassaj-migration-only-result/v1', integrity,
      foreignKeyViolations, targetSchemaDigest })}\n`);
  } finally {
    db.close();
  }
 }

/** Recognize only the host runner's fixed retained entry FD; importing another entry stays inert. */
function isPinnedMigrationCliEntry(): boolean {
  if (process.argv[1] !== '/proc/self/fd/5') return false;
  try { return fs.realpathSync('/proc/self/fd/5') === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) || isPinnedMigrationCliEntry())) runLegacyMigrationCli();
