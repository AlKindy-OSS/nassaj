import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- integration test exercises real migration owners. */
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
import { initialConnectorPolicyV2SubstrateState,
  migrateConnectorPolicyV2Substrate } from '../database/connector-policy-v2.migration.js';
/* eslint-enable boundaries/dependencies */

import { runConnectorAutoSetupOnBoot, type ConnectorAutoSetupDeps } from './connector-auto-setup.js';
import { ConnectorInstallationOriginV2Store } from './connector-installation-readiness-v2.js';
import type { ConnectorLocalActivation } from './connector-local-activation.js';
import { ConnectorOwnerSetupService } from './connector-owner-setup.service.js';
import { SqliteConnectorPolicyV2Store } from './connector-policy-v2-store.js';
import { openOrCreateConnectorRuntimeAuthorityRoot } from './connector-runtime-authority-root.js';
import { inspectConnectorSetup } from './connector-setup-doctor.js';
import { ConnectorSetupStore } from './connector-setup-store.js';
import {
  assertSafeConnectorKeyDir, buildConnectorGlobalPack, buildConnectorTrustBundle,
  CONNECTOR_SIGNING_DEFAULT_CERTIFY, connectorPrivateKeyPath, connectorPublicKeyPath,
  generateConnectorEd25519KeyPair, parseConnectorCertifySpec, signAndVerifyConnectorGlobalPack,
} from './connector-signing-core.js';
import { executeConnectorPolicyV2LifecycleWrite,
  initializeConnectorPolicyV2SubstrateOnly } from './connector-substrate-only.production.js';
import { parseConnectorTrustBundle } from './connector-trust-bundle.js';

const VALID_ORIGIN = 'https://nassaj.auto-setup.test';

type Harness = Readonly<{ database: Database.Database; installationId: string; dir: string;
  service: ConnectorOwnerSetupService; setupStore: ConnectorSetupStore; setNow: (ms: number) => void;
  deps: (env: Record<string, string>) => ConnectorAutoSetupDeps; cleanup: () => void }>;

/** Builds a real substrate DB and an owner-setup service wired to real stores. */
const harness = (): Harness => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL,
    status TEXT NOT NULL, is_active INTEGER NOT NULL); INSERT INTO users VALUES (7,'owner','active',1);`);
  migrateConnectorAuthSchema(database);
  const installationId = migrateConnectorPolicyV2Substrate(database);
  const dir = mkdtempSync('/var/tmp/nassaj-auto-setup-');
  const authorityPath = join(dir, 'authority.json');
  let nowMs = Date.now();
  const clock = (): number => nowMs;
  const prior = process.env.NASSAJ_CONNECTOR_AUTO_SETUP;
  process.env.NASSAJ_CONNECTOR_AUTO_SETUP = '0'; // the substrate init's own call must be a no-op here
  // Share the test clock with the runtime fence so its clock high-water mark stays
  // monotonic with the service/auto-setup clock (otherwise the doctor's preflight sees
  // a rollback and blocks the substrate).
  try {
    assert.equal(initializeConnectorPolicyV2SubstrateOnly(database, authorityPath, clock).ready, true);
  } finally {
    if (prior === undefined) delete process.env.NASSAJ_CONNECTOR_AUTO_SETUP;
    else process.env.NASSAJ_CONNECTOR_AUTO_SETUP = prior;
  }
  const authority = openOrCreateConnectorRuntimeAuthorityRoot(authorityPath).authority;
  const setupStore = new ConnectorSetupStore(database, false);
  const policy = new SqliteConnectorPolicyV2Store(database, installationId, initialConnectorPolicyV2SubstrateState(),
    { initializeSchema: false, recoverPlacementIntents: false });
  const originStore = new ConnectorInstallationOriginV2Store(database, policy,
    { initializeSchema: false, allowInitialOriginBootstrap: true, allowLoopbackDevelopment: true });
  // Use the live fenced writer the substrate init just installed, so writes pass the
  // runtime fence exactly as they do in production instead of a bypass stub.
  const service = new ConnectorOwnerSetupService(database, installationId, authority, setupStore, originStore,
    (_advance, effect) => executeConnectorPolicyV2LifecycleWrite(effect), clock);
  const deps = (env: Record<string, string>): ConnectorAutoSetupDeps => Object.freeze({ database, installationId,
    authority, service, setupStore, env: env as NodeJS.ProcessEnv, now: clock, repoRoot: process.cwd() });
  return { database, installationId, dir, service, setupStore, setNow: (ms: number) => { nowMs = ms; },
    deps, cleanup: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
};

const enabledEnv = (h: Harness, extra: Record<string, string> = {}): Record<string, string> => ({
  NASSAJ_CONNECTOR_AUTO_SETUP: '1', NASSAJ_PUBLIC_ORIGIN: VALID_ORIGIN,
  NASSAJ_CONNECTOR_SIGNING_KEY_DIR: join(h.dir, 'keys'), ...extra });
const step = (h: Harness, id: 'origin' | 'trust' | 'pack' | 'activation'): string =>
  inspectConnectorSetup(h.database, h.installationId, /* authority */ (h.deps({}).authority), Date.now())
    .checks.find(c => c.id === id)!.status;

const lockPathFor = (h: Harness): string => join(h.dir, 'keys', '.auto-setup.lock');
const TEST_FLOCK_EXECUTOR = Symbol.for('nassaj.connector-auto-setup.test-flock-executor');

/** Installs the non-production flock seam for one synchronous test callback. */
const withTestFlock = <T>(executor: (args: readonly string[], fd: number) => { status: number | null;
  signal: NodeJS.Signals | null; error?: Error }, effect: () => T): T => {
  const priorEnv = process.env.NODE_ENV;
  const prior = (globalThis as Record<PropertyKey, unknown>)[TEST_FLOCK_EXECUTOR];
  process.env.NODE_ENV = 'test';
  (globalThis as Record<PropertyKey, unknown>)[TEST_FLOCK_EXECUTOR] = executor;
  try { return effect(); } finally {
    if (priorEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnv;
    if (prior === undefined) delete (globalThis as Record<PropertyKey, unknown>)[TEST_FLOCK_EXECUTOR];
    else (globalThis as Record<PropertyKey, unknown>)[TEST_FLOCK_EXECUTOR] = prior;
  }
};

/** Runs an effect while auto-setup owns its lock and before its first database write. */
const mutateLockDuringSetup = (h: Harness, effect: (lockPath: string) => void): void => {
  const originalSetOrigin = h.service.setOrigin.bind(h.service);
  h.service.setOrigin = (...args: Parameters<ConnectorOwnerSetupService['setOrigin']>) => {
    effect(lockPathFor(h));
    return originalSetOrigin(...args);
  };
};

/**
 * Drives the four owner-setup steps directly through the service under an arbitrary issuer,
 * so a test can build a COMPLETE install whose active pack is NOT 'nassaj-auto-setup'.
 */
const completeSetupWithIssuer = (h: Harness, keyId: string,
  pair: Readonly<{ privateKeyPem: string; publicKeyPem: string }>, issuer: string): void => {
  const nowMs = h.deps({}).now();
  const ctx = (idempotencyKey: string, expectedRevision: number) => ({ ownerUserId: 7, idempotencyKey,
    expectedRevision, requestOrigin: VALID_ORIGIN, authTimeMs: nowMs, expiresAtMs: nowMs + 30_000, nowMs });
  const trustBundle = buildConnectorTrustBundle({ issuer, keyId, publicKeyPem: pair.publicKeyPem,
    revision: 1, nowMs });
  const pack = buildConnectorGlobalPack({ issuer, keyId, channel: 'stable', sequence: 1, issuedAtMs: nowMs,
    ttlDays: 30, certifications: parseConnectorCertifySpec(CONNECTOR_SIGNING_DEFAULT_CERTIFY) });
  const signed = signAndVerifyConnectorGlobalPack({ pack, privateKeyPem: pair.privateKeyPem,
    trustBundle, sequence: 1, nowMs });
  h.service.setOrigin({ canonicalOrigin: VALID_ORIGIN, expectedOriginRevision: 0 }, ctx('setup-origin', 0));
  h.service.importTrust({ bundle: trustBundle, expectedTrustBundleRevision: 0 }, ctx('setup-trust', 0));
  h.service.importPack({ envelope: signed.envelope }, ctx('setup-pack', 0));
  const status = h.service.status();
  const changes: ConnectorLocalActivation[] = status.activationCandidates
    .filter(candidate => candidate.certification === 'certified')
    .map(candidate => Object.freeze({ providerId: candidate.providerId, serviceId: candidate.serviceId,
      operation: candidate.operation as ConnectorLocalActivation['operation'], enabled: true,
      profileRevision: candidate.profileRequired ? candidate.profileRevision : null }));
  h.service.setActivations({ expectedRecordRevision: status.activationRecordRevision,
    globalPackDigest: signed.digest, changes }, ctx('setup-activation', status.activationRecordRevision));
};

test('flag off is a complete no-op: nothing is written', () => {
  const h = harness();
  try {
    const outcome = runConnectorAutoSetupOnBoot(h.deps({ NASSAJ_PUBLIC_ORIGIN: VALID_ORIGIN }));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason }, { ran: false, reason: 'disabled' });
    assert.equal(step(h, 'origin'), 'required');
    assert.equal(h.setupStore.readTrustBundle(h.installationId), null);
  } finally { h.cleanup(); }
});

test('fresh DB + valid origin reaches complete setup with github activated', () => {
  const h = harness();
  try {
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.equal(outcome.ran, true);
    assert.deepEqual([...outcome.stepsApplied], ['origin', 'trust', 'pack', 'activation']);
    const report = inspectConnectorSetup(h.database, h.installationId, h.deps({}).authority, Date.now());
    assert.equal(report.resumableStep, 'complete');
    assert.equal(report.readyForAccountLinking, true);
    assert.equal(h.service.status().origin?.canonicalOrigin, VALID_ORIGIN);
    assert.equal(h.service.status().activePack?.issuer, 'nassaj-auto-setup');
  } finally { h.cleanup(); }
});

test('a second run on a complete install is a no-op that writes nothing new', () => {
  const h = harness();
  try {
    runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    const before = h.service.status();
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason }, { ran: false, reason: 'already_complete' });
    const after = h.service.status();
    assert.equal(after.trustBundleRevision, before.trustBundleRevision);
    assert.equal(after.activePack?.sequence, before.activePack?.sequence);
    assert.equal(after.activationRecordRevision, before.activationRecordRevision);
  } finally { h.cleanup(); }
});

test('complete setup outside renewal window does not create a key directory or lock', () => {
  const h = harness();
  try {
    runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    const before = h.service.status();
    const unusedKeyDir = join(h.dir, 'must-not-exist');
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: unusedKeyDir })));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason },
      { ran: false, reason: 'already_complete' });
    assert.equal(existsSync(unusedKeyDir), false);
    const after = h.service.status();
    assert.equal(after.trustBundleRevision, before.trustBundleRevision);
    assert.equal(after.activePack?.sequence, before.activePack?.sequence);
    assert.equal(after.activationRecordRevision, before.activationRecordRevision);
  } finally { h.cleanup(); }
});

test('a concurrent contender fails closed while the first setup holds the lock', () => {
  const h = harness();
  try {
    const originalSetOrigin = h.service.setOrigin.bind(h.service);
    let contender: ReturnType<typeof runConnectorAutoSetupOnBoot> | undefined;
    h.service.setOrigin = (...args: Parameters<ConnectorOwnerSetupService['setOrigin']>) => {
      contender = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
      return originalSetOrigin(...args);
    };
    const winner = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.equal(winner.reason, 'configured');
    assert.deepEqual({ ran: contender?.ran, reason: contender?.reason },
      { ran: false, reason: 'locked' });
  } finally { h.cleanup(); }
});

test('a SIGKILL releases the kernel lock for the next boot', async () => {
  const h = harness();
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const keyDir = join(h.dir, 'keys');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    writeFileSync(lockPathFor(h), '', { mode: 0o600 });
    holder = spawn('/bin/sh', ['-c', 'exec 3<> "$1"; /usr/bin/flock -x 3; printf held; exec sleep 60',
      'sh', lockPathFor(h)], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(holder.stdout!, 'data');
    const blocked = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.deepEqual({ ran: blocked.ran, reason: blocked.reason }, { ran: false, reason: 'locked' });
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    holder = undefined;
    assert.equal(runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h))).reason, 'configured');
  } finally {
    holder?.kill('SIGKILL');
    h.cleanup();
  }
});

test('the locked preflight observes setup completed after the initial preflight', () => {
  const h = harness();
  try {
    const pair = generateConnectorEd25519KeyPair();
    const originalStatus = h.service.status.bind(h.service);
    let statusCalls = 0;
    h.service.status = () => {
      statusCalls += 1;
      if (statusCalls === 2) {
        h.service.status = originalStatus;
        completeSetupWithIssuer(h, 'operator-race-key', pair, 'operator-race');
      }
      return originalStatus();
    };
    const keyDir = join(h.dir, 'auto-key-must-not-be-created');
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: keyDir })));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason },
      { ran: false, reason: 'already_complete' });
    assert.equal(existsSync(connectorPrivateKeyPath(keyDir, 'auto-setup-owner-1')), false);
    assert.equal(h.service.status().activePack?.issuer, 'operator-race');
  } finally { h.cleanup(); }
});

test('a legacy token lock is reused as a stable inode and its contents are preserved', () => {
  const h = harness();
  try {
    const keyDir = join(h.dir, 'keys');
    const lockPath = join(keyDir, '.auto-setup.lock');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, 'other-process', { mode: 0o600 });
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason }, { ran: true, reason: 'configured' });
    assert.equal(readFileSync(lockPath, 'utf8'), 'other-process');
    assert.equal(step(h, 'origin'), 'ok');
  } finally { h.cleanup(); }
});

test('normal lock cleanup retains the permanent lock pathname', () => {
  const h = harness();
  try {
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.equal(outcome.reason, 'configured');
    assert.equal(existsSync(lockPathFor(h)), true);
    assert.equal(readFileSync(lockPathFor(h), 'utf8'), '');
  } finally { h.cleanup(); }
});

test('replacement pathname is never unlinked or inspected during cleanup', () => {
  const h = harness();
  try {
    mutateLockDuringSetup(h, lockPath => {
      assert.equal(statSync(lockPath).mode & 0o777, 0o600);
      const ownedInode = statSync(lockPath).ino;
      rmSync(lockPath);
      writeFileSync(lockPath, 'replacement-lock\n', { mode: 0o600 });
      assert.notEqual(statSync(lockPath).ino, ownedInode);
    });
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.equal(outcome.reason, 'configured');
    assert.equal(readFileSync(lockPathFor(h), 'utf8'), 'replacement-lock\n');
  } finally { h.cleanup(); }
});

test('replacing keyDir after FD binding cannot redirect the lock or write a lock in the replacement', () => {
  const h = harness();
  try {
    mutateLockDuringSetup(h, lockPath => {
      const keyDir = join(h.dir, 'keys');
      const boundDir = join(h.dir, 'keys-bound');
      renameSync(keyDir, boundDir);
      mkdirSync(keyDir, { mode: 0o700 });
      assert.equal(existsSync(join(keyDir, '.auto-setup.lock')), false);
      const contender = spawnSync('/usr/bin/flock', ['-x', '-n', '-E', '75', join(boundDir, '.auto-setup.lock'), '/usr/bin/true']);
      assert.equal(contender.status, 75, 'the descriptor-bound original inode remains locked');
    });
    assert.equal(runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h))).reason, 'configured');
    assert.equal(existsSync(join(h.dir, 'keys', '.auto-setup.lock')), false);
    assert.equal(existsSync(connectorPrivateKeyPath(join(h.dir, 'keys'), 'auto-setup-owner-1')), false);
    assert.equal(existsSync(connectorPrivateKeyPath(join(h.dir, 'keys-bound'), 'auto-setup-owner-1')), true);
  } finally { h.cleanup(); }
});

test('untrusted ancestor permissions and lock inode forms fail closed before setup writes', () => {
  const h = harness();
  try {
    const ancestor = join(h.dir, 'untrusted');
    mkdirSync(ancestor, { mode: 0o700 });
    chmodSync(ancestor, 0o777);
    const ancestorResult = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: join(ancestor, 'keys') })));
    assert.equal(ancestorResult.blocker, 'CONNECTOR_AUTO_SETUP_LOCKDIR_UNTRUSTED');
    chmodSync(ancestor, 0o700);

    const sharedLeaf = join(h.dir, 'shared-leaf');
    mkdirSync(sharedLeaf, { mode: 0o700 });
    chmodSync(sharedLeaf, 0o1777);
    const sharedLeafResult = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: sharedLeaf })));
    assert.equal(sharedLeafResult.blocker, 'CONNECTOR_AUTO_SETUP_LOCKDIR_UNTRUSTED');
    chmodSync(sharedLeaf, 0o700);

    for (const kind of ['symlink', 'directory', 'hardlink', 'permissions'] as const) {
      const keyDir = join(h.dir, `lock-${kind}`);
      mkdirSync(keyDir, { mode: 0o700 });
      const lock = join(keyDir, '.auto-setup.lock');
      if (kind === 'symlink') {
        const target = join(h.dir, `target-${kind}`);
        writeFileSync(target, '', { mode: 0o600 });
        symlinkSync(target, lock);
      } else if (kind === 'directory') mkdirSync(lock, { mode: 0o700 });
      else {
        writeFileSync(lock, '', { mode: 0o600 });
        if (kind === 'hardlink') linkSync(lock, join(keyDir, 'linked-lock'));
        else chmodSync(lock, 0o640);
      }
      const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
        { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: keyDir })));
      assert.equal(outcome.ran, false, kind);
      assert.equal(outcome.reason, 'failed', kind);
      assert.equal(outcome.blocker, 'CONNECTOR_AUTO_SETUP_LOCK_UNTRUSTED', kind);
    }
    assert.equal(step(h, 'origin'), 'required');
  } finally { h.cleanup(); }
});

test('a lock file with an untrusted owner fails closed', t => {
  if ((process.getuid?.() ?? -1) !== 0) return t.skip('owner mutation requires root');
  const h = harness();
  try {
    const keyDir = join(h.dir, 'foreign-owned');
    mkdirSync(keyDir, { mode: 0o700 });
    const lock = join(keyDir, '.auto-setup.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    try { chownSync(lock, 65_534, 65_534); } catch { return t.skip('owner mutation capability unavailable'); }
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: keyDir })));
    assert.equal(outcome.blocker, 'CONNECTOR_AUTO_SETUP_LOCK_UNTRUSTED');
    assert.equal(step(h, 'origin'), 'required');
  } finally { h.cleanup(); }
});

test('the fixed helper receives exact flock arguments; missing and nonzero outcomes fail closed', () => {
  const h = harness();
  try {
    let observed: readonly string[] | undefined;
    const missing = withTestFlock((args, fd) => {
      observed = args;
      assert.ok(Number.isInteger(fd));
      return { status: null, signal: null, error: new Error('missing') };
    }, () => runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h))));
    assert.deepEqual({ ran: missing.ran, reason: missing.reason, blocker: missing.blocker },
      { ran: false, reason: 'failed', blocker: 'CONNECTOR_AUTO_SETUP_LOCK_UNAVAILABLE' });
    assert.deepEqual(observed, ['-x', '-n', '3']);
    const nonzero = withTestFlock(() => ({ status: 2, signal: null }),
      () => runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h))));
    assert.deepEqual({ ran: nonzero.ran, reason: nonzero.reason, blocker: nonzero.blocker },
      { ran: false, reason: 'failed', blocker: 'CONNECTOR_AUTO_SETUP_LOCK_UNAVAILABLE' });
    assert.equal(step(h, 'origin'), 'required');
  } finally { h.cleanup(); }
});

test('an untrusted key directory fails closed before any setup write', () => {
  const h = harness();
  try {
    const keyDir = join(h.dir, 'shared-keys');
    mkdirSync(keyDir, { mode: 0o700 });
    chmodSync(keyDir, 0o770);
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: keyDir })));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason, blocker: outcome.blocker },
      { ran: false, reason: 'failed', blocker: 'CONNECTOR_AUTO_SETUP_LOCKDIR_UNTRUSTED' });
    assert.equal(step(h, 'origin'), 'required');
  } finally { h.cleanup(); }
});

test('a symlinked key directory fails closed before any setup write', () => {
  const h = harness();
  try {
    const target = join(h.dir, 'key-target');
    mkdirSync(target, { mode: 0o700 });
    const link = join(h.dir, 'key-link');
    symlinkSync(target, link);
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: link })));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason, blocker: outcome.blocker },
      { ran: false, reason: 'failed', blocker: 'CONNECTOR_AUTO_SETUP_LOCKDIR_UNTRUSTED' });
    assert.equal(step(h, 'origin'), 'required');
  } finally { h.cleanup(); }
});

test('missing, invalid, and production-loopback origins are skipped with a blocker and no writes', () => {
  for (const env of [
    { NASSAJ_CONNECTOR_AUTO_SETUP: '1' },
    { NASSAJ_CONNECTOR_AUTO_SETUP: '1', NASSAJ_PUBLIC_ORIGIN: 'not-a-url' },
    { NASSAJ_CONNECTOR_AUTO_SETUP: '1', NASSAJ_PUBLIC_ORIGIN: 'https://localhost', NODE_ENV: 'production' },
  ]) {
    const h = harness();
    try {
      const outcome = runConnectorAutoSetupOnBoot(h.deps({ ...env, NASSAJ_CONNECTOR_SIGNING_KEY_DIR: join(h.dir, 'k') }));
      assert.equal(outcome.ran, false);
      assert.equal(outcome.blocker, 'origin_missing_or_invalid');
      assert.equal(step(h, 'origin'), 'required');
    } finally { h.cleanup(); }
  }
});

test('an origin already set to a different value is never replaced', () => {
  const h = harness();
  try {
    runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h, { NASSAJ_PUBLIC_ORIGIN: 'https://other.test' })));
    assert.deepEqual({ ran: outcome.ran, blocker: outcome.blocker }, { ran: false, blocker: 'origin_conflict' });
    assert.equal(h.service.status().origin?.canonicalOrigin, VALID_ORIGIN);
  } finally { h.cleanup(); }
});

test('the generated private key is written 0600 and an unsafe key directory is rejected', () => {
  const h = harness();
  try {
    runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    const keyPath = connectorPrivateKeyPath(join(h.dir, 'keys'), 'auto-setup-owner-1');
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  } finally { h.cleanup(); }
  for (const [extra, blocker] of [
    [{ NASSAJ_CONNECTOR_SIGNING_KEY_DIR: join(process.cwd(), '.git', 'connector-keys') }, /KEYDIR_FORBIDDEN/u],
    [{ NASSAJ_CONNECTOR_SIGNING_KEY_ID: '../../escape' }, /ID_INVALID/u],
  ] as const) {
    const fresh = harness();
    try {
      const rejected = runConnectorAutoSetupOnBoot(fresh.deps(enabledEnv(fresh, extra)));
      assert.equal(rejected.ran, false);
      assert.equal(rejected.reason, 'key_dir_unsafe');
      assert.match(rejected.blocker ?? '', blocker);
    } finally { fresh.cleanup(); }
  }
});

test('an auto-setup pack inside its expiry window is renewed and rebound on boot', () => {
  const h = harness();
  try {
    runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    const before = h.service.status();
    h.setNow(Date.parse(before.packExpiresAt!) - 3 * 24 * 60 * 60 * 1_000); // 3 days before expiry
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.equal(outcome.reason, 'renewed');
    const after = h.service.status();
    assert.equal(after.activePack!.sequence, before.activePack!.sequence + 1);
    assert.ok(Date.parse(after.packExpiresAt!) > Date.parse(before.packExpiresAt!));
    const report = inspectConnectorSetup(h.database, h.installationId, h.deps({}).authority, h.deps({}).now());
    assert.equal(report.resumableStep, 'complete');
  } finally { h.cleanup(); }
});

test('an unwritable/erroring lock directory returns failed and never throws or writes', () => {
  const h = harness();
  try {
    // A regular file where a directory is expected: acquireLock's mkdirSync throws ENOTDIR
    // from OUTSIDE the original inner try, exercising the fail-closed lock path.
    const blocker = join(h.dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    let outcome: ReturnType<typeof runConnectorAutoSetupOnBoot> | undefined;
    assert.doesNotThrow(() => {
      outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
        { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: join(blocker, 'keys') })));
    });
    assert.equal(outcome!.ran, false);
    assert.equal(outcome!.reason, 'failed');
    assert.equal(step(h, 'origin'), 'required');
    assert.equal(h.setupStore.readTrustBundle(h.installationId), null);
  } finally { h.cleanup(); }
});

test('no owner-role user: auto-setup is skipped with a blocker and writes nothing', () => {
  const h = harness();
  try {
    h.database.exec("DELETE FROM users"); // installation has no owner to attribute writes to
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
    assert.deepEqual({ ran: outcome.ran, reason: outcome.reason, blocker: outcome.blocker },
      { ran: false, reason: 'no_owner', blocker: 'no_owner_user' });
    assert.equal(step(h, 'origin'), 'required');
    assert.equal(h.setupStore.readTrustBundle(h.installationId), null);
    assert.equal(existsSync(join(h.dir, 'keys')), false, 'no key directory or lock is created');
  } finally { h.cleanup(); }
});

for (const ownerState of [
  { name: 'inactive', sql: 'UPDATE users SET is_active=0 WHERE id=7' },
  { name: 'disabled', sql: "UPDATE users SET status='disabled' WHERE id=7" },
] as const) {
  test(`${ownerState.name} owner is treated as no_owner with zero setup writes`, () => {
    const h = harness();
    try {
      h.database.exec(ownerState.sql);
      const beforeEvents = (h.database.prepare(
        'SELECT COUNT(*) AS count FROM connector_setup_event',
      ).get() as { count: number }).count;
      const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h)));
      const afterEvents = (h.database.prepare(
        'SELECT COUNT(*) AS count FROM connector_setup_event',
      ).get() as { count: number }).count;
      assert.deepEqual({ ran: outcome.ran, reason: outcome.reason, blocker: outcome.blocker },
        { ran: false, reason: 'no_owner', blocker: 'no_owner_user' });
      assert.equal(afterEvents, beforeEvents, 'owner setup service performs no write');
      assert.equal(step(h, 'origin'), 'required');
      assert.equal(h.setupStore.readTrustBundle(h.installationId), null);
      assert.equal(h.service.status().activePack, null);
      assert.equal(h.service.status().activationRecordRevision, 0);
      assert.equal(existsSync(join(h.dir, 'keys')), false, 'no key directory, lock, or private key is created');
    } finally { h.cleanup(); }
  });
}

test('a complete install whose pack was issued by a different issuer is never renewed', () => {
  const h = harness();
  try {
    const keyDir = join(h.dir, 'foreign');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const pair = generateConnectorEd25519KeyPair();
    const keyId = 'operator-key-1';
    writeFileSync(connectorPrivateKeyPath(keyDir, keyId), pair.privateKeyPem, { mode: 0o600 });
    writeFileSync(connectorPublicKeyPath(keyDir, keyId), pair.publicKeyPem, { mode: 0o644 });
    // Build a COMPLETE install under a foreign (operator) issuer, not 'nassaj-auto-setup'.
    completeSetupWithIssuer(h, keyId, pair, 'nassaj-oss-owner');
    const before = h.service.status();
    assert.equal(before.activePack?.issuer, 'nassaj-oss-owner');
    // Move the clock inside the 7-day renewal window; a same-issuer pack would be renewed.
    h.setNow(Date.parse(before.packExpiresAt!) - 3 * 24 * 60 * 60 * 1_000);
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: keyDir, NASSAJ_CONNECTOR_SIGNING_KEY_ID: keyId })));
    assert.equal(outcome.reason, 'already_complete');
    const after = h.service.status();
    assert.equal(after.activePack?.sequence, before.activePack?.sequence);
    assert.equal(after.activePack?.digest, before.activePack?.digest);
  } finally { h.cleanup(); }
});

test('a key directory that symlinks into the repo .git tree is rejected', () => {
  const dir = mkdtempSync('/var/tmp/nassaj-signing-symlink-');
  try {
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    const link = join(dir, 'link-into-git');
    symlinkSync(gitDir, link); // a symlink whose lexical path looks safe but resolves into .git
    assert.throws(() => assertSafeConnectorKeyDir(join(link, 'connector-signing'), gitDir),
      /CONNECTOR_SIGN_KEYDIR_FORBIDDEN/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pre-provisioned key is reused rather than regenerated', () => {
  const h = harness();
  try {
    const keyDir = join(h.dir, 'preprovisioned');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const pair = generateConnectorEd25519KeyPair();
    writeFileSync(connectorPrivateKeyPath(keyDir, 'auto-setup-owner-1'), pair.privateKeyPem, { mode: 0o600 });
    writeFileSync(connectorPublicKeyPath(keyDir, 'auto-setup-owner-1'), pair.publicKeyPem, { mode: 0o644 });
    const outcome = runConnectorAutoSetupOnBoot(h.deps(enabledEnv(h,
      { NASSAJ_CONNECTOR_SIGNING_KEY_DIR: keyDir })));
    assert.equal(outcome.ran, true);
    const bundle = parseConnectorTrustBundle(JSON.parse(h.setupStore.readTrustBundle(h.installationId)!.bundleJson));
    assert.equal(bundle?.roots[0].publicKeyPem, pair.publicKeyPem);
  } finally { h.cleanup(); }
});
