/**
 * Cost routes (mounted at /api/providers/costs by provider.routes.ts).
 *
 *   GET /costs/session/:sessionId       → what one conversation was worth
 *   GET /costs/subscriptions            → per-provider total for the current cycle
 *   PUT /costs/subscriptions/:provider  → renewal day / plan label / visibility
 *
 * Read routes are gated by the SAME session/visibility predicate the rest of the
 * app uses (assertSessionAccessible): a conversation's cost is a property OF the
 * conversation, so anyone who may not read the conversation may not price it
 * either — and a refusal answers 404, never 403, so the cost endpoint cannot be
 * turned into a sessionId oracle.
 *
 * The handlers deliberately forward the service answer VERBATIM. Every honesty
 * flag in the contract (`available`, `metered`, `complete`, `unpricedModels`,
 * `costUsd: null`) is decided by the pricing engine; a route that "helpfully"
 * defaulted a missing number to 0 would turn an unknown into a claim.
 *
 * Envelope: these three endpoints answer FLAT (`{ success, cost }`,
 * `{ success, subscriptions }`, `{ success, subscription }`) rather than the
 * usual `{ success, data }` wrapper — that is the fixed contract shared with the
 * frontend for this surface, and the client envelope reader tolerates a bare
 * body. The rest of the route conventions (Router, asyncHandler, AppError) are
 * unchanged.
 */

import express, { type Request, type Response } from 'express';

import { PRICES_AS_OF } from '@/modules/providers/services/cost/model-pricing.js';
import { sessionCostService } from '@/modules/providers/services/cost/session-cost.service.js';
import { subscriptionConfigService } from '@/modules/providers/services/cost/subscription-config.service.js';
import type { SubscriptionPatch } from '@/modules/providers/services/cost/subscription-config.service.js';
import { assertSessionAccessible } from '@/modules/providers/services/sessions.service.js';
import type { ProviderSubscriptionCost, SessionCostSummary } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

// Same alphabet the session routes accept (uuid v4/v7, opencode `ses_…` base62).
// Reads the authenticated caller's role. Set by authenticateToken alongside
// req.user.id. Absent → treated as no elevated role. Same in-handler idiom as
// provider.routes.ts (assertCredentialWriteAllowed): a module route must not
// import the middleware element directly.
const readAuthenticatedUserRole = (req: Request): string | null =>
  (req as Request & { user?: { role?: string } }).user?.role ?? null;

/**
 * Gate for subscription-config writes. The stored config is INSTALL-WIDE (one
 * app_config key), not per user: an anchor day or a `hidden` flag written here
 * changes what EVERY member sees. Authentication alone would therefore let any
 * member silently reshape the whole team's billing view — and `hidden:true` has
 * no un-hiding surface in the UI, so it is a one-way door. Subscriptions belong
 * to whoever pays for them.
 */
const assertSubscriptionWriteAllowed = (req: Request): void => {
  readAuthenticatedUserId(req);
  const role = readAuthenticatedUserRole(req);
  if (role !== 'owner' && role !== 'admin') {
    throw new AppError('Changing subscription settings requires an admin or owner.', {
      code: 'SUBSCRIPTION_WRITE_FORBIDDEN',
      statusCode: 403,
    });
  }
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function parseSessionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }
  return raw;
}

/**
 * Provider segment of the subscription path. Syntax only — whether the name is a
 * provider that HAS a subscription is the config service's judgement, so the two
 * layers cannot drift apart as providers are added.
 */
function parseProviderName(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!PROVIDER_PATTERN.test(raw)) {
    throw new AppError('Invalid provider.', {
      code: 'INVALID_PROVIDER',
      statusCode: 400,
    });
  }
  return raw;
}

type AuthenticatedUser = { id?: number | string };

/**
 * Numeric id of the authenticated caller, read from req.user only (populated by
 * authenticateToken at the mount point) — never from request input. Fail-closed:
 * an unresolved identity is refused before any cost is computed.
 */
function readAuthenticatedUserId(req: Request): number {
  const rawId = (req as Request & { user?: AuthenticatedUser }).user?.id;
  const userId =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && rawId.trim() !== ''
        ? Number.parseInt(rawId, 10)
        : NaN;

  if (!Number.isInteger(userId)) {
    throw new AppError('Authentication required.', {
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

/** The only body fields a subscription may be patched through. */
const SUBSCRIPTION_PATCH_FIELDS = ['anchorDay', 'plan', 'hidden'] as const;

/**
 * Shapes the patch body: rejects a non-object, keeps ONLY the three known
 * fields (so no stray key reaches the store), and refuses a patch that changes
 * nothing. The VALUES are not judged here on purpose — `subscriptionConfigService
 * .update` already rejects an out-of-range anchorDay or an oversized plan label
 * with its own 400 contract, and a second copy of those rules in the route would
 * be free to drift away from the one that actually guards the write.
 */
function parseSubscriptionPatch(body: unknown): SubscriptionPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const payload = body as Record<string, unknown>;
  const patch: SubscriptionPatch = {};

  for (const field of SUBSCRIPTION_PATCH_FIELDS) {
    if (payload[field] !== undefined) {
      patch[field] = payload[field];
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new AppError('Request body must change at least one field.', {
      code: 'EMPTY_SUBSCRIPTION_PATCH',
      statusCode: 400,
    });
  }

  return patch;
}

// The gate runs BEFORE the service call, so a caller who may not see the session
// never causes its transcript to be opened and parsed.
//
// The two `SessionCostSummary` / `ProviderSubscriptionCost` annotations below are
// not decoration: they are the PUBLISHED wire contract, kept in @/shared/types
// where the frontend contract lives, and binding the engine's own view type to
// them here makes the compiler — not a reviewer — the thing that notices if the
// pricing engine ever stops answering the shape the UI was built against.
router.get(
  '/session/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const userId = readAuthenticatedUserId(req);

    assertSessionAccessible(sessionId, userId, 'read');

    const cost: SessionCostSummary = await sessionCostService.getSessionCost(sessionId, userId);
    res.json({ success: true, cost });
  }),
);

// Cycle totals for the caller's own conversations. `pricesAsOf` is lifted to the
// envelope because it dates the whole table, not one row.
router.get(
  '/subscriptions',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    const subscriptions: ProviderSubscriptionCost[] = await sessionCostService.getSubscriptionCosts(userId);
    res.json({ success: true, pricesAsOf: PRICES_AS_OF, subscriptions });
  }),
);

router.put(
  '/subscriptions/:provider',
  asyncHandler(async (req: Request, res: Response) => {
    // A write is for an identified caller only. The router already sits behind
    // authenticateToken; this re-asserts it instead of trusting the mount point.
    assertSubscriptionWriteAllowed(req);

    const userId = readAuthenticatedUserId(req);
    const provider = parseProviderName(req.params.provider);
    const patch = parseSubscriptionPatch(req.body);

    subscriptionConfigService.update(provider, patch);

    // Answer with the RECOMPUTED cost row, not the stored config entry. Moving
    // the anchor day moves the cycle window, so the amount and the dates the
    // client is showing are stale the moment the write lands. Returning the
    // config shape here would hand the client {provider, anchorDay, plan,
    // hidden} where it expects a cost row, blanking the very figure the user
    // was looking at. Recomputing is cheap: the per-transcript cache is warm
    // from the GET that rendered the row being edited.
    const subscriptions: ProviderSubscriptionCost[] = await sessionCostService.getSubscriptionCosts(userId);
    const subscription = subscriptions.find((entry) => entry.provider === provider);

    if (!subscription) {
      // Only reachable when the patch hid the provider (or auth vanished
      // mid-request): the row is gone from the panel, and saying so beats
      // returning a half-shape the client would render as an empty row.
      throw new AppError('Subscription is no longer listed.', {
        code: 'SUBSCRIPTION_NOT_LISTED',
        statusCode: 409,
      });
    }

    res.json({ success: true, pricesAsOf: PRICES_AS_OF, subscription });
  }),
);

export default router;
