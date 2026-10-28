/**
 * ADR-216 §3.3: owner-only release-branch re-attach, mounted by the system
 * router at `/api/system/update/source-attach` (behind authenticateToken, which
 * also enforces Origin + CSRF on cookie-session mutations).
 *
 *   GET  /                 → 200 describe()            (details for the owner's confirmation)
 *   POST / {expectedHead}  → 202 {operationId} | 400 {code} | 409 {code}
 *   GET  /operations/:id   → 200 operation | 400 {code} | 404 {code}
 *
 * The POST never runs the attach inside the request: it starts a detached
 * background operation and returns at once; the client polls the operation.
 */
import express from 'express';

import { requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

function noStore(_req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
}

/**
 * @param {object} deps
 * @param {() => ReturnType<import('../services/source-attach-operation.js').createSourceAttachService> | null} deps.service
 *   resolved per request (index.js wires it after the router is built)
 * @param {Function} [deps.limiter] the update routes' limiter (localUpdateLimiter)
 * @param {{pollMax?: number}} [deps.rateLimit]
 */
export function createSourceAttachRouter({ service, limiter, rateLimit = {}, logger = console } = {}) {
    const router = express.Router();
    const actionLimiter = limiter || createRateLimiter({ windowMs: 60_000, max: 20, message: 'Too many update requests' });
    // Polling has its own bucket: a 2 s poll must not use up the allowance of the action itself.
    const pollLimiter = createRateLimiter({ windowMs: 60_000, max: rateLimit.pollMax ?? 60, message: 'Too many update requests' });
    const resolve = (res) => {
        const current = typeof service === 'function' ? service() : null;
        if (!current) res.status(409).json({ code: 'source_attach_unavailable' });
        return current;
    };
    const fail = (res, error) => {
        logger.error?.(`[source-attach] request failed: ${error?.code || 'unknown'}`);
        return res.status(500).json({ code: 'source_attach_unavailable' });
    };

    router.get('/', requireRole('owner'), actionLimiter, noStore, async (_req, res) => {
        const current = resolve(res);
        if (!current) return undefined;
        try { return res.json(await current.describe()); } catch (error) { return fail(res, error); }
    });

    router.post('/', requireRole('owner'), actionLimiter, noStore, async (req, res) => {
        const current = resolve(res);
        if (!current) return undefined;
        if (!Number.isSafeInteger(req.user?.id) || req.user.id < 1) return res.status(403).json({ code: 'owner_identity_unavailable' });
        try {
            const outcome = await current.start({ expectedHead: req.body?.expectedHead, userId: req.user.id });
            return res.status(outcome.status).json(outcome.body);
        } catch (error) { return fail(res, error); }
    });

    router.get('/operations/:id', requireRole('owner'), pollLimiter, noStore, async (req, res) => {
        const current = resolve(res);
        if (!current) return undefined;
        if (!/^[0-9a-f-]{36}$/.test(req.params.id || '')) return res.status(400).json({ code: 'invalid_request' });
        try {
            const operation = await current.operation(req.params.id);
            return operation ? res.json(operation) : res.status(404).json({ code: 'operation_not_found' });
        } catch (error) { return fail(res, error); }
    });

    return router;
}
