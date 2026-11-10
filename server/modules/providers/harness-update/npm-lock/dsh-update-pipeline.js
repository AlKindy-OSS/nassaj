/**
 * dsh-update-pipeline — the staged, auto-verified dsh update behind the owner's update button
 * (T-2091, ADR-225; owner 2026-11-08: "updating DeepSeek must not break the Nassaj integration").
 *
 * One run for one EXACT candidate version (never a tag, never @latest):
 *   1. one run at a time (dsh_update_busy); a held candidate stays held (no flapping);
 *   2. channel = the installed one (a prerelease only when the active version is one), and the
 *      Nassaj policy plugin's engines.dsh must admit it (dsh disables an incompatible plugin);
 *   3. free space >= 3 × the expected tree size, else held: disk (nothing is installed);
 *   4. install into <root>/staging/<id>/ (fresh package.json, --ignore-scripts, private cache;
 *      the adapter returns the lockfile and the full-tree manifest it generated);
 *   5. the offline contract suite (P1–P4, mapped tools, conformance, security rows) — red keeps
 *      the current version and holds the candidate with the failing code;
 *   6. green: the tree moves to <root>/versions/<v>, its reviewed result (lockfile, manifest,
 *      report) to <root>/reviewed/<v>/, and the active link is renamed atomically onto it; at
 *      most two versions are kept (active + previous); staging is always removed.
 * After a switch, the first live launch that fails a capability probe (P1/P2/P4) rolls back to
 * the previous version and holds the candidate; a member-specific refusal never does.
 * State: <root>/update-state.json (status for version-status: installed | checking | held |
 * switched | rolled_back, with code and candidateVersion).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { checkPluginEngines } from '../../../../services/permission-parity/dsh-contract-suite.js';
import { computeTreeManifest, hashSmallFileSync, verifyTreeManifest } from './tree-manifest.js';

export const DSH_UPDATE_CODES = Object.freeze({
  notPinned: 'dsh_update_version_not_pinned',
  busy: 'dsh_update_busy',
  disk: 'dsh_update_held_disk',
  channel: 'dsh_update_channel_mismatch',
  installFailed: 'dsh_update_install_failed',
  contractFailed: 'dsh_update_contract_failed',
  tooNew: 'dsh_update_too_new',
  signatureFailed: 'dsh_update_signature_failed',
  interrupted: 'dsh_update_interrupted',
});
/** Failures that may pass on a second try (bounded retry); every other code holds at once. */
export const DSH_TRANSIENT_CODES = Object.freeze(['dsh_cap_channel', 'dsh_update_install_failed', 'dsh_update_registry_unavailable']);
const RETRIES = 2;
/** A candidate must have been published at least this long ago (supply-chain soak; qa I2). */
export const DSH_MIN_CANDIDATE_AGE_MS = 72 * 3600 * 1000;
/** Live dsh_cap_channel failures in a row before a rollback (a timeout can be transient). */
const CHANNEL_FAILURES_TO_ROLLBACK = 2;
/** Launch codes that prove the integration broken on the new version (they roll back). */
export const DSH_CAPABILITY_CODES = Object.freeze(['dsh_cap_tools_api', 'dsh_cap_gate', 'dsh_cap_channel']);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const DISK_FACTOR = 3;
const KEEP_VERSIONS = 2;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const isPrerelease = (version) => String(version).includes('-');

/** The kernel start time of `pid` (field 22 of /proc/<pid>/stat), or null. */
function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** True when the lock content names a live process with the recorded start time. */
function lockHolderAlive(content) {
  const [pidText, start] = String(content).trim().split(':');
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error?.code !== 'EPERM') return false; }
  if (!start) return true;
  const actual = processStartTime(pid);
  return actual === null || actual === start;
}

/**
 * @param {{ root: string, install: (job: { version: string, dir: string, cacheDir: string }) => Promise<{ treeBytes?: number,
 *   lock?: Buffer|string, packageJson?: Buffer|string }>, contractSuite: (job: { version: string, dir: string }) => Promise<{ ok: boolean,
 *   code?: string, report?: object }>, freeBytes: (dir: string) => number, estimatedTreeBytes?: number, binRel?: string,
 *   activeLink?: string, initialActive?: string|null, now?: () => string,
 *   publishedAt?: (version: string) => Promise<string|null>, verifySignatures?: (job: { version: string, dir: string }) => Promise<{ ok: boolean }> }} deps
 *   publishedAt (registry `time`) and verifySignatures (`npm audit signatures` in staging) fail closed when absent (held).
 */
export function createDshUpdatePipeline({ root, install, contractSuite, freeBytes, estimatedTreeBytes = 750 * 1024 ** 2,
  binRel = 'lib/bin.js', activeLink = path.join(root, 'current'), initialActive = null, now = () => new Date().toISOString(),
  publishedAt = async () => null, verifySignatures = async () => ({ ok: false }) }) {
  const stateFile = path.join(root, 'update-state.json');
  const versionsDir = path.join(root, 'versions');
  const reviewedDir = path.join(root, 'reviewed');
  let running = false;
  for (const dir of [root, versionsDir, reviewedDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A version installed before the pipeline existed (a reviewed repo pin) is the starting point.
  if (initialActive && !fs.existsSync(stateFile)) {
    writeJsonAtomic(stateFile, { active: initialActive, previous: null, held: [], status: { state: 'installed', code: null, candidateVersion: null } });
  }

  const state = () => readJson(stateFile, { active: null, previous: null, held: [], status: { state: 'installed', code: null, candidateVersion: null } });
  const save = (next) => { writeJsonAtomic(stateFile, next); return next; };
  const setStatus = (status) => save({ ...state(), status: { code: null, candidateVersion: null, ...status, at: now() } });
  /** Holds `version`. Conditions that pass with time (too new, disk) only set the status. */
  const hold = (version, code) => {
    const s = state();
    const passing = code === DSH_UPDATE_CODES.tooNew || code === DSH_UPDATE_CODES.disk;
    const held = passing ? s.held : [...s.held.filter((h) => h.version !== version), { version, code, at: now() }];
    save({ ...s, held, status: { state: 'held', code, candidateVersion: version, clearable: true, at: now() } });
    return { status: 'held', code, version };
  };
  const lockFile = path.join(root, 'pipeline.lock');
  /** Cross-process lock: O_EXCL file holding `<pid>:<start time>`; a dead or reused pid is stale. */
  function acquireLock() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.writeFileSync(lockFile, `${process.pid}:${processStartTime(process.pid) ?? ''}`, { flag: 'wx', mode: 0o600 });
        return true;
      } catch {
        let holder;
        try { holder = fs.readFileSync(lockFile, 'utf8'); } catch (error) {
          if (error?.code === 'ENOENT') continue; // released between our attempt and the read: retry
          return false;
        }
        if (lockHolderAlive(holder)) return false;
        fs.rmSync(lockFile, { force: true });
      }
    }
    return false;
  }

  /** Points the active link at `version` by an atomic rename of a fresh symlink. */
  function link(version) {
    const tmp = `${activeLink}.nassaj-${process.pid}-${crypto.randomUUID()}`;
    fs.mkdirSync(path.dirname(activeLink), { recursive: true });
    fs.symlinkSync(path.join(versionsDir, version, binRel), tmp);
    fs.renameSync(tmp, activeLink);
  }

  /** Keeps the active and previous versions (and their reviewed records); removes the rest. */
  function prune(keep) {
    for (const name of fs.readdirSync(versionsDir)) {
      if (!keep.includes(name)) fs.rmSync(path.join(versionsDir, name), { recursive: true, force: true });
    }
    for (const name of fs.readdirSync(reviewedDir)) {
      if (!keep.includes(name)) fs.rmSync(path.join(reviewedDir, name), { recursive: true, force: true });
    }
  }

  /** Moves a green tree in, records its reviewed result, switches the link. */
  async function promote(version, tree, installed, report) {
    const target = path.join(versionsDir, version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tree, target);
    const lock = installed.lock ? JSON.parse(String(installed.lock)) : { packages: {} };
    const keys = Object.keys(lock.packages ?? {}).filter((key) => key !== '' && fs.existsSync(path.join(target, key)));
    const entry = path.join(target, binRel);
    const manifest = { schema: 1, harness: 'dsh', package: '@deepseek-ai/dsh', version, platform: `${process.platform}-${process.arch}`,
      lockfileSha256: installed.lock ? crypto.createHash('sha256').update(installed.lock).digest('hex') : null,
      entry: { path: binRel, sha256: fs.existsSync(entry) ? hashSmallFileSync(entry) : null },
      ...(await computeTreeManifest(target, keys)), autoVerified: true };
    const record = path.join(reviewedDir, version);
    fs.mkdirSync(record, { recursive: true, mode: 0o700 });
    if (installed.lock) fs.writeFileSync(path.join(record, 'package-lock.json'), installed.lock);
    if (installed.packageJson) fs.writeFileSync(path.join(record, 'package.json'), installed.packageJson);
    writeJsonAtomic(path.join(record, 'tree-manifest.json'), manifest);
    writeJsonAtomic(path.join(record, 'report.json'), { version, verifiedAt: now(), report: report ?? null });
    const s = state();
    link(version);
    const previous = s.active && s.active !== version ? s.active : s.previous;
    save({ ...s, active: version, previous, channelFailures: 0, status: { state: 'switched', code: null, candidateVersion: version, at: now() } });
    prune([version, previous].filter(Boolean).slice(0, KEEP_VERSIONS));
  }

  /** The refusal code a run must stop at before installing anything, or null. */
  function preflight(version) {
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) return DSH_UPDATE_CODES.notPinned;
    const s = state();
    const held = s.held.find((h) => h.version === version);
    if (held) return held.code;
    if (s.active && isPrerelease(version) && !isPrerelease(s.active)) return DSH_UPDATE_CODES.channel;
    const engines = checkPluginEngines(version);
    if (engines) return engines;
    const record = s.active ? readJson(path.join(reviewedDir, s.active, 'tree-manifest.json'), null) : null;
    const expected = record?.totalBytes || estimatedTreeBytes;
    if (freeBytes(root) < DISK_FACTOR * expected) return DSH_UPDATE_CODES.disk;
    return null;
  }

  /** qa I2: published long enough ago (registry `time`); null/unknown counts as too new. */
  async function oldEnough(version) {
    let published = null;
    try { published = await publishedAt(version); } catch { published = null; }
    const at = published ? Date.parse(published) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at >= DSH_MIN_CANDIDATE_AGE_MS;
  }

  /** The contract suite with a bounded retry of transient codes. */
  async function contractWithRetry(version, tree) {
    let verdict = null;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      verdict = await contractSuite({ version, dir: tree });
      if (verdict?.ok || !DSH_TRANSIENT_CODES.includes(verdict?.code)) return verdict;
    }
    return verdict;
  }

  /** Steps 4–6 for a candidate that passed the preflight. */
  async function stageAndCheck(version) {
    const staging = path.join(root, 'staging', crypto.randomUUID());
    const tree = path.join(staging, 'tree');
    fs.mkdirSync(path.join(staging, 'cache'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(tree, { recursive: true, mode: 0o700 });
    try {
      let installed;
      try {
        installed = await install({ version, dir: tree, cacheDir: path.join(staging, 'cache') });
      } catch (error) {
        return hold(version, error?.code ?? DSH_UPDATE_CODES.installFailed);
      }
      fs.rmSync(path.join(staging, 'cache'), { recursive: true, force: true });
      let signed = { ok: false };
      try { signed = await verifySignatures({ version, dir: tree }); } catch { signed = { ok: false }; }
      if (!signed?.ok) return hold(version, DSH_UPDATE_CODES.signatureFailed);
      const verdict = await contractWithRetry(version, tree);
      if (!verdict?.ok) return hold(version, verdict?.code ?? DSH_UPDATE_CODES.contractFailed);
      await promote(version, tree, installed ?? {}, verdict.report);
      return { status: 'green', version };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** One pipeline run for an exact candidate version. */
  async function run({ version }) {
    if (running || !acquireLock()) return { status: 'held', code: DSH_UPDATE_CODES.busy, version };
    running = true;
    try {
      const refusal = preflight(version);
      if (refusal) {
        if (refusal === DSH_UPDATE_CODES.notPinned) return { status: 'held', code: refusal, version };
        return hold(version, refusal);
      }
      if (!(await oldEnough(version))) return hold(version, DSH_UPDATE_CODES.tooNew);
      setStatus({ state: 'checking', candidateVersion: version });
      return await stageAndCheck(version);
    } finally {
      running = false;
      fs.rmSync(lockFile, { force: true });
    }
  }

  /** The active version, its dir and the kept previous one. */
  function active() {
    const s = state();
    return { version: s.active, dir: s.active ? path.join(versionsDir, s.active) : null, previous: s.previous, status: s.status };
  }

  /** Full manifest check of the active tree against its reviewed record: null or 'tree_tampered'. */
  async function verifyActive() {
    const s = state();
    const manifest = s.active ? readJson(path.join(reviewedDir, s.active, 'tree-manifest.json'), null) : null;
    if (!manifest) return 'tree_unmanaged';
    const result = await verifyTreeManifest(path.join(versionsDir, s.active), manifest);
    return result.ok ? null : 'tree_tampered';
  }

  /**
   * A live launch on `version` failed with `code`. A capability code on the version the last run
   * switched to rolls back to the previous one (whose tree must still verify) and holds it.
   * @returns {Promise<boolean>} true when it rolled back
   */
  async function reportLaunchCapabilityFailure({ version, code }) {
    const s = state();
    if (!DSH_CAPABILITY_CODES.includes(code) || s.active !== version || !s.previous || s.status?.state !== 'switched') return false;
    if (code === 'dsh_cap_channel') {
      const failures = (s.channelFailures ?? 0) + 1;
      if (failures < CHANNEL_FAILURES_TO_ROLLBACK) { save({ ...s, channelFailures: failures }); return false; }
    }
    const manifest = readJson(path.join(reviewedDir, s.previous, 'tree-manifest.json'), null);
    if (manifest && !(await verifyTreeManifest(path.join(versionsDir, s.previous), manifest)).ok) return false;
    link(s.previous);
    const held = [...s.held.filter((h) => h.version !== version), { version, code, at: now() }];
    save({ ...s, active: s.previous, previous: version, held, channelFailures: 0,
      status: { state: 'rolled_back', code, candidateVersion: version, clearable: true, at: now() } });
    return true;
  }

  /** A launch on `version` passed its handshake: the switch is proven (qa round 2 M1). */
  function reportLaunchSuccess({ version }) {
    const s = state();
    if (s.active !== version) return;
    const proven = s.status?.state === 'switched' ? { state: 'installed', code: null, candidateVersion: null, at: now() } : s.status;
    if ((s.channelFailures ?? 0) === 0 && proven === s.status) return;
    save({ ...s, channelFailures: 0, status: proven });
  }

  /** The owner's explicit retry: forgets the hold of `version` (all holds when omitted). */
  function clearHold({ version } = {}) {
    const s = state();
    const held = version ? s.held.filter((h) => h.version !== version) : [];
    if (held.length === s.held.length) return false;
    const status = s.status?.clearable ? { state: 'installed', code: null, candidateVersion: null, at: now() } : s.status;
    save({ ...s, held, status });
    return true;
  }

  /** Boot: sweeps staging leftovers of a crashed run and corrects a stale `checking` state. */
  function recover() {
    if (running || !acquireLock()) return; // another live run owns staging
    try {
      fs.rmSync(path.join(root, 'staging'), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'staging'), { recursive: true, mode: 0o700 });
      const s = state();
      if (s.status?.state === 'checking') {
        save({ ...s, status: { state: 'installed', code: DSH_UPDATE_CODES.interrupted, candidateVersion: s.status.candidateVersion ?? null, at: now() } });
      }
    } finally {
      fs.rmSync(lockFile, { force: true }); // released only after the sweep (qa round 2 M2)
    }
  }

  return { run, active, held: () => state().held, status: () => state().status, verifyActive, reportLaunchCapabilityFailure,
    reportLaunchSuccess, clearHold, recover };
}
