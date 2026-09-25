/**
 * Fail-closed control plane for ADR-129 server-preview activation.
 *
 * This module never builds, promotes, restarts, or writes the preview ledger.
 * It reads the candidate identity, classifies its input-manifest diff, and
 * persists the durable transaction consumed by the out-of-process guard.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { inspectOwnerControlRequest, readConsumerState } from '../../scripts/local-preview-ledger.mjs';
import {
  readLocalMainTarget, readLocalUpdate, prepareLocalUpdate, cancelLocalUpdate, confirmLocalUpdate,
} from '../../scripts/lib/local-update-control.mjs';
import { readClientPublicationBlockers } from '../../scripts/lib/client-publication-control.mjs';
import { inspectConfirmedOidPair } from '../../scripts/oid-control-capsule.mjs';
import { canonicalTripleJson, validateOidTripleTargetDescriptor } from '../../scripts/lib/oid-triple-target.mjs';
import { DEV_FULL_CAPABILITY, readLocalUpdatePolicy, publicLocalUpdatePolicy,
  inspectLocalUpdatePolicyGrant } from '../../scripts/lib/local-update-policy.mjs';
import { writeLocalUpdatePolicy } from '../../scripts/lib/local-update-policy-write.mjs';
import { gitControlPath, tryCommonGitDir } from '../../scripts/git-control-root.mjs';

import { APP_ROOT, SAFE_SERVER_BUILD_ID } from './server-actions.js';

export const SERVER_INPUT_MANIFEST = 'SERVER_INPUT_MANIFEST.json';
export const ACTIVATION_TRANSACTION_NAME = 'nassaj-server-activation-v1.json';
export const SERVER_CANDIDATES_DIRECTORY = path.join('.nassaj-local-preview', 'server-candidates');
export const SERVER_ACTIVATING_DIRECTORY = path.join('.nassaj-local-preview', 'server-activating');
const ACTIVATION_TRANSACTION_LOCK = 'nassaj-server-activation.lock';
const TERMINAL_TRANSACTION_STATES = new Set(['complete', 'rolled_back', 'superseded']);
const BUNDLED_CONTROL_FILES = [
  'scripts/local-preview-server-activation.mjs',
  'scripts/local-preview-ledger.mjs',
  'scripts/safe-restart.sh',
];
let localUpdateRuntime = null;
let servedClientReader = null;

/** Capture the process identity at startup, before any candidate can replace the files on disk. */
export function setLocalUpdateRuntimeIdentity(identity, readServedClient = null, root = APP_ROOT) {
  localUpdateRuntime = Object.freeze({ ...identity, devFullCapability: capturePolicyCapability(root, identity) });
  servedClientReader = readServedClient;
}

function capturePolicyCapability(root, identity) {
  try {
    const manifest = readRegularJson(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'));
    const capsule = fs.readFileSync(path.join(root, 'dist-server/OID_CONTROL_CAPSULE.mjs'));
    if (manifest.serverBuildId !== identity.serverLoadedBuildId
      || manifest.capabilities?.oidDevFullPolicyV1 !== DEV_FULL_CAPABILITY
      || crypto.createHash('sha256').update(capsule).digest('hex') !== manifest.capsuleSha256) return null;
    return Object.freeze({ protocol: DEV_FULL_CAPABILITY, serverLoadedBuildId: manifest.serverBuildId,
      retainedExecutorSha256: manifest.capsuleSha256 });
  } catch { return null; }
}

/** Expose only a capability captured from this process's verified generation at startup. */
export function getLocalUpdatePolicyCapability() {
  return localUpdateRuntime?.devFullCapability ?? null;
}

/** Owner-only route adapter; callers provide authenticated identity, never capability or paths. */
export async function requestLocalUpdatePolicyChange({ root = APP_ROOT, ownerId, mode, expectedRevision, idempotencyKey, env = process.env }) {
  if (mode !== 'disabled' && resolveHostUpdateMode(env) !== 'local-main') {
    throw Object.assign(new Error('local_update_mode_required'), { code: 'local_update_mode_required' });
  }
  return publicLocalUpdatePolicy(await writeLocalUpdatePolicy(root, { ownerId, mode, expectedRevision, idempotencyKey,
    capability: getLocalUpdatePolicyCapability() }));
}

/** Read-only policy disposition and loaded capability, without exposing its private receipt. */
export function getLocalUpdatePolicyStatus(root = APP_ROOT) {
  return { ...publicLocalUpdatePolicy(readLocalUpdatePolicy(root)), available: Boolean(getLocalUpdatePolicyCapability()) };
}

/** Select explicit policy authority or unchanged manual consent; never fabricate a human receipt. */
export function localUpdateAuthority(root, state) {
  if (state?.policyAuthorization) {
    if (!getLocalUpdatePolicyCapability()) throw new Error('local_update_policy_capability_required');
    return inspectLocalUpdatePolicyGrant(root, state);
  }
  if (!state?.consent) return null;
  return { kind: 'manual', ownerId: state.consent.ownerId, issuedAt: state.consent.confirmedAt,
    expiresAt: state.consent.expiresAt, targetDigest: state.consent.targetDigest };
}

function localUpdateRequester(authority) {
  return authority.kind === 'policy' ? `local-update-policy:${authority.ownerId}:${authority.grantDigest}`
    : `local-update:${authority.ownerId}`;
}

/** Combine frozen server identity with a fresh trusted serving observation. */
export function readLocalUpdateRuntimeIdentity() {
  if (!localUpdateRuntime) return null;
  if (!servedClientReader) return localUpdateRuntime;
  const clientBuildIdServed = servedClientReader();
  return { ...localUpdateRuntime, clientBuildIdServed: SAFE_SERVER_BUILD_ID.test(clientBuildIdServed || '') ? clientBuildIdServed : null };
}

/** Select update authority only from trusted process configuration, never a request or node.env. */
export function resolveHostUpdateMode(env = process.env) {
  const mode = env.NASSAJ_UPDATE_MODE ?? 'release';
  if (!['release', 'local-main'].includes(mode)) throw Object.assign(new Error('local_update_mode_invalid'), { code: 'local_update_mode_invalid' });
  return mode;
}

/** Keep the authenticated update response separate from filesystem control records. */
export function publicLocalUpdate(state) {
  if (!state) return null;
  return { sequence: state.sequence, revision: state.revision, oid: state.oid, phase: state.phase,
    targetDigest: state.targetDigest ?? null, target: state.target ? { clientBuildId: state.target.clientBuildId, serverBuildId: state.target.serverBuildId,
      ...(state.target.schema ? { schema: state.target.schema, generationNames: state.target.generationNames } : {}) } : null,
    consentExpiresAt: state.consent?.expiresAt ?? null, authorityKind: state.prepare?.origin?.kind === 'policy' || state.policyAuthorization ? 'policy' : state.consent ? 'manual' : null,
    policyExpiresAt: state.policyAuthorization?.expiresAt ?? null,
    outcome: state.receipt?.outcome ?? null };
}

function tripleCapabilityMatches(loaded, candidate, target) {
    validateOidTripleTargetDescriptor(target);
    if (loaded.capabilities?.oidTripleAdmissionV2 !== true || candidate.capabilities?.oidTripleAdmissionV2 !== true) return false;
    const expected = { schema: 'nassaj-oid-dependency-generation/v2',
        nodeModulesTreeSha256: target.nodeModulesTreeSha256, dependencyContractSha256: target.dependencyContractSha256,
        packageJsonSha256: target.packageJsonSha256, packageLockSha256: target.packageLockSha256,
        installPolicySha256: target.installPolicySha256, installRuntime: target.installRuntime };
    return canonicalTripleJson(candidate.dependencyGenerationV2) === canonicalTripleJson(expected);
}

/** Advertise only a loaded protocol and an exact prepared target; consent revalidates full trees. */
export function localPairActivationAvailable(root = APP_ROOT, state = readLocalUpdate(root)) {
    try {
        const loaded = readRegularJson(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'));
        const targetPath = path.join(root, '.nassaj-local-preview/server-candidates', state.target.serverBuildId, 'OID_CONTROL_MANIFEST.json');
        const candidate = readRegularJson(targetPath);
        if (loaded.serverBuildId !== localUpdateRuntime?.serverLoadedBuildId
            || !/^[a-f0-9]{64}$/.test(loaded.runtimeDependenciesSha256 || '')) return false;
        if (state.target.schema) {
            if (crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex') !== state.target.controlManifestSha256
                || candidate.serverBuildId !== state.target.serverBuildId || candidate.oid !== state.oid) return false;
            return tripleCapabilityMatches(loaded, candidate, state.target);
        }
        return loaded.capabilities?.oidPairAdmissionV1 === true && candidate.capabilities?.oidPairAdmissionV1 === true
            && candidate.runtimeDependenciesSha256 === loaded.runtimeDependenciesSha256;
    } catch { return false; }
}

/** Read local status without confusing a disk generation with the currently loaded process. */
export function getLocalUpdateStatus(root = APP_ROOT, env = process.env) {
    const mode = resolveHostUpdateMode(env);
    const blockers = fs.existsSync(path.join(root, '.git')) ? readClientPublicationBlockers(root) : { publications: [], fullUpdates: [] };
    const publicationStatus = blockers.publications.length || blockers.fullUpdates.length ? { clientPublication: {
        active: blockers.publications.map(({ sequence, revision, sourceOid, phase, reason, requestId }) => ({ sequence, revision, sourceOid, phase, reason, requestId })),
        fullWaiters: blockers.fullUpdates.map(({ requestId, revision, phase, reason, ownerId }) => ({ requestId, revision, phase, reason, ownerId })),
    } } : {};
    if (mode === 'release') return { mode, ...publicationStatus };
    const state = readLocalUpdate(root);
    const activationReady = localPairActivationAvailable(root, state);
    const runtime = readLocalUpdateRuntimeIdentity(), target = readLocalMainTarget(root, runtime);
    const consumer = readConsumerState(root);
    return { mode, ...publicationStatus, ...target, update: publicLocalUpdate(state), policy: getLocalUpdatePolicyStatus(root),
        targetMainOid: target.oid, preparedOid: state?.target ? state.oid : null,
        pendingOid: state && state.oid !== target.oid ? target.oid : null,
        serverLoadedOid: runtime?.serverLoadedOid ?? null, serverLoadedBuildId: runtime?.serverLoadedBuildId ?? null,
        clientBuildIdServed: runtime?.clientBuildIdServed ?? null,
        waitReasonCode: state?.preparationFailure?.code ?? consumer.devFull?.waitReason
            ?? (state?.phase === 'awaiting_sessions' ? 'awaiting_sessions' : null),
        observedAt: Date.now(),
        activationReady, blockedReasonCode: activationReady ? null : 'pair_activation_unavailable' };
}

/** Persist consent only after the loaded bridge can safely activate both generations. */
export async function requestLocalUpdateConfirmation({ root = APP_ROOT, ownerId, sequence, expectedRevision, targetDigest, env = process.env }) {
    if (resolveHostUpdateMode(env) !== 'local-main') throw Object.assign(new Error('local_update_mode_required'), { code: 'local_update_mode_required' });
    if (!localPairActivationAvailable(root)) throw Object.assign(new Error('pair_activation_unavailable'), { code: 'pair_activation_unavailable' });
    return confirmLocalUpdate(root, { mode: 'local-main', ownerId, sequence, expectedRevision, targetDigest });
}

/** Adapt the existing activation loop to durable local consent, without a second scheduler. */
export function localUpdateActivationJobs(root = APP_ROOT) {
    return {
        readActivationAuthority(job) {
            const state = readLocalUpdate(root);
            if (state?.phase !== 'awaiting_sessions' || job.id !== `local-update:${state.sequence}`) return null;
            try {
                const authority = localUpdateAuthority(root, state);
                return authority?.kind === 'policy' && authority.grantDigest === job.activationAuthority?.grantDigest ? authority : null;
            } catch { return null; }
        },
        listAutoActivatable() {
            const state = readLocalUpdate(root);
            if (state?.phase !== 'awaiting_sessions') return [];
            let authority;
            try { authority = localUpdateAuthority(root, state); } catch { return []; }
            if (!authority) return [];
            return [{ id: `local-update:${state.sequence}`, owner_id: Number(authority.ownerId),
                ...(authority.kind === 'policy' ? { activationAuthority: authority } : {}),
                updated_at: new Date(authority.issuedAt).toISOString() }];
        },
        listReceipts(id) {
            const state = readLocalUpdate(root);
            return state && id === `local-update:${state.sequence}` && state.consent
                ? [{ phase: 'restart_queued', kind: 'done', created_at: new Date(state.consent.confirmedAt).toISOString() }] : [];
        },
    };
}

/** Match a pending restart to the exact pair and consenting owner before the durable action claim. */
export function inspectLocalUpdateAction(row, root = APP_ROOT) {
    const state = readLocalUpdate(root);
    const authority = localUpdateAuthority(root, state);
    if (!state || row?.reason !== `local-update:${state.sequence}`
        || row.activationIdentitySha256 !== state.targetDigest || row.releaseCommit !== state.oid
        || row.expectedServerBuildId !== state.target?.serverBuildId
        || !authority || row.requestedBy !== localUpdateRequester(authority)) throw new Error('local_update_action_mismatch');
    return inspectConfirmedOidPair(root, { sequence: state.sequence, targetDigest: state.targetDigest,
        ownerId: authority.ownerId, actionId: row.id, transactionNonce: row.executionAttemptNonce });
}

/** Request preparation using the authenticated owner and a main OID, without activating runtime. */
export async function requestLocalUpdatePreparation({ root = APP_ROOT, ownerId, expectedOid, idempotencyKey, env = process.env }) {
  return publicLocalUpdate(await prepareLocalUpdate(root, {
    mode: resolveHostUpdateMode(env), ownerId, expectedOid, idempotencyKey,
  }));
}

/** Cancel a prepared local request using its revision and the authenticated owner. */
export async function requestLocalUpdateCancellation({ root = APP_ROOT, ownerId, sequence, expectedRevision, env = process.env }) {
  return publicLocalUpdate(await cancelLocalUpdate(root, {
    mode: resolveHostUpdateMode(env), ownerId, sequence, expectedRevision,
  }));
}

const normalizeRelativePath = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith('/') || normalized === '..'
    || normalized.startsWith('../') || normalized.includes('\0')) return null;
  return normalized;
};

/** Classify one server-build input. Unknown is intentionally blocking. */
export function classifyServerInput(relativePath) {
  const name = normalizeRelativePath(relativePath);
  if (!name) return 'unknown';
  if (
    /(^|\/)(?:migrations?|schema)(?:\/|\.|$)/i.test(name)
    || /(^|\/)auth(?:\/|\.|-|$)/i.test(name)
    || /(^|\/)(?:\.env|[^/]*\.env|env)(?:\/|\.|-|$)/i.test(name)
    || /(^|\/)oidc(?:\/|\.|-|$)/i.test(name)
    || /(^|\/)(?:stores?|control)(?:\/|\.|-|$)/i.test(name)
    || /(^|\/)(?:credentials?|permissions?|secrets?|tokens?|access-policy)(?:\/|\.|-|$)/i.test(name)
    || /(^|\/)[^/]*\.routes?\.[cm]?[jt]s$/i.test(name)
    || /^server\/(?:routes|middleware|modules\/database)\//.test(name)
    || /^server\/services\/(?:server-actions|source-updater|local-preview-server-control)\./.test(name)
    || /^scripts\/(?:safe-restart\.sh|local-preview-server-activation\.mjs|local-preview-ledger\.mjs)$/.test(name)
  ) return 'sensitive';
  if (/^server\/modules\/(?:projects|providers|workflow-supervisor|websocket)\/.+\.(?:js|ts|json)$/.test(name)) return 'ordinary';
  return 'unknown';
}

function readRegularJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('control_file_not_regular');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeManifest(raw, expectedBuildId) {
  if (!raw || ![1, 2].includes(raw.schemaVersion) || raw.buildId !== expectedBuildId || !Array.isArray(raw.inputs)
    || (raw.schemaVersion === 2 && raw.buildIdMode !== 'path-mode-content-sha256')) {
    throw new Error('invalid_input_manifest');
  }
  const inputs = new Map();
  for (const entry of raw.inputs) {
    const name = normalizeRelativePath(entry?.path);
    if (!name || !SAFE_SERVER_BUILD_ID.test(entry?.sha256 || '') || inputs.has(name)
      || (raw.schemaVersion === 2 && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777))) {
      throw new Error('invalid_input_manifest');
    }
    inputs.set(name, raw.schemaVersion === 2 ? `${entry.mode}:${entry.sha256}` : entry.sha256);
  }
  const digest = crypto.createHash('sha256');
  // Keep this bytewise ordering identical to server-build-atomic.mjs. Locale
  // collation can place punctuation differently (for example `-` versus `/`),
  // which made a valid schema-v2 manifest fail its own build-id attestation.
  const canonicalInputs = [...inputs].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  for (const [name, identity] of canonicalInputs) {
    digest.update(name).update('\0');
    if (raw.schemaVersion === 2) {
      const separator = identity.indexOf(':');
      digest.update(identity.slice(0, separator)).update('\0').update(identity.slice(separator + 1)).update('\0');
    } else digest.update(identity).update('\0');
  }
  if (digest.digest('hex') !== expectedBuildId) throw new Error('input_manifest_fingerprint_mismatch');
  return inputs;
}

function assertArtifactIdentity(directory, expectedBuildId) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('artifact_directory_not_regular');
  const provenance = readRegularJson(path.join(directory, 'BUILD_PROVENANCE.json'));
  if (provenance?.artifact !== 'server' || provenance.buildId !== expectedBuildId) {
    throw new Error('artifact_provenance_mismatch');
  }
  const manifest = readRegularJson(path.join(directory, SERVER_INPUT_MANIFEST));
  const inputs = normalizeManifest(manifest, expectedBuildId);
  for (const relativePath of BUNDLED_CONTROL_FILES) {
    const expectedIdentity = inputs.get(relativePath);
    if (!expectedIdentity) throw new Error('bundled_control_missing_from_manifest');
    const file = path.join(directory, relativePath);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('bundled_control_not_regular');
    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const expectedSha256 = expectedIdentity.includes(':') ? expectedIdentity.slice(expectedIdentity.indexOf(':') + 1) : expectedIdentity;
    if (actualSha256 !== expectedSha256) throw new Error('bundled_control_fingerprint_mismatch');
  }
  return manifest;
}

export const serverCandidateDirectory = (root, buildId) => {
  if (!SAFE_SERVER_BUILD_ID.test(buildId || '')) throw new Error('invalid_candidate_build_id');
  return path.join(root, SERVER_CANDIDATES_DIRECTORY, buildId);
};

export const serverActivatingDirectory = (root, buildId) => {
  if (!SAFE_SERVER_BUILD_ID.test(buildId || '')) throw new Error('invalid_candidate_build_id');
  return path.join(root, SERVER_ACTIVATING_DIRECTORY, buildId);
};

/** Compare candidate and loaded manifests; sensitive or unknown changes block. */
export function classifyServerCandidate(options) {
  try {
    const candidate = normalizeManifest(options.candidateManifest, options.expectedBuildId);
    const loaded = normalizeManifest(options.loadedManifest, options.loadedBuildId);
    const changedPaths = [...new Set([...candidate.keys(), ...loaded.keys()])]
      .filter((name) => candidate.get(name) !== loaded.get(name))
      .sort();
    const classifications = changedPaths.map((name) => ({ path: name, classification: classifyServerInput(name) }));
    const blocking = classifications.filter(({ classification }) => classification !== 'ordinary');
    return blocking.length > 0
      ? { allowed: false, code: blocking.some((item) => item.classification === 'sensitive')
        ? 'sensitive_candidate' : 'unknown_candidate', changedPaths: classifications }
      : { allowed: true, code: 'ordinary_candidate', changedPaths: classifications };
  } catch (error) {
    return { allowed: false, code: candidateFailureCode(error), changedPaths: [] };
  }
}

/** Classify control failures into bounded public codes without exposing filesystem details. */
export function candidateFailureCode(error) {
  if (error?.code === 'ENOENT') return 'candidate_evidence_missing';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'candidate_evidence_unreadable';
  if (error instanceof SyntaxError) return 'candidate_evidence_invalid';
  const message = error?.message || '';
  if (message === 'OID owner control request was superseded or is not awaiting this exact candidate.') {
    return 'oid_candidate_not_awaiting_owner';
  }
  if (message.includes('provenance') || message.includes('fingerprint')
    || message === 'OID event control identity does not match the owner request.') return 'candidate_identity_mismatch';
  if (message.includes('not a regular file') || message.includes('not_regular')
    || message === 'invalid_input_manifest'
    || message === 'OID owner control request identity is invalid.') return 'candidate_evidence_invalid';
  return 'candidate_inspection_failed';
}

/** Read and validate the currently operator-visible server candidate. */
export function inspectServerCandidate(expectedServerBuildId, root = APP_ROOT) {
  if (!SAFE_SERVER_BUILD_ID.test(expectedServerBuildId || '')) {
    return { allowed: false, code: 'invalid_expected_server_build_id' };
  }
  try {
    const ledger = readRegularJson(gitControlPath(root, 'nassaj-local-preview-ledger-v1.json'));
    const loadedBuildId = ledger.serverLoadedBuildId;
    const generation = ledger.serverSourceGeneration;
    const identityMatches = ledger.serverSourceBuildId === expectedServerBuildId
      && ledger.serverCandidateBuildId === expectedServerBuildId
      && ledger.serverState === 'built'
      && SAFE_SERVER_BUILD_ID.test(loadedBuildId || '')
      && loadedBuildId !== expectedServerBuildId
      && Number.isSafeInteger(generation) && generation >= 0;
    if (!identityMatches) return { allowed: false, code: 'superseded' };

    const candidateDirectory = serverCandidateDirectory(root, expectedServerBuildId);
    const candidateManifest = assertArtifactIdentity(candidateDirectory, expectedServerBuildId);
    const loadedDirectory = path.join(root, 'dist-server');
    const onDiskProvenance = readRegularJson(path.join(loadedDirectory, 'BUILD_PROVENANCE.json'));
    if (onDiskProvenance?.artifact === 'server'
      && SAFE_SERVER_BUILD_ID.test(onDiskProvenance.buildId || '')
      && onDiskProvenance.buildId !== loadedBuildId) {
      return {
        allowed: false,
        code: 'loaded_artifact_unavailable',
        expectedServerBuildId,
        loadedBuildId,
        onDiskBuildId: onDiskProvenance.buildId,
        generation,
      };
    }
    const loadedManifest = assertArtifactIdentity(loadedDirectory, loadedBuildId);
    const classified = classifyServerCandidate({
      candidateManifest, loadedManifest, expectedBuildId: expectedServerBuildId, loadedBuildId,
    });
    return { ...classified, expectedServerBuildId, loadedBuildId, generation };
  } catch (error) {
    return { allowed: false, code: candidateFailureCode(error) };
  }
}

/**
 * Resolve the exact activation protocol for a command-board server candidate.
 *
 * OID previews own a separate immutable control request and must execute through
 * preview-safe-restart.sh. Falling through to the legacy manifest classifier
 * bypasses that request and compares the candidate against the stale live
 * dist-server lineage. A present OID request therefore has precedence and fails
 * closed: a mismatched build is superseded, while a malformed request is
 * unknown. Only when no OID request exists may the legacy classifier run.
 */
export function inspectServerActivationCandidate(expectedServerBuildId, root = APP_ROOT) {
  if (!SAFE_SERVER_BUILD_ID.test(expectedServerBuildId || '')) {
    return { allowed: false, code: 'invalid_expected_server_build_id', activationKind: null };
  }
  // Without a resolvable common Git dir no OID request can exist; fall through.
  const gitDirectory = tryCommonGitDir(root);
  const oidControl = gitDirectory && path.join(gitDirectory, 'nassaj-preview-oid-control-request-v1.json');
  // lstat observes the directory entry itself. A broken or substituted symlink
  // is still a present OID request and must fail closed, never fall through to
  // the legacy classifier merely because existsSync followed it to nowhere.
  try {
    if (oidControl && fs.lstatSync(oidControl, { throwIfNoEntry: false })) {
      const request = inspectOwnerControlRequest(root);
      if (request.buildId !== expectedServerBuildId) {
        return { allowed: false, code: 'superseded', activationKind: 'oid' };
      }
      return {
        allowed: true,
        code: 'oid_candidate',
        activationKind: 'oid',
        expectedServerBuildId,
        generation: request.sequence,
        oid: request.oid,
        group: request.group,
      };
    }
  } catch (error) {
    return { allowed: false, code: candidateFailureCode(error), activationKind: 'oid' };
  }
  return { ...inspectServerCandidate(expectedServerBuildId, root), activationKind: 'legacy' };
}

/** New legacy candidates cannot activate outside the update button; existing recovery retains its authority. */
export function inspectLegacyRestartDisposition(expectedServerBuildId, requestId = null, root = APP_ROOT) {
  const blocked = { allowed: false, code: 'node_update_button_required', activationKind: 'legacy' };
  if (!SAFE_SERVER_BUILD_ID.test(expectedServerBuildId || '')) return blocked;
  try {
    const transaction = readActivationTransaction(root);
    if (transaction && ['prepared', 'guard_ready', 'install_authorized', 'candidate_installed', 'restart_spawned',
      'awaiting_readiness', 'rolling_back', 'rollback_restart_pending', 'rollback_deferred'].includes(transaction.state)
      && transaction.expectedServerBuildId === expectedServerBuildId && transaction.requestId === requestId && requestId) {
      return { allowed: true, code: 'existing_activation_recovery', activationKind: 'legacy-resume',
        expectedServerBuildId, transaction };
    }
    if (transaction && !TERMINAL_TRANSACTION_STATES.has(transaction.state)) return blocked;
    if (localUpdateRuntime?.serverLoadedBuildId !== expectedServerBuildId) return blocked;
    assertArtifactIdentity(path.join(root, 'dist-server'), expectedServerBuildId);
    return { allowed: true, code: 'loaded_generation_restart', activationKind: 'maintenance', expectedServerBuildId };
  } catch { return blocked; }
}

export const activationTransactionPath = (root = APP_ROOT) =>
  gitControlPath(root, ACTIVATION_TRANSACTION_NAME);

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeTransactionUnlocked(root, transaction) {
  const target = activationTransactionPath(root);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(transaction, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally { fs.rmSync(temporary, { force: true }); }
  return transaction;
}

function withTransactionLock(root, operation) {
  const lock = gitControlPath(root, ACTIVATION_TRANSACTION_LOCK);
  let fd;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.fsyncSync(fd);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0) throw error;
      const owner = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
      try { process.kill(owner, 0); throw new Error('activation_transaction_locked'); }
      catch (probe) {
        if (probe?.message === 'activation_transaction_locked' || probe?.code === 'EPERM') throw probe;
        fs.unlinkSync(lock);
      }
    }
  }
  try { return operation(); } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
    fsyncDirectory(path.dirname(lock));
  }
}

export function readActivationTransaction(root = APP_ROOT) {
  // Release layouts have no `.git`: no common dir means no transaction to resume.
  const gitDirectory = tryCommonGitDir(root);
  if (!gitDirectory) return null;
  const target = path.join(gitDirectory, ACTIVATION_TRANSACTION_NAME);
  if (!fs.existsSync(target)) return null;
  const transaction = readRegularJson(target);
  const expectedActivatingPath = transaction
    ? path.join(SERVER_ACTIVATING_DIRECTORY, transaction.expectedServerBuildId || '') : '';
  if (transaction?.schemaVersion !== 1 || !SAFE_SERVER_BUILD_ID.test(transaction.expectedServerBuildId || '')
    || transaction.activationRelativePath !== expectedActivatingPath) {
    throw new Error('invalid_activation_transaction');
  }
  return transaction;
}

/** Persist the exact identity before any restart child is spawned. */
export function prepareActivationTransaction(candidate, requestId, root = APP_ROOT) {
  if (!candidate?.allowed || !SAFE_SERVER_BUILD_ID.test(candidate.expectedServerBuildId || '')
    || !SAFE_SERVER_BUILD_ID.test(candidate.loadedBuildId || '')) {
    throw new Error('candidate_not_activatable');
  }
  return withTransactionLock(root, () => {
    const current = readActivationTransaction(root);
    if (current && !TERMINAL_TRANSACTION_STATES.has(current.state)
      && current.expectedServerBuildId !== candidate.expectedServerBuildId) {
      writeTransactionUnlocked(root, { ...current, state: 'superseded', updatedAt: new Date().toISOString() });
    }
    const now = new Date().toISOString();
    return writeTransactionUnlocked(root, {
      schemaVersion: 1,
      state: 'prepared',
      requestId,
      sourceGeneration: candidate.generation,
      expectedServerBuildId: candidate.expectedServerBuildId,
      previousServerBuildId: candidate.loadedBuildId,
      activationRelativePath: path.join(SERVER_ACTIVATING_DIRECTORY, candidate.expectedServerBuildId),
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      error: null,
    });
  });
}

/** CAS-like state update: a stale worker cannot mutate a newer transaction. */
export function transitionActivationTransaction(expectedBuildId, fromStates, patch, root = APP_ROOT) {
  return withTransactionLock(root, () => {
    const current = readActivationTransaction(root);
    if (!current || current.expectedServerBuildId !== expectedBuildId || !fromStates.includes(current.state)) {
      return null;
    }
    return writeTransactionUnlocked(root, { ...current, ...patch, updatedAt: new Date().toISOString() });
  });
}

/** Re-create a lost queue insertion from already durable consent; never invent or renew consent. */
export async function ensureLocalUpdateAction(jobId, enqueue, root = APP_ROOT) {
    const state = readLocalUpdate(root);
    const authority = localUpdateAuthority(root, state);
    if (state?.phase !== 'awaiting_sessions' || jobId !== `local-update:${state.sequence}`
        || !authority || authority.expiresAt <= Date.now()) return;
    enqueue({ id: crypto.randomUUID(), actionType: 'safe-restart', reason: jobId,
        requestedBy: localUpdateRequester(authority), expectedServerBuildId: state.target.serverBuildId,
        activationIdentitySha256: state.targetDigest, releaseCommit: state.oid });
}
