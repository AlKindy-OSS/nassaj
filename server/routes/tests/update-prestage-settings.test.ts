/**
 * T-2030 (ADR-207 decision 4): GET/PUT /api/system/update/prestage/settings.
 *
 * The REAL router (requireRole('owner') + strict validation) against the REAL
 * app_config table in a throwaway database: owner-only, input validation,
 * persistence, the env lock / overrides in the response, and corrupt values.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'update-prestage-settings-test-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'prestage-settings-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { closeConnection } = await import('@/modules/database/connection.js');
const { appConfigDb } = await import('@/modules/database/index.js');
const { createPrestageSettingsRouter } = await import('../update-prestage-settings.js');
const { PRESTAGE_SETTINGS_KEY, readStoredPrestageSettings, validatePrestageSettingsInput } = await import('../../services/update-prestage-settings.js');
await initializeDatabase();

type User = { id: number; role: string; username: string };
const OWNER: User = { id: 1, role: 'owner', username: 'owner' };
const ADMIN: User = { id: 2, role: 'admin', username: 'admin' };
const MEMBER: User = { id: 3, role: 'user', username: 'member' };
let currentUser: User = OWNER;
const env: Record<string, string> = {};
const audits: { action: string; details: any }[] = [];
let wakes = 0;

const app = express();
app.use(express.json());
app.use('/api/system', (req, _res, next) => { (req as any).user = currentUser; next(); });
app.use('/api/system/update/prestage', createPrestageSettingsRouter({
    env, audit: (action: string, details: unknown) => { audits.push({ action, details }); },
    logger: { error() {}, warn() {} }, rateLimit: { readMax: 1000, writeMax: 1000 },
    onChange: () => { wakes += 1; },
}));
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/update/prestage/settings`;
after(async () => {
    server.close();
    closeConnection();
    await rm(tmpDir, { recursive: true, force: true });
});

async function get(user: User = OWNER) {
    currentUser = user;
    const response = await fetch(url);
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') };
}

async function put(body: unknown, user: User = OWNER) {
    currentUser = user;
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}

function reset() {
    appConfigDb.delete(PRESTAGE_SETTINGS_KEY);
    for (const key of Object.keys(env)) delete env[key];
    audits.length = 0;
    wakes = 0;
}

test('GET: defaults are on with 0 h (prestage immediately), nothing locked or overridden', async () => {
    reset();
    const { status, body, cacheControl } = await get();
    assert.equal(status, 200);
    assert.equal(cacheControl, 'no-store');
    assert.deepEqual(body, {
        settings: { prestageEnabled: true, prestageQuarantineHours: 0 },
        effective: { prestageEnabled: true, policy: 'quarantine', prestageQuarantineHours: 0 },
        lockedByEnv: false,
        overriddenByEnv: { prestageEnabled: false, prestageQuarantineHours: false },
        policyInvalid: false,
        defaults: { prestageEnabled: true, prestageQuarantineHours: 0 },
        limits: { minQuarantineHours: 0, maxQuarantineHours: 168 },
    });
});

test('owner-only: admin and member get 403 on GET and PUT; nothing is written', async () => {
    reset();
    for (const user of [ADMIN, MEMBER]) {
        assert.equal((await get(user)).status, 403);
        assert.equal((await put({ prestageEnabled: false, prestageQuarantineHours: 5 }, user)).status, 403);
    }
    assert.equal(appConfigDb.get(PRESTAGE_SETTINGS_KEY), null);
    assert.equal(audits.length, 0);
    assert.equal(wakes, 0, 'a refused PUT wakes nothing');
});

test('PUT: a valid setting persists, is audited and returned', async () => {
    reset();
    const { status, body } = await put({ prestageEnabled: false, prestageQuarantineHours: 24 });
    assert.equal(status, 200);
    assert.deepEqual(body.settings, { prestageEnabled: false, prestageQuarantineHours: 24 });
    assert.deepEqual(body.effective, { prestageEnabled: false, policy: 'off', prestageQuarantineHours: 24 });
    assert.deepEqual(readStoredPrestageSettings(), { prestageEnabled: false, prestageQuarantineHours: 24 });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'update_prestage_settings_changed');
    assert.equal(wakes, 1, 'a successful PUT wakes the prestager');
    assert.deepEqual(audits[0].details.metadata.after, { prestageEnabled: false, prestageQuarantineHours: 24 });
    assert.equal((await put({ prestageEnabled: true, prestageQuarantineHours: 168 })).status, 200, 'upper bound');
    assert.equal((await put({ prestageEnabled: true, prestageQuarantineHours: 0 })).status, 200, 'lower bound');
});

test('PUT: strict validation, nothing coerced, nothing written', async () => {
    reset();
    const cases: [unknown, string][] = [
        [[], 'prestage_settings_invalid'],
        [{}, 'prestage_settings_invalid'],
        [{ prestageEnabled: true }, 'prestage_settings_invalid'],
        [{ prestageEnabled: true, prestageQuarantineHours: 1, extra: 1 }, 'prestage_settings_invalid'],
        [{ prestageEnabled: 'true', prestageQuarantineHours: 1 }, 'prestage_enabled_invalid'],
        [{ prestageEnabled: 1, prestageQuarantineHours: 1 }, 'prestage_enabled_invalid'],
        [{ prestageEnabled: true, prestageQuarantineHours: -1 }, 'prestage_quarantine_hours_invalid'],
        [{ prestageEnabled: true, prestageQuarantineHours: 169 }, 'prestage_quarantine_hours_invalid'],
        [{ prestageEnabled: true, prestageQuarantineHours: 1.5 }, 'prestage_quarantine_hours_invalid'],
        [{ prestageEnabled: true, prestageQuarantineHours: '12' }, 'prestage_quarantine_hours_invalid'],
        [{ prestageEnabled: true, prestageQuarantineHours: null }, 'prestage_quarantine_hours_invalid'],
    ];
    for (const [body, code] of cases) {
        const response = await put(body);
        assert.deepEqual([response.status, response.body.code], [400, code], JSON.stringify(body));
    }
    // Primitive bodies never reach the handler (express.json strict); the validator refuses them too.
    for (const body of [null, 'on', 1, true]) assert.equal(validatePrestageSettingsInput(body).ok, false);
    assert.equal(appConfigDb.get(PRESTAGE_SETTINGS_KEY), null);
    assert.equal(audits.length, 0);
    assert.equal(wakes, 0, 'an invalid PUT wakes nothing');
});

test('GET: the env kill switch locks prestaging off; env policy / hours are reported as overrides', async () => {
    reset();
    await put({ prestageEnabled: true, prestageQuarantineHours: 10 });
    env.NASSAJ_UPDATE_PRESTAGE = '0';
    let body = (await get()).body;
    assert.equal(body.lockedByEnv, true);
    assert.equal(body.effective.prestageEnabled, false);
    assert.equal(body.effective.policy, 'off');
    assert.deepEqual(body.settings, { prestageEnabled: true, prestageQuarantineHours: 10 }, 'the stored value is kept');

    delete env.NASSAJ_UPDATE_PRESTAGE;
    Object.assign(env, { NASSAJ_UPDATE_PRESTAGE_POLICY: 'off', NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: '3' });
    body = (await get()).body;
    assert.equal(body.lockedByEnv, false);
    assert.deepEqual(body.overriddenByEnv, { prestageEnabled: true, prestageQuarantineHours: true });
    assert.deepEqual(body.effective, { prestageEnabled: false, policy: 'off', prestageQuarantineHours: 3 });
});

test('a corrupt stored value reads as the defaults, field by field', async () => {
    reset();
    appConfigDb.set(PRESTAGE_SETTINGS_KEY, '{not json');
    assert.deepEqual((await get()).body.settings, { prestageEnabled: true, prestageQuarantineHours: 0 });
    appConfigDb.set(PRESTAGE_SETTINGS_KEY, JSON.stringify({ prestageEnabled: false, prestageQuarantineHours: 999 }));
    assert.deepEqual((await get()).body.settings, { prestageEnabled: false, prestageQuarantineHours: 0 });
});

test('PUT is rate limited (10 per minute by default)', async () => {
    const limited = express();
    limited.use(express.json());
    limited.use((req, _res, next) => { (req as any).user = OWNER; next(); });
    limited.use(createPrestageSettingsRouter({ env: {}, logger: { error() {}, warn() {} }, rateLimit: { readMax: 5, writeMax: 2 } }));
    const limitedServer = limited.listen(0);
    await new Promise<void>((resolve) => limitedServer.once('listening', () => resolve()));
    const target = `http://127.0.0.1:${(limitedServer.address() as { port: number }).port}/settings`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
        const response = await fetch(target, { method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prestageEnabled: true, prestageQuarantineHours: 0 }) });
        statuses.push(response.status);
    }
    limitedServer.close();
    assert.deepEqual(statuses, [200, 200, 429]);
});

test('qa 1: a store read failure is an error (500), never the enabled default', async () => {
    const { describePrestageSettings } = await import('../../services/update-prestage-settings.js');
    const broken = { getStrict() { throw new Error('db down'); }, set() {} };
    assert.throws(() => readStoredPrestageSettings({ store: broken }));
    assert.throws(() => describePrestageSettings({ store: broken, env: {} }));
    const failing = express();
    failing.use(express.json());
    failing.use((req, _res, next) => { (req as any).user = OWNER; next(); });
    failing.use(createPrestageSettingsRouter({ store: broken, env: {}, logger: { error() {}, warn() {} } }));
    const failingServer = failing.listen(0);
    await new Promise<void>((resolve) => failingServer.once('listening', () => resolve()));
    const response = await fetch(`http://127.0.0.1:${(failingServer.address() as { port: number }).port}/settings`);
    failingServer.close();
    assert.deepEqual([response.status, (await response.json()).code], [500, 'prestage_settings_unavailable']);
});

test('GET reports an invalid env policy (policyInvalid)', async () => {
    reset();
    env.NASSAJ_UPDATE_PRESTAGE_POLICY = 'always';
    const { body } = await get();
    assert.equal(body.policyInvalid, true);
    assert.equal(body.overriddenByEnv.prestageEnabled, false);
});
