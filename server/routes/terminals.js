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

const router = express.Router();

const NOT_FOUND_BODY = { error: 'Terminal not found', code: 'not_found' };

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
router.post('/', (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) {
        return;
    }
    try {
        const result = createStandaloneTerminal({
            userId,
            title: req.body?.title,
            cwd: req.body?.cwd,
            initialCommand: req.body?.initialCommand,
        });
        if (!result.ok) {
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
