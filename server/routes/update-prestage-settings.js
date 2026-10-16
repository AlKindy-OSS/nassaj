/**
 * T-2030 (ADR-207 decision 4): owner-only GET/PUT of this node's prestage
 * setting, mounted by the system router at `/api/system/update/prestage`
 * (behind authenticateToken, which also enforces the cookie-session CSRF
 * guard). A successful PUT wakes the prestager (`onChange`), so turning it
 * off aborts/discards at once and turning it on starts settling.
 *
 *   GET  /settings → describePrestageSettings()
 *   PUT  /settings {prestageEnabled: boolean, prestageQuarantineHours: 0–168 integer}
 *        → 200 describePrestageSettings() | 400 {code} | 403 (non-owner)
 */
import express from 'express';

import { requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import {
    describePrestageSettings, readStoredPrestageSettings, validatePrestageSettingsInput, writePrestageSettings,
} from '../services/update-prestage-settings.js';

function noStore(_req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
}

/**
 * @param {object} [deps]
 * @param {{getStrict(key: string): string|null, set(key: string, value: string): void}} [deps.store] app_config (default)
 * @param {object} [deps.env] process environment
 * @param {(action: string, details: object) => void} [deps.audit] audit-log writer
 * @param {object} [deps.logger]
 * @param {{readMax: number, writeMax: number}} [deps.rateLimit] requests per minute
 * @param {() => unknown} [deps.onChange] after a successful PUT: wake the prestager now
 */
export function createPrestageSettingsRouter({
    store, env = process.env, audit = () => {}, logger = console, rateLimit = { readMax: 60, writeMax: 10 }, onChange = () => {},
} = {}) {
    const router = express.Router();
    const storeOption = store ? { store } : {};
    const view = () => describePrestageSettings({ ...storeOption, env, logger });
    const readLimiter = createRateLimiter({ windowMs: 60_000, max: rateLimit.readMax, message: 'Too many requests', code: 'rate_limited' });
    const writeLimiter = createRateLimiter({ windowMs: 60_000, max: rateLimit.writeMax, message: 'Too many requests', code: 'rate_limited' });

    router.get('/settings', requireRole('owner'), readLimiter, noStore, (_req, res) => {
        try { return res.json(view()); } catch (error) {
            logger.error?.('[prestage-settings]', JSON.stringify({ event: 'read_failed', code: error?.code ?? 'unknown' }));
            return res.status(500).json({ code: 'prestage_settings_unavailable' });
        }
    });

    router.put('/settings', requireRole('owner'), writeLimiter, noStore, (req, res) => {
        const checked = validatePrestageSettingsInput(req.body);
        if (!checked.ok) return res.status(400).json({ code: checked.code });
        try {
            const before = readStoredPrestageSettings(storeOption);
            const after = writePrestageSettings(checked.value, storeOption);
            audit('update_prestage_settings_changed', { userId: req.user?.id ?? null, metadata: { before, after } });
            try { void Promise.resolve(onChange()).catch(() => {}); } catch { /* the next poll still applies it */ }
            return res.json(view());
        } catch (error) {
            logger.error?.('[prestage-settings]', JSON.stringify({ event: 'write_failed', code: error?.code ?? 'unknown' }));
            return res.status(500).json({ code: 'prestage_settings_unavailable' });
        }
    });

    return router;
}
