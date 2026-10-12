/**
 * HTTP contract for opening a project secret file (B-1593).
 *
 * Service secrets (the running service's own .env, service database, credential
 * and transcript stores) are always refused by the path guards. An ordinary
 * project dotenv or SQLite file is served only when the request carries an
 * explicit confirmation flag (`confirmSecret=1` in the query for reads,
 * `confirmSecret: true` in the body for saves). Without it the route answers
 * 428 with SECRET_FILE_CONFIRMATION_CODE, the client asks the user and retries
 * with the flag. A confirmed access is audited without its content.
 */

import path from 'node:path';

/** Error code the client turns into a "this is a secrets file, open it?" prompt. */
export const SECRET_FILE_CONFIRMATION_CODE = 'secret_file_confirmation_required';

/** Audit action for a confirmed secret-file read, download or save. */
export const SECRET_FILE_AUDIT_ACTION = 'project_secret_file_accessed';

/**
 * True only for an explicit confirmation value.
 *
 * @param {unknown} value Query string or JSON body value.
 * @returns {boolean}
 */
export function isSecretFileConfirmed(value) {
  return value === true || value === '1' || value === 'true';
}

/**
 * Answers 428 asking the client to confirm opening a project secret file.
 *
 * @param {import('express').Response} res
 */
export function sendSecretFileConfirmationRequired(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(428).json({
    error: 'This is a secrets file; confirm to open it',
    code: SECRET_FILE_CONFIRMATION_CODE,
  });
}

/**
 * Audit options for a confirmed access: who, which project, the
 * project-relative path and how. Never the content.
 *
 * @param {{ user?: { id?: unknown }, ip?: string, get?: (name: string) => string | undefined }} req
 * @param {{ userId: number | null, projectId: string, projectRoot: string, absolutePath: string,
 *   access: 'read' | 'download' | 'save' }} details
 */
export function buildSecretFileAuditEntry(req, { userId, projectId, projectRoot, absolutePath, access }) {
  return {
    userId,
    ipAddress: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    metadata: { projectId: String(projectId), path: path.relative(projectRoot, absolutePath), access },
  };
}
