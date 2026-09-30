/** Production wiring for POST /api/connectors/owner-session/step-up (T-1939 6B). */

import type express from 'express';

import { auditLogDb } from '@/modules/database/index.js';

// server/middleware and server/services are cross-cutting infrastructure outside
// the configured boundaries elements (same pattern as connectors.routes.ts).
// eslint-disable-next-line boundaries/no-unknown
import { createKeyedLimiter } from '../../middleware/keyed-limiter.js';
// eslint-disable-next-line boundaries/no-unknown
import { createRateLimiter } from '../../middleware/rate-limit.js';
import {
  BROWSER_TRANSACTION_COOKIE,
  BROWSER_TRANSACTION_COOKIE_OPTIONS,
// eslint-disable-next-line boundaries/no-unknown
} from '../../services/oidc-browser-transaction.js';
// eslint-disable-next-line boundaries/no-unknown
import { StepUpError, verifyStepUpEvidence } from '../../services/step-up.service.js';

import {
  connectorOwnerSessionAvailable,
  connectorOwnerSessionOrigin,
  recordConnectorOwnerAuthentication,
} from './connector-owner-auth-session.js';
import {
  createConnectorOwnerSessionRoutes,
  type ConnectorOwnerSessionDependencies,
} from './connector-owner-session.routes.js';

// Per-caller route cap; the verifier's stepup:<id> quota still bounds the
// expensive verifications themselves.
const routeLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  key: (req: express.Request & { user?: { id?: number } }) => `connector-step-up-route:${req.user?.id ?? 'none'}`,
  message: 'Too many verification attempts, please try again later',
  code: 'step_up_rate_limited',
});

// One step_up_rate_limited audit row per user per verifier window (15 min),
// the same de-duplication routes/webauthn.js applies to enrollment refusals.
const rateLimitedAuditGate = createKeyedLimiter({ windowMs: 15 * 60_000, max: 1 });

/** Production dependencies; exported so tests exercise this exact wiring. */
export const connectorOwnerSessionProductionDependencies: ConnectorOwnerSessionDependencies = Object.freeze({
  resolveOrigin: connectorOwnerSessionOrigin,
  verifyEvidence: verifyStepUpEvidence as ConnectorOwnerSessionDependencies['verifyEvidence'],
  record: recordConnectorOwnerAuthentication,
  audit: (event, data) => { auditLogDb.record(event, data); },
  asStepUpRefusal: error => (error instanceof StepUpError ? error : null),
  clearOidcTransaction: res => { res.clearCookie(BROWSER_TRANSACTION_COOKIE, BROWSER_TRANSACTION_COOKIE_OPTIONS); },
  routeLimiter,
  isAvailable: connectorOwnerSessionAvailable,
  auditRateLimited: userId => rateLimitedAuditGate.hit(`connector-step-up-rate-limited-audit:${userId}`).allowed,
});

export default createConnectorOwnerSessionRoutes(connectorOwnerSessionProductionDependencies);
