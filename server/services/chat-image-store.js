/**
 * chat-image-store — durable storage for images attached to a chat prompt.
 *
 * WHY (B-430). Images used to be materialized under `os.tmpdir()` and deleted by
 * `cleanupTempFiles` the moment the query finished. The prompt text keeps only
 * the `[Images provided at the following paths:]` note, and that note is what the
 * transcript stores — so the second the optimistic (base64-carrying) message is
 * replaced by its transcript twin, the picture the user attached is gone from the
 * conversation for good, leaving a path that points at a file which no longer
 * exists. Storing the bytes outside /tmp is what makes re-rendering an old
 * message possible at all.
 *
 * WHERE. Next to the app database (`DATABASE_PATH`), NOT inside the project tree:
 * a chat attachment is app data, and dropping it into the repo would show up in
 * `git status` for every user of that project.
 *
 * ACCESS MODEL. The bucket name is 16 random bytes, so a path is unguessable, and
 * the serving route additionally requires an authenticated session. The bucket id
 * only ever travels inside the session transcript, which is already restricted to
 * the people who can read that session.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import sharp from 'sharp';

import { appConfigDb } from '../modules/database/index.js';

import { sanitizeSvg } from './svg-sanitizer.js';


/**
 * Longest side, in pixels, of the copy the MODEL reads (T-1667). Anthropic
 * downscales anything larger than ~1568px before tokenizing, so pixels beyond
 * that are pure transport cost: a 2560×1800 phone screenshot arrives as a
 * ~600KB file, the agent `Read`s it, and that blob then rides in the
 * transcript on every later API call of the session (51 such reads = 10.8MB in
 * two weeks). The original is kept beside the copy as `image_N.orig.ext`, so
 * nothing the user attached is ever lost (B-430 durability still holds).
 */
const MODEL_MAX_EDGE_PX = 1568;
/** Raster formats sharp re-encodes; svg/gif are stored untouched. */
const RESIZABLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

/** Extensions we are willing to write and later serve back. */
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/**
 * Ceilings, mirroring the `/upload-images` multer limits (5MB × 15).
 *
 * WHY THEY LIVE HERE TOO (qa-critic veto 2): the browser reaches the store
 * through that guarded endpoint, but the SERVER does not require it — the
 * `images` array arrives over the WebSocket and is fully client-controlled, so a
 * single crafted message could write unbounded bytes onto the partition that
 * holds db.sqlite. These files are now durable by design, so nothing reclaims
 * them afterwards either. A cap the transport cannot bypass is the only real one.
 */
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 15;
const DEFAULT_MAX_MB_PER_IMAGE = 5;
/** Absolute ceilings the owner's setting may not exceed. */
const HARD_MAX_IMAGES = 50;
const HARD_MAX_MB = 25;

/**
 * The owner-configured ceilings (`/api/system/storage-policy`), falling back to
 * the defaults whenever the value is missing or out of range.
 *
 * Read per call, NOT cached: the setting is changed from the UI and must take
 * effect on the next message, not on the next restart. `appConfigDb` is a
 * synchronous SQLite read of one row — cheaper than the base64 decode that
 * follows it.
 */
function readImageLimits() {
  let maxCount = DEFAULT_MAX_IMAGES_PER_MESSAGE;
  let maxMb = DEFAULT_MAX_MB_PER_IMAGE;
  try {
    const storedCount = Number(appConfigDb.get('chat_image_max_count'));
    const storedMb = Number(appConfigDb.get('chat_image_max_mb'));
    if (Number.isInteger(storedCount) && storedCount > 0 && storedCount <= HARD_MAX_IMAGES) {
      maxCount = storedCount;
    }
    if (Number.isInteger(storedMb) && storedMb > 0 && storedMb <= HARD_MAX_MB) {
      maxMb = storedMb;
    }
  } catch {
    // A settings read must never cost the user their attachment: fall back to
    // the defaults, which are the values that shipped before the setting existed.
  }
  return {
    maxCount,
    maxBytesPerImage: maxMb * 1024 * 1024,
    // Per-message total: the count cap times the per-image cap is the honest
    // implied ceiling, so no separate knob can contradict the two visible ones.
    maxBytesPerMessage: maxCount * maxMb * 1024 * 1024,
  };
}

const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** `<bucket>` is 16 hex-encoded random bytes; `<name>` is always `image_<n>.<ext>`. */
const BUCKET_PATTERN = /^[0-9a-f]{32}$/;
// `image_N.<ext>` is the copy the model reads; `image_N.orig.<ext>` is the
// untouched upload kept beside a downscaled copy (T-1667). Nothing else.
const NAME_PATTERN = /^image_\d+(?:\.orig)?\.[a-z0-9]+$/;

/**
 * Root of the store: the directory holding the app database, which is the one
 * durable, per-install, non-repo location the server already owns.
 * @returns {string}
 */
export function getChatImageRoot() {
  const dbPath = process.env.DATABASE_PATH;
  const baseDir = dbPath
    ? path.dirname(dbPath)
    : path.join(os.homedir(), '.local', 'share', 'nassaj-dev');
  return path.join(baseDir, 'chat-images');
}

/**
 * Decodes one client-supplied data URL into bytes ready to be written, or
 * returns a rejection reason. Pure — no I/O — so every rule below is testable
 * without touching the disk.
 *
 * @param {{data?: string}} image
 * @returns {{ok: true, bytes: Buffer, extension: string} | {ok: false, reason: string}}
 */
function decodeImagePayload(image, maxBytesPerImage) {
  const matches = typeof image?.data === 'string'
    ? image.data.match(/^data:([^;]+);base64,(.+)$/)
    : null;
  if (!matches) {
    return { ok: false, reason: 'not a base64 data URL' };
  }

  const [, mimeType, base64Data] = matches;
  const rawExtension = (mimeType.split('/')[1] || 'png').toLowerCase();
  // An unknown subtype is stored as .png rather than trusting the client to
  // name the file: the serve route only hands back known extensions.
  const isSvg = rawExtension === 'svg+xml' || rawExtension === 'svg';
  const extension = isSvg ? 'svg' : (ALLOWED_EXTENSIONS.has(rawExtension) ? rawExtension : 'png');

  let bytes = Buffer.from(base64Data, 'base64');
  if (bytes.length === 0) {
    return { ok: false, reason: 'empty after base64 decode' };
  }
  if (bytes.length > maxBytesPerImage) {
    return { ok: false, reason: `exceeds the ${Math.round(maxBytesPerImage / 1048576)}MB per-image limit` };
  }

  // B-158 (qa-critic veto 1): an SVG can carry <script>/on* handlers. The upload
  // endpoint sanitizes, but this path is reached straight from the WebSocket
  // payload, so the guard has to sit HERE — the one place every writer passes
  // through — or it is a guard on the wrong branch. A blob: URL inherits the
  // page origin, and the site CSP is report-only, so an unsanitized stored SVG
  // opened from the viewer would run script against the user's own session.
  if (extension === 'svg') {
    const sanitized = sanitizeSvg(bytes.toString('utf8'));
    if (!sanitized) {
      return { ok: false, reason: 'not a valid SVG once sanitized' };
    }
    bytes = Buffer.from(sanitized, 'utf8');
  }

  return { ok: true, bytes, extension };
}

/**
 * Returns a resized copy when the image's longest side exceeds
 * {@link MODEL_MAX_EDGE_PX}, otherwise null (store the original as-is). Any
 * decode/encode failure also yields null: a picture the model sees at full
 * size beats a picture it never sees.
 *
 * @param {Buffer} bytes
 * @param {string} extension - already vetted against ALLOWED_EXTENSIONS
 * @returns {Promise<Buffer|null>}
 */
async function downscaleForModel(bytes, extension) {
  if (!RESIZABLE_EXTENSIONS.has(extension)) return null;
  try {
    const meta = await sharp(bytes).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    if (!longest || longest <= MODEL_MAX_EDGE_PX) return null;
    const pipeline = sharp(bytes).resize({
      width: MODEL_MAX_EDGE_PX,
      height: MODEL_MAX_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    });
    // Keep the extension so the serve route and the transcript note stay valid.
    if (extension === 'png') return await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (extension === 'webp') return await pipeline.webp({ quality: 82 }).toBuffer();
    return await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch {
    return null;
  }
}

/**
 * Writes base64 data-URL images into a fresh bucket.
 *
 * Partial failure is REPORTED, not swallowed (qa-critic): one unwritable image
 * used to throw out of here and cost the prompt every other image silently, so
 * the model received "compare these three" with nothing attached. Each entry is
 * now independent and the rejected ones come back in `failures` for the caller
 * to surface.
 *
 * @param {Array<{data: string, name?: string}>} images
 * @returns {Promise<{bucket: string|null, paths: string[], failures: Array<{index: number, reason: string}>}>}
 */
export async function saveChatImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return { bucket: null, paths: [], failures: [] };
  }

  const limits = readImageLimits();
  const failures = [];
  const accepted = [];
  let totalBytes = 0;

  // Decode and vet everything BEFORE creating the bucket, so a message whose
  // images are all invalid leaves no empty directory behind.
  for (const [index, image] of images.entries()) {
    if (accepted.length >= limits.maxCount) {
      failures.push({ index, reason: `over the ${limits.maxCount}-image limit` });
      continue;
    }

    const decoded = decodeImagePayload(image, limits.maxBytesPerImage);
    if (!decoded.ok) {
      failures.push({ index, reason: decoded.reason });
      continue;
    }
    if (totalBytes + decoded.bytes.length > limits.maxBytesPerMessage) {
      failures.push({ index, reason: `over the ${Math.round(limits.maxBytesPerMessage / 1048576)}MB message limit` });
      continue;
    }

    totalBytes += decoded.bytes.length;
    accepted.push({ index, ...decoded });
  }

  if (accepted.length === 0) {
    return { bucket: null, paths: [], failures };
  }

  const bucket = crypto.randomBytes(16).toString('hex');
  const bucketDir = path.join(getChatImageRoot(), bucket);
  await fs.mkdir(bucketDir, { recursive: true, mode: 0o700 });

  const paths = [];
  for (const [position, item] of accepted.entries()) {
    const filepath = path.join(bucketDir, `image_${position}.${item.extension}`);
    try {
      const modelCopy = await downscaleForModel(item.bytes, item.extension);
      if (modelCopy) {
        // The path the model reads holds the downscaled copy; the untouched
        // upload sits beside it and is served by the same route.
        await fs.writeFile(path.join(bucketDir, `image_${position}.orig.${item.extension}`), item.bytes, { mode: 0o600 });
        await fs.writeFile(filepath, modelCopy, { mode: 0o600 });
      } else {
        await fs.writeFile(filepath, item.bytes, { mode: 0o600 });
      }
      paths.push(filepath);
    } catch (error) {
      // ENOSPC / EDQUOT / EACCES on one image must not cost the others.
      failures.push({ index: item.index, reason: `write failed: ${error.code || error.message}` });
    }
  }

  return { bucket, paths, failures };
}

/**
 * Resolves a `<bucket>/<name>` pair to an absolute path inside the store.
 * Returns null for anything malformed or escaping the root — the caller must
 * treat null as "not found" and never fall back to the raw input.
 *
 * @param {string} bucket
 * @param {string} name
 * @returns {{absolutePath: string, mimeType: string}|null}
 */
export function resolveChatImagePath(bucket, name) {
  if (!BUCKET_PATTERN.test(String(bucket || '')) || !NAME_PATTERN.test(String(name || ''))) {
    return null;
  }
  const extension = String(name).split('.').pop().toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return null;
  }

  const root = getChatImageRoot();
  const absolutePath = path.join(root, bucket, name);
  // Belt-and-braces: the patterns above already exclude separators and `..`, but
  // the containment check is what makes this safe if they are ever loosened.
  if (path.relative(root, absolutePath).startsWith('..')) {
    return null;
  }

  return { absolutePath, mimeType: MIME_BY_EXTENSION[extension] };
}
