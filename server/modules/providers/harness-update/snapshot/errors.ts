/**
 * Error codes of the harness snapshot / restore libraries (T-1871 stage 3).
 *
 * Every message is generic on purpose: no path, member id or file name ever
 * reaches an error message, a log line or an HTTP body (spec §11, PDPL).
 */

import { AppError } from '@/shared/utils.js';

const STATUS_BY_CODE = {
  SNAPSHOT_TAMPERED: 409,
  ORIGIN_NAME_CONFLICT: 409,
  SNAPSHOT_LAYOUT_MISMATCH: 409,
  SNAPSHOT_UNSAFE_ENTRY: 409,
  MANIFEST_INVALID: 500,
  STORE_IN_USE: 423,
  STORE_ACCESS_UNPROVABLE: 423,
  INSUFFICIENT_STORAGE: 507,
  SNAPSHOT_COUNT_CAP: 507,
  CONFIRMATION_REQUIRED: 409,
  ACK_KEY_INSECURE: 500,
  ASSET_HOST_NOT_ALLOWED: 502,
  ASSET_REDIRECT_LIMIT: 502,
  ASSET_HTTP_STATUS: 502,
  ASSET_SIZE_MISMATCH: 502,
  ASSET_TOO_LARGE: 502,
  ASSET_DIGEST_MISMATCH: 502,
  ASSET_ARCHIVE_INVALID: 502,
  ASSET_ENTRY_UNSAFE: 502,
  ASSET_ENTRY_DUPLICATE: 502,
  ASSET_ENTRY_NAME_MISMATCH: 502,
  ASSET_VERSION_MISMATCH: 502,
  PREFLIGHT_CHANGED: 409,
  NOT_RESTORE_COMPATIBLE: 404,
  SNAPSHOT_NOT_FOUND: 404,
  NO_RECOVERY_PENDING: 409,
  RECOVERY_UNVERIFIED: 409,
  INVALID_ROLLBACK_SCOPE: 400,
  INVALID_RECOVERY_ACTION: 400,
} as const;

/** Machine-readable error code raised by the snapshot libraries. */
export type SnapshotErrorCode = keyof typeof STATUS_BY_CODE;

/** Builds an AppError with the fixed HTTP status of `code` and a generic message. */
export function snapshotError(code: SnapshotErrorCode, details?: unknown): AppError {
  return new AppError(`Harness snapshot operation refused (${code})`, {
    code,
    statusCode: STATUS_BY_CODE[code],
    details,
  });
}

/** True when `error` is an AppError carrying `code`. */
export function hasErrorCode(error: unknown, code: SnapshotErrorCode): boolean {
  return error instanceof AppError && error.code === code;
}
