/**
 * Owner-configurable per-file cap for chat attachments
 * (POST /api/projects/:projectId/upload-attachments), T-2116.
 *
 * Set from `/api/system/storage-policy` (field `attachmentMaxMb`, owner only) and
 * read per request, like chat-image-store's image limits, so a change applies to
 * the next upload without a restart. The file-manager upload cap is separate.
 */

import { createRateLimiter } from '../middleware/rate-limit.js';
import { appConfigDb } from '../modules/database/index.js';
import { clientIp } from '../utils/client-ip.js';

export const ATTACHMENT_MAX_MB_KEY = 'chat_attachment_max_mb';

/** Bounds shared with the storage-policy route so validation and reads agree. */
export const ATTACHMENT_MAX_MB_BOUNDS = Object.freeze({ min: 1, max: 200, fallback: 50 });

const BYTES_PER_MB = 1024 * 1024;

/**
 * Total bytes one upload request may carry: twice the per-file cap (a couple of
 * files at the limit), never above this ceiling, plus room for multipart framing.
 * The ceiling bounds what a single request can stage on disk even at 200 MB per
 * file (20 files x 200 MB would otherwise be 4 GB); 256 MB still admits one file
 * at the 200 MB maximum.
 */
const REQUEST_CEILING_BYTES = 256 * BYTES_PER_MB;
const MULTIPART_FRAMING_BYTES = BYTES_PER_MB;

/** Uploads per user per minute; a message sends its attachments in one request. */
export const ATTACHMENT_UPLOADS_PER_MINUTE = 10;

/**
 * The single parser for the stored value, shared with the storage-policy route
 * so settings and the upload path can never disagree: only a canonical base-10
 * integer in bounds ('1e2', '0x40', '080', '100.0' are rejected).
 * @param {string | null} stored
 * @returns {number | null}
 */
export function parseStoredAttachmentMb(stored) {
  if (typeof stored !== 'string' || !/^[1-9][0-9]{0,2}$/.test(stored)) return null;
  const value = Number(stored);
  return value >= ATTACHMENT_MAX_MB_BOUNDS.min && value <= ATTACHMENT_MAX_MB_BOUNDS.max ? value : null;
}

/**
 * The effective per-file attachment cap.
 * Falls back to the default when the stored value is missing, out of range, or
 * unreadable: a settings read must never block the upload path.
 * @returns {{ maxMb: number, maxBytes: number }}
 */
export function readAttachmentLimit() {
  const maxMb = parseStoredAttachmentMb(appConfigDb.get(ATTACHMENT_MAX_MB_KEY)) ?? ATTACHMENT_MAX_MB_BOUNDS.fallback;
  return { maxMb, maxBytes: maxMb * BYTES_PER_MB };
}

/**
 * User-facing text for an over-limit attachment.
 * @param {number} maxMb - the cap that was enforced for this request
 * @returns {string}
 */
export function attachmentTooLargeMessage(maxMb) {
  return `File too large. Maximum size is ${maxMb}MB per file.`;
}

/**
 * Maps a multer error from the attachment route to its HTTP response. An
 * oversize file is 413 with a stable `code` and the enforced `maxMb`, so the
 * client can show a localized message and adopt the server's limit.
 * @param {{ code?: string, message?: string }} err
 * @param {{ maxMb: number, maxCount: number }} limits - the caps enforced for this request
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function attachmentUploadErrorResponse(err, { maxMb, maxCount }) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return {
      status: 413,
      body: { error: attachmentTooLargeMessage(maxMb), code: 'attachment_too_large', maxMb },
    };
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return { status: 400, body: { error: `Too many files. Maximum is ${maxCount} files.` } };
  }
  return { status: 400, body: { error: err?.message || 'Upload rejected' } };
}

/**
 * @param {number} maxBytes - the per-file cap in force for this request
 * @returns {number} the total byte cap for the whole request
 */
export function attachmentRequestByteCap(maxBytes) {
  return Math.min(maxBytes * 2, REQUEST_CEILING_BYTES) + MULTIPART_FRAMING_BYTES;
}

/**
 * Refuses an upload by its declared size before any body byte is read. Node's
 * HTTP parser never delivers more than Content-Length bytes and rejects requests
 * carrying both Content-Length and Transfer-Encoding, so a declared length is a
 * hard bound; a chunked request has none and is refused (browsers always send
 * a length for FormData).
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @param {{ maxBytes: number }} limit
 * @returns {{ status: number, body: Record<string, unknown> } | null} null when allowed
 */
export function checkAttachmentRequestSize(req, { maxBytes }) {
  const declared = req.headers['content-length'];
  if (typeof declared !== 'string' || !/^[0-9]+$/.test(declared)) {
    return {
      status: 411,
      body: { error: 'Upload length required.', code: 'attachment_length_required' },
    };
  }
  const cap = attachmentRequestByteCap(maxBytes);
  if (Number(declared) <= cap) return null;
  const maxRequestMb = Math.floor(cap / BYTES_PER_MB);
  return {
    status: 413,
    body: {
      error: `Upload too large. The attached files together may not exceed ${maxRequestMb}MB.`,
      code: 'attachment_request_too_large',
      maxRequestMb,
    },
  };
}

/**
 * Per-user fixed-window limiter for the upload route (after authenticateToken).
 * Keys on the user id, falling back to the client IP.
 * @returns {import('express').RequestHandler}
 */
export function createAttachmentUploadLimiter() {
  return createRateLimiter({
    windowMs: 60_000,
    max: ATTACHMENT_UPLOADS_PER_MINUTE,
    message: 'Too many uploads, please slow down',
    code: 'attachment_rate_limited',
    key: (req) => (req.user?.id != null ? `user:${req.user.id}` : `ip:${clientIp(req) || 'unknown'}`),
  });
}
