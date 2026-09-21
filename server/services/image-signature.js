import { looksLikeSvgRoot } from './svg-sanitizer.js';

/**
 * "What kind of image is this, really?" — the ONE answer used by every upload
 * path that persists a user-supplied image (app branding logo, project logo).
 *
 * The client-declared Content-Type and the client-supplied filename are never
 * trusted: the extension is derived from the real leading bytes, so a request
 * that claims image/png while carrying HTML is rejected here rather than being
 * written to disk under a .png name and later served same-origin.
 *
 * Lived in server/routes/settings.js until the per-project logo needed the same
 * check. Two copies of a security decision drift; this module is the single
 * definition both import.
 */

/** Allowed image MIME types → canonical extension used on disk and in URLs. */
export const IMAGE_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** The extensions that may ever appear on disk, derived from the MIME map. */
export const IMAGE_ALLOWED_EXTS = new Set(Object.values(IMAGE_MIME_TO_EXT));

/**
 * Inspect the real leading bytes of the buffer and return the canonical
 * extension for the detected format, or null if it matches no allowed
 * signature.
 */
export function detectImageExt(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }
  // SVG is text/XML, not a binary signature. Detect it by content: the document
  // (after BOM/whitespace/<?xml?>/comments) must have an <svg> ROOT element —
  // not merely contain the substring "<svg" somewhere. This is checked before
  // the 12-byte minimum used for raster signatures because a valid SVG can be
  // shorter than 12 bytes.
  if (looksLikeSvgRoot(buffer.toString('utf8'))) {
    return 'svg';
  }
  if (buffer.length < 12) {
    return null;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  // WEBP: "RIFF" (52 49 46 46) at 0..3 and "WEBP" (57 45 42 50) at 8..11.
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}
