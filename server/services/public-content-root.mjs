/**
 * T-1798 — where operator-published page content lives.
 *
 * Content served on a public URL must NOT live inside the Nassaj tree. A file
 * planted in `dist/` is inventoried by `CLIENT_ASSET_MANIFEST.json`, so a single
 * hand-placed page makes every node update fail with
 * `client_asset_manifest_changed`; and a generation swap deletes it anyway.
 * The content root is therefore app-data, outside the checkout and outside any
 * build output, and survives generation swaps and re-installs.
 *
 * Resolution order (first match wins):
 *   1. `NASSAJ_PUBLIC_CONTENT_ROOT`  — absolute path, operator's choice.
 *   2. `$XDG_DATA_HOME/nassaj-dev/public-content`
 *   3. `<home>/.local/share/nassaj-dev/public-content`
 *
 * Any candidate that is relative, non-normal, or inside the application root is
 * refused (returns null = feature simply off). Refusing is the safe default:
 * publishing is opt-in, and a mis-set root must never resurrect the `dist/`
 * planting this replaces.
 */
import os from 'node:os';
import path from 'node:path';

/** `true` when `candidate` is `parent` itself or lives beneath it. */
function isInside(candidate, parent) {
  if (!parent) return false;
  const base = path.resolve(parent);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

/**
 * Resolve the external public-content root, or null when it is unusable.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.appRoot] application root the content must stay out of
 * @param {string} [options.homedir]
 * @returns {string|null} absolute, normalized directory path
 */
export function resolvePublicContentRoot({ env = process.env, appRoot, homedir = os.homedir() } = {}) {
    const configured = env.NASSAJ_PUBLIC_CONTENT_ROOT?.trim();
    const dataHome = env.XDG_DATA_HOME?.trim();
    const candidate = configured
        || path.join(dataHome || path.join(homedir, '.local', 'share'), 'nassaj-dev', 'public-content');
    if (!path.isAbsolute(candidate) || candidate.includes('\0')) return null;
    const resolved = path.resolve(candidate);
    if (resolved === path.sep || resolved !== path.normalize(candidate)) return null;
    if (isInside(resolved, appRoot)) return null;
    return resolved;
}
