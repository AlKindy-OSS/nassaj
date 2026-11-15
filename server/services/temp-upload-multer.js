/**
 * Disk-staged multer builder for endpoints that receive uploads into a private
 * staging dir before the route copies them into the project tree.
 *
 * Extracted from server/index.js (T-2116) so the per-request attachment cap can
 * be exercised against the real builder in tests. Files stream to disk, never to
 * memory; on LIMIT_FILE_SIZE or any other abort multer removes every file it
 * wrote for the request (including the partial one) before calling back.
 */

/**
 * @param {Object} opts
 * @param {Function} opts.fileFilter - multer fileFilter(req, file, cb)
 * @param {number} opts.maxSizeBytes - per-file byte cap (limits.fileSize)
 * @param {number} opts.maxCount - max file count (limits.files)
 * @param {Function} opts.destination - multer diskStorage destination callback
 * @returns {Promise<import('multer').Multer>}
 */
export async function buildTempUploadMulter({ fileFilter, maxSizeBytes, maxCount, destination }) {
  const multer = (await import('multer')).default;
  return multer({
    storage: multer.diskStorage({
      destination,
      filename: (_req, _file, cb) => {
        // Unique temp name only; the original (possibly unsafe) name is
        // preserved on file.originalname and sanitised by the route.
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `upload-${uniqueSuffix}`);
      },
    }),
    fileFilter,
    limits: {
      fileSize: maxSizeBytes,
      files: maxCount,
    },
  });
}

const RAM_FS_TYPES = new Set(['tmpfs', 'ramfs']);
/** Used only when the mount table cannot be read. */
const KNOWN_RAM_ROOTS = ['/tmp', '/dev/shm', '/run'];

function isUnder(target, root) {
  return root === '/' || target === root || target.startsWith(`${root}/`);
}

/**
 * True when `target` lives on a RAM-backed filesystem, judged by the longest
 * mount point that contains it.
 * @param {string} target - absolute path
 * @param {string | null} mounts - /proc/mounts text, or null when unreadable
 * @returns {boolean}
 */
export function isRamBackedPath(target, mounts) {
  if (typeof mounts !== 'string') return KNOWN_RAM_ROOTS.some((root) => isUnder(target, root));
  let best = { length: -1, ram: false };
  for (const line of mounts.split('\n')) {
    const [, rawPoint, fsType] = line.split(' ');
    if (!rawPoint || !fsType) continue;
    const point = rawPoint.replace(/\\040/g, ' ');
    if (isUnder(target, point) && point.length > best.length) {
      best = { length: point.length, ram: RAM_FS_TYPES.has(fsType) };
    }
  }
  return best.ram;
}

/**
 * Picks the root for upload staging: `NASSAJ_UPLOAD_STAGING_DIR` if set (refused
 * when RAM-backed), else /var/tmp, else `<fallbackDir>/upload-staging`, the first
 * one on disk. Never os.tmpdir(): /tmp is tmpfs on the fleet hosts, so staged
 * uploads (up to the attachment cap per file) would be held in memory.
 * @param {{ env?: Record<string, string | undefined>, mounts: string | null, fallbackDir?: string | null }} opts
 * @returns {string} absolute disk-backed directory (may not exist yet)
 */
export function resolveUploadStagingRoot({ env = process.env, mounts, fallbackDir = null }) {
  const override = env.NASSAJ_UPLOAD_STAGING_DIR;
  if (override) {
    if (isRamBackedPath(override, mounts)) {
      throw new Error(`NASSAJ_UPLOAD_STAGING_DIR is RAM-backed: ${override}`);
    }
    return override;
  }
  const candidates = ['/var/tmp', fallbackDir ? `${fallbackDir}/upload-staging` : null].filter(Boolean);
  const chosen = candidates.find((dir) => !isRamBackedPath(dir, mounts));
  if (!chosen) throw new Error('no disk-backed upload staging directory; set NASSAJ_UPLOAD_STAGING_DIR');
  return chosen;
}
