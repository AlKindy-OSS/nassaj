import express from 'express';

import sessionManager from '../sessionManager.js';
import { assertSessionAccessible } from '../modules/providers/services/sessions.service.js';
import { coerceUserId } from '../modules/projects/services/project-visibility-guard.service.js';
import { sessionsDb } from '../modules/database/index.js';
import { AppError } from '../shared/utils.js';

const router = express.Router();

/**
 * DELETE /api/gemini/sessions/:sessionId
 *
 * Two defects were fixed here (B-IDOR-GEMINI):
 *
 * 1. No identity was read anywhere in this module, so any authenticated caller
 *    could destroy any session by id — the transcript file via
 *    sessionManager.deleteSession and the row via sessionsDb.deleteSessionById.
 *    The session now passes the shared write gate (participant of the session, or
 *    write mandate on its project), which answers 404 on refusal so a probe
 *    cannot tell "not yours" from "does not exist".
 *
 * 2. sessionsDb.deleteSessionById is NOT provider-scoped: this Gemini-specific
 *    route happily deleted a Claude / Codex / Cursor session. The route now
 *    refuses anything whose stored provider is not gemini, with the same 404
 *    contract.
 *
 * The router is mounted behind authenticateToken (index.js), so req.user is the
 * authenticated caller.
 */
router.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!sessionId || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(sessionId)) {
            return res.status(400).json({ success: false, error: 'Invalid session ID format' });
        }

        const session = assertSessionAccessible(sessionId, coerceUserId(req.user?.id ?? null), 'write');
        if (session.provider !== 'gemini') {
            // Same 404 contract as an unauthorized session: this endpoint owns
            // gemini sessions only and must not act on another provider's row.
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        await sessionManager.deleteSession(sessionId);
        sessionsDb.deleteSessionById(sessionId);
        res.json({ success: true });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ success: false, error: error.message });
        }
        console.error(`Error deleting Gemini session ${req.params.sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
