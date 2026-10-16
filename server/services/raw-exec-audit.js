/**
 * raw-exec-audit.js — the audit sink for every raw (free-form) host command.
 *
 * Extracted verbatim from routes/system.js (T-2037) so the command board's raw
 * exec route AND the composer shell one-shot (/shell WebSocket) write the SAME
 * row shape under the SAME action, `command_board_raw_exec`. The strict variant's
 * read-back keys on that action string, so it must never change.
 *
 * Callers pass an ACTOR instead of an Express request, because the shell path
 * has a WebSocket upgrade request, not a routed one: { userId, ip, userAgent }.
 * `actorFromRequest` builds it from either kind of request.
 */

import crypto from 'crypto';

import { auditLogDb } from '../modules/database/index.js';
import { clientIp } from '../utils/client-ip.js';

import { redactSecretsForAudit } from './command-board-raw.js';

/** The one audit action every raw-exec row carries (strict read-back keys on it). */
export const RAW_EXEC_AUDIT_ACTION = 'command_board_raw_exec';

/** Newest rows scanned when proving a strict row landed. */
export const AUDIT_READBACK_LIMIT = 50;

/**
 * Builds an audit actor from an HTTP or WebSocket upgrade request.
 * @param {{ user?: { id?: unknown }, headers?: Record<string, unknown> } | null | undefined} req
 * @returns {{ userId: unknown, ip: string | null, userAgent: string | null }}
 */
export function actorFromRequest(req) {
    return {
        userId: req?.user?.id ?? null,
        ip: clientIp(req),
        userAgent: req?.headers?.['user-agent'] ?? null,
    };
}

/**
 * Audit for a raw-exec attempt (insert/reject/success/failure). The FULL command
 * + digest + actor + reason/exit go to audit_log (an owner-only, internal sink)
 * — NEVER to console/pm2 logs which may be shared.
 *
 * HONEST DESCRIPTION OF THE SINK: audit_log is append-only by USAGE (nothing in
 * this codebase updates or deletes rows; retention pruning is separate), but the
 * WRITE IS BEST-EFFORT: auditLogDb.record swallows every error and only logs to
 * console. A full disk or a locked DB therefore drops the row silently. For the
 * one place where that is unacceptable — the record that a raw command is about
 * to run — use auditRawExecStrict below, which verifies the row landed.
 *
 * B-197 (branch ٣): the command is the owner's own free-form shell, so it may
 * carry an INLINE credential. audit_log is owner-only but long-lived and
 * exported/backed-up, so the labelled credential VALUES are masked here before
 * the row is written. Redaction touches the AUDIT COPY only — the stored/executed
 * bytes and the digest are untouched (WYSIWYG is preserved). See
 * redactSecretsForAudit for its honest, name-directed limits.
 * @param {{ userId: unknown, ip: string | null, userAgent: string | null }} actor
 * @param {string} result
 * @param {Record<string, unknown>} [extra]
 */
export function auditRawExec(actor, result, extra = {}) {
    const metadata = { result, ...extra };
    if ('command' in metadata) {
        metadata.command = redactSecretsForAudit(metadata.command);
    }
    auditLogDb.record(RAW_EXEC_AUDIT_ACTION, {
        userId: actor?.userId ?? null,
        metadata,
        ipAddress: actor?.ip ?? null,
        userAgent: actor?.userAgent ?? null,
    });
}

/**
 * STRICT audit: writes the row and then PROVES it is readable, throwing if not.
 * Used for every pre-spawn start record so that an unauditable execution is
 * REFUSED rather than run silently (ADR-068 discipline: no unlogged raw exec).
 *
 * Verification method: a random nonce is embedded in the metadata and looked up
 * in the most recent rows. auditLogDb.record cannot report failure (it swallows
 * errors and returns void), so a read-back is the only way to distinguish
 * "written" from "silently dropped".
 *
 * LIMIT, stated plainly: the read-back scans the newest AUDIT_READBACK_LIMIT
 * rows. A concurrent flood of other audit events large enough to push the row
 * out of that window would produce a FALSE failure — i.e. it errs toward
 * refusing to execute, never toward executing unlogged.
 * @throws {Error} when the row cannot be confirmed.
 */
export function auditRawExecStrict(actor, result, extra = {}) {
    const auditNonce = crypto.randomUUID();
    auditRawExec(actor, result, { ...extra, auditNonce });
    let landed = false;
    try {
        landed = auditLogDb
            .recent(AUDIT_READBACK_LIMIT)
            .some((r) => r.action === RAW_EXEC_AUDIT_ACTION
                && typeof r.metadata === 'string'
                && r.metadata.includes(auditNonce));
    } catch (error) {
        throw new Error(`audit_unverifiable: ${error.message}`);
    }
    if (!landed) {
        throw new Error('audit_write_failed');
    }
}
