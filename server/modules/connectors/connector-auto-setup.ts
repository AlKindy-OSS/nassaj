/**
 * First-boot connector operator auto-setup (ADR-162, T-1831).
 *
 * When an installation opts in with `NASSAJ_CONNECTOR_AUTO_SETUP=1` and supplies
 * an exact public origin in `NASSAJ_PUBLIC_ORIGIN`, this initializer performs the
 * owner Setup sequence the operator would otherwise click through — set origin,
 * import a self-signed trust bundle (rev 1), import a github/api_key certification
 * pack, and activate github — by calling ConnectorOwnerSetupService directly with
 * a narrowly-scoped system/owner Context. It does not weaken the HTTP owner gate.
 *
 * Design decisions (T-1831):
 * - The flag is a standalone opt-in for THIS automation only. It never flips the
 *   independent runtime gates (NASSAJ_CONNECTOR_GRANTS_V2, *_AUTH_REGISTRY_V1,
 *   *_CERT_GITHUB); those stay the operator's explicit choice for the connector
 *   runtime. Auto-setup only writes the origin/trust/pack/activation substrate.
 * - Origin is adopted ONLY from NASSAJ_PUBLIC_ORIGIN (strict canonical, https,
 *   non-loopback in production); never from a request header. Missing/invalid or
 *   an owner-set different origin ⇒ skip, log a blocker, write nothing.
 * - The signing key is generated locally (Ed25519, 0600) under the operator key
 *   directory, or a pre-provisioned key is reused via NASSAJ_CONNECTOR_SIGNING_KEY_DIR
 *   / _KEY_ID. The .git and tmpfs refusals from the signing core are reused.
 * - Fully idempotent: inspectConnectorSetup gates each step; a complete install is
 *   a no-op. Existing origin/trust/pack are never replaced — only missing steps we
 *   own are filled. Each step is an atomic, fenced, CAS-guarded service call, so a
 *   mid-run failure leaves only completed, valid steps that resume on the next boot.
 * - Pack renewal on boot: because auto-setup keeps the signing key locally it can
 *   re-mint its own expiring pack (same trust) and rebind activation. Renewal runs
 *   only for a pack this automation issued and only inside the expiry window.
 * - Concurrency-safe via an exclusive lock file; secrets are never logged.
 */

import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';

import { connectorEnvironmentOriginProposal } from './connector-installation-origin-resolver.js';
import type { ConnectorOwnerSetupService } from './connector-owner-setup.service.js';
import type { ConnectorRuntimeAuthority } from './connector-runtime-fence.js';
import type { ConnectorLocalActivation } from './connector-local-activation.js';
import { inspectConnectorSetup } from './connector-setup-doctor.js';
import type { ConnectorSetupStore } from './connector-setup-store.js';
import {
  CONNECTOR_SIGNING_DEFAULT_CERTIFY, ConnectorSigningError, assertSafeConnectorKeyDir,
  buildConnectorGlobalPack, buildConnectorTrustBundle, connectorPrivateKeyPath, connectorPublicKeyPath,
  generateConnectorEd25519KeyPair, parseConnectorCertifySpec, readConnectorPrivateKey,
  signAndVerifyConnectorGlobalPack, validateConnectorSigningId, writeConnectorSigningFile,
} from './connector-signing-core.js';

export const CONNECTOR_AUTO_SETUP_FLAG = 'NASSAJ_CONNECTOR_AUTO_SETUP';
const ORIGIN_ENV = 'NASSAJ_PUBLIC_ORIGIN';
const KEY_DIR_ENV = 'NASSAJ_CONNECTOR_SIGNING_KEY_DIR';
const KEY_ID_ENV = 'NASSAJ_CONNECTOR_SIGNING_KEY_ID';
// Reserved issuer name: only packs this automation itself issued carry AUTO_SETUP_ISSUER,
// and only those are ever re-minted/rebound on boot (see maybeRenewPack). An operator-issued
// pack under any other issuer id — including one imported by hand — is left untouched. Do not
// reuse 'nassaj-auto-setup' as an operator/distribution issuer id.
const AUTO_SETUP_ISSUER = 'nassaj-auto-setup';
const DEFAULT_KEY_ID = 'auto-setup-owner-1';
const PACK_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const LOG_TAG = '[connector-auto-setup]';

type Context = Parameters<ConnectorOwnerSetupService['setOrigin']>[1];

export type ConnectorAutoSetupDeps = Readonly<{
  database: Database; installationId: string; authority: ConnectorRuntimeAuthority;
  service: ConnectorOwnerSetupService; setupStore: ConnectorSetupStore;
  env: NodeJS.ProcessEnv; now: () => number; repoRoot: string;
}>;

export type ConnectorAutoSetupResult = Readonly<{
  ran: boolean; reason: string; stepsApplied: readonly string[]; blocker: string | null;
}>;

const result = (ran: boolean, reason: string, stepsApplied: readonly string[] = [],
  blocker: string | null = null): ConnectorAutoSetupResult =>
  Object.freeze({ ran, reason, stepsApplied: Object.freeze([...stepsApplied]), blocker });

/** Default operator key directory, outside the repo and off tmpfs. */
const defaultKeyDir = (): string => path.join(os.homedir(), '.config', 'nassaj', 'connector-signing');

/** Resolves the exact public origin from NASSAJ_PUBLIC_ORIGIN, or null when unusable. */
const resolveOrigin = (env: NodeJS.ProcessEnv): string | null => {
  const production = env.NODE_ENV === 'production';
  try {
    const proposal = connectorEnvironmentOriginProposal(env[ORIGIN_ENV]?.trim() || undefined, !production);
    if (!proposal) return null;
    const hostname = new URL(proposal.canonicalOrigin).hostname;
    if (production && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return null;
    return proposal.canonicalOrigin;
  } catch { return null; }
};

/** Reads a pre-provisioned key pair or generates and persists a fresh 0600 key. */
const loadOrCreateKey = (keyDir: string, keyId: string): Readonly<{ privateKeyPem: string; publicKeyPem: string }> => {
  const privatePath = connectorPrivateKeyPath(keyDir, keyId);
  const publicPath = connectorPublicKeyPath(keyDir, keyId);
  if (fs.existsSync(privatePath)) {
    const privateKeyPem = readConnectorPrivateKey(keyDir, keyId);
    const publicKeyPem = fs.existsSync(publicPath) ? fs.readFileSync(publicPath, 'utf8') : deriverPublic(privateKeyPem);
    return Object.freeze({ privateKeyPem, publicKeyPem });
  }
  const pair = generateConnectorEd25519KeyPair();
  writeConnectorSigningFile(privatePath, pair.privateKeyPem, 0o600);
  writeConnectorSigningFile(publicPath, pair.publicKeyPem, 0o644);
  return pair;
};

/** Recovers the SPKI public PEM from a private key when the public file is absent. */
const deriverPublic = (privateKeyPem: string): string =>
  createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();

type MintedArtifacts = Readonly<{ trustBundle: ReturnType<typeof buildConnectorTrustBundle>;
  envelope: { pack: unknown; signature: string }; digest: string }>;

/** Mints the trust bundle (rev 1) and a github/api_key certification pack for one sequence. */
const mintArtifacts = (input: Readonly<{ keyId: string; publicKeyPem: string;
  privateKeyPem: string; nowMs: number; sequence: number }>): MintedArtifacts => {
  const trustBundle = buildConnectorTrustBundle({ issuer: AUTO_SETUP_ISSUER, keyId: input.keyId,
    publicKeyPem: input.publicKeyPem, revision: 1, nowMs: input.nowMs });
  const pack = buildConnectorGlobalPack({ issuer: AUTO_SETUP_ISSUER, keyId: input.keyId, channel: 'stable',
    sequence: input.sequence, issuedAtMs: input.nowMs, ttlDays: 30,
    certifications: parseConnectorCertifySpec(CONNECTOR_SIGNING_DEFAULT_CERTIFY) });
  const signed = signAndVerifyConnectorGlobalPack({ pack, privateKeyPem: input.privateKeyPem,
    trustBundle, sequence: input.sequence, nowMs: input.nowMs });
  return Object.freeze({ trustBundle, envelope: signed.envelope, digest: signed.digest });
};

/**
 * The installation owner's user id for setup provenance, or null when no owner-role
 * user exists. Auto-setup never attributes owner writes to an arbitrary member: with
 * no owner the whole run is skipped and nothing is written.
 */
const systemOwnerUserId = (database: Database): number | null => {
  try {
    const owner = database.prepare(
      "SELECT id FROM users WHERE role='owner' AND is_active=1 AND status='active' ORDER BY id ASC LIMIT 1",
    )
      .get() as { id: number } | undefined;
    return Number.isSafeInteger(owner?.id) && (owner?.id ?? 0) > 0 ? owner!.id : null;
  } catch { return null; }
};

/** Revalidates the exact selected owner immediately before each setup write. */
const assertSystemOwnerCurrent = (database: Database, ownerUserId: number): void => {
  const row = database.prepare(
    "SELECT 1 FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active' LIMIT 1",
  ).get(ownerUserId);
  if (!row) {
    throw new ConnectorSigningError(
      'CONNECTOR_AUTO_SETUP_OWNER_STALE',
      'The selected setup owner is no longer active.',
    );
  }
};

const context = (ownerUserId: number, origin: string, expectedRevision: number,
  idempotencyKey: string, nowMs: number): Context => Object.freeze({ ownerUserId, idempotencyKey,
    expectedRevision, requestOrigin: origin, authTimeMs: nowMs, expiresAtMs: nowMs + 30_000, nowMs });

const checkOk = (report: ReturnType<typeof inspectConnectorSetup>,
  id: 'origin' | 'trust' | 'pack' | 'activation'): boolean =>
  report.checks.find(item => item.id === id)?.status === 'ok';

const certifiedChanges = (service: ConnectorOwnerSetupService): ConnectorLocalActivation[] =>
  service.status().activationCandidates.filter(candidate => candidate.certification === 'certified')
    .map(candidate => Object.freeze({ providerId: candidate.providerId, serviceId: candidate.serviceId,
      operation: candidate.operation as ConnectorLocalActivation['operation'], enabled: true,
      profileRevision: candidate.profileRequired ? candidate.profileRevision : null }));

/** Runs each still-missing owner-setup step in order; already-ok steps are skipped. */
const applyMissingSteps = (deps: ConnectorAutoSetupDeps, origin: string, ownerUserId: number,
  artifacts: MintedArtifacts): string[] => {
  const steps: string[] = [];
  const now = deps.now;
  const inspect = (): ReturnType<typeof inspectConnectorSetup> =>
    inspectConnectorSetup(deps.database, deps.installationId, deps.authority, now());
  if (!checkOk(inspect(), 'origin')) {
    assertSystemOwnerCurrent(deps.database, ownerUserId);
    deps.service.setOrigin({ canonicalOrigin: origin, expectedOriginRevision: 0 },
      context(ownerUserId, origin, 0, 'auto-setup-origin-1', now()));
    steps.push('origin');
  }
  if (!checkOk(inspect(), 'trust')) {
    assertSystemOwnerCurrent(deps.database, ownerUserId);
    deps.service.importTrust({ bundle: artifacts.trustBundle, expectedTrustBundleRevision: 0 },
      context(ownerUserId, origin, 0, 'auto-setup-trust-1', now()));
    steps.push('trust');
  }
  if (!checkOk(inspect(), 'pack')) {
    assertSystemOwnerCurrent(deps.database, ownerUserId);
    deps.service.importPack({ envelope: artifacts.envelope },
      context(ownerUserId, origin, deps.service.status().activePack?.sequence ?? 0, 'auto-setup-pack-1', now()));
    steps.push('pack');
  }
  if (!checkOk(inspect(), 'activation')) applyActivation(deps, origin, ownerUserId, steps);
  return steps;
};

/** Enables the certified github operations, binding the activation record to the active pack. */
const applyActivation = (deps: ConnectorAutoSetupDeps, origin: string,
  ownerUserId: number, steps: string[]): void => {
  const status = deps.service.status();
  const digest = status.activePack?.digest;
  if (!digest) throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_PACK_MISSING', 'No active pack to activate.');
  assertSystemOwnerCurrent(deps.database, ownerUserId);
  deps.service.setActivations({ expectedRecordRevision: status.activationRecordRevision,
    globalPackDigest: digest, changes: certifiedChanges(deps.service) },
  context(ownerUserId, origin, status.activationRecordRevision, 'auto-setup-activation-1', deps.now()));
  steps.push('activation');
};

/** Re-mints and rebinds an auto-setup-issued pack when it is inside the expiry window. */
const maybeRenewPack = (deps: ConnectorAutoSetupDeps, origin: string, ownerUserId: number,
  keyId: string, key: Readonly<{ privateKeyPem: string; publicKeyPem: string }>): string[] => {
  const status = deps.service.status();
  const pack = status.activePack;
  const expiresAtMs = status.packExpiresAt ? Date.parse(status.packExpiresAt) : Number.NaN;
  if (!pack || pack.issuer !== AUTO_SETUP_ISSUER || !Number.isFinite(expiresAtMs)) return [];
  if (expiresAtMs - deps.now() > PACK_RENEWAL_WINDOW_MS) return [];
  const nowMs = deps.now();
  const sequence = pack.sequence + 1;
  const artifacts = mintArtifacts({ keyId, publicKeyPem: key.publicKeyPem,
    privateKeyPem: key.privateKeyPem, nowMs, sequence });
  assertSystemOwnerCurrent(deps.database, ownerUserId);
  deps.service.importPack({ envelope: artifacts.envelope },
    context(ownerUserId, origin, pack.sequence, `auto-setup-pack-renew-${sequence}`, nowMs));
  const rebind = deps.service.status();
  assertSystemOwnerCurrent(deps.database, ownerUserId);
  deps.service.setActivations({ expectedRecordRevision: rebind.activationRecordRevision,
    globalPackDigest: artifacts.digest, changes: certifiedChanges(deps.service) },
  context(ownerUserId, origin, rebind.activationRecordRevision, `auto-setup-activation-renew-${sequence}`, nowMs));
  return ['pack_renewed', 'activation_rebound'];
};

const FLOCK_PATH = '/usr/bin/flock';
const LOCK_FILE = '.auto-setup.lock';
const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const LOCK_OPEN_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;

type LockLease = Readonly<{ directoryFd: number; lockFd: number }>;

type FlockResult = Readonly<{ status: number | null; signal: NodeJS.Signals | null; error?: Error }>;
type TestFlockExecutor = (args: readonly string[], fd: number) => FlockResult;
const TEST_FLOCK_EXECUTOR = Symbol.for('nassaj.connector-auto-setup.test-flock-executor');

const closeNoThrow = (fd: number): void => {
  try { fs.closeSync(fd); } catch { /* Cleanup cannot replace the setup result. */ }
};

/** Closes bound descriptors only; the permanent lock pathname is never modified. */
const releaseLock = (lease: LockLease): void => {
  closeNoThrow(lease.lockFd);
  closeNoThrow(lease.directoryFd);
};

/** A process owner or root owns a directory/file we can safely bind into. */
const hasTrustedOwner = (stat: fs.Stats): boolean => stat.uid === 0 || stat.uid === (process.getuid?.() ?? -1);

/** `/var/tmp`-style sticky directories are safe shared ancestors only when root-owned. */
const isTrustedAncestorDirectory = (stat: fs.Stats): boolean => {
  if (!stat.isDirectory() || !hasTrustedOwner(stat)) return false;
  if ((stat.mode & 0o022) === 0) return true;
  return stat.uid === 0 && (stat.mode & 0o1000) !== 0;
};

/** The bound key directory itself must be private; sticky sharing is ancestor-only. */
const isTrustedLockDirectory = (stat: fs.Stats): boolean =>
  stat.isDirectory() && hasTrustedOwner(stat) && (stat.mode & 0o022) === 0;

const failUntrustedLockDirectory = (): never => {
  throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_LOCKDIR_UNTRUSTED', 'Lock directory is not trusted.');
};

const procFdPath = (fd: number, component?: string): string =>
  component === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${component}`;

/** Opens one trusted absolute directory chain without ever resolving a user path twice. */
const openTrustedLockDirectory = (keyDir: string): number => {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) {
    throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_LOCKDIR_UNTRUSTED', 'Linux procfd is required.');
  }
  const resolved = path.resolve(keyDir);
  const components = resolved.split(path.sep).filter(Boolean);
  let parentFd = fs.openSync(path.parse(resolved).root, DIRECTORY_OPEN_FLAGS);
  try {
    if (!isTrustedAncestorDirectory(fs.fstatSync(parentFd))) failUntrustedLockDirectory();
    for (const [index, component] of components.entries()) {
      let childFd: number;
      try {
        childFd = fs.openSync(procFdPath(parentFd, component), DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOTDIR') failUntrustedLockDirectory();
        if (code !== 'ENOENT') throw error;
        fs.mkdirSync(procFdPath(parentFd, component), { mode: 0o700 });
        childFd = fs.openSync(procFdPath(parentFd, component), DIRECTORY_OPEN_FLAGS);
      }
      closeNoThrow(parentFd);
      parentFd = childFd;
      const trustCheck = index === components.length - 1
        ? isTrustedLockDirectory : isTrustedAncestorDirectory;
      if (!trustCheck(fs.fstatSync(parentFd))) failUntrustedLockDirectory();
    }
    const directoryFd = parentFd;
    parentFd = -1;
    return directoryFd;
  } finally {
    if (parentFd >= 0) closeNoThrow(parentFd);
  }
};

/** Opens the permanent lock through the bound directory and verifies its inode properties. */
const openTrustedLockFile = (directoryFd: number): number => {
  let lockFd: number;
  try {
    lockFd = fs.openSync(procFdPath(directoryFd, LOCK_FILE), LOCK_OPEN_FLAGS, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_LOCK_UNTRUSTED', 'Lock file is not private.');
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(lockFd);
    if (!stat.isFile() || stat.nlink !== 1 || !hasTrustedOwner(stat) || (stat.mode & 0o777) !== 0o600) {
      throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_LOCK_UNTRUSTED', 'Lock file is not private.');
    }
    return lockFd;
  } catch (error) {
    closeNoThrow(lockFd);
    throw error;
  }
};

/** Test-only process-local seam; production always executes the fixed absolute helper. */
const invokeFlock = (fd: number): FlockResult => {
  const seam = process.env.NODE_ENV === 'test'
    ? (globalThis as Record<PropertyKey, unknown>)[TEST_FLOCK_EXECUTOR] as TestFlockExecutor | undefined
    : undefined;
  const args = Object.freeze(['-x', '-n', '3']);
  return seam ? seam(args, fd) : spawnSync(FLOCK_PATH, args, { stdio: ['ignore', 'ignore', 'ignore', fd] });
};

/**
 * Takes a kernel-held exclusive lock through a permanently bound trusted directory. The inherited descriptor means
 * flock's lock remains attached to this process's open file description after its helper
 * exits. Legacy token-file contents are intentionally ignored and preserved.
 */
const acquireLock = (keyDir: string): LockLease | null => {
  const directoryFd = openTrustedLockDirectory(keyDir);
  let lockFd: number | null = null;
  let leased = false;
  try {
    lockFd = openTrustedLockFile(directoryFd);
    const invocation = invokeFlock(lockFd);
    if (invocation.error || invocation.status === null) {
      throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_LOCK_UNAVAILABLE', 'flock helper is unavailable.');
    }
    if (invocation.status === 1) return null;
    if (invocation.status !== 0) {
      throw new ConnectorSigningError('CONNECTOR_AUTO_SETUP_LOCK_UNAVAILABLE', 'flock helper failed.');
    }
    const lease = Object.freeze({ directoryFd, lockFd });
    lockFd = null;
    leased = true;
    return lease;
  } finally {
    if (!leased) {
      if (lockFd !== null) closeNoThrow(lockFd);
      closeNoThrow(directoryFd);
    }
  }
};

type SetupPreflight = Readonly<{
  complete: boolean;
  renewalRequired: boolean;
  originConflict: boolean;
}>;

/** Read-only setup decision used before and after lock acquisition. */
const inspectSetupPreflight = (deps: ConnectorAutoSetupDeps, origin: string): SetupPreflight => {
  const nowMs = deps.now();
  const status = deps.service.status();
  const originConflict = Boolean(status.origin && status.origin.canonicalOrigin !== origin);
  const complete = !originConflict
    && inspectConnectorSetup(deps.database, deps.installationId, deps.authority, nowMs).resumableStep
      === 'complete';
  const expiresAtMs = status.packExpiresAt ? Date.parse(status.packExpiresAt) : Number.NaN;
  const renewalRequired = complete && status.activePack?.issuer === AUTO_SETUP_ISSUER
    && Number.isFinite(expiresAtMs) && expiresAtMs - nowMs <= PACK_RENEWAL_WINDOW_MS;
  return Object.freeze({ complete, renewalRequired, originConflict });
};

/** Returns a terminal, read-only preflight result when no setup work is required. */
const terminalPreflightResult = (preflight: SetupPreflight): ConnectorAutoSetupResult | null => {
  if (preflight.originConflict) return result(false, 'origin_conflict', [], 'origin_conflict');
  if (preflight.complete && !preflight.renewalRequired) return result(false, 'already_complete');
  return null;
};

/**
 * Performs opt-in first-boot connector operator setup. Safe to call on every boot:
 * it is idempotent, fail-closed, and a no-op unless the flag and a valid origin are set.
 */
export const runConnectorAutoSetupOnBoot = (deps: ConnectorAutoSetupDeps): ConnectorAutoSetupResult => {
  if (deps.env[CONNECTOR_AUTO_SETUP_FLAG] !== '1') return result(false, 'disabled');
  const origin = resolveOrigin(deps.env);
  if (!origin) {
    console.warn(`${LOG_TAG} skipped: ${ORIGIN_ENV} missing/invalid or loopback in production; nothing written.`);
    return result(false, 'origin_missing_or_invalid', [], 'origin_missing_or_invalid');
  }
  try {
    const preflightResult = terminalPreflightResult(inspectSetupPreflight(deps, origin));
    if (preflightResult) return preflightResult;
  } catch (error) {
    const code = classifyBootError(error);
    console.warn(`${LOG_TAG} preflight failed (fail-closed): ${code}.`);
    return result(false, 'failed', [], code);
  }
  let keyDir: string;
  let keyId: string;
  try {
    // Validate the key id (env-supplied) before it becomes a file path, so a stray
    // value can never traverse out of the key directory.
    keyId = validateConnectorSigningId(deps.env[KEY_ID_ENV]?.trim() || DEFAULT_KEY_ID, 'key-id');
    keyDir = assertSafeConnectorKeyDir(deps.env[KEY_DIR_ENV]?.trim() || defaultKeyDir(),
      path.join(deps.repoRoot, '.git'));
  } catch (error) {
    const code = error instanceof ConnectorSigningError ? error.code : 'CONNECTOR_AUTO_SETUP_KEYDIR_UNSAFE';
    console.warn(`${LOG_TAG} skipped: key directory rejected (${code}); nothing written.`);
    return result(false, 'key_dir_unsafe', [], code);
  }
  return runLocked(deps, origin, keyDir, keyId);
};

/**
 * Reduces any thrown value to a stable, secret-free code for logging and the returned
 * blocker: the signing-core machine code, else the errno code or error class name, never
 * the raw message (which could echo a path or other environment detail).
 */
const classifyBootError = (error: unknown): string => {
  if (error instanceof ConnectorSigningError) return error.code;
  if (error && typeof error === 'object') {
    const e = error as { name?: string; code?: string };
    return e.code ?? e.name ?? 'unknown';
  }
  return 'unknown';
};

/**
 * Holds the exclusive lock while performing the gated setup / renewal. Every filesystem
 * step (lock acquisition included) is inside the try, so an EACCES/ENOSPC/ENOTDIR from a
 * hostile lock directory becomes a fail-closed `failed` result and never throws out to the
 * substrate initializer. Cleanup closes only the held descriptor and never alters a path.
 */
const runLocked = (deps: ConnectorAutoSetupDeps, origin: string, keyDir: string,
  keyId: string): ConnectorAutoSetupResult => {
  let lease: LockLease | null = null;
  try {
    // Refuse before acquireLock creates the key directory or permanent lock.
    // The same predicate is repeated after locking to close the selection race.
    if (systemOwnerUserId(deps.database) === null) {
      console.warn(`${LOG_TAG} skipped: no active owner-role user to attribute setup to; nothing written.`);
      return result(false, 'no_owner', [], 'no_owner_user');
    }
    lease = acquireLock(keyDir);
    if (!lease) return result(false, 'locked', [], 'locked');
    const preflightResult = terminalPreflightResult(inspectSetupPreflight(deps, origin));
    if (preflightResult) return preflightResult;
    const ownerUserId = systemOwnerUserId(deps.database);
    if (ownerUserId === null) {
      console.warn(`${LOG_TAG} skipped: no active owner-role user to attribute setup to; nothing written.`);
      return result(false, 'no_owner', [], 'no_owner_user');
    }
    // Key reads/writes follow the same bound directory FD as the lock. A rename of
    // the user-supplied pathname after acquisition therefore cannot redirect custody.
    return performSetup(deps, origin, procFdPath(lease.directoryFd), keyId, ownerUserId);
  } catch (error) {
    const code = classifyBootError(error);
    console.warn(`${LOG_TAG} failed (fail-closed): ${code}. Completed steps remain valid and resume next boot.`);
    return result(false, 'failed', [], code);
  } finally {
    if (lease) releaseLock(lease);
  }
};

/** Loads the key, renews a complete install, or fills missing setup steps. */
const performSetup = (deps: ConnectorAutoSetupDeps, origin: string, keyDir: string,
  keyId: string, ownerUserId: number): ConnectorAutoSetupResult => {
  const key = loadOrCreateKey(keyDir, keyId);
  if (inspectConnectorSetup(deps.database, deps.installationId, deps.authority, deps.now()).resumableStep
    === 'complete') {
    const renewed = maybeRenewPack(deps, origin, ownerUserId, keyId, key);
    console.log(`${LOG_TAG} ${renewed.length ? 'renewed pack' : 'already complete'} for ${origin}.`);
    return result(renewed.length > 0, renewed.length ? 'renewed' : 'already_complete', renewed);
  }
  const artifacts = mintArtifacts({ keyId, publicKeyPem: key.publicKeyPem,
    privateKeyPem: key.privateKeyPem, nowMs: deps.now(), sequence: 1 });
  const steps = applyMissingSteps(deps, origin, ownerUserId, artifacts);
  console.log(`${LOG_TAG} configured ${origin}: steps=[${steps.join(',')}].`);
  return result(true, 'configured', steps);
};
