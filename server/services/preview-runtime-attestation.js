/**
 * Process-memory attestation for an OID-built server generation.
 *
 * The file is read exactly once while the process boots. Health/control routes
 * must expose this frozen value; reading BUILD_PROVENANCE.json after promotion
 * would prove only disk state, not the code loaded in this process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const SAFE_OID = /^[a-f0-9]{40}$/;
const SAFE_BUILD_ID = /^[a-f0-9]{64}$/;
const SAFE_NONCE = /^[a-f0-9]{64}$/;

export function parseProcessStartTicks(raw) {
  if (typeof raw !== 'string') return null;
  const commandEnd = raw.lastIndexOf(')');
  if (commandEnd < 2) return null;
  const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks || '') ? startTicks : null;
}

function processStartTicks(pid = process.pid) {
  try { return parseProcessStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; }
}

function durableJson(file, value) {
  const temporary = `${file}.startup-${process.pid}-${Date.now()}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** Worktree-safe, fail-closed resolver kept standalone for compiled boot code. */
function commonGitDir(root) {
  const repository = fs.realpathSync(path.resolve(root));
  const entry = fs.lstatSync(path.join(repository, '.git'));
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('git_control_entry_unsafe');
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repository, encoding: 'utf8', stdio: 'pipe',
  });
  const reported = String(result.stdout || '').trim();
  if (result.status !== 0 || !path.isAbsolute(reported)) throw new Error('git_control_common_dir_unresolved');
  const metadata = fs.lstatSync(reported);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('git_control_common_dir_unsafe');
  const resolved = fs.realpathSync(reported);
  if (resolved !== path.resolve(reported)) throw new Error('git_control_common_dir_redirected');
  return resolved;
}

/** Resolve only an exact nonce-attested post-restart journal; all ambiguity remains fenced. */
export function reconcileOidControlJournalAtStartup(root, attestation) {
  if (!attestation?.oid || !attestation?.buildId || !attestation?.processStartTicks) return null;
  try {
    const gitDirectory = commonGitDir(root);
    const matches = fs.readdirSync(gitDirectory)
      .filter((name) => name.startsWith('nassaj-oid-control-transaction-') && name.endsWith('.json'))
      .map((name) => ({ file: path.join(gitDirectory, name), name }))
      .filter(({ file }) => {
        const metadata = fs.lstatSync(file);
        return metadata.isFile() && !metadata.isSymbolicLink();
      })
      .map(({ file }) => ({ file, value: JSON.parse(fs.readFileSync(file, 'utf8')) }))
      .filter(({ value }) => {
        const livePath = path.join(root, 'dist-server');
        const candidateParent = path.join(root, '.nassaj-local-preview', 'server-candidates');
        if (value.livePath !== livePath || typeof value.candidatePath !== 'string'
          || path.dirname(value.candidatePath) !== candidateParent) return false;
        const liveMetadata = fs.lstatSync(livePath, { throwIfNoEntry: false });
        const candidateMetadata = fs.lstatSync(value.candidatePath, { throwIfNoEntry: false });
        if (!liveMetadata?.isDirectory() || liveMetadata.isSymbolicLink()
          || !candidateMetadata?.isDirectory() || candidateMetadata.isSymbolicLink()
          || liveMetadata.dev !== candidateMetadata.dev) return false;
        const diskIdentity = (directory) => {
          const file = path.join(directory, 'BUILD_PROVENANCE.json');
          const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
          if (!metadata?.isFile() || metadata.isSymbolicLink()) return null;
          const provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
          return { oid: provenance.commit, buildId: provenance.buildId };
        };
        const live = diskIdentity(livePath);
        const retained = diskIdentity(value.candidatePath);
        const candidateLayout = live?.oid === value.oid && live?.buildId === value.buildId
          && retained?.oid === value.previousOid && retained?.buildId === value.previousBuildId;
        const previousLayout = live?.oid === value.previousOid && live?.buildId === value.previousBuildId
          && retained?.oid === value.oid && retained?.buildId === value.buildId;
        const candidateBoot = ['promoted', 'restart_outcome_unknown'].includes(value.state)
          && value.oid === attestation.oid && value.buildId === attestation.buildId
          && value.transactionNonce === attestation.transactionNonce
          && value.bootNonce === attestation.bootNonce && candidateLayout;
        const previousSafe = ['launch_prepared', 'executor_ready', 'prepared'].includes(value.state)
          && value.previousOid === attestation.oid && value.previousBuildId === attestation.buildId
          && previousLayout;
        const rollbackSafe = value.state === 'rollback_prepared'
          && value.previousOid === attestation.oid && value.previousBuildId === attestation.buildId
          && previousLayout
          && (!value.rollbackBootNonce || (value.transactionNonce === attestation.transactionNonce
            && value.rollbackBootNonce === attestation.bootNonce));
        return (candidateBoot || previousSafe || rollbackSafe)
          && String(value.oldStartTicks || '') !== String(attestation.processStartTicks);
      });
    if (matches.length !== 1) return null;
    const [{ file, value }] = matches;
    const state = ['promoted', 'restart_outcome_unknown'].includes(value.state)
      ? 'loaded' : value.state === 'rollback_prepared' ? 'rolled_back' : 'restart_deferred_restored';
    const loaded = {
      ...value, state, newPid: attestation.pid,
      newStartTicks: attestation.processStartTicks, recoveredAtStartup: true,
      loadedAt: new Date().toISOString(),
    };
    durableJson(file, loaded);
    return Object.freeze(loaded);
  } catch {
    return null;
  }
}

export function captureServerRuntimeAttestation(root, moduleDirectory) {
  const compiledDirectory = path.join(root, 'dist-server', 'server');
  const relativeModuleDirectory = path.relative(compiledDirectory, path.resolve(moduleDirectory));
  // Runtime modules normally live below dist-server/server (for example this
  // file is loaded from dist-server/server/services), not at that directory's
  // root.  Keep the check fail-closed while accepting only descendants of the
  // exact compiled server tree.
  if (relativeModuleDirectory.startsWith(`..${path.sep}`)
    || relativeModuleDirectory === '..'
    || path.isAbsolute(relativeModuleDirectory)) {
    return Object.freeze({ oid: null, buildId: null });
  }
  try {
    const file = path.join(root, 'dist-server', 'BUILD_PROVENANCE.json');
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return Object.freeze({ oid: null, buildId: null });
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.artifact !== 'server' || value.dirty !== false
      || value.commit !== value.baseCommit || !SAFE_OID.test(value.commit || '')
      || !SAFE_BUILD_ID.test(value.buildId || '')) return Object.freeze({ oid: null, buildId: null });
    const transactionNonce = SAFE_NONCE.test(process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE || '')
      ? process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE : null;
    const bootNonce = SAFE_NONCE.test(process.env.NASSAJ_PREVIEW_BOOT_NONCE || '')
      ? process.env.NASSAJ_PREVIEW_BOOT_NONCE : null;
    return Object.freeze({
      oid: value.commit,
      buildId: value.buildId,
      controlProtocol: 1,
      launcherAbi: 'nassaj-oid-launcher/v1',
      transactionNonce,
      bootNonce,
      pid: process.pid,
      processStartTicks: processStartTicks(),
    });
  } catch {
    return Object.freeze({ oid: null, buildId: null });
  }
}

const moduleDirectory = getModuleDir(import.meta.url);
const appRoot = findAppRoot(moduleDirectory);
export const SERVER_RUNTIME_ATTESTATION = captureServerRuntimeAttestation(appRoot, moduleDirectory);

/** Stable getter for route injection; always returns the boot-frozen object. */
export function getServerRuntimeAttestation() {
  return SERVER_RUNTIME_ATTESTATION;
}
