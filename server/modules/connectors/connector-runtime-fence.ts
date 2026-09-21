/** ADR-132 M2 compatibility fence used by the Substrate-Only production lifecycle. */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Database } from 'better-sqlite3';

/* eslint-disable-next-line boundaries/dependencies -- inert M2 inventory must derive from canonical SQL without loading the database barrel. */
import { CONNECTOR_SCHEMA_TABLE_INVENTORY } from '../database/connector-table-inventory.js';

export const CONNECTOR_RUNTIME_FLOOR = 1 as const;
export const CONNECTOR_POLICY_SCHEMA_VERSION = 2 as const;

export const CONNECTOR_RUNTIME_THREAT_MODEL = Object.freeze({
  protectsAgainst: Object.freeze([
    'legacy_binary_without_fence_functions', 'stale_or_concurrent_writer',
    'raw_control_or_lease_row_tampering', 'missing_or_modified_fence_trigger',
  ]),
  doesNotProtectAgainst: Object.freeze([
    'hostile_process_with_arbitrary_sqlite_function_and_ddl_access',
    'host_or_filesystem_compromise',
  ]),
});

type CanonicalConnectorTable = Readonly<{ name: string; guarded: boolean }>;

/** Single canonical inventory; trigger coverage is derived, never duplicated. */
export const CONNECTOR_RUNTIME_CANONICAL_TABLE_INVENTORY: readonly CanonicalConnectorTable[] = Object.freeze([
  ...CONNECTOR_SCHEMA_TABLE_INVENTORY.map(name => Object.freeze({ name, guarded: true })),
]);

const AUTHORITY_TABLES = Object.freeze([
  'connector_runtime_anchor', 'connector_runtime_control', 'connector_runtime_writer_lease',
]);
const ACTIONS = Object.freeze(['INSERT', 'UPDATE', 'DELETE'] as const);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TRIGGER_PREFIX = 'connector_runtime_fence_';

export const CONNECTOR_RUNTIME_FENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_runtime_anchor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  initialized_marker INTEGER NOT NULL CHECK (initialized_marker = 1),
  maximum_fencing_token INTEGER NOT NULL CHECK (maximum_fencing_token >= 0),
  maximum_writer_epoch INTEGER NOT NULL CHECK (maximum_writer_epoch > 0),
  clock_high_water_ms INTEGER NOT NULL CHECK (clock_high_water_ms >= 0),
  authority_mac TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_runtime_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  connector_runtime_floor INTEGER NOT NULL CHECK (connector_runtime_floor > 0),
  policy_schema_version INTEGER NOT NULL CHECK (policy_schema_version > 0),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  last_fencing_token INTEGER NOT NULL CHECK (last_fencing_token >= 0),
  last_clock_ms INTEGER NOT NULL CHECK (last_clock_ms >= 0),
  authority_mac TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_runtime_writer_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL,
  acquisition_nonce TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  authority_mac TEXT NOT NULL
);
`;

type AnchorRow = {
  initialized_marker: number;
  maximum_fencing_token: number;
  maximum_writer_epoch: number;
  clock_high_water_ms: number;
  authority_mac: string;
};

type ControlRow = {
  connector_runtime_floor: number;
  policy_schema_version: number;
  writer_epoch: number;
  last_fencing_token: number;
  last_clock_ms: number;
  authority_mac: string;
};

type LeaseRow = {
  owner_token: string;
  acquisition_nonce: string;
  lease_generation: number;
  fencing_token: number;
  writer_epoch: number;
  expires_at_ms: number;
  authority_mac: string;
};

const authorityKeys = new WeakMap<ConnectorRuntimeAuthority, Buffer>();

/** Opaque installation authority; the HMAC key is never serialized or stored in SQLite. */
export class ConnectorRuntimeAuthority {
  private constructor() { Object.freeze(this); }
  static create(key: Buffer): ConnectorRuntimeAuthority {
    if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('connector_runtime_authority_key_invalid');
    const authority = new ConnectorRuntimeAuthority();
    authorityKeys.set(authority, Buffer.from(key));
    return authority;
  }
  toJSON(): never { throw new Error('connector_runtime_authority_not_serializable'); }
}

const keyFor = (authority: ConnectorRuntimeAuthority): Buffer => {
  const key = authorityKeys.get(authority);
  if (!key) throw new Error('connector_runtime_authority_invalid');
  return key;
};

/** Domain-separated MAC for installation-local connector activation records; the root never leaves this module. */
export const connectorRuntimeActivationMac = (
  authority: ConnectorRuntimeAuthority,
  payload: Uint8Array,
): string => createHmac('sha256', keyFor(authority))
  .update('NASSAJ\0CONNECTOR_LOCAL_ACTIVATION\0V1\0').update(payload).digest('base64url');

/** Constant-time activation MAC verification without exposing the installation authority root. */
export const verifyConnectorRuntimeActivationMac = (
  authority: ConnectorRuntimeAuthority,
  payload: Uint8Array,
  supplied: string,
): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(supplied)) return false;
  const actual = Buffer.from(supplied, 'base64url');
  const expected = Buffer.from(connectorRuntimeActivationMac(authority, payload), 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const authorityMac = (key: Buffer, domain: 'anchor' | 'control' | 'lease', fields: readonly unknown[]): string =>
  createHmac('sha256', key).update(`NASSAJ\0CONNECTOR_RUNTIME_${domain.toUpperCase()}\0V1\0`)
    .update(JSON.stringify(fields)).digest('base64url');

const controlFields = (row: Omit<ControlRow, 'authority_mac'>): readonly unknown[] => [
  row.connector_runtime_floor, row.policy_schema_version, row.writer_epoch,
  row.last_fencing_token, row.last_clock_ms,
];

const leaseFields = (row: Omit<LeaseRow, 'authority_mac'>): readonly unknown[] => [
  row.owner_token, row.acquisition_nonce, row.lease_generation, row.fencing_token,
  row.writer_epoch, row.expires_at_ms,
];

const anchorFields = (row: Omit<AnchorRow, 'authority_mac'>): readonly unknown[] => [
  row.initialized_marker, row.maximum_fencing_token,
  row.maximum_writer_epoch, row.clock_high_water_ms,
];

const safeMacEqual = (actual: unknown, expected: string): boolean => {
  if (typeof actual !== 'string' || !MAC_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};

const validPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const validNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const validControl = (row: ControlRow | undefined, key: Buffer): row is ControlRow => Boolean(row
  && validPositiveInteger(row.connector_runtime_floor) && validPositiveInteger(row.policy_schema_version)
  && validPositiveInteger(row.writer_epoch) && validNonnegativeInteger(row.last_fencing_token)
  && validNonnegativeInteger(row.last_clock_ms)
  && safeMacEqual(row.authority_mac, authorityMac(key, 'control', controlFields(row))));

const validLease = (row: LeaseRow | undefined, key: Buffer): row is LeaseRow => Boolean(row
  && UUID_PATTERN.test(row.owner_token) && /^[A-Za-z0-9_-]{43}$/u.test(row.acquisition_nonce)
  && validPositiveInteger(row.lease_generation) && validPositiveInteger(row.fencing_token)
  && validPositiveInteger(row.writer_epoch) && validPositiveInteger(row.expires_at_ms)
  && safeMacEqual(row.authority_mac, authorityMac(key, 'lease', leaseFields(row))));

const validAnchor = (row: AnchorRow | undefined, key: Buffer): row is AnchorRow => Boolean(row
  && row.initialized_marker === 1 && validNonnegativeInteger(row.maximum_fencing_token)
  && validPositiveInteger(row.maximum_writer_epoch) && validNonnegativeInteger(row.clock_high_water_ms)
  && safeMacEqual(row.authority_mac, authorityMac(key, 'anchor', anchorFields(row))));

const readAnchor = (database: Database): AnchorRow | undefined => database.prepare(
  `SELECT initialized_marker, maximum_fencing_token, maximum_writer_epoch,
          clock_high_water_ms, authority_mac
   FROM connector_runtime_anchor WHERE singleton = 1`,
).get() as AnchorRow | undefined;

const readControl = (database: Database): ControlRow | undefined => database.prepare(
  `SELECT connector_runtime_floor, policy_schema_version, writer_epoch,
          last_fencing_token, last_clock_ms, authority_mac
   FROM connector_runtime_control WHERE singleton = 1`,
).get() as ControlRow | undefined;

const readLease = (database: Database): LeaseRow | undefined => database.prepare(
  `SELECT owner_token, acquisition_nonce, lease_generation, fencing_token,
          writer_epoch, expires_at_ms, authority_mac
   FROM connector_runtime_writer_lease WHERE singleton = 1`,
).get() as LeaseRow | undefined;

const triggerName = (table: string, action: typeof ACTIONS[number]): string =>
  `${TRIGGER_PREFIX}${table}_${action.toLowerCase()}`;

const triggerSql = (table: string, action: typeof ACTIONS[number]): string => `
CREATE TRIGGER ${triggerName(table, action)}
BEFORE ${action} ON ${table}
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM connector_runtime_anchor a
    JOIN connector_runtime_control c ON c.singleton = a.singleton
    JOIN connector_runtime_writer_lease l ON l.singleton = c.singleton
    WHERE c.singleton = 1
      AND nassaj_connector_authority_valid(
        a.initialized_marker, a.maximum_fencing_token, a.maximum_writer_epoch,
        a.clock_high_water_ms, a.authority_mac,
        c.connector_runtime_floor, c.policy_schema_version, c.writer_epoch,
        c.last_fencing_token, c.last_clock_ms, c.authority_mac,
        l.owner_token, l.acquisition_nonce, l.lease_generation, l.fencing_token,
        l.writer_epoch, l.expires_at_ms, l.authority_mac
      ) = 1
      AND nassaj_connector_runtime_version() >= c.connector_runtime_floor
      AND nassaj_connector_policy_schema_version() >= c.policy_schema_version
      AND nassaj_connector_writer_epoch() = c.writer_epoch
      AND l.writer_epoch = c.writer_epoch
      AND nassaj_connector_owner_token() = l.owner_token
      AND nassaj_connector_acquisition_nonce() = l.acquisition_nonce
      AND nassaj_connector_fencing_token() = l.fencing_token
      AND nassaj_connector_now_ms() >= c.last_clock_ms
      AND l.expires_at_ms > nassaj_connector_now_ms()
  ) THEN RAISE(ABORT, 'connector_runtime_fence_required') END;
END`;

const normalizeSql = (sql: string): string => sql.replace(/\s+/gu, ' ').trim().replace(/;$/u, '');
const sqlDigest = (sql: string): string => createHash('sha256')
  .update('NASSAJ\0CONNECTOR_TRIGGER_SQL\0V1\0').update(normalizeSql(sql)).digest('base64url');

const existingGuardedTables = (database: Database): string[] => {
  const present = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>).map(row => row.name));
  return CONNECTOR_RUNTIME_CANONICAL_TABLE_INVENTORY.filter(entry => entry.guarded && present.has(entry.name))
    .map(entry => entry.name);
};

type TriggerInspection = Readonly<{ valid: boolean; expectedCount: number; actualCount: number }>;

const inspectTriggers = (database: Database): TriggerInspection => {
  const tables = existingGuardedTables(database);
  const expected = new Map<string, string>();
  for (const table of tables) for (const action of ACTIONS) {
    expected.set(triggerName(table, action), sqlDigest(triggerSql(table, action)));
  }
  const actual = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name",
  ).all(`${TRIGGER_PREFIX}%`) as Array<{ name: string; sql: string }>;
  const valid = actual.length === expected.size && actual.every(row =>
    expected.get(row.name) === sqlDigest(row.sql));
  return Object.freeze({ valid, expectedCount: expected.size, actualCount: actual.length });
};

const authorityTablesExist = (database: Database): boolean => {
  const found = existingAuthorityTableNames(database);
  return AUTHORITY_TABLES.every(table => found.has(table));
};

/** Atomic install/reinstall lifecycle hook. Call after every connector schema rebuild. */
export const reinstallConnectorRuntimeFence = (
  database: Database,
  authority: ConnectorRuntimeAuthority,
): void => database.transaction(() => {
  const key = keyFor(authority);
  const priorAuthorityTables = existingAuthorityTableNames(database);
  if (priorAuthorityTables.size !== 0 && priorAuthorityTables.size !== AUTHORITY_TABLES.length) {
    throw new Error('connector_runtime_authority_partial_or_deleted');
  }
  database.exec(CONNECTOR_RUNTIME_FENCE_SCHEMA_SQL);
  const anchor = readAnchor(database);
  const existing = readControl(database);
  if (priorAuthorityTables.size === 0) insertInitialAuthority(database, key);
  else if (!validAnchor(anchor, key) || !validControl(existing, key)) {
    throw new Error('connector_runtime_authority_tampered');
  }
  const lease = readLease(database);
  if (lease && !validLease(lease, key)) throw new Error('connector_runtime_lease_tampered');
  const triggerRows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?",
  ).all(`${TRIGGER_PREFIX}%`) as Array<{ name: string }>;
  for (const row of triggerRows) {
    if (!/^[a-z0-9_]+$/u.test(row.name)) throw new Error('connector_runtime_trigger_name_invalid');
    database.exec(`DROP TRIGGER "${row.name}"`);
  }
  for (const table of existingGuardedTables(database)) {
    for (const action of ACTIONS) database.exec(triggerSql(table, action));
  }
  const finalAnchor = readAnchor(database);
  const finalControl = readControl(database);
  const finalLease = readLease(database);
  if (!validAnchor(finalAnchor, key) || !validControl(finalControl, key)
    || !anchorMatchesControl(finalAnchor, finalControl)
    || (finalControl.last_fencing_token > 0 && !finalLease)
    || (finalLease && (!validLease(finalLease, key)
      || finalLease.fencing_token !== finalControl.last_fencing_token
      || finalLease.writer_epoch !== finalControl.writer_epoch))) {
    throw new Error('connector_runtime_authority_final_verify_failed');
  }
  if (!inspectTriggers(database).valid) throw new Error('connector_runtime_trigger_inventory_invalid');
}).immediate();

export const migrateConnectorRuntimeFence = reinstallConnectorRuntimeFence;

const insertInitialAuthority = (database: Database, key: Buffer): void => {
  const anchor = { initialized_marker: 1, maximum_fencing_token: 0,
    maximum_writer_epoch: 1, clock_high_water_ms: 0 };
  database.prepare(`INSERT INTO connector_runtime_anchor (
    singleton, initialized_marker, maximum_fencing_token, maximum_writer_epoch,
    clock_high_water_ms, authority_mac
  ) VALUES (1, ?, ?, ?, ?, ?)`).run(...anchorFields(anchor),
    authorityMac(key, 'anchor', anchorFields(anchor)));
  const row = { connector_runtime_floor: CONNECTOR_RUNTIME_FLOOR,
    policy_schema_version: CONNECTOR_POLICY_SCHEMA_VERSION, writer_epoch: 1,
    last_fencing_token: 0, last_clock_ms: 0 };
  database.prepare(`INSERT INTO connector_runtime_control (
    singleton, connector_runtime_floor, policy_schema_version, writer_epoch,
    last_fencing_token, last_clock_ms, authority_mac
  ) VALUES (1, ?, ?, ?, ?, ?, ?)`)
    .run(...controlFields(row), authorityMac(key, 'control', controlFields(row)));
};

const existingAuthorityTableNames = (database: Database): ReadonlySet<string> => new Set(
  (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(row => row.name).filter(name => AUTHORITY_TABLES.includes(name)),
);

const anchorMatchesControl = (anchor: AnchorRow, control: ControlRow): boolean =>
  anchor.maximum_fencing_token === control.last_fencing_token
  && anchor.maximum_writer_epoch === control.writer_epoch
  && anchor.clock_high_water_ms === control.last_clock_ms;

export type ConnectorRuntimeHealth = Readonly<{
  subsystemReady: boolean;
  reason: 'ready' | 'control_plane_absent' | 'runtime_floor_incompatible'
  | 'policy_schema_incompatible' | 'fencing_unsupported' | 'authority_tampered'
  | 'lease_state_tampered' | 'trigger_inventory_invalid' | 'clock_rollback_detected';
  connectorRuntimeFloor: number | null;
  policySchemaVersion: number | null;
  writerEpoch: number | null;
  fencingToken: number | null;
}>;

export type ConnectorRuntimeBuild = Readonly<{
  runtimeVersion: number;
  maximumPolicySchemaVersion: number;
  supportsWriterFencing: boolean;
}>;

/** Read-only subsystem preflight. Failure disables connectors, never the whole server. */
export const preflightConnectorRuntime = (
  database: Database,
  build: ConnectorRuntimeBuild,
  authority: ConnectorRuntimeAuthority,
  nowMs = Date.now(),
): ConnectorRuntimeHealth => {
  if (!authorityTablesExist(database)) return health(null, null, 'control_plane_absent');
  const key = keyFor(authority);
  let anchor: AnchorRow | undefined;
  let control: ControlRow | undefined;
  let lease: LeaseRow | undefined;
  try { anchor = readAnchor(database); control = readControl(database); lease = readLease(database); }
  catch { return health(null, null, 'authority_tampered'); }
  if (!validAnchor(anchor, key) || !validControl(control, key)
    || !anchorMatchesControl(anchor, control)) return health(control, null, 'authority_tampered');
  if ((control.last_fencing_token > 0 && !lease) || (lease && (!validLease(lease, key)
    || lease.fencing_token !== control.last_fencing_token || lease.writer_epoch !== control.writer_epoch))) {
    return health(control, lease, 'lease_state_tampered');
  }
  if (!inspectTriggers(database).valid) return health(control, lease, 'trigger_inventory_invalid');
  if (!Number.isSafeInteger(nowMs) || nowMs < anchor.clock_high_water_ms) {
    return health(control, lease, 'clock_rollback_detected');
  }
  if (!validPositiveInteger(build.runtimeVersion)
    || build.runtimeVersion < control.connector_runtime_floor) return health(control, lease, 'runtime_floor_incompatible');
  if (!validPositiveInteger(build.maximumPolicySchemaVersion)
    || build.maximumPolicySchemaVersion < control.policy_schema_version) return health(control, lease, 'policy_schema_incompatible');
  if (build.supportsWriterFencing !== true) return health(control, lease, 'fencing_unsupported');
  return health(control, lease, 'ready');
};

const health = (control: ControlRow | null | undefined, lease: LeaseRow | null | undefined,
  reason: ConnectorRuntimeHealth['reason']): ConnectorRuntimeHealth => Object.freeze({
  subsystemReady: reason === 'ready', reason,
  connectorRuntimeFloor: control?.connector_runtime_floor ?? null,
  policySchemaVersion: control?.policy_schema_version ?? null,
  writerEpoch: control?.writer_epoch ?? null, fencingToken: lease?.fencing_token ?? null,
});

/** Verify an existing fence without installation, repair, lease acquisition, or writes. */
export const verifyExistingConnectorRuntimeFence = (
  database: Database,
  build: ConnectorRuntimeBuild,
  authority: ConnectorRuntimeAuthority,
  nowMs = Date.now(),
): ConnectorRuntimeHealth => {
  const result = preflightConnectorRuntime(database, build, authority, nowMs);
  if (!result.subsystemReady) throw new Error(`connector_existing_runtime_invalid:${result.reason}`);
  return result;
};

type LeaseRecord = Readonly<{
  ownerToken: string; acquisitionNonce: string; leaseGeneration: number;
  fencingToken: number; writerEpoch: number; expiresAtMs: number;
}>;

const leaseRecords = new WeakMap<ConnectorRuntimeLease, LeaseRecord>();

/** Opaque exact lease instance; its owner and acquisition nonce are never exposed. */
export class ConnectorRuntimeLease {
  private constructor() { Object.freeze(this); }
  static create(record: LeaseRecord): ConnectorRuntimeLease {
    const lease = new ConnectorRuntimeLease();
    leaseRecords.set(lease, record);
    return lease;
  }
  get fencingToken(): number { return leaseRecords.get(this)?.fencingToken ?? -1; }
  get writerEpoch(): number { return leaseRecords.get(this)?.writerEpoch ?? -1; }
  toJSON(): never { throw new Error('connector_runtime_lease_not_serializable'); }
}

export type ConnectorFencedOperation = 'connector_write' | 'credential_decrypt' | 'm2_placement';

/** Shared connection factory/gate. Authority state is HMAC-bound in an unextractable closure. */
export class ConnectorRuntimeWriteGate {
  readonly #database: Database;
  readonly #build: ConnectorRuntimeBuild;
  readonly #authority: ConnectorRuntimeAuthority;
  readonly #clock: () => number;
  #armed: ConnectorRuntimeLease | null = null;
  #exposed: LeaseRecord | null = null;

  constructor(database: Database, build: ConnectorRuntimeBuild,
    authority: ConnectorRuntimeAuthority, clock: () => number = Date.now) {
    this.#database = database;
    this.#build = build;
    this.#authority = authority;
    this.#clock = clock;
    this.#registerFenceFunctions();
  }

  preflight(): ConnectorRuntimeHealth {
    return preflightConnectorRuntime(this.#database, this.#build, this.#authority, this.#clock());
  }

  assertAllowed(_operation: ConnectorFencedOperation): void {
    const ready = this.preflight();
    if (!ready.subsystemReady || !this.#armed || !this.leaseIsCurrent(this.#armed)) {
      throw new Error(`connector_subsystem_blocked:${ready.reason}`);
    }
  }

  acquire(ownerToken = randomUUID(), ttlMs = 15_000,
    expectedWriterEpoch?: number): ConnectorRuntimeLease | null {
    const nowMs = this.#validatedClockAndTtl(ownerToken, ttlMs);
    const ready = this.preflight();
    if (!ready.subsystemReady || ready.writerEpoch === null) return null;
    const writerEpoch = expectedWriterEpoch ?? ready.writerEpoch;
    if (!validPositiveInteger(writerEpoch)) return null;
    const record = this.#acquireTransaction(ownerToken, writerEpoch, nowMs, ttlMs, false);
    const lease = record ? ConnectorRuntimeLease.create(record) : null;
    this.#armed = lease;
    return lease;
  }

  /** Boot-only fencing takeover; the new token invalidates an older process before migrations run. */
  acquireForInitialization(ownerToken = randomUUID(), ttlMs = 15_000): ConnectorRuntimeLease | null {
    const nowMs = this.#validatedClockAndTtl(ownerToken, ttlMs);
    const ready = this.preflight();
    if (!ready.subsystemReady || ready.writerEpoch === null) return null;
    const record = this.#acquireTransaction(ownerToken, ready.writerEpoch, nowMs, ttlMs, true);
    const lease = record ? ConnectorRuntimeLease.create(record) : null;
    this.#armed = lease;
    return lease;
  }

  renew(lease: ConnectorRuntimeLease, ttlMs = 15_000): ConnectorRuntimeLease | null {
    const exact = leaseRecords.get(lease);
    if (!exact || this.#armed !== lease) return null;
    const nowMs = this.#validatedClockAndTtl(exact.ownerToken, ttlMs);
    const renewed = this.#renewTransaction(exact, nowMs, ttlMs);
    const result = renewed ? ConnectorRuntimeLease.create(renewed) : null;
    this.#armed = result;
    return result;
  }

  leaseIsCurrent(lease: ConnectorRuntimeLease): boolean {
    const expected = leaseRecords.get(lease);
    if (!expected) return false;
    const anchor = readAnchor(this.#database);
    const control = readControl(this.#database);
    const row = readLease(this.#database);
    const key = keyFor(this.#authority);
    return Boolean(validAnchor(anchor, key) && validControl(control, key)
      && anchorMatchesControl(anchor, control) && validLease(row, key)
      && sameLease(row, expected) && row.expires_at_ms > this.#clock()
      && row.fencing_token === control.last_fencing_token && row.writer_epoch === control.writer_epoch);
  }

  /** Executes one local guarded mutation and optionally advances the writer epoch atomically. */
  runFencedMutation(effect: () => void, advanceWriterEpoch: boolean): boolean {
    const armed = this.#armed;
    const expected = armed ? leaseRecords.get(armed) : null;
    if (!armed || !expected || this.#exposed || !this.leaseIsCurrent(armed)) return false;
    let advanced: LeaseRecord | null = null;
    const execute = this.#database.transaction(() => {
      const key = keyFor(this.#authority);
      const anchor = readAnchor(this.#database); const control = readControl(this.#database);
      const lease = readLease(this.#database);
      if (!validAnchor(anchor, key) || !validControl(control, key) || !validLease(lease, key)
        || !anchorMatchesControl(anchor, control) || !sameLease(lease, expected)) {
        throw new Error('connector_runtime_lease_stale');
      }
      this.#exposed = expected;
      try {
        effect();
        if (advanceWriterEpoch) advanced = advanceAuthorityWriterEpoch(
          this.#database, key, anchor, control, expected,
        );
      } finally { this.#exposed = null; }
    });
    execute.immediate();
    if (advanced) this.#armed = ConnectorRuntimeLease.create(advanced);
    return true;
  }

  #validatedClockAndTtl(ownerToken: string, ttlMs: number): number {
    const nowMs = this.#clock();
    if (!UUID_PATTERN.test(ownerToken) || !validPositiveInteger(ttlMs) || ttlMs > 60_000
      || !Number.isSafeInteger(nowMs) || nowMs <= 0
      || !Number.isSafeInteger(nowMs + ttlMs)) throw new Error('connector_runtime_lease_input_invalid');
    return nowMs;
  }

  readonly #acquireTransaction = (ownerToken: string, writerEpoch: number,
    nowMs: number, ttlMs: number, replaceCurrent: boolean): LeaseRecord | null => this.#database.transaction(() => {
    const key = keyFor(this.#authority);
    const control = readControl(this.#database);
    const anchor = readAnchor(this.#database);
    const prior = readLease(this.#database);
    if (!validAnchor(anchor, key) || !validControl(control, key)
      || !anchorMatchesControl(anchor, control) || writerEpoch !== control.writer_epoch
      || nowMs < anchor.clock_high_water_ms) return null;
    if (prior && (!validLease(prior, key) || (!replaceCurrent && prior.expires_at_ms > nowMs))) return null;
    if (!prior && control.last_fencing_token > 0) return null;
    const fencingToken = control.last_fencing_token + 1;
    if (!Number.isSafeInteger(fencingToken)) return null;
    const record = makeLeaseRecord(ownerToken, writerEpoch, fencingToken, nowMs + ttlMs);
    writeAuthorityState(this.#database, key, control, record, nowMs);
    return record;
  }).immediate();

  readonly #renewTransaction = (expected: LeaseRecord, nowMs: number,
    ttlMs: number): LeaseRecord | null => this.#database.transaction(() => {
    const key = keyFor(this.#authority);
    const anchor = readAnchor(this.#database);
    const control = readControl(this.#database);
    const prior = readLease(this.#database);
    if (!validAnchor(anchor, key) || !validControl(control, key)
      || !anchorMatchesControl(anchor, control) || control.writer_epoch !== expected.writerEpoch
      || !validLease(prior, key) || !sameLease(prior, expected)
      || prior.expires_at_ms <= nowMs || nowMs < anchor.clock_high_water_ms) return null;
    const renewed = makeLeaseRecord(expected.ownerToken, expected.writerEpoch,
      expected.fencingToken, nowMs + ttlMs);
    writeAuthorityState(this.#database, key, control, renewed, nowMs);
    return renewed;
  }).immediate();

  #registerFenceFunctions(): void {
    this.#database.function('nassaj_connector_runtime_version', () => this.#build.runtimeVersion);
    this.#database.function('nassaj_connector_policy_schema_version', () => this.#build.maximumPolicySchemaVersion);
    this.#database.function('nassaj_connector_writer_epoch', () => this.#armedRecord()?.writerEpoch ?? -1);
    this.#database.function('nassaj_connector_owner_token', () => this.#armedRecord()?.ownerToken ?? '');
    this.#database.function('nassaj_connector_acquisition_nonce', () => this.#armedRecord()?.acquisitionNonce ?? '');
    this.#database.function('nassaj_connector_fencing_token', () => this.#armedRecord()?.fencingToken ?? -1);
    this.#database.function('nassaj_connector_now_ms', () => this.#clock());
    this.#database.function('nassaj_connector_authority_valid', (
      marker: number, maximumFence: number, maximumWriterEpoch: number,
      clockHighWater: number, anchorMac: string,
      runtimeFloor: number, policySchema: number, writerEpoch: number,
      lastFence: number, lastClock: number, controlMac: string,
      ownerToken: string, nonce: string, generation: number, fencingToken: number,
      leaseWriterEpoch: number, expiresAtMs: number, leaseMac: string,
    ) => this.#authorityRowsValid({ initialized_marker: marker,
      maximum_fencing_token: maximumFence, maximum_writer_epoch: maximumWriterEpoch,
      clock_high_water_ms: clockHighWater, authority_mac: anchorMac },
    { connector_runtime_floor: runtimeFloor,
      policy_schema_version: policySchema, writer_epoch: writerEpoch,
      last_fencing_token: lastFence, last_clock_ms: lastClock, authority_mac: controlMac },
    { owner_token: ownerToken, acquisition_nonce: nonce, lease_generation: generation,
      fencing_token: fencingToken, writer_epoch: leaseWriterEpoch,
      expires_at_ms: expiresAtMs, authority_mac: leaseMac }) ? 1 : 0);
  }

  #armedRecord(): LeaseRecord | null { return this.#exposed; }

  #authorityRowsValid(anchor: AnchorRow, control: ControlRow, lease: LeaseRow): boolean {
    const key = keyFor(this.#authority);
    return Boolean(validAnchor(anchor, key) && validControl(control, key)
      && anchorMatchesControl(anchor, control) && validLease(lease, key)
      && lease.fencing_token === control.last_fencing_token && lease.writer_epoch === control.writer_epoch);
  }
}

const makeLeaseRecord = (ownerToken: string, writerEpoch: number,
  fencingToken: number, expiresAtMs: number): LeaseRecord => Object.freeze({
  ownerToken, acquisitionNonce: randomBytes(32).toString('base64url'),
  leaseGeneration: fencingToken, fencingToken, writerEpoch, expiresAtMs,
});

const sameLease = (row: LeaseRow, record: LeaseRecord): boolean =>
  row.owner_token === record.ownerToken && row.acquisition_nonce === record.acquisitionNonce
  && row.lease_generation === record.leaseGeneration && row.fencing_token === record.fencingToken
  && row.writer_epoch === record.writerEpoch && row.expires_at_ms === record.expiresAtMs;

const writeAuthorityState = (database: Database, key: Buffer, prior: ControlRow,
  lease: LeaseRecord, nowMs: number): void => {
  const priorAnchor = readAnchor(database);
  if (!validAnchor(priorAnchor, key) || !anchorMatchesControl(priorAnchor, prior)) {
    throw new Error('connector_runtime_anchor_cas_stale');
  }
  const anchor = { initialized_marker: 1, maximum_fencing_token: lease.fencingToken,
    maximum_writer_epoch: lease.writerEpoch, clock_high_water_ms: nowMs };
  const anchorUpdated = database.prepare(`UPDATE connector_runtime_anchor SET
    maximum_fencing_token = ?, maximum_writer_epoch = ?, clock_high_water_ms = ?, authority_mac = ?
    WHERE singleton = 1 AND authority_mac = ?`).run(lease.fencingToken, lease.writerEpoch, nowMs,
    authorityMac(key, 'anchor', anchorFields(anchor)), priorAnchor.authority_mac);
  if (anchorUpdated.changes !== 1) throw new Error('connector_runtime_anchor_cas_stale');
  const control = { connector_runtime_floor: prior.connector_runtime_floor,
    policy_schema_version: prior.policy_schema_version, writer_epoch: prior.writer_epoch,
    last_fencing_token: lease.fencingToken, last_clock_ms: nowMs };
  const updated = database.prepare(`UPDATE connector_runtime_control SET
    last_fencing_token = ?, last_clock_ms = ?, authority_mac = ?
    WHERE singleton = 1 AND authority_mac = ?`).run(lease.fencingToken, nowMs,
    authorityMac(key, 'control', controlFields(control)), prior.authority_mac);
  if (updated.changes !== 1) throw new Error('connector_runtime_control_cas_stale');
  const row = { owner_token: lease.ownerToken, acquisition_nonce: lease.acquisitionNonce,
    lease_generation: lease.leaseGeneration, fencing_token: lease.fencingToken,
    writer_epoch: lease.writerEpoch, expires_at_ms: lease.expiresAtMs };
  database.prepare(`INSERT INTO connector_runtime_writer_lease (
    singleton, owner_token, acquisition_nonce, lease_generation, fencing_token,
    writer_epoch, expires_at_ms, authority_mac
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
    owner_token = excluded.owner_token, acquisition_nonce = excluded.acquisition_nonce,
    lease_generation = excluded.lease_generation, fencing_token = excluded.fencing_token,
    writer_epoch = excluded.writer_epoch, expires_at_ms = excluded.expires_at_ms,
    authority_mac = excluded.authority_mac`).run(...leaseFields(row),
    authorityMac(key, 'lease', leaseFields(row)));
};

const advanceAuthorityWriterEpoch = (database: Database, key: Buffer, priorAnchor: AnchorRow,
  prior: ControlRow, lease: LeaseRecord): LeaseRecord => {
  const writerEpoch = prior.writer_epoch + 1;
  if (!Number.isSafeInteger(writerEpoch)) throw new Error('connector_runtime_writer_epoch_exhausted');
  const anchor = { initialized_marker: 1, maximum_fencing_token: prior.last_fencing_token,
    maximum_writer_epoch: writerEpoch, clock_high_water_ms: prior.last_clock_ms };
  const anchorUpdate = database.prepare(`UPDATE connector_runtime_anchor SET maximum_writer_epoch = ?,
    authority_mac = ? WHERE singleton = 1 AND authority_mac = ?`).run(writerEpoch,
    authorityMac(key, 'anchor', anchorFields(anchor)), priorAnchor.authority_mac);
  if (anchorUpdate.changes !== 1) throw new Error('connector_runtime_anchor_cas_stale');
  const control = { ...prior, writer_epoch: writerEpoch };
  const controlUpdate = database.prepare(`UPDATE connector_runtime_control SET writer_epoch = ?, authority_mac = ?
    WHERE singleton = 1 AND authority_mac = ?`).run(writerEpoch,
    authorityMac(key, 'control', controlFields(control)), prior.authority_mac);
  if (controlUpdate.changes !== 1) throw new Error('connector_runtime_control_cas_stale');
  const next = Object.freeze({ ...lease, writerEpoch });
  const row = { owner_token: next.ownerToken, acquisition_nonce: next.acquisitionNonce,
    lease_generation: next.leaseGeneration, fencing_token: next.fencingToken,
    writer_epoch: next.writerEpoch, expires_at_ms: next.expiresAtMs };
  const leaseUpdate = database.prepare(`UPDATE connector_runtime_writer_lease SET writer_epoch = ?, authority_mac = ?
    WHERE singleton = 1 AND authority_mac = ?`).run(writerEpoch,
    authorityMac(key, 'lease', leaseFields(row)),
    authorityMac(key, 'lease', leaseFields({ owner_token: lease.ownerToken,
      acquisition_nonce: lease.acquisitionNonce, lease_generation: lease.leaseGeneration,
      fencing_token: lease.fencingToken, writer_epoch: lease.writerEpoch, expires_at_ms: lease.expiresAtMs })));
  if (leaseUpdate.changes !== 1) throw new Error('connector_runtime_lease_cas_stale');
  return next;
};
