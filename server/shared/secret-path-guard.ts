/**
 * Secret-location guard for project roots and project file access (B-1373).
 *
 * The project path guard (server/utils/path-guard.js) only proves that a path
 * stays inside its project root. It cannot help when the ROOT itself is the
 * service user's home: a project registered at the service home made every
 * credential under it (`.ssh`, `.config/nassaj`, `.nassaj-users/*`, the live
 * database, Claude credentials) readable by any member through
 * GET /api/projects/:id/file.
 *
 * This module is the single policy for that class of leak:
 *   - `findForbiddenProjectRootReason` refuses a project root that equals or
 *     contains the service user's home, or equals/contains/lies inside a known
 *     secret location. Legitimate roots such as `~/Project/<name>` pass.
 *   - `isSecretPath` refuses any path that resolves (realpath) into a secret
 *     location, as defense in depth for file reads/writes on existing projects.
 *   - Structural rule (round 2): everything under a first-level hidden entry of
 *     a protected home is secret, except ALLOWED_HIDDEN_HOME_ENTRIES. The fixed
 *     SECRET_HOME_ENTRIES list stays as defense in depth (it also wins over the
 *     allowlist).
 *
 *   - Secret files at any depth (security fix after B-1373): dotenv files
 *     (`.env`, `.env.*`, `.envrc`, matched on the basename, case-insensitive)
 *     except the secret-free templates in PUBLIC_ENV_TEMPLATE_NAMES, and the
 *     live application database (DATABASE_PATH and its -wal/-shm/-journal
 *     siblings). A project rooted at the install directory otherwise served
 *     JWT_SECRET to every member who can see the project (ADR-089).
 *
 *   - Two classes (B-1593): `classifySecretPath` separates SERVICE secrets
 *     (credential locations, harness stores, the service database, and any dotenv
 *     or SQLite file under a service root: the install root, the deploy/
 *     release/update-control roots and NASSAJ_SERVICE_SECRET_ROOTS), which are
 *     never served, from PROJECT secret files (dotenv/SQLite files elsewhere),
 *     which a member may open after an explicit per-request confirmation.
 *
 * Synchronous on purpose: it is called from both the async read guard and the
 * synchronous mutate guard. Depends only on node built-ins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDeniedHostSecretEnvKey } from '../services/isolation/sanitize-vendor-agent-env.js';

/**
 * Credential-bearing entries relative to a protected home directory. Anything
 * at or below one of these is never served, and no project root may equal,
 * contain, or lie inside one.
 */
export const SECRET_HOME_ENTRIES: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.docker',
  '.kube',
  '.netrc',
  '.git-credentials',
  '.config/nassaj',
  '.config/nassaj-test',
  '.config/gh',
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.hermes',
  '.local/share/nassaj-dev',
  '.nassaj-users',
]);

/**
 * Dotenv-style names that conventionally hold no secrets and stay readable.
 * Compared case-insensitively against the basename.
 */
export const PUBLIC_ENV_TEMPLATE_NAMES: readonly string[] = Object.freeze([
  '.env.example',
  '.env.sample',
  '.env.template',
]);

/**
 * Dotenv names (case-insensitive): `.env`, `.envrc`, any `.env`/`.envrc`
 * followed by `.`, `_`, `~` or `-` (`.env.local`, `.env~`, `.env-backup`,
 * `.env_old`), and anything ending in `.env` (`app.env`, `secrets.env`).
 */
const DOTENV_NAMES: readonly RegExp[] = Object.freeze([/^\.env(?:rc)?(?:[._~-].*)?$/i, /\.env$/i]);

/** SQLite files by name: main file plus WAL/SHM/journal sidecars. */
const SQLITE_FILE_NAME = /\.(?:sqlite3?|db3?)(?:-(?:wal|shm|journal))?$/i;

/** The 16-byte header every SQLite 3 database file starts with. */
export const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Configuration homes of the AI harnesses, relative to a home directory. Kept
 * in step with the per-user provider dirs in provision-user-dirs.js
 * (hardenUserTree), plus the opencode/hermes/cursor locations.
 */
export const HARNESS_HOME_ENTRIES: readonly string[] = Object.freeze([
  '.claude',
  '.codex',
  '.gemini',
  '.kimi',
  '.qwen',
  '.cursor',
  '.hermes',
  '.config/opencode',
  '.local/share/opencode',
]);

/**
 * Environment variables naming roots of the running service. A dotenv or SQLite
 * file under one of them is the service's own secret, never a project file.
 * NASSAJ_SERVICE_SECRET_ROOTS takes extra roots separated by path.delimiter.
 */
const SERVICE_ROOT_ENV_VARS: readonly string[] = Object.freeze([
  'NASSAJ_DEPLOY_ROOT',
  'NASSAJ_RELEASE_ROOT',
  'NASSAJ_UPDATE_CONTROL_ROOT',
  'NASSAJ_SERVICE_SECRET_ROOTS',
]);

/** Environment variables that relocate a harness home. */
const HARNESS_HOME_ENV_VARS: readonly string[] = Object.freeze(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);

/**
 * Entries directly below a harness home that hold transcripts, history,
 * credentials or session state. Their content is never served, wherever the
 * home really lives (`~/.claude` may be a symlink into a registered project).
 */
export const HARNESS_SECRET_ENTRIES: readonly string[] = Object.freeze([
  'projects',
  'sessions',
  'archived_sessions',
  'session-data',
  'session-env',
  'transcripts',
  'history',
  'history.jsonl',
  'todos',
  'shell-snapshots',
  'file-history',
  'paste-cache',
  'debug',
  'backups',
  'log',
  'logs',
  'memories',
  'tmp',
  'antigravity-cli',
  '.credentials.json',
  '.claude.json',
  'auth.json',
  'oauth_creds.json',
]);

/** Backup spellings of the stores above, e.g. `projects.backup-20260504`. */
const HARNESS_SECRET_ENTRY_PREFIX = /^(?:projects|sessions|history|transcripts)[._-]/;
/** Any `*auth.json` / `*credentials.json` at the top of a harness home. */
const HARNESS_SECRET_ENTRY_SUFFIX = /(?:auth|credentials)\.json$/i;

/** SQLite side files that hold configured database pages next to the main file. */
const DATABASE_SIDE_SUFFIXES: readonly string[] = Object.freeze(['', '-wal', '-shm', '-journal']);

/**
 * True when `fileName` (a basename) is a dotenv file that may hold secrets.
 * Templates listed in PUBLIC_ENV_TEMPLATE_NAMES are not secret.
 */
export function isSecretFileName(fileName: string): boolean {
  if (typeof fileName !== 'string' || !DOTENV_NAMES.some((pattern) => pattern.test(fileName))) return false;
  return !PUBLIC_ENV_TEMPLATE_NAMES.includes(fileName.toLowerCase());
}

/** True when `fileName` (a basename) names an SQLite database or sidecar. */
export function isSqliteFileName(fileName: string): boolean {
  return typeof fileName === 'string' && SQLITE_FILE_NAME.test(fileName);
}

/** True when `bytes` starts with the SQLite 3 file header. */
export function hasSqliteHeader(bytes: Uint8Array): boolean {
  return bytes.length >= SQLITE_HEADER.length
    && Buffer.from(bytes.buffer, bytes.byteOffset, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}

/** True when `bytes` starts with an SQLite write-ahead-log magic (0x377f0682 / 0x377f0683). */
export function hasSqliteWalHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x37 && bytes[1] === 0x7f && bytes[2] === 0x06
    && (bytes[3] === 0x82 || bytes[3] === 0x83);
}

/**
 * Tables only the Nassaj application database creates. sqlite_master keeps the
 * original CREATE TABLE text, so the schema is recognised by a byte scan of the
 * file, without opening it with SQLite or executing anything it contains.
 */
const APP_SCHEMA_TABLE_PATTERN = new RegExp(
  'CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["`\\[]?(app_config|audit_log|pending_server_actions'
  + '|session_participants|vapid_keys|device_sessions|project_members|api_keys)\\b',
  'gi',
);

/** How many distinct application tables identify the application database. */
const APP_SCHEMA_MIN_TABLES = 2;

/** True when `bytes` (an SQLite file prefix) carries the Nassaj application schema. */
export function hasAppDatabaseSchema(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
  const found = new Set<string>();
  for (const match of text.matchAll(APP_SCHEMA_TABLE_PATTERN)) {
    found.add(match[1].toLowerCase());
    if (found.size >= APP_SCHEMA_MIN_TABLES) return true;
  }
  return false;
}

/** Shortest value treated as a service secret (shorter values collide with ordinary text). */
const MIN_SECRET_VALUE_LENGTH = 16;

/** Extra env-name suffixes that hold credentials beyond the host-secret deny list. */
const EXTRA_SECRET_ENV_SUFFIXES: readonly string[] = Object.freeze(['_TOKEN', '_KEY']);

/** Secret values the running service resolved outside the environment (e.g. JWT from app_config). */
const registeredSecretValues = new Set<string>();

/**
 * Registers a secret the running service holds but which is not in
 * process.env (the JWT secret persisted in app_config). Never logged.
 */
export function registerServiceSecretValue(value: unknown): void {
  if (typeof value === 'string' && value.length >= MIN_SECRET_VALUE_LENGTH) registeredSecretValues.add(value);
}

/** True when an env variable name holds a credential of the running service. */
function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.includes('PUBLIC')) return false; // e.g. VAPID_PUBLIC_KEY is served to browsers.
  return isDeniedHostSecretEnvKey(name) || EXTRA_SECRET_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/** Secret values the running service holds: secret-named env values plus registered ones. */
function serviceSecretValues(): string[] {
  const values = new Set<string>(registeredSecretValues);
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (path.isAbsolute(value) || !isSecretEnvName(name)) continue;
    values.add(value);
  }
  return [...values];
}

/**
 * True when `content` contains the value of any secret the running service
 * holds (JWT, encryption keys, OIDC/client/session secrets …). A copy of the
 * service's .env under any name is then a service secret, never a project file.
 * Values are only compared, never logged or returned.
 */
export function containsServiceSecretValue(content: Uint8Array | string): boolean {
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) return false;
  const haystack = typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : Buffer.from(content.buffer, content.byteOffset, content.length);
  return serviceSecretValues().some((value) => haystack.includes(Buffer.from(value, 'utf8')));
}

/** True when text returned to a client embeds an SQLite file (header anywhere). */
export function containsSqliteContent(text: string): boolean {
  return typeof text === 'string' && text.includes(SQLITE_HEADER.toString('latin1'));
}

export type ForbiddenProjectRootReason = 'home' | 'secret';

/** Canonical form of `p`: realpath when it exists, otherwise the lexical resolve. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when `child` equals `parent` or lies strictly beneath it. */
function isAtOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Both the lexical and canonical forms of a path, deduplicated. */
function forms(p: string): string[] {
  const lexical = path.resolve(p);
  const real = canonical(p);
  return lexical === real ? [lexical] : [lexical, real];
}

/**
 * Hidden home paths that ARE legitimate project roots. `agent.js` clones
 * githubUrl-only requests into `~/.claude/external-projects/<hash>`. Nothing
 * else under a hidden first-level home entry is a workspace.
 */
export const ALLOWED_HIDDEN_HOME_ENTRIES: readonly string[] = Object.freeze([
  '.claude/external-projects',
]);

/** How long the derived home/secret sets are reused before re-resolving. */
const POLICY_TTL_MS = 30_000;

type SecretPolicy = {
  key: string;
  expiresAt: number;
  homes: string[];
  secrets: string[];
  allowed: string[];
  databaseFiles: string[];
  harnessHomes: string[];
  serviceRoots: string[];
};

let cachedPolicy: SecretPolicy | null = null;
let cachedPasswdHome: string | null | undefined;

/** The passwd home (independent of $HOME); resolved once per process. */
function passwdHome(): string | null {
  if (cachedPasswdHome === undefined) {
    try {
      cachedPasswdHome = os.userInfo().homedir || null;
    } catch {
      cachedPasswdHome = null; // No passwd entry (rare container setups).
    }
  }
  return cachedPasswdHome;
}

/** The configured database file and its SQLite side files, lexical and canonical. */
function databaseFileForms(databasePath: string): string[] {
  if (databasePath.length === 0) return [];
  const out = new Set<string>();
  for (const suffix of DATABASE_SIDE_SUFFIXES) {
    for (const form of forms(databasePath + suffix)) out.add(form);
  }
  // The canonical directory may differ even when a side file does not exist yet.
  const realDir = canonical(path.dirname(path.resolve(databasePath)));
  for (const suffix of DATABASE_SIDE_SUFFIXES) {
    out.add(path.join(realDir, path.basename(databasePath) + suffix));
  }
  return [...out];
}

/** Children of `dir` (names only); empty when unreadable. */
function listDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every harness configuration home, lexical and canonical: the service home's,
 * each `~/.nassaj-users/<id>/` home's, and the env-relocated ones.
 */
function harnessHomeForms(homes: string[]): string[] {
  const bases = new Set<string>(homes);
  for (const home of homes) {
    const usersRoot = path.join(home, '.nassaj-users');
    for (const userId of listDirNames(usersRoot)) bases.add(path.join(usersRoot, userId));
  }
  const out = new Set<string>(expandUnderHomes([...bases], HARNESS_HOME_ENTRIES));
  for (const name of HARNESS_HOME_ENV_VARS) {
    const value = process.env[name];
    if (value) for (const form of forms(value)) out.add(form);
  }
  return [...out];
}

/** True when the first component of `candidate` below `harnessHome` is a secret store. */
function isUnderHarnessSecretEntry(candidate: string, harnessHome: string): boolean {
  const relative = path.relative(harnessHome, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return HARNESS_SECRET_ENTRIES.includes(first)
    || HARNESS_SECRET_ENTRY_PREFIX.test(first)
    || HARNESS_SECRET_ENTRY_SUFFIX.test(first);
}

/**
 * The application root this module runs from: `<app>/server/shared` in source,
 * `<app>/dist-server/server/shared` when compiled. Null when the layout is not
 * recognised (the env-configured roots still apply).
 */
function moduleAppRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (path.basename(dir) !== 'server') {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  const parent = path.dirname(dir);
  return path.basename(parent) === 'dist-server' ? path.dirname(parent) : parent;
}

/** Service roots (install root plus SERVICE_ROOT_ENV_VARS), lexical and canonical. */
function serviceRootForms(): string[] {
  const roots: string[] = [];
  const appRoot = moduleAppRoot();
  if (appRoot) roots.push(appRoot);
  for (const name of SERVICE_ROOT_ENV_VARS) {
    for (const entry of (process.env[name] ?? '').split(path.delimiter)) {
      if (entry.length > 0 && path.isAbsolute(entry)) roots.push(entry);
    }
  }
  const out = new Set<string>();
  for (const root of roots) for (const form of forms(root)) out.add(form);
  return [...out];
}

/** Joins every home with every entry, in lexical and canonical forms. */
function expandUnderHomes(homes: string[], entries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const home of homes) {
    for (const entry of entries) {
      for (const form of forms(path.join(home, entry))) out.add(form);
    }
  }
  return [...out];
}

/**
 * The derived policy, memoised for POLICY_TTL_MS (each build costs ~30
 * realpath calls). The key is the current $HOME, so changing it re-derives at
 * once; a secret directory created later is still caught lexically and by the
 * structural hidden-entry rule, so a stale canonical form cannot open a hole.
 */
function policy(): SecretPolicy {
  const envHome = os.homedir();
  const databasePath = process.env.DATABASE_PATH ?? '';
  const key = [envHome, passwdHome() ?? '', databasePath,
    ...HARNESS_HOME_ENV_VARS.map((name) => process.env[name] ?? ''),
    ...SERVICE_ROOT_ENV_VARS.map((name) => process.env[name] ?? '')].join('\0');
  const now = Date.now();
  if (cachedPolicy && cachedPolicy.key === key && cachedPolicy.expiresAt > now) return cachedPolicy;
  const homeSet = new Set<string>();
  for (const home of [envHome, passwdHome()]) {
    if (typeof home === 'string' && home.length > 0) {
      for (const form of forms(home)) homeSet.add(form);
    }
  }
  const homes = [...homeSet];
  cachedPolicy = {
    key,
    expiresAt: now + POLICY_TTL_MS,
    homes,
    secrets: expandUnderHomes(homes, SECRET_HOME_ENTRIES),
    allowed: expandUnderHomes(homes, ALLOWED_HIDDEN_HOME_ENTRIES),
    databaseFiles: databaseFileForms(databasePath),
    harnessHomes: harnessHomeForms(homes),
    serviceRoots: serviceRootForms(),
  };
  return cachedPolicy;
}

/** Drops the memoised policy (tests, or after a known configuration change). */
export function resetSecretPathGuardCache(): void {
  cachedPolicy = null;
  cachedPasswdHome = undefined;
}

/**
 * Home directories of the service user. `os.homedir()` honours $HOME, and the
 * passwd entry is added so a changed $HOME cannot hide the real home.
 */
export function getProtectedHomes(): string[] {
  return [...policy().homes];
}

/** Absolute listed secret locations (lexical and canonical) under every protected home. */
export function getSecretLocations(): string[] {
  return [...policy().secrets];
}

/** True when `candidate` lies under a first-level hidden entry of `home`. */
function isUnderHiddenHomeEntry(candidate: string, home: string): boolean {
  const relative = path.relative(home, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0].startsWith('.');
}

/** Secret test for one already-resolved form of a path. */
function isSecretForm(candidate: string, current: SecretPolicy): boolean {
  // Listed locations win over the allowlist: credentials are never re-opened.
  if (current.secrets.some((secret) => isAtOrInside(candidate, secret))) return true;
  if (!current.homes.some((home) => isUnderHiddenHomeEntry(candidate, home))) return false;
  return !current.allowed.some((allowed) => isAtOrInside(candidate, allowed));
}

/**
 * True when `targetPath` (lexically or after following symlinks) is, or lies
 * beneath, a secret location: a listed credential location, or ANY entry under
 * a first-level hidden directory/file of a protected home (`~/.cloudflared`,
 * `~/.pgpass`, `~/.codex`, `~/.claude.json` …) except the explicit allowlist,
 * a dotenv file at any depth (see isSecretFileName), the configured database
 * file (DATABASE_PATH) and its SQLite side files, or a transcript/history/
 * credential store directly below a harness home (HARNESS_SECRET_ENTRIES),
 * judged on the canonical path so `~/.claude -> <registered project>` cannot
 * expose `<registered project>/projects`.
 *
 * The file rules apply only here, not to project-root decisions, so a root
 * that merely contains a `.env` or the database stays a valid project.
 */
export function isSecretPath(targetPath: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  const current = policy();
  return forms(targetPath).some((candidate) => isSecretForm(candidate, current)
    || isSecretFileName(path.basename(candidate))
    || current.databaseFiles.includes(candidate)
    || current.harnessHomes.some((home) => isUnderHarnessSecretEntry(candidate, home)));
}

/** True when `fileName` (a basename) is a dotenv or SQLite file. */
export function isSecretFileKind(fileName: string): boolean {
  return isSecretFileName(fileName) || isSqliteFileName(fileName);
}

/**
 * True when `targetPath` IS or CONTAINS a service root, so renaming, moving or
 * deleting it would move or remove the running service's own tree.
 */
export function containsServiceRoot(targetPath: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  const current = policy();
  return forms(targetPath).some((candidate) => current.serviceRoots.some((root) => isAtOrInside(root, candidate)));
}

/** True when `candidate` lies at or below a service root. */
function isUnderServiceRoot(candidate: string, current: SecretPolicy): boolean {
  return current.serviceRoots.some((root) => isAtOrInside(candidate, root));
}

/** Service-secret test for one already-resolved form of a path. */
function isServiceSecretForm(candidate: string, current: SecretPolicy): boolean {
  return isSecretForm(candidate, current)
    || current.databaseFiles.includes(candidate)
    || current.harnessHomes.some((home) => isUnderHarnessSecretEntry(candidate, home))
    || (isSecretFileKind(path.basename(candidate)) && isUnderServiceRoot(candidate, current));
}

/**
 * B-1593 secret classes: 'service' is a secret of the running service and is
 * never served; 'project' is an ordinary project dotenv/SQLite file, served
 * only after an explicit per-request confirmation; null is not secret.
 */
export type SecretPathClass = 'service' | 'project' | null;

/**
 * Classifies `targetPath` on its lexical and canonical forms; the stricter
 * class wins. 'service' covers everything isSecretPath refuses except dotenv
 * files outside the service roots, plus any dotenv/SQLite file under a service
 * root; 'project' is any other dotenv (templates excepted) or SQLite name.
 */
export function classifySecretPath(targetPath: string): SecretPathClass {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null;
  const current = policy();
  const candidates = forms(targetPath);
  if (candidates.some((candidate) => isServiceSecretForm(candidate, current))) return 'service';
  return candidates.some((candidate) => isSecretFileKind(path.basename(candidate))) ? 'project' : null;
}

/**
 * Class of a file whose CONTENT is an SQLite database (header sniff) whatever
 * its name: 'service' when it is a service secret or lies under a service root,
 * otherwise 'project'.
 */
export function classifySqliteContentPath(targetPath: string): 'service' | 'project' {
  const current = policy();
  return forms(targetPath).some((candidate) => isServiceSecretForm(candidate, current)
    || isUnderServiceRoot(candidate, current)) ? 'service' : 'project';
}

/**
 * True when a path recorded in repository history must never be rendered
 * (B-1592): a dotenv or SQLite name at any depth, or a path that is secret on
 * disk. History is passive exposure, so project secret files are hidden too.
 *
 * @param repositoryRoot          Absolute repository top-level directory.
 * @param repositoryRelativePath  Path as printed by the VCS, relative to that root.
 */
export function isSecretRepositoryPath(repositoryRoot: string, repositoryRelativePath: string): boolean {
  if (typeof repositoryRelativePath !== 'string' || repositoryRelativePath.length === 0) return false;
  if (isSecretFileKind(path.posix.basename(repositoryRelativePath))) return true;
  return isSecretPath(path.resolve(repositoryRoot, repositoryRelativePath));
}

/**
 * Why `projectRoot` may not be a project root, or `null` when it is allowed.
 *   - 'home'   the root equals or contains a protected home directory;
 *   - 'secret' the root equals, contains, or lies inside a secret location.
 */
export function findForbiddenProjectRootReason(projectRoot: string): ForbiddenProjectRootReason | null {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return null;
  const roots = forms(projectRoot);
  const current = policy();
  if (roots.some((root) => current.homes.some((home) => isAtOrInside(home, root)))) {
    return 'home';
  }
  if (roots.some((root) => isSecretForm(root, current)
    || current.secrets.some((secret) => isAtOrInside(secret, root)))) {
    return 'secret';
  }
  return null;
}

/** True when `projectRoot` must never be registered or served as a project. */
export function isForbiddenProjectRoot(projectRoot: string): boolean {
  return findForbiddenProjectRootReason(projectRoot) !== null;
}
