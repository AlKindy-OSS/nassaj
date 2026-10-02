/**
 * Owner SSO settings API (ADR-194 D8, T-1962 S4), mounted at
 * /api/settings/sso behind authenticateToken (server/index.js mounts the
 * settings router with it). Every route: requireRole('owner'), the cookie
 * mutation guard, a per-owner rate limit and Cache-Control: no-store. Writes
 * record a strict audit in the same transaction (in the services).
 *
 * Step-up (`sso_config`, local password or passkey only) gates apply, enable,
 * the installation origin, draft writes that turn private-network reach on or
 * change the issuer port (I5), and disable while SSO is active (I6). The
 * evidence travels in the JSON body as `stepUp`.
 *
 *   curl -H "Authorization: Bearer <owner-jwt>" http://localhost:3004/api/settings/sso
 *   curl -X POST -H "Authorization: Bearer <owner-jwt>" -H 'Content-Type: application/json' \
 *        -d '{"draftVersion":4,"configHash":"<64 hex>","stepUp":{"method":"password","password":"…"}}' \
 *        http://localhost:3004/api/settings/sso/apply
 */
import express from 'express';

import { JWT_SECRET, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { enforceCookieMutationGuard } from '../modules/account-wallet/request-csrf.js';
import { getConnection } from '../modules/database/connection.js';
import { readSlotOn } from '../modules/database/repositories/sso-oidc-config.js';
import {
  confirmedInstallationOrigin,
  confirmInstallationOrigin,
  InstallationOriginError,
} from '../services/installation-origin.service.js';
import { applySsoDraft, enableSso } from '../services/sso-apply.service.js';
import { ssoState } from '../services/sso-config.service.js';
import { draftNeedsStepUp, parseSsoDraftInput } from '../services/sso-draft-input.js';
import { saveSsoDraft, testSsoDraftDiscovery } from '../services/sso-draft.service.js';
import { importLegacyEnvToDraft, SsoImportError } from '../services/sso-import-env.service.js';
import { disableSso, SsoDisableStepUpRequiredError } from '../services/sso-lifecycle.service.js';
import { SsoSettingsError } from '../services/sso-settings-error.js';
import { ssoConfigView, ssoSettingsStatus } from '../services/sso-settings-status.js';
import { readTestResult } from '../services/sso-test-signin.service.js';
import { StepUpError, verifyStepUpEvidence } from '../services/step-up.service.js';

import { beginTestAuthorization } from './oidc.js';

const router = express.Router();
const CONFIG_HASH = /^[a-f0-9]{64}$/;
const MAX_CONFIRMATION_LENGTH = 64;

const ownerLimiter = (name, max) => createRateLimiter({
  windowMs: 60_000, max, key: (req) => `sso-settings-${name}:${req.user?.id}`,
  message: 'Too many requests, please try again later', code: 'rate_limited',
});
const readLimiter = ownerLimiter('read', 60);
const writeLimiter = ownerLimiter('write', 10);
const testLimiter = ownerLimiter('test', 10);

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function cookieMutationGuard(req, res, next) {
  if (enforceCookieMutationGuard(req, res, JWT_SECRET)) next();
}

/** Identity fence: refuses a write whose authenticated identity changed mid-request. */
function currentIdentity(req, res, next) {
  if (req.assertCurrentIdentity?.() === false) {
    return res.status(409).json({ error: 'Identity changed during request', code: 'identity_changed' });
  }
  return next();
}

router.use(requireRole('owner'), noStore, cookieMutationGuard);

function log(code, fields = {}) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso_settings', code, ...fields })}\n`);
}

const STATUS_BY_IMPORT_CODE = Object.freeze({ sso_active_config_exists: 409, legacy_env_incomplete: 400 });
const STATUS_BY_ORIGIN_CODE = Object.freeze({ installation_origin_managed_by_connectors: 409 });

/** Maps every service refusal to a coded, generic answer; anything else is a logged 500. */
function sendError(res, error, scope) {
  if (error instanceof StepUpError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof SsoDisableStepUpRequiredError) {
    return res.status(403).json({ error: 'Confirm your identity to continue', code: 'step_up_required' });
  }
  if (error instanceof SsoSettingsError) {
    return res.status(error.status).json({ error: 'SSO settings request refused', code: error.code, ...error.details });
  }
  if (error instanceof SsoImportError) {
    return res.status(STATUS_BY_IMPORT_CODE[error.code] ?? 400).json({ error: 'Import refused', code: error.code });
  }
  if (error instanceof InstallationOriginError) {
    return res.status(STATUS_BY_ORIGIN_CODE[error.code] ?? 400).json({ error: 'Origin refused', code: error.code });
  }
  log('sso_settings_failed', { route: scope });
  return res.status(500).json({ error: 'SSO settings request failed', code: 'internal_error' });
}

/** Wraps an async handler so every refusal goes through sendError. */
const handle = (scope, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error, scope);
  }
};

const verifySsoStepUp = (req) => verifyStepUpEvidence(req, req.user, 'sso_config', req.body?.stepUp);

function readDraftRow() {
  return readSlotOn(getConnection(), 'draft');
}

router.get('/', readLimiter, handle('status', (req, res) => {
  res.json(ssoSettingsStatus(req.user.id));
}));

router.put('/draft', writeLimiter, currentIdentity, handle('draft', async (req, res) => {
  const input = parseSsoDraftInput(req.body);
  const needsStepUp = draftNeedsStepUp(readDraftRow(), input);
  if (needsStepUp || req.body?.stepUp !== undefined) await verifySsoStepUp(req);
  const saved = saveSsoDraft({
    actorUserId: req.user.id, input, stepUpVerified: needsStepUp || req.body?.stepUp !== undefined,
  });
  res.json({ draft: ssoConfigView(saved) });
}));

router.post('/draft/test-discovery', testLimiter, currentIdentity, handle('discovery', async (req, res) => {
  const { draft, ...result } = await testSsoDraftDiscovery({ actorUserId: req.user.id });
  res.json({ ...result, draft: ssoConfigView(draft) });
}));

const STATUS_BY_TEST_REFUSAL = Object.freeze({ temporarily_unavailable: 503 });

router.post('/draft/test-login/start', testLimiter, currentIdentity, handle('test_start', async (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  const started = await beginTestAuthorization(res, req.user.id);
  if (started.refusal) {
    return res.status(STATUS_BY_TEST_REFUSAL[started.refusal] ?? 409)
      .json({ error: 'Test sign-in cannot start', code: started.refusal });
  }
  return res.json({ authorizationUrl: started.authorizationUrl });
}));

router.get('/draft/test-login/result/:id', testLimiter, handle('test_result', (req, res) => {
  const result = readTestResult(req.params.id, req.user.id);
  if (result === null) return res.status(404).json({ error: 'Result not found', code: 'sso_test_result_not_found' });
  return res.json({ result });
}));

/** POST /apply body: the draft binding, optional enable and the typed opt-out. */
function parseApplyBody(body) {
  const { draftVersion, configHash, enable, keepOrphanedSessions, confirmation } = body ?? {};
  const valid = Number.isSafeInteger(draftVersion) && draftVersion >= 0
    && typeof configHash === 'string' && CONFIG_HASH.test(configHash)
    && (enable === undefined || typeof enable === 'boolean')
    && (keepOrphanedSessions === undefined || typeof keepOrphanedSessions === 'boolean')
    && (confirmation === undefined || (typeof confirmation === 'string' && confirmation.length <= MAX_CONFIRMATION_LENGTH));
  if (!valid) throw new SsoSettingsError('sso_apply_invalid', 400);
  return { draftVersion, configHash, enable, keepOrphanedSessions, confirmation };
}

router.post('/apply', writeLimiter, currentIdentity, handle('apply', async (req, res) => {
  const request = parseApplyBody(req.body);
  await verifySsoStepUp(req);
  const applied = applySsoDraft({ actorUserId: req.user.id, ...request });
  res.json({ applied, ssoState: ssoState() });
}));

router.post('/enable', writeLimiter, currentIdentity, handle('enable', async (req, res) => {
  await verifySsoStepUp(req);
  const result = enableSso({ actorUserId: req.user.id });
  res.json({ ...result, ssoState: ssoState() });
}));

router.post('/disable', writeLimiter, currentIdentity, handle('disable', async (req, res) => {
  const keep = req.body?.keepLinkedSessions;
  if (keep !== undefined && typeof keep !== 'boolean') throw new SsoSettingsError('sso_disable_invalid', 400);
  const stepUpVerified = ssoState() === 'active' || keep === true || req.body?.stepUp !== undefined;
  if (stepUpVerified) await verifySsoStepUp(req);
  const result = disableSso({
    actorUserId: req.user.id, keepLinkedSessions: keep === true, requireStepUpWhenActive: true, stepUpVerified,
  });
  res.json({ ...result, ssoState: ssoState() });
}));

router.post('/import-env', writeLimiter, currentIdentity, handle('import', (req, res) => {
  const { warnings } = importLegacyEnvToDraft({
    actorUserId: req.user.id, installationOrigin: confirmedInstallationOrigin(),
  });
  res.json({ draft: ssoConfigView(readDraftRow()), warnings });
}));

router.put('/installation-origin', writeLimiter, currentIdentity, handle('origin', async (req, res) => {
  const origin = req.body?.origin;
  if (typeof origin !== 'string' || origin.length > 2048) {
    throw new SsoSettingsError('installation_origin_invalid', 400);
  }
  await verifySsoStepUp(req);
  res.json({ origin: confirmInstallationOrigin({ origin, actorUserId: req.user.id }) });
}));

export default router;
