/** Unix socket paths are capped by sun_path (108 bytes); deep checkouts such as session overlays overflow it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUN_PATH_BUDGET = 104;

/**
 * Create a private temp dir short enough that `<dir>/<leaf>` fits in sun_path.
 * Prefers os.tmpdir() and falls back to /var/tmp then /tmp; the caller removes the dir.
 */
export function makeShortSocketDir(prefix, leaf = 'x.sock') {
    const base = [os.tmpdir(), '/var/tmp', '/tmp']
        .find(dir => path.join(dir, `${prefix}XXXXXX`, leaf).length < SUN_PATH_BUDGET);
    if (!base) throw new Error('No temp directory is short enough for a Unix socket path.');
    return fs.mkdtempSync(path.join(base, prefix));
}
