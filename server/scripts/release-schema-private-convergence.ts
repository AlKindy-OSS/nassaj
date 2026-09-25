import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import {
  applyDeviceAccountSessionsComponent,
  DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS,
} from '../modules/database/device-account-sessions.migration.js';
import {
  applyUsageStatisticsV3Component,
  USAGE_STATISTICS_V3_OWNED_OBJECTS,
} from '../modules/database/usage-statistics-v3.migration.js';

type ComponentTargets = Readonly<{
  usage: Readonly<{ count: number; sha256: string }>;
  wallet: Readonly<{ count: number; sha256: string }>;
}>;

export const EXPECTED_PRIVATE_COMPONENT_TARGETS: ComponentTargets = Object.freeze({
  usage: Object.freeze({ count: 30, sha256: '3b5b9058734d07ce70a1a44eeedd36e447326e095f00fd627542f0f899c73daa' }),
  wallet: Object.freeze({ count: 6, sha256: 'a742aacd1988f53cd1e88f4c4d2ca7813554dcf3b039e4bdf98b2d2b4422004a' }),
});

type ManifestFile = { path: string; size: number; sha256: string };
type RehearsalManifest = { schema: string; files: ManifestFile[] };
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
type DatabaseFactory = (filename: string) => Database.Database;

export type PrivateConvergenceOptions = {
  manifestPath: string;
  fixturePaths: readonly string[];
  tempRoot?: string;
  databaseFactory?: DatabaseFactory;
};

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error(`release_schema_private_gate_${reason}`); };

function parseManifest(manifestPath: string): RehearsalManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { fail('manifest_invalid'); }
  const value = parsed as Partial<RehearsalManifest>;
  if (value.schema !== 'nassaj-installed-artifact-rehearsal-manifest/v1' || !Array.isArray(value.files)) {
    fail('manifest_invalid');
  }
  return value as RehearsalManifest;
}

function openFixtureReadOnly(filename: string): number {
  try { return openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail('fixture_type_invalid'); }
}

function verifiedFixtureBytes(manifestPath: string, manifest: RehearsalManifest, fixturePath: string): Buffer {
  const resolvedManifest = path.resolve(manifestPath);
  const resolvedFixture = path.resolve(fixturePath);
  const relative = path.relative(path.dirname(resolvedManifest), resolvedFixture).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) fail('fixture_outside_manifest');
  const matches = manifest.files.filter((entry) => entry.path === relative);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].size) || matches[0].size < 0
    || !/^[a-f0-9]{64}$/.test(matches[0].sha256)) fail('fixture_manifest_entry_invalid');
  const descriptor = openFixtureReadOnly(resolvedFixture);
  let bytes: Buffer;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail('fixture_type_invalid');
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== matches[0].size) fail('fixture_size_mismatch');
  } finally {
    closeSync(descriptor);
  }
  if (sha256(bytes) !== matches[0].sha256) fail('fixture_hash_mismatch');
  return bytes;
}

function schemaObjects(db: Database.Database): SchemaObject[] {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as SchemaObject[];
}

function componentFingerprint(db: Database.Database, names: readonly string[]): { count: number; sha256: string } {
  const owned = new Set(names);
  const objects = schemaObjects(db).filter((entry) => owned.has(entry.name));
  return { count: objects.length, sha256: sha256(JSON.stringify(objects)) };
}

function applyAndMeasure(db: Database.Database): ComponentTargets {
  const owned = new Set([...USAGE_STATISTICS_V3_OWNED_OBJECTS, ...DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS]);
  const inherited = schemaObjects(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    applyUsageStatisticsV3Component(db);
    applyDeviceAccountSessionsComponent(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
  if (JSON.stringify(schemaObjects(db).filter((entry) => !owned.has(entry.name))) !== JSON.stringify(inherited)) {
    fail('inherited_schema_changed');
  }
  const measured = Object.freeze({
    usage: Object.freeze(componentFingerprint(db, USAGE_STATISTICS_V3_OWNED_OBJECTS)),
    wallet: Object.freeze(componentFingerprint(db, DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS)),
  });
  if (JSON.stringify(measured) !== JSON.stringify(EXPECTED_PRIVATE_COMPONENT_TARGETS)) fail('target_fingerprint_mismatch');
  if ((db.pragma('foreign_key_check') as unknown[]).length !== 0
    || (db.pragma('quick_check') as Array<{ quick_check: string }>)[0]?.quick_check !== 'ok') fail('database_check_failed');
  return measured;
}

/** Verify sealed private source bytes before opening copies, then measure additive convergence. */
export function runPrivateSchemaConvergenceGate(options: PrivateConvergenceOptions): Readonly<{
  sourceCount: number;
  targets: typeof EXPECTED_PRIVATE_COMPONENT_TARGETS;
}> {
  if (options.fixturePaths.length !== 2 || new Set(options.fixturePaths.map((item) => path.resolve(item))).size !== 2) {
    fail('fixture_set_invalid');
  }
  const manifest = parseManifest(options.manifestPath);
  const verified = options.fixturePaths.map((fixture) => verifiedFixtureBytes(options.manifestPath, manifest, fixture));
  const tempRoot = path.resolve(options.tempRoot ?? process.env.NASSAJ_TEST_TEMP_ROOT
    ?? process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? os.tmpdir());
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(tempRoot, 'nassaj-schema-convergence-'));
  const openDatabase = options.databaseFactory ?? ((filename: string) => new Database(filename));
  try {
    const targets = verified.map((bytes, index) => {
      const copy = path.join(scratch, `source-${index}.sqlite`);
      writeFileSync(copy, bytes, { mode: 0o600 });
      chmodSync(copy, 0o600);
      const db = openDatabase(copy);
      try { return applyAndMeasure(db); } finally { db.close(); }
    });
    if (JSON.stringify(targets[0]) !== JSON.stringify(targets[1])) fail('sources_do_not_converge');
    return Object.freeze({ sourceCount: targets.length, targets: targets[0] });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' },
    fixture: { type: 'string', multiple: true },
    'temp-root': { type: 'string' },
  } });
  const manifestPath = values.manifest ?? fail('arguments_invalid');
  const fixturePaths = values.fixture ?? fail('arguments_invalid');
  const report = runPrivateSchemaConvergenceGate({
    manifestPath,
    fixturePaths,
    tempRoot: values['temp-root'],
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'release_schema_private_gate_failed'}\n`);
    process.exitCode = 1;
  }
}
