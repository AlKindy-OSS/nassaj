/**
 * codex-shared-skills — materializes nassaj's portable skills (nassaj-core
 * dist/portable/skills, ADR-191) into an isolated per-user Codex home
 * (<codexHome>/skills/<name>/), so a Codex session launched with
 * CODEX_HOME=~/.nassaj-users/<id>/.codex sees the same skills as the operator home
 * (T-2000, ADR-202). The operator home (~/.codex) is NOT handled here: it stays with
 * nassaj-core's scripts/sync-harness-homes.
 *
 * Mechanics mirror sync-harness-homes `plan_owned_tree` (codex-skills target):
 *   - every source file is verified against dist/MANIFEST.json (path, sha256, exec bit)
 *     and read ONCE; writes use only those verified in-memory bytes;
 *   - per-file byte + exec-bit compare, atomic tmp+rename writes, symlinks replaced by
 *     real files, stale files inside owned skill dirs deleted, dropped owned skills
 *     removed; ENOENT on delete is tolerated (a concurrent launch may race us);
 *   - ownership is recorded in <codexHome>/skills/.nassaj-sync-state.json with the SAME
 *     format and owner string as the script, written last, so either tool can converge
 *     the other's output.
 * Deliberate difference: a same-named directory we do NOT own (absent from the state
 * file) is left untouched, logged, and excluded from the state — the script instead
 * refuses the whole run unless --force. `.system` (Codex's own skills) is never touched.
 *
 * Security posture (honest scope): the manifest check detects DRIFT or CORRUPTION of
 * the source tree. It is NOT isolation: every session runs on one uid with full
 * control (owner decision 2026-09-28), so a deliberate actor can alter both the source
 * files and MANIFEST.json together.
 *
 * Synchronous node fs only; never throws. Safe to call on every Codex launch.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Ownership-state filename shared with nassaj-core scripts/sync-harness-homes. */
export const SKILLS_STATE_NAME = '.nassaj-sync-state.json';
/** Owner string written by scripts/sync-harness-homes; kept identical on purpose. */
export const SKILLS_STATE_OWNER = 'scripts/sync-harness-homes (ADR-191)';
/** Manifest-relative prefix of the portable skills tree. */
const SOURCE_PREFIX = 'dist/portable/skills/';
const MANIFEST_REL = path.join('dist', 'MANIFEST.json');
/** Plain single-segment skill name; shared with the Codex skills listing (T-2003). */
export const SAFE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolves the nassaj-core root: explicit option, then NASSAJ_CORE_DIR, then the
 * directory of realpath(<home>/.claude/AGENTS.md) (same basis as the governance copy).
 *
 * @param {{home?: string, coreRoot?: string}} opts
 * @returns {string|null} absolute core root, or null when unresolvable
 */
export function resolveCoreRoot(opts = {}) {
  if (opts.coreRoot) {
    return opts.coreRoot;
  }
  if (process.env.NASSAJ_CORE_DIR) {
    return process.env.NASSAJ_CORE_DIR;
  }
  const home = opts.home || os.homedir();
  const real = realpathOrNull(path.join(home, '.claude', 'AGENTS.md'));
  return real ? path.dirname(real) : null;
}

/** True iff every segment of a skills-relative path is a plain, safe name. */
function isSafeRel(rel) {
  const parts = rel.split('/');
  return parts.length >= 2 && parts.every((p) => SAFE_SEGMENT_RE.test(p) && p !== '..');
}

/** Verifies one manifest entry; returns {bytes, mode} or a problem string. */
function verifyEntry(coreRoot, rel, meta) {
  const abs = path.join(coreRoot, rel);
  const st = lstatOrNull(abs);
  if (!st || !st.isFile()) {
    return `missing ${rel}`;
  }
  const mode = Number.parseInt(String(meta?.mode ?? ''), 8);
  if (!Number.isInteger(mode) || typeof meta?.sha256 !== 'string') {
    return `bad_entry ${rel}`;
  }
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch {
    return `unreadable ${rel}`;
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
    return `sha_mismatch ${rel}`;
  }
  if (Boolean(st.mode & 0o111) !== Boolean(mode & 0o111)) {
    return `exec_bit_mismatch ${rel}`;
  }
  return { bytes, mode: mode & 0o777 };
}

/**
 * Loads and verifies every portable-skill file listed in the core manifest.
 *
 * @param {string} coreRoot nassaj-core root
 * @returns {{ok: true, files: Map<string, {bytes: Buffer, mode: number}>} |
 *           {ok: false, reason: string, problems?: string[]}}
 */
export function loadVerifiedSkillSources(coreRoot) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(path.join(coreRoot, MANIFEST_REL), 'utf8')).files;
  } catch {
    return { ok: false, reason: 'manifest_unavailable' };
  }
  if (!entries || typeof entries !== 'object') {
    return { ok: false, reason: 'manifest_malformed' };
  }
  const files = new Map();
  const problems = [];
  for (const rel of Object.keys(entries).sort()) {
    if (!rel.startsWith(SOURCE_PREFIX)) {
      continue;
    }
    const skillRel = rel.slice(SOURCE_PREFIX.length);
    if (!isSafeRel(skillRel)) {
      problems.push(`unsafe_path ${rel}`);
      continue;
    }
    const verified = verifyEntry(coreRoot, rel, entries[rel]);
    if (typeof verified === 'string') {
      problems.push(verified);
    } else {
      files.set(skillRel, verified);
    }
  }
  if (problems.length > 0) {
    return { ok: false, reason: 'source_verification_failed', problems };
  }
  if (files.size === 0) {
    return { ok: false, reason: 'no_skills_in_manifest' };
  }
  return { ok: true, files };
}

/** Reads the owned-skill list from the state file; [] when absent or unparseable. */
function readOwnedSkills(skillsRoot) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(skillsRoot, SKILLS_STATE_NAME), 'utf8'));
    const list = Array.isArray(doc?.skills) ? doc.skills : [];
    return list.filter((n) => typeof n === 'string' && SAFE_SEGMENT_RE.test(n));
  } catch {
    return [];
  }
}

/** Atomic write via a unique sibling tmp name, then rename over the target. */
function writeAtomic(target, bytes, mode) {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Ensures every dir from `base` down to `dir` is a real directory (symlinks replaced). */
function ensureRealDirChain(base, dir) {
  const rel = path.relative(base, dir);
  let cur = base;
  for (const seg of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, seg);
    const st = lstatOrNull(cur);
    if (st && !st.isDirectory()) {
      fs.rmSync(cur, { force: true });
    }
    if (!st || !st.isDirectory()) {
      fs.mkdirSync(cur, { recursive: true, mode: 0o755 });
    }
  }
}

/** True iff the target already holds the exact bytes with a matching exec bit. */
function fileMatches(target, bytes, mode) {
  const st = lstatOrNull(target);
  if (!st || !st.isFile() || Boolean(st.mode & 0o111) !== Boolean(mode & 0o111)) {
    return false;
  }
  try {
    return fs.readFileSync(target).equals(bytes);
  } catch {
    return false;
  }
}

/** Removes a path, tolerating ENOENT (a concurrent launch may have removed it). */
function removeTolerant(p, recursive = false) {
  try {
    fs.rmSync(p, { recursive, force: true });
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/** True iff `p` is a real directory (lstat; a symlink to a dir is NOT one). */
function isRealDir(p) {
  return Boolean(lstatOrNull(p)?.isDirectory());
}

/**
 * Lists files/symlinks under `dir` as dir-relative paths. Never follows a symlink:
 * a non-real-dir `dir` yields nothing, and symlinked children are listed, not entered.
 */
function listTreeFiles(dir, prefix = '') {
  if (!isRealDir(dir)) {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...listTreeFiles(path.join(dir, e.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Splits source skills into those we may manage and those blocked by an unowned
 * same-named entry (left untouched, logged, excluded from state).
 */
function partitionSkills(skillsRoot, sourceSkills, ownedPrev) {
  const managed = [];
  const blocked = [];
  for (const name of sourceSkills) {
    // An owned entry that became a symlink/file is ours to replace (ensureRealDirChain).
    if (lstatOrNull(path.join(skillsRoot, name)) && !ownedPrev.has(name)) {
      blocked.push(name);
    } else {
      managed.push(name);
    }
  }
  return { managed, blocked };
}

/** Writes changed files of the managed skills; returns the write count. */
function writeSkillFiles(skillsRoot, files, managedSet) {
  let written = 0;
  for (const [rel, { bytes, mode }] of files) {
    if (!managedSet.has(rel.split('/')[0])) {
      continue;
    }
    const target = path.join(skillsRoot, ...rel.split('/'));
    // Replace symlinked parents BEFORE comparing: a match read through a link outside
    // codexHome must never short-circuit the repair.
    ensureRealDirChain(skillsRoot, path.dirname(target));
    if (fileMatches(target, bytes, mode)) {
      continue;
    }
    writeAtomic(target, bytes, mode);
    written += 1;
  }
  return written;
}

/** Deletes stale files in managed skills and whole owned skills dropped from source. */
function pruneOwned(skillsRoot, files, managed, ownedPrev, sourceSkillSet) {
  let removed = 0;
  for (const name of managed) {
    const skillDir = path.join(skillsRoot, name);
    if (!isRealDir(skillDir)) {
      // Never list or delete through a link: drop the link itself only.
      removed += removeTolerant(skillDir) ? 1 : 0;
      continue;
    }
    for (const rel of listTreeFiles(skillDir, name)) {
      if (!files.has(rel) && removeTolerant(path.join(skillsRoot, ...rel.split('/')))) {
        removed += 1;
      }
    }
  }
  for (const name of ownedPrev) {
    if (!sourceSkillSet.has(name)) {
      if (removeTolerant(path.join(skillsRoot, name), true)) {
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * Writes the ownership state (script-identical JSON) when it differs; last step.
 * Private mode (ADR-203) adds `"mode":"private"`; shared mode keeps the exact
 * script format so either tool can converge the other's output.
 */
function writeState(skillsRoot, managed, mode) {
  const doc = { owner: SKILLS_STATE_OWNER, skills: [...managed].sort() };
  if (mode === 'private') {
    doc.mode = 'private';
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const target = path.join(skillsRoot, SKILLS_STATE_NAME);
  let current = null;
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current !== text) {
    writeAtomic(target, Buffer.from(text, 'utf8'), 0o644);
  }
}

/** Converges <skillsRoot> from verified sources. Throws on fs errors (caller catches). */
function convergeSkills(skillsRoot, files, mode) {
  const sourceSkillSet = new Set([...files.keys()].map((rel) => rel.split('/')[0]));
  const ownedPrev = new Set(readOwnedSkills(skillsRoot));
  const { managed, blocked } = partitionSkills(skillsRoot, [...sourceSkillSet].sort(), ownedPrev);
  if (blocked.length > 0) {
    console.warn('[Codex] shared skills: unowned same-name entries left untouched', {
      skillsRoot,
      blocked,
    });
  }
  const written = writeSkillFiles(skillsRoot, files, new Set(managed));
  const removed = pruneOwned(skillsRoot, files, managed, ownedPrev, sourceSkillSet);
  writeState(skillsRoot, managed, mode);
  return { written, removed, blocked };
}

/**
 * Loads the files to materialize: the caller's private set (ADR-203; already read
 * by private-skills-store with lstat, caps and safe names) or the manifest-verified
 * shared set.
 */
function loadSources(opts) {
  if (opts.privateFiles instanceof Map) {
    return { ok: true, files: opts.privateFiles, mode: 'private' };
  }
  const coreRoot = resolveCoreRoot(opts);
  if (!coreRoot) {
    return { ok: false, reason: 'core_root_unresolved' };
  }
  const sources = loadVerifiedSkillSources(coreRoot);
  if (!sources.ok) {
    console.warn('[Codex] shared skills: source verification failed — nothing written', {
      reason: sources.reason,
      problems: sources.problems?.slice(0, 20),
    });
    return sources;
  }
  return { ok: true, files: sources.files, mode: 'shared' };
}

/**
 * Materializes skills into <codexHome>/skills/. Never throws. Skips (ok:true,
 * skipped:true) for the operator Codex home, which sync-harness-homes owns. On any
 * source failure nothing is written (ok:false).
 *
 * Source: nassaj's manifest-verified portable skills (shared mode), or, when
 * `opts.privateFiles` is given, the user's private store (ADR-203). Both use the
 * same ownership rules: only skills named in the state file are ever replaced or
 * deleted; unowned same-named dirs and `.system` are never touched.
 *
 * @param {string} codexHome the effective (isolated) CODEX_HOME of this launch
 * @param {{home?: string, coreRoot?: string,
 *          privateFiles?: Map<string, {bytes: Buffer, mode: number}>}} [opts]
 * @returns {{ok: boolean, reason?: string, written: number, removed: number,
 *            skipped: boolean, blocked?: string[], problems?: string[], mode?: string}}
 */
export function materializeSharedSkills(codexHome, opts = {}) {
  const base = { written: 0, removed: 0, skipped: false };
  if (typeof codexHome !== 'string' || !codexHome) {
    return { ok: false, reason: 'codex_home_invalid', ...base };
  }
  const operatorCodex = realpathOrNull(path.join(opts.home || os.homedir(), '.codex'));
  if (operatorCodex && realpathOrNull(codexHome) === operatorCodex) {
    return { ok: true, reason: 'operator_home', ...base, skipped: true };
  }
  const sources = loadSources(opts);
  if (!sources.ok) {
    return { ok: false, reason: sources.reason, problems: sources.problems, ...base };
  }
  const skillsRoot = path.join(codexHome, 'skills');
  try {
    fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o755 });
    if (lstatOrNull(skillsRoot)?.isSymbolicLink()) {
      return { ok: false, reason: 'skills_root_symlink', ...base };
    }
    const { written, removed, blocked } = convergeSkills(skillsRoot, sources.files, sources.mode);
    return { ok: true, written, removed, skipped: false, blocked, mode: sources.mode };
  } catch (err) {
    console.warn('[Codex] shared skills: write failed (non-fatal)', {
      skillsRoot,
      error: errMessage(err),
    });
    return { ok: false, reason: 'write_failed', ...base };
  }
}
