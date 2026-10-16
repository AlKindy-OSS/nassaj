/**
 * ADR-207 decision 4 (T-2030): the owner's prestage setting on this node.
 *
 * Two fields, persisted as one JSON value in `app_config`:
 *   - `prestageEnabled` (default true): off = policy `off` (any un-adopted slot
 *     is discarded on the next cycle);
 *   - `prestageQuarantineHours` (default 0 = prestage immediately; 0–168):
 *     the node-local delay counted from the release's first sighting.
 *
 * The prestager reads it every cycle through {@link readStoredPrestageSettings}
 * (one indexed key read). The environment still wins (see
 * resolvePrestageConfig): `NASSAJ_UPDATE_PRESTAGE=0` locks prestaging off and
 * the policy / quarantine variables override the stored fields;
 * {@link describePrestageSettings} reports both so the UI can show them.
 */
import { appConfigDb } from '../modules/database/index.js';
import { PRESTAGE_POLICY_DEFAULT, resolvePrestageConfig } from './update-prestager.js';

export const PRESTAGE_SETTINGS_KEY = 'update_prestage_settings';
export const PRESTAGE_QUARANTINE_HOURS_MIN = 0;
export const PRESTAGE_QUARANTINE_HOURS_MAX = 168;

export const PRESTAGE_SETTINGS_DEFAULT = Object.freeze({
    prestageEnabled: true,
    prestageQuarantineHours: PRESTAGE_POLICY_DEFAULT.quarantineHours,
});

const FIELDS = Object.freeze(['prestageEnabled', 'prestageQuarantineHours']);

function validHours(value) {
    return Number.isSafeInteger(value) && value >= PRESTAGE_QUARANTINE_HOURS_MIN && value <= PRESTAGE_QUARANTINE_HOURS_MAX;
}

/**
 * Strict validation of a PUT body: a plain object with exactly the two fields,
 * a boolean and a whole number of hours in 0–168. Nothing is coerced.
 * @returns {{ ok: true, value: {prestageEnabled: boolean, prestageQuarantineHours: number} } | { ok: false, code: string }}
 */
export function validatePrestageSettingsInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'prestage_settings_invalid' };
    const keys = Object.keys(body);
    if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) {
        return { ok: false, code: 'prestage_settings_invalid' };
    }
    if (typeof body.prestageEnabled !== 'boolean') return { ok: false, code: 'prestage_enabled_invalid' };
    if (!validHours(body.prestageQuarantineHours)) return { ok: false, code: 'prestage_quarantine_hours_invalid' };
    return { ok: true, value: { prestageEnabled: body.prestageEnabled, prestageQuarantineHours: body.prestageQuarantineHours } };
}

/**
 * The stored setting, field by field; a missing or corrupt value (or field)
 * falls back to its default. A store that cannot be read THROWS (qa condition
 * 1): a disabled setting must never silently become the enabled default.
 */
export function readStoredPrestageSettings({ store = appConfigDb } = {}) {
    const raw = store.getStrict(PRESTAGE_SETTINGS_KEY);
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return { ...PRESTAGE_SETTINGS_DEFAULT };
    return {
        prestageEnabled: typeof parsed.prestageEnabled === 'boolean' ? parsed.prestageEnabled : PRESTAGE_SETTINGS_DEFAULT.prestageEnabled,
        prestageQuarantineHours: validHours(parsed.prestageQuarantineHours)
            ? parsed.prestageQuarantineHours : PRESTAGE_SETTINGS_DEFAULT.prestageQuarantineHours,
    };
}

/** Persist an already validated setting (see {@link validatePrestageSettingsInput}). */
export function writePrestageSettings(value, { store = appConfigDb } = {}) {
    store.set(PRESTAGE_SETTINGS_KEY, JSON.stringify({
        prestageEnabled: value.prestageEnabled, prestageQuarantineHours: value.prestageQuarantineHours,
    }));
    return readStoredPrestageSettings({ store });
}

/**
 * The owner-facing view: the stored setting, what the prestager will actually
 * use, and which parts the environment controls.
 * @returns {{
 *   settings: {prestageEnabled: boolean, prestageQuarantineHours: number},
 *   effective: {prestageEnabled: boolean, policy: string, prestageQuarantineHours: number},
 *   lockedByEnv: boolean,
 *   overriddenByEnv: {prestageEnabled: boolean, prestageQuarantineHours: boolean},
 *   policyInvalid: boolean,
 *   defaults: {prestageEnabled: boolean, prestageQuarantineHours: number},
 *   limits: {minQuarantineHours: number, maxQuarantineHours: number},
 * }}
 */
export function describePrestageSettings({ store = appConfigDb, env = process.env, logger = console } = {}) {
    const settings = readStoredPrestageSettings({ store });
    const config = resolvePrestageConfig(env, { logger, stored: settings });
    return {
        settings,
        effective: {
            prestageEnabled: !config.killed && config.policy !== 'off',
            policy: config.killed ? 'off' : config.policy,
            prestageQuarantineHours: config.quarantineMs / 3_600_000,
        },
        lockedByEnv: config.killed,
        overriddenByEnv: { prestageEnabled: config.envOverrides.policy, prestageQuarantineHours: config.envOverrides.quarantineHours },
        policyInvalid: config.policyInvalid,
        defaults: { ...PRESTAGE_SETTINGS_DEFAULT },
        limits: { minQuarantineHours: PRESTAGE_QUARANTINE_HOURS_MIN, maxQuarantineHours: PRESTAGE_QUARANTINE_HOURS_MAX },
    };
}
