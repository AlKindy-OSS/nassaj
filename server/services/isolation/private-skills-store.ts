/**
 * private-skills-store — each user's private skill copy per harness (ADR-203,
 * T-2003 C2): `~/.nassaj-users/<id>/.nassaj-private/<harness>/skills/<name>/`.
 *
 * Integrity rules (ADR-203 conditions 4 and 5), enforced here for every caller:
 *   - the user id is a positive integer and the harness is `claude` or `codex`;
 *   - every component from `~/.nassaj-users` down is lstat-checked: a symlink or
 *     a non-directory anywhere is refused (never followed);
 *   - skill names match SAFE_SEGMENT_RE; reads never follow a symlink and are
 *     capped (files per skill, bytes per file and per store, depth);
 *   - seeding happens ONCE: an existing store is reused and never overwritten.
 *     The copy is built in a sibling temp dir and renamed into place, so a
 *     concurrent or failed seed never leaves a half store under the real name.
 *
 * Same uid for everyone: this is integrity (the app never writes outside the
 * caller's own tree), not isolation (ADR-203 Context).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SAFE_SEGMENT_RE,
  loadVerifiedSkillSources,
  resolveCoreRoot,
} from './codex-shared-skills.js';
import type { PrivateSkillsHarness } from './harness-files-mode.js';

export const PRIVATE_SKILLS_CAPS = Object.freeze({
  filesPerSkill: 200,
  bytesPerFile: 1024 * 1024,
  bytesPerStore: 8 * 1024 * 1024,
  depth: 6,
});

/** Top-level names of the shared Claude library that are never skills. */
const CLAUDE_SEED_DENY = new Set(['synced', 'LICENSES']);
/** App install marker (skills.provider.ts B-175/2); seeded copies carry it. */
const SKILL_MARKER_FILE = '.nassaj-skill.json';
const DIR_MODE = 0o700;

export type PrivateStoreErrorCode =
  | 'invalid_target'
  | 'path_rejected'
  | 'cap_exceeded'
  | 'seed_source_unverified'
  | 'seed_source_unavailable';

/** Typed failure the API layer maps to 4xx/5xx without string matching. */
export class PrivateStoreError extends Error {
  readonly code: PrivateStoreErrorCode;
  readonly detail?: string;

  constructor(code: PrivateStoreErrorCode, detail?: string) {
    super(`private skills store: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'PrivateStoreError';
    this.code = code;
    this.detail = detail;
  }
}

export type SkillFile = { bytes: Buffer; mode: number };
export type SkillFiles = Map<string, SkillFile>;

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function usersRoot(): string {
  return path.join(os.homedir(), '.nassaj-users');
}

function assertTarget(userId: string | number, harness: string): number {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(userId).trim()) {
    throw new PrivateStoreError('invalid_target', 'user');
  }
  if (harness !== 'claude' && harness !== 'codex') {
    throw new PrivateStoreError('invalid_target', 'harness');
  }
  return id;
}

/** Components from `~/.nassaj-users` down to the store root (inclusive). */
function storeChain(userId: string | number, harness: PrivateSkillsHarness): string[] {
  const id = assertTarget(userId, harness);
  const root = usersRoot();
  const parts = [String(id), '.nassaj-private', harness, 'skills'];
  const chain = [root];
  for (const part of parts) chain.push(path.join(chain[chain.length - 1], part));
  return chain;
}

/**
 * Absolute store root for one user and harness. Pure path math; validates the
 * id and harness but touches nothing on disk.
 */
export function privateSkillsStoreRoot(userId: string | number, harness: PrivateSkillsHarness): string {
  const chain = storeChain(userId, harness);
  return chain[chain.length - 1];
}

/** Throws path_rejected if any EXISTING component is a symlink or not a dir. */
function assertChainReal(chain: readonly string[]): void {
  for (const component of chain) {
    const st = lstatOrNull(component);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new PrivateStoreError('path_rejected', path.basename(component));
    }
  }
}

/**
 * Creates missing chain components top-down (0700). Each component is checked
 * BEFORE anything is created beneath it, so a symlinked parent is refused
 * instead of being written through.
 */
function ensureChainDirs(chain: readonly string[]): void {
  for (const component of chain) {
    assertChainReal([component]);
    if (lstatOrNull(component)) continue;
    try {
      fs.mkdirSync(component, { mode: DIR_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    assertChainReal([component]);
  }
}

/** True when the store root exists as a real directory (chain verified). */
export function privateSkillsStoreExists(userId: string | number, harness: PrivateSkillsHarness): boolean {
  const chain = storeChain(userId, harness);
  assertChainReal(chain);
  return Boolean(lstatOrNull(chain[chain.length - 1])?.isDirectory());
}

/**
 * Resolves `<store>/<name>` for a write (condition 4): name must match
 * SAFE_SEGMENT_RE and every existing component (including `<name>`) must be a
 * real directory. Creates the store chain if missing; does not create `<name>`.
 */
export function resolvePrivateSkillTarget(
  userId: string | number,
  harness: PrivateSkillsHarness,
  name: string,
): string {
  if (typeof name !== 'string' || !SAFE_SEGMENT_RE.test(name)) {
    throw new PrivateStoreError('path_rejected', 'name');
  }
  const chain = storeChain(userId, harness);
  ensureChainDirs(chain);
  const target = path.join(chain[chain.length - 1], name);
  assertChainReal([target]);
  assertRealpathInside(target, chain[chain.length - 1]);
  return target;
}

/** Verifies realpath(target) (or of its parent when absent) stays under `root`. */
export function assertRealpathInside(target: string, root: string): void {
  const realRoot = fs.realpathSync(root);
  const probe = lstatOrNull(target) ? target : path.dirname(target);
  const realProbe = fs.realpathSync(probe);
  const inside = realProbe === realRoot || realProbe.startsWith(`${realRoot}${path.sep}`);
  if (!inside) throw new PrivateStoreError('path_rejected', 'realpath');
}

type WalkBudget = { storeBytes: number; skillFiles: number };

function addFile(files: SkillFiles, rel: string, abs: string, st: fs.Stats, budget: WalkBudget): void {
  if (st.size > PRIVATE_SKILLS_CAPS.bytesPerFile) throw new PrivateStoreError('cap_exceeded', 'file_bytes');
  budget.skillFiles += 1;
  budget.storeBytes += st.size;
  if (budget.skillFiles > PRIVATE_SKILLS_CAPS.filesPerSkill) {
    throw new PrivateStoreError('cap_exceeded', 'skill_files');
  }
  if (budget.storeBytes > PRIVATE_SKILLS_CAPS.bytesPerStore) {
    throw new PrivateStoreError('cap_exceeded', 'store_bytes');
  }
  files.set(rel, { bytes: fs.readFileSync(abs), mode: st.mode & 0o777 });
}

/**
 * Walks one skill directory without following links. Symlinks and unsafe names
 * are skipped (recorded in `skipped`); caps throw `cap_exceeded`.
 */
function walkSkillDir(
  dir: string,
  rel: string,
  depth: number,
  out: { files: SkillFiles; skipped: string[]; budget: WalkBudget },
): void {
  if (depth > PRIVATE_SKILLS_CAPS.depth) throw new PrivateStoreError('cap_exceeded', 'depth');
  for (const name of fs.readdirSync(dir).sort()) {
    const childRel = `${rel}/${name}`;
    const abs = path.join(dir, name);
    const st = lstatOrNull(abs);
    if (!st || !SAFE_SEGMENT_RE.test(name) || st.isSymbolicLink()) {
      if (name !== SKILL_MARKER_FILE) out.skipped.push(childRel);
      continue;
    }
    if (st.isDirectory()) walkSkillDir(abs, childRel, depth + 1, out);
    else if (st.isFile()) addFile(out.files, childRel, abs, st, out.budget);
    else out.skipped.push(childRel);
  }
}

/** True when `<dir>/SKILL.md` is a REAL file and `dir` a real directory. */
function isRealSkillDir(dir: string): boolean {
  return Boolean(lstatOrNull(dir)?.isDirectory() && lstatOrNull(path.join(dir, 'SKILL.md'))?.isFile());
}

/**
 * Reads a skills tree into memory under the caps, never following a link: only
 * top-level REAL directories with a SAFE name and a REAL SKILL.md are skills.
 *
 * @param root directory whose children are skill folders
 * @param deny top-level names that are never skills
 */
export function readSkillTree(
  root: string,
  deny: ReadonlySet<string> = new Set(),
): { files: SkillFiles; skills: string[]; skipped: string[] } {
  const out = { files: new Map() as SkillFiles, skipped: [] as string[], budget: { storeBytes: 0, skillFiles: 0 } };
  const skills: string[] = [];
  if (!lstatOrNull(root)?.isDirectory()) return { files: out.files, skills, skipped: out.skipped };
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (deny.has(name) || !SAFE_SEGMENT_RE.test(name) || !isRealSkillDir(dir)) {
      if (!name.startsWith('.')) out.skipped.push(name);
      continue;
    }
    out.budget.skillFiles = 0;
    walkSkillDir(dir, name, 1, out);
    skills.push(name);
  }
  return { files: out.files, skills, skipped: out.skipped };
}

/** Claude seed source: realpath(~/.claude/skills), real skill dirs only. */
function planClaudeSeed(): SkillFiles {
  let source: string;
  try {
    source = fs.realpathSync(path.join(os.homedir(), '.claude', 'skills'));
  } catch {
    return new Map();
  }
  return readSkillTree(source, CLAUDE_SEED_DENY).files;
}

/** Applies the store caps to an already-loaded file map (Codex manifest seed). */
function assertFilesWithinCaps(files: SkillFiles): void {
  const perSkill = new Map<string, number>();
  let total = 0;
  for (const [rel, { bytes }] of files) {
    const parts = rel.split('/');
    if (parts.length - 1 > PRIVATE_SKILLS_CAPS.depth) throw new PrivateStoreError('cap_exceeded', 'depth');
    if (bytes.length > PRIVATE_SKILLS_CAPS.bytesPerFile) throw new PrivateStoreError('cap_exceeded', 'file_bytes');
    const count = (perSkill.get(parts[0]) ?? 0) + 1;
    perSkill.set(parts[0], count);
    total += bytes.length;
    if (count > PRIVATE_SKILLS_CAPS.filesPerSkill) throw new PrivateStoreError('cap_exceeded', 'skill_files');
    if (total > PRIVATE_SKILLS_CAPS.bytesPerStore) throw new PrivateStoreError('cap_exceeded', 'store_bytes');
  }
}

let coreRootMissingLogged = false;

/**
 * Codex seed source: nassaj-core dist/portable/skills verified against
 * MANIFEST.json (the same bytes shared mode installs). An unresolvable core root
 * is refused (`seed_source_unavailable`) rather than seeding an empty store that
 * would then be reused forever; a core without a manifest seeds empty (shared
 * mode installs nothing either); a failed verification is refused.
 */
function planCodexSeed(): SkillFiles {
  const coreRoot = resolveCoreRoot({});
  if (!coreRoot) {
    if (!coreRootMissingLogged) {
      coreRootMissingLogged = true;
      console.warn('[harness-files] nassaj-core root unresolved; Codex private store not seeded');
    }
    throw new PrivateStoreError('seed_source_unavailable', 'core_root');
  }
  const loaded = loadVerifiedSkillSources(coreRoot) as
    | { ok: true; files: SkillFiles }
    | { ok: false; reason: string };
  if (!loaded.ok) {
    if (loaded.reason === 'manifest_unavailable' || loaded.reason === 'no_skills_in_manifest') return new Map();
    throw new PrivateStoreError('seed_source_unverified', loaded.reason);
  }
  assertFilesWithinCaps(loaded.files);
  return loaded.files;
}

function writeSeedTree(tmpRoot: string, files: SkillFiles, harness: PrivateSkillsHarness): void {
  const skills = new Set<string>();
  for (const [rel, { bytes, mode }] of files) {
    const target = path.join(tmpRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: (mode & 0o100) ? 0o700 : 0o600 });
    skills.add(rel.split('/')[0]);
  }
  const seededAt = new Date().toISOString();
  for (const name of skills) {
    const marker = { managedBy: 'nassaj', provider: harness, name, installedAt: seededAt, seededFrom: 'shared' };
    fs.writeFileSync(path.join(tmpRoot, name, SKILL_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * Seeds the store from the harness's own shared source if it does not exist
 * yet. Never overwrites: an existing store (or one created concurrently) is
 * reused. Caller must hold the user's harness-files lock.
 *
 * @returns `seeded: false` when the store already existed
 */
export function seedPrivateSkillsStore(
  userId: string | number,
  harness: PrivateSkillsHarness,
): { seeded: boolean; skills: number } {
  const chain = storeChain(userId, harness);
  const storeRoot = chain[chain.length - 1];
  assertChainReal(chain);
  if (lstatOrNull(storeRoot)) return { seeded: false, skills: 0 };
  const files = harness === 'claude' ? planClaudeSeed() : planCodexSeed();
  ensureChainDirs(chain.slice(0, -1));
  const tmpRoot = path.join(path.dirname(storeRoot), `.skills.seed-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpRoot, { mode: DIR_MODE });
  try {
    writeSeedTree(tmpRoot, files, harness);
    fs.renameSync(tmpRoot, storeRoot);
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return { seeded: false, skills: 0 };
    throw err;
  }
  assertChainReal(chain);
  return { seeded: true, skills: new Set([...files.keys()].map((rel) => rel.split('/')[0])).size };
}

/**
 * Loads a user's private store for Codex materialization (condition 5): no
 * manifest, lstat-only walk, symlinks and unsafe names skipped, caps enforced.
 */
export function readPrivateSkillSources(
  userId: string | number,
  harness: PrivateSkillsHarness,
): { files: SkillFiles; skipped: string[] } {
  const chain = storeChain(userId, harness);
  assertChainReal(chain);
  const { files, skipped } = readSkillTree(chain[chain.length - 1]);
  return { files, skipped };
}

/** Upper bound on listed private skills so a flooded store cannot stall a listing. */
const MAX_LISTED_PRIVATE_SKILLS = 500;

/**
 * SKILL.md paths of the user's private skills for listing: lstat-only, SAFE
 * names, real dirs with a real SKILL.md, capped count. Empty when the store is
 * absent or its path is unsafe (never throws).
 */
export function listPrivateSkillFiles(userId: string | number, harness: PrivateSkillsHarness): string[] {
  try {
    const chain = storeChain(userId, harness);
    assertChainReal(chain);
    const root = chain[chain.length - 1];
    if (!lstatOrNull(root)?.isDirectory()) return [];
    return fs.readdirSync(root).sort()
      .filter((name) => SAFE_SEGMENT_RE.test(name) && isRealSkillDir(path.join(root, name)))
      .slice(0, MAX_LISTED_PRIVATE_SKILLS)
      .map((name) => path.join(root, name, 'SKILL.md'));
  } catch {
    return [];
  }
}
