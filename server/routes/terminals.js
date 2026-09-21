/**
 * STANDALONE TERMINALS API ROUTES — T-938 (ADR-063)
 * =================================================
 *
 * REST is for CREATE + METADATA ONLY; the live PTY stream attaches exclusively
 * over WS `/terminal` (terminal-websocket.service.ts). Mounted in
 * server/index.js behind authenticateToken:
 *
 *   GET    /api/terminals      → 200 {"terminals":[...]}   (caller's only,
 *                                 createdAt ascending)
 *   POST   /api/terminals      → 201 {"terminal":{...}} — the PTY has ALREADY
 *                                 spawned when this returns
 *                                 | 400 invalid_title / invalid_cwd /
 *                                       invalid_initial_command
 *                                 | 409 terminal_limit_reached
 *   PATCH  /api/terminals/:id  → 200 {"terminal":{...}} | 400 | 404 not_found
 *   DELETE /api/terminals/:id  → 204 (kills a live PTY, drops the record)
 *                                 | 404 not_found
 *
 * Error envelope: {"error":"<English message>","code":"<code>"} — generic
 * messages only; internals are logged server-side, never surfaced.
 *
 * SECURITY: ownership is enforced INSIDE the registry — every call carries
 * req.user.id from the JWT and a foreign terminal answers 404 (identical to a
 * nonexistent one, never 403). This router is a thin transport shim: all
 * validation, limits and state live in the registry service.
 */

import express from 'express';

import {
    createStandaloneTerminal,
    listStandaloneTerminals,
    renameStandaloneTerminal,
    deleteStandaloneTerminal,
} from '../services/standalone-terminals/standalone-terminal-registry.js';
import { acquireApplicationWriterLease, reportWriterLeaseRefusal } from '../services/update-writer-lease.js';

const router = express.Router();

const NOT_FOUND_BODY = { error: 'Terminal not found', code: 'not_found' };
const INVALID_MODE_BODY = {
    error: 'Terminal mode must be general or session-bound',
    code: 'invalid_terminal_mode',
};
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Reads the authenticated user id, fail-closed. authenticateToken (mounted in
 * server/index.js) guarantees req.user, but the registry must never be reached
 * without an owner key, so a missing id short-circuits to 401 here too.
 */
function requireUserId(req, res) {
    const userId = req.user?.id;
    if (userId === null || userId === undefined) {
        res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        return null;
    }
    return userId;
}

// GET /api/terminals — the caller's terminals, createdAt ascending.
router.get('/', (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) {
        return;
    }
    res.json({ terminals: listStandaloneTerminals(userId) });
});

// POST /api/terminals — create + spawn immediately (before any WS attach).
router.post('/', async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) {
        return;
    }
    try {
        const mode = req.body?.mode ?? 'general';
        const sessionId = req.body?.sessionId;
        const validMode = mode === 'general' || mode === 'session-bound';
        const validContract = validMode
            && (mode === 'general'
                ? sessionId === undefined || sessionId === null
                : typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId));
        // Validate shape before an ownership lookup so malformed requests always
        // have the same 400 response and cannot become a 400/404 session oracle.
        if (!validContract) {
            return res.status(400).json(INVALID_MODE_BODY);
        }
        if (mode === 'session-bound') {
            // Lazy import keeps the general-terminal route's dependency graph
            // unchanged. Authorization is still before registry/PTY spawn, and
            // uses the same indistinguishable 404 contract as session writes.
            const { assertSessionAccessible } = await import('../modules/providers/index.js');
            try {
                assertSessionAccessible(sessionId, userId, 'write');
            } catch {
                return res.status(404).json({ error: 'Not found', code: 'not_found' });
            }
        }
        let writerLease;
        try {
            writerLease = await acquireApplicationWriterLease('standalone-pty', { waitMs: 100 });
        } catch (leaseError) {
            // The 409 used to be silent server-side, so a terminal that simply
            // never opened had no diagnosable cause in the logs. Same wording
            // and same classification as every other refusal surface.
            const refusal = reportWriterLeaseRefusal('Standalone terminal rejected: writer lease', leaseError);
            // NOT a gate denial ⇒ NOT a 409 and NOT "maintenance is active".
            // Answered here, not rethrown: the outer catch logs the raw message,
            // and the helper above already logged this refusal with free text
            // withheld. The terminal is refused either way.
            if (!refusal.gateDenial) {
                return res.status(500).json({ error: 'Failed to create terminal', code: 'internal_error' });
            }
            return res.status(409).json({ error: 'Source update maintenance is active', code: refusal.code });
        }
        const result = createStandaloneTerminal({
            userId,
            title: req.body?.title,
            cwd: req.body?.cwd,
            initialCommand: req.body?.initialCommand,
            mode: req.body?.mode,
            sessionId: req.body?.sessionId,
            writerLease,
            authenticatedPrincipal: req.user,
        });
        if (!result.ok) {
            writerLease.release();
            return res.status(result.status).json({ error: result.error, code: result.code });
        }
        res.status(201).json({ terminal: result.terminal });
    } catch (error) {
        // Spawn/env failures stay generic on the wire (no internals leaked).
        console.error('[ERROR] Standalone terminal create failed:', error?.message || error);
        res.status(500).json({ error: 'Failed to create terminal', code: 'internal_error' });
    }
});

// PATCH /api/terminals/:id — rename only (the sole mutable metadata field).
router.patch('/:id', (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) {
        return;
    }
    const result = renameStandaloneTerminal(userId, req.params.id, req.body?.title);
    if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
    }
    res.json({ terminal: result.terminal });
});

// DELETE /api/terminals/:id — kill a live PTY and drop the record + buffer.
router.delete('/:id', (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) {
        return;
    }
    if (!deleteStandaloneTerminal(userId, req.params.id)) {
        return res.status(404).json(NOT_FOUND_BODY);
    }
    res.status(204).end();
});

export default router;
