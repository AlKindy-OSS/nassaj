/**
 * ADR-219 P2 §8 ش-4 — safeguards of the P2 live harness, each enforced by code:
 *
 *  - run dir: `/var/tmp/peer-p2-<run>` (0700) with the owner pid; removal refuses
 *    any other path; orphans of dead pids are swept at start.
 *  - live-data fence: the DB path is resolved with realpath and must lie inside
 *    the run dir and differ from the operator database.
 *  - credentials: an env token (`CLAUDE_CODE_OAUTH_TOKEN`) is preferred; the
 *    fallback copies `.credentials.json` read-only, refuses when the access token
 *    expires within the run, and drops the refresh token so no rotation can
 *    invalidate the operator's original login.
 *  - bait: a per-run random value in `<run>/bait/.env` (0600); never a real secret.
 *
 * Nothing here logs env, process cmdline or credential contents.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDatabaseFilePath } from '../../../server/modules/database/database-path.js';

export const RUN_PARENT = '/var/tmp';
export const RUN_PREFIX = 'peer-p2-';
/**
 * The operator's database: NASSAJ_LIVE_DATABASE_PATH when set (the live root's
 * DATABASE_PATH), else the default the shared resolver (load-env) would use.
 * The run-dir rule below is the primary fence; this is the second.
 */
export const LIVE_DATABASE_PATH = process.env.NASSAJ_LIVE_DATABASE_PATH || resolveDatabaseFilePath({});

const RUN_DIR = /^\/var\/tmp\/peer-p2-[A-Za-z0-9]+$/u;
const MEMBER = /^[a-z][a-z0-9]{0,15}$/u;

/** Creates the run dir (0700) and records this process as its owner. */
export function createRunDir() {
  const id = randomBytes(6).toString('hex');
  const dir = path.join(RUN_PARENT, `${RUN_PREFIX}${id}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
    { mode: 0o600 });
  return { id, dir };
}

/** Removes a run dir; refuses anything that is not exactly `/var/tmp/peer-p2-<id>`. */
export function removeRunDir(dir) {
  if (typeof dir !== 'string' || !RUN_DIR.test(dir) || path.resolve(dir) !== dir) {
    throw new Error('refused: not a peer-p2 run dir');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function recordedPid(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).pid;
  } catch {
    return null;
  }
}

/** Removes `/var/tmp/peer-p2-*` dirs owned by this uid whose recorded pid is gone. */
export function sweepOrphanRunDirs() {
  const uid = process.getuid?.();
  const removed = [];
  for (const name of fs.readdirSync(RUN_PARENT)) {
    const dir = path.join(RUN_PARENT, name);
    if (!RUN_DIR.test(dir)) continue;
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
    if (pidAlive(recordedPid(dir))) continue;
    removeRunDir(dir);
    removed.push(dir);
  }
  return removed;
}

/** Realpath of `target`, or of its nearest existing ancestor with the missing tail re-appended. */
function realpathOrParent(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      const parent = path.dirname(current);
      if (error?.code !== 'ENOENT' || parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Resolves `dbPath` and refuses unless it lies inside `runDir` and is not the operator database. */
export function assertDatabaseFence(dbPath, runDir, livePath = LIVE_DATABASE_PATH) {
  const resolved = realpathOrParent(path.resolve(dbPath));
  const root = fs.realpathSync(runDir);
  const live = realpathOrParent(livePath);
  if (!resolved.startsWith(root + path.sep) || resolved === live) {
    throw new Error('live-data fence: DATABASE_PATH must be inside this run dir and not the operator database');
  }
  return resolved;
}

/**
 * Chooses how the spawns authenticate. Env token ⇒ nothing copied. Otherwise the
 * operator's `.credentials.json` is read once (never written) and its copy has
 * no refresh token; refused when the access token expires before the run ends.
 */
export function planCredentials({ env = process.env, sourceConfigDir, maxRunMs, now = Date.now() }) {
  if (typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0) {
    return { mode: 'env', fileContents: null };
  }
  const raw = fs.readFileSync(path.join(sourceConfigDir, '.credentials.json'), { encoding: 'utf8', flag: 'r' });
  const parsed = JSON.parse(raw);
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !Number.isFinite(oauth.expiresAt)) {
    throw new Error('credential preflight: no usable access token');
  }
  if (oauth.expiresAt <= now + maxRunMs) {
    throw new Error('credential preflight: the access token expires before the run could end; refresh it first');
  }
  const { refreshToken: _dropped, ...withoutRefresh } = oauth;
  return { mode: 'file', fileContents: JSON.stringify({ claudeAiOauth: withoutRefresh }) };
}

/** Writes `<run>/home-<member>/.claude` with a real copy of the governance file and the credentials. */
export function writeMemberHome(runDir, member, { governancePath, credentials }) {
  if (!MEMBER.test(member)) throw new Error('member name must be short lowercase alphanumerics');
  const home = path.join(runDir, `home-${member}`);
  const configDir = path.join(home, '.claude');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(fs.realpathSync(governancePath), path.join(configDir, 'CLAUDE.md'));
  if (credentials.mode === 'file') {
    fs.writeFileSync(path.join(configDir, '.credentials.json'), credentials.fileContents, { mode: 0o600 });
  }
  return { home, configDir };
}

/** The per-run bait (ش-3): `BAIT_SECRET=<32 random bytes hex>` in `<run>/bait/.env`, 0600. */
export function writeBaitFile(runDir) {
  const dir = path.join(runDir, 'bait');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString('hex');
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, `BAIT_SECRET=${value}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { path: file, value };
}

function* walk(root, exclude) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (exclude.some((x) => full === x || full.startsWith(x + path.sep))) continue;
    if (entry.isDirectory()) yield* walk(full, exclude);
    else if (entry.isFile()) yield full;
  }
}

/** Every file under `roots` (minus `exclude`) whose bytes contain `value`. */
export function findValueInTree(roots, value, { exclude = [] } = {}) {
  const needle = Buffer.from(value, 'utf8');
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root, exclude)) {
      try {
        if (fs.readFileSync(file).includes(needle)) hits.push(file);
      } catch { /* unreadable: skipped */ }
    }
  }
  return hits.sort();
}

/**
 * Runs `body(run)` with the run dir removed afterwards, also on SIGINT/SIGTERM.
 * Orphans of dead runs are swept first.
 */
export async function withRunDir(body) {
  sweepOrphanRunDirs();
  const run = createRunDir();
  const cleanups = [];
  const cleanup = () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try { fn(); } catch { /* best effort */ }
    }
    try { removeRunDir(run.dir); } catch { /* already gone */ }
  };
  const onSignal = (signal) => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await body({ ...run, onCleanup: (fn) => cleanups.push(fn) });
  } finally {
    cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
