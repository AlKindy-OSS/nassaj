import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

export const PLATFORM_FEATURES = ['deletion', 'credential_scope', 'outcomes'] as const;
export type PlatformFeature = typeof PLATFORM_FEATURES[number];
export type ProtocolFloor = ReadonlyArray<{ feature: PlatformFeature; protocolVersion: number; minimumBuild: string }>;
export type VerifiedBuild = Readonly<{ buildId: string; supports: Readonly<Record<PlatformFeature, readonly number[]>> }>;
export const PLATFORM_UDF = Object.freeze({ name: 'nassaj_platform_supports', arity: 2, owner: 'platform', contract: 1 });
export const PLATFORM_UDFS = Object.freeze([
  PLATFORM_UDF,
  ...[
    { name: 'nassaj_platform_business_writes_allowed', arity: 0 },
    { name: 'nassaj_platform_installing', arity: 3 },
    { name: 'nassaj_platform_upgrading', arity: 6 },
    { name: 'nassaj_platform_receipt_matches', arity: 9 },
  ].map(entry => Object.freeze({ ...entry, owner: 'platform', contract: 1 })),
]);
const registered = new WeakMap<Database.Database, string>();
const transitions = new WeakMap<Database.Database, { binding: RecoveryBinding; target: ProtocolFloor; previous: ProtocolFloor }>();

/** Copy a descriptor only after the caller's sealed-build verifier accepted it. No version ordering. */
export function registerPlatformProtocol(db: Database.Database, descriptor: VerifiedBuild): void {
  if (registered.has(db) || !descriptor.buildId) throw new Error('PLATFORM_REGISTRY_INVALID');
  const supported = new Map<string, Set<number>>();
  for (const feature of PLATFORM_FEATURES) {
    const versions = descriptor.supports[feature];
    if (!Array.isArray(versions) || versions.some(v => !Number.isSafeInteger(v) || v < 1)) {
      throw new Error('PLATFORM_DESCRIPTOR_INVALID');
    }
    supported.set(feature, new Set(versions));
  }
  db.function(PLATFORM_UDF.name, (feature: unknown, version: unknown) =>
    typeof feature === 'string' && typeof version === 'number' && supported.get(feature)?.has(version) ? 1 : 0);
  db.function('nassaj_platform_business_writes_allowed', () => transitions.has(db) ? 0 : 1);
  db.function('nassaj_platform_installing', (feature: unknown, version: unknown, minimumBuild: unknown) => {
    const context = transitions.get(db);
    return db.inTransaction && context?.target.some(row => row.feature === feature && row.protocolVersion === version && row.minimumBuild === minimumBuild) ? 1 : 0;
  });
  db.function('nassaj_platform_upgrading', (oldFeature: unknown, oldVersion: unknown, oldBuild: unknown, feature: unknown, version: unknown, minimumBuild: unknown) => {
    const context = transitions.get(db);
    return db.inTransaction && oldFeature === feature && typeof version === 'number' && typeof oldVersion === 'number' && version > oldVersion &&
      context?.previous.some(row => row.feature === oldFeature && row.protocolVersion === oldVersion && row.minimumBuild === oldBuild) &&
      context.target.some(row => row.feature === feature && row.protocolVersion === version && row.minimumBuild === minimumBuild) ? 1 : 0;
  });
  db.function('nassaj_platform_receipt_matches', (operationId: unknown, databaseId: unknown, restoreEpoch: unknown, fileIdentity: unknown, approvedPath: unknown, toolBuild: unknown, previousHash: unknown, targetHash: unknown, guardHash: unknown) => {
    const binding = transitions.get(db)?.binding;
    return db.inTransaction && binding && JSON.stringify([operationId,databaseId,restoreEpoch,fileIdentity,approvedPath,toolBuild,previousHash,targetHash,guardHash]) === JSON.stringify(receiptTuple(binding)) ? 1 : 0;
  });
  registered.set(db, descriptor.buildId);
}

/** All installed feature contracts must be explicit members of the verified build set. */
export function assertPlatformSupport(db: Database.Database, floor: ProtocolFloor): void {
  const supports = db.prepare('SELECT nassaj_platform_supports(?, ?) AS supported');
  const seen = new Set<string>();
  for (const row of floor) {
    if (seen.has(row.feature) || !row.minimumBuild || (supports.get(row.feature, row.protocolVersion) as { supported: number }).supported !== 1) {
      throw new Error('PLATFORM_FLOOR_UNSUPPORTED');
    }
    seen.add(row.feature);
  }
}

export type DatabaseIdentity = Readonly<{ databaseId: string; restoreEpoch: string; fileIdentity: string; approvedPath: string }>;
export type RecoveryBinding = Readonly<{
  operationId: string; database: DatabaseIdentity; toolBuild: string;
  previousFloorHash: string; targetFloorHash: string; guardHash: string;
}>;

/** Validate journal bindings only; this grants no write authority and performs no recovery. */
export function assertRecoveryBinding(actual: RecoveryBinding, expected: RecoveryBinding): void {
  const fields = ['operationId', 'toolBuild', 'previousFloorHash', 'targetFloorHash', 'guardHash'] as const;
  const identity = ['databaseId', 'restoreEpoch', 'fileIdentity', 'approvedPath'] as const;
  if (fields.some(k => !actual[k] || actual[k] !== expected[k]) ||
      identity.some(k => !actual.database[k] || actual.database[k] !== expected.database[k])) {
    throw new Error('PLATFORM_RECOVERY_IDENTITY_MISMATCH');
  }
}

/** Canonical tuples make comparison independent of JSON object insertion order. */
export function canonicalFloorTuples(floor: ProtocolFloor): readonly (readonly [PlatformFeature, number, string])[] {
  const seen = new Set<PlatformFeature>();
  const tuples = floor.map(row => {
    if (!PLATFORM_FEATURES.includes(row.feature) || !Number.isSafeInteger(row.protocolVersion) || row.protocolVersion < 1 ||
        typeof row.minimumBuild !== 'string' || !row.minimumBuild || seen.has(row.feature)) throw new Error('PLATFORM_FLOOR_INVALID');
    seen.add(row.feature);
    return [row.feature, row.protocolVersion, row.minimumBuild] as const;
  });
  return tuples.sort((a,b) => a[0].localeCompare(b[0]));
}

/** Hash the validated canonical floor used by journal admission and DB readback. */
export function protocolFloorHash(floor: ProtocolFloor): string {
  return createHash('sha256').update(JSON.stringify(canonicalFloorTuples(floor))).digest('hex');
}

/** Ordinary application admission never chooses the lower side of inconsistent floors. */
export function assertPlatformAdmission(db: Database.Database, databaseFloor: ProtocolFloor, hostFloor: ProtocolFloor): void {
  assertPlatformSupport(db,databaseFloor); assertPlatformSupport(db,hostFloor);
  if (protocolFloorHash(databaseFloor)!==protocolFloorHash(hostFloor)) throw new Error('PLATFORM_BOOTSTRAP_REQUIRED');
}

export type LockedRecoveryInput = {
  journal: RecoveryBinding; expected: RecoveryBinding; previousFloor: ProtocolFloor; targetFloor: ProtocolFloor;
  assertWriterLockHeld: () => void; listenerRunning: boolean; schedulerRunning: boolean; providerRunning: boolean;
};

/** Narrow recovery admission binds actual floor hashes and preserves every previously installed contract. */
export function assertLockedRecovery(db: Database.Database, input: LockedRecoveryInput): void {
  input.assertWriterLockHeld();
  if (input.listenerRunning || input.schedulerRunning || input.providerRunning) throw new Error('PLATFORM_RECOVERY_RUNTIME_ACTIVE');
  assertRecoveryBinding(input.journal,input.expected);
  if (registered.get(db) !== input.journal.toolBuild) throw new Error('PLATFORM_RECOVERY_TOOL_MISMATCH');
  assertPlatformSupport(db,input.previousFloor); assertPlatformSupport(db,input.targetFloor);
  if (protocolFloorHash(input.previousFloor)!==input.journal.previousFloorHash || protocolFloorHash(input.targetFloor)!==input.journal.targetFloorHash) {
    throw new Error('PLATFORM_RECOVERY_FLOOR_HASH_MISMATCH');
  }
  const target = new Map(canonicalFloorTuples(input.targetFloor).map(row => [row[0], row]));
  for (const previous of canonicalFloorTuples(input.previousFloor)) {
    const next = target.get(previous[0]);
    if (!next || next[1] < previous[1] || (next[1] === previous[1] && next[2] !== previous[2])) throw new Error('PLATFORM_RECOVERY_DOWNGRADE');
  }
}

function receiptTuple(binding: RecoveryBinding): readonly string[] {
  return [binding.operationId,binding.database.databaseId,binding.database.restoreEpoch,binding.database.fileIdentity,
    binding.database.approvedPath,binding.toolBuild,binding.previousFloorHash,binding.targetFloorHash,binding.guardHash];
}

function readDatabaseFloor(db: Database.Database): ProtocolFloor {
  return db.prepare('SELECT feature, protocol_version AS protocolVersion, minimum_build AS minimumBuild FROM platform_protocol_marker').all() as ProtocolFloor;
}

function assertTransitionReceipt(db: Database.Database, binding: RecoveryBinding): void {
  const receipt = db.prepare(`SELECT operation_id, database_id, restore_epoch, file_identity, approved_path,
    tool_build, previous_floor_hash, target_floor_hash, guard_hash FROM platform_activation_receipts WHERE operation_id=?`).get(binding.operationId) as Record<string,string> | undefined;
  if (!receipt || JSON.stringify(Object.values(receipt)) !== JSON.stringify(receiptTuple(binding))) throw new Error('PLATFORM_RECOVERY_RECEIPT_REQUIRED');
}

/** Private bootstrap-only SQL capability; no journal/fsync or live installer is supplied by S1a. */
export function withPlatformTransition<T>(db: Database.Database, input: LockedRecoveryInput, work: () => T): T {
  assertLockedRecovery(db,input);
  if (db.inTransaction || transitions.has(db)) throw new Error('PLATFORM_TRANSITION_NESTED');
  const binding = structuredClone(input.journal);
  const target = structuredClone(input.targetFloor);
  const previous = structuredClone(input.previousFloor);
  try {
    return db.transaction(() => {
      input.assertWriterLockHeld();
      const currentHash = protocolFloorHash(readDatabaseFloor(db));
      if (currentHash !== binding.previousFloorHash && currentHash !== binding.targetFloorHash) throw new Error('PLATFORM_RECOVERY_DB_FLOOR_MISMATCH');
      if (currentHash === binding.targetFloorHash) assertTransitionReceipt(db,binding);
      transitions.set(db,{ binding, target, previous });
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('PLATFORM_TRANSITION_ASYNC');
      input.assertWriterLockHeld();
      if (protocolFloorHash(readDatabaseFloor(db)) !== binding.targetFloorHash) throw new Error('PLATFORM_RECOVERY_TARGET_INCOMPLETE');
      assertTransitionReceipt(db,binding);
      return result;
    }).immediate();
  } finally { transitions.delete(db); }
}

/** Shared platform guards are installed independently of every feature flag. No deletion-owned floor protection. */
export const PLATFORM_PROTOCOL_GUARDS_SQL = `
CREATE TRIGGER nassaj_platform_marker_insert BEFORE INSERT ON platform_protocol_marker BEGIN
 SELECT CASE WHEN nassaj_platform_installing(NEW.feature,NEW.protocol_version,NEW.minimum_build)!=1 OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature=NEW.feature) THEN RAISE(ABORT,'PLATFORM_MARKER_IMMUTABLE') END;
END;
CREATE TRIGGER nassaj_platform_marker_update BEFORE UPDATE ON platform_protocol_marker BEGIN
 SELECT CASE WHEN nassaj_platform_upgrading(OLD.feature,OLD.protocol_version,OLD.minimum_build,NEW.feature,NEW.protocol_version,NEW.minimum_build)!=1 THEN RAISE(ABORT,'PLATFORM_MARKER_IMMUTABLE') END;
END;
CREATE TRIGGER nassaj_platform_marker_delete BEFORE DELETE ON platform_protocol_marker BEGIN
 SELECT RAISE(ABORT,'PLATFORM_MARKER_IMMUTABLE');
END;
CREATE TRIGGER nassaj_platform_receipt_insert BEFORE INSERT ON platform_activation_receipts BEGIN
 SELECT CASE WHEN nassaj_platform_receipt_matches(NEW.operation_id,NEW.database_id,NEW.restore_epoch,NEW.file_identity,NEW.approved_path,NEW.tool_build,NEW.previous_floor_hash,NEW.target_floor_hash,NEW.guard_hash)!=1 OR EXISTS(SELECT 1 FROM platform_activation_receipts WHERE operation_id=NEW.operation_id) THEN RAISE(ABORT,'PLATFORM_RECEIPT_IMMUTABLE') END;
END;
CREATE TRIGGER nassaj_platform_receipt_update BEFORE UPDATE ON platform_activation_receipts BEGIN
 SELECT RAISE(ABORT,'PLATFORM_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER nassaj_platform_receipt_delete BEFORE DELETE ON platform_activation_receipts BEGIN
 SELECT RAISE(ABORT,'PLATFORM_RECEIPT_IMMUTABLE');
END;
`;
