/**
 * grant-home — a HOME for a grantee's spawn of a HOME/XDG-steered provider
 * (T-1675 / ADR-152, closing qa-critic finding 1).
 *
 * agy, hermes and cursor find their credential relative to $HOME, and
 * opencode relative to $XDG_DATA_HOME. Handing such a spawn the OWNER's root
 * would expose every credential the owner holds — `.claude/`, `.codex/`,
 * `.qwen/`, the lot — through a grant for one provider. So a grantee never
 * runs on the owner's root. They run here:
 *
 *   ~/.nassaj-users/<grantee>/.grants/<owner>/
 *     .gemini                -> ~/.nassaj-users/<owner>/.gemini    (only if agy is granted)
 *     .hermes                -> ~/.nassaj-users/<owner>/.hermes    (only if hermes is granted)
 *     .cursor                -> ~/.nassaj-users/<owner>/.cursor    (only if cursor is granted)
 *     .local/                   (real dir)
 *       share/                  (real dir)
 *         opencode           -> ~/.nassaj-users/<owner>/.local/share/opencode  (only if granted)
 *         <everything else>  -> ~/.nassaj-users/<grantee>/.local/share/<…>
 *       <everything else>    -> ~/.nassaj-users/<grantee>/.local/<…>
 *     <everything else>      -> ~/.nassaj-users/<grantee>/<…>
 *
 * i.e. the grantee's OWN tree, with exactly the granted provider dirs swapped
 * for the owner's. Rebuilt on every spawn from the live grant set, so a revoked
 * provider's link disappears on the next spawn and a newly granted one appears.
 * Only symlinks are ever created or removed here; a real file or directory
 * found in the way is left alone and logged.
 *
 * agy's grant is stored under the credential unit named after its `~/.gemini`
 * home (see credential-principal.js); listDelegatedProvidersFromOwner hands the
 * provider key `agy` here, which links `.gemini`.
 */

import fs from 'fs';
import path from 'path';

import { userConfigDir } from './provision-user-dirs.js';

const DIR_MODE = 0o700;

/** Where each HOME/XDG-steered provider keeps its credential, relative to root. */
const OWNER_LINKED_PATHS = Object.freeze({
  agy: ['.gemini'],
  hermes: ['.hermes'],
  cursor: ['.cursor'],
  opencode: [path.join('.local', 'share', 'opencode')],
  qwen: ['.qwen'],
});

/** Providers whose grant is realised through a grant home (the keys above). */
export const GRANT_HOME_PROVIDERS = Object.freeze(Object.keys(OWNER_LINKED_PATHS));

/**
 * SINGLE-PROCESS, SYNCHRONOUS ON PURPOSE. lstat → unlink → symlink below carries
 * no EEXIST/ENOENT handling because nothing can interleave: every call is
 * synchronous inside the one server process, so two spawns cannot rebuild the
 * same grant home at once. Turning this into fs.promises or running it from a
 * worker would need real races handled first.
 */

/** The grant-home subdir inside a grantee's tree; skipped when mirroring. */
const GRANTS_SUBDIR = '.grants';

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/** Makes `link` a symlink to `target`, replacing a symlink with another target. */
function ensureLink(link, target) {
  const stat = lstatOrNull(link);
  if (stat) {
    if (!stat.isSymbolicLink()) {
      console.error('[grant-home] real entry in the way of a link; left untouched', { link });
      return;
    }
    if (fs.readlinkSync(link) === target) {
      return;
    }
    fs.unlinkSync(link);
  }
  fs.symlinkSync(target, link);
}

function listEntries(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Mirrors one level: every entry of `granteeDir` becomes a link into the
 * grantee's tree, except the owner-linked paths, which become links into the
 * owner's tree (or real dirs to descend through when the owner link is deeper).
 * Stale symlinks that match neither side are removed.
 */
function syncLevel(compositeDir, granteeDir, ownerDir, ownerLinks, skip) {
  ensureDir(compositeDir);

  /** @type {Map<string, string[][]>} first segment → remaining segments of each owner link */
  const byHead = new Map();
  for (const rel of ownerLinks) {
    const [head, ...rest] = rel.split(path.sep);
    if (!byHead.has(head)) byHead.set(head, []);
    byHead.get(head).push(rest);
  }

  const wanted = new Set([...listEntries(granteeDir), ...byHead.keys()]);
  wanted.delete(skip);

  for (const name of wanted) {
    const compositePath = path.join(compositeDir, name);
    const rests = byHead.get(name);
    if (rests) {
      const leaf = rests.some((rest) => rest.length === 0);
      if (leaf) {
        // The owner's provider dir itself. Link it only when the owner has one:
        // a dangling link would make the CLI's first write land nowhere useful.
        const ownerPath = path.join(ownerDir, name);
        if (fs.existsSync(ownerPath)) {
          ensureLink(compositePath, ownerPath);
        } else {
          const stat = lstatOrNull(compositePath);
          if (stat?.isSymbolicLink()) fs.unlinkSync(compositePath);
        }
        continue;
      }
      // Deeper owner link (e.g. .local/share/opencode): this level is a real
      // dir on the composite side, mirrored recursively.
      const stat = lstatOrNull(compositePath);
      if (stat?.isSymbolicLink()) fs.unlinkSync(compositePath);
      syncLevel(
        compositePath,
        path.join(granteeDir, name),
        path.join(ownerDir, name),
        rests.map((rest) => rest.join(path.sep)),
        null,
      );
      continue;
    }
    ensureLink(compositePath, path.join(granteeDir, name));
  }

  // Drop links for entries that vanished from the grantee's tree or whose
  // provider grant was revoked (they are no longer in `wanted`).
  for (const name of listEntries(compositeDir)) {
    if (wanted.has(name)) continue;
    const stat = lstatOrNull(path.join(compositeDir, name));
    if (stat?.isSymbolicLink()) fs.unlinkSync(path.join(compositeDir, name));
  }
}

/**
 * Builds (or refreshes) the grant home of `granteeId` for credentials delegated
 * by `ownerId`, linking exactly the dirs of `providers`, and returns its path.
 * Both trees must already be provisioned. Idempotent; safe on every spawn.
 *
 * @param {string|number} granteeId
 * @param {string|number} ownerId
 * @param {string[]} providers providers currently delegated from this owner
 * @returns {string} absolute path to use as HOME (or XDG root) for the spawn
 */
export function materializeGrantHome(granteeId, ownerId, providers) {
  const granteeRoot = userConfigDir(granteeId, '');
  const ownerRoot = userConfigDir(ownerId, '');
  const compositeRoot = userConfigDir(granteeId, path.join(GRANTS_SUBDIR, String(ownerId)));
  const ownerLinks = [...new Set(
    providers
      .filter((p) => GRANT_HOME_PROVIDERS.includes(p))
      .flatMap((p) => OWNER_LINKED_PATHS[p]),
  )];
  syncLevel(compositeRoot, granteeRoot, ownerRoot, ownerLinks, GRANTS_SUBDIR);
  return compositeRoot;
}

/**
 * Removes grant homes of `granteeId` for owners not in `keepOwnerIds` — a grant
 * home is a directory of symlinks, so removing it never touches either tree
 * (`fs.rmSync` unlinks links, it does not follow them). The spawn path calls it
 * with every owner the grantee still runs on, so a revoked or deleted owner
 * leaves nothing behind.
 *
 * @param {string|number} granteeId
 * @param {string[]} keepOwnerIds
 */
export function sweepGrantHomes(granteeId, keepOwnerIds) {
  const grantsDir = userConfigDir(granteeId, GRANTS_SUBDIR);
  for (const name of listEntries(grantsDir)) {
    if (keepOwnerIds.includes(name)) continue;
    try {
      fs.rmSync(path.join(grantsDir, name), { recursive: true, force: true });
    } catch (error) {
      console.error('[grant-home] sweep failed', { granteeId, name, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
