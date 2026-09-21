/**
 * Connector routes (mounted at /api/connectors by index.js) — T-1228, ADR-098.
 *
 *   GET    /api/connectors            → list platforms + whether a key is stored
 *   GET    /api/connectors/targets    → which engines can host a connector
 *   POST   /api/connectors            → register a platform (owner/admin)
 *   PUT    /api/connectors/:id/key    → paste or ROTATE the key (owner/admin)
 *   PATCH  /api/connectors/:id        → enable/disable (owner/admin)
 *   DELETE /api/connectors/:id        → remove everywhere, then forget the key
 *
 * ── AUTHORIZATION (ADR-098 rev2) ─────────────────────────────────────────────
 * The gate follows OWNERSHIP, not a permission tier:
 *   • A PERSONAL connector is the caller's own — any member may create, key,
 *     disable, and delete their own, and may touch nobody else's.
 *   • A SHARED connector lands in every member's tree, so creating or changing
 *     one is owner/admin.
 * Reads are scoped: a member sees the shared connectors plus their own.
 *
 * There is still NO per-connector role gate on USE. Personal-vs-shared decides
 * whose credential is spent, not who is permitted — reopening the role gate is
 * a decision (ADR-098 §1), not an oversight to fix.
 *
 * ── WHAT A CLIENT MAY SAY ────────────────────────────────────────────────────
 * A create body carries a PLATFORM and a credential, never the packaging that
 * reaches it: the command, its arguments, the transport, the endpoint and the
 * variable the key travels in are all read from the catalog, keyed by `service`,
 * and a platform the catalog does not list is refused outright. See
 * `CREATE_BODY_FIELDS` for the whole allow-list and why it is a refusal rather
 * than a quiet drop (B-542).
 *
 * ── WHAT NEVER CROSSES THIS BOUNDARY ─────────────────────────────────────────
 * The key. It arrives in a request body and is never echoed, never logged, and
 * never present in any response — responses carry `configured: true|false`.
 * `extraEnv` is the deliberate exception: those are NON-secret startup values
 * (Slack's workspace id) that the member may need to read back and correct.
 * `distribution` results name providers and members, never payloads.
 */

import express from 'express';

import {
  beginLink,
  completeLink,
  remoteUrlFromArgs,
  resolveConfiguredClient,
} from '@/modules/connectors/connector-oauth-flow.js';
import { isConnectorPlacementWriterEnabled } from '@/modules/connectors/connector-placement-writer.js';
import { connectorsService } from '@/modules/connectors/connectors.service.js';
import { auditLogDb, connectorsDb, type ConnectorRow } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

import {
  BUILT_IN_SERVERS_TOKEN,
  catalogEntryFor,
  CONNECTOR_CATALOG,
  type CatalogEntry,
} from '../../../shared/connector-catalog.js';
import {
  providerAuthReadiness,
  providerAuthSpecFor,
  type AuthMethod,
  type ProviderAuthReadiness,
} from '../../../shared/connector-auth-registry.js';
// server/middleware is cross-cutting infrastructure and is not represented in
// the configured boundaries elements; this is the same shared limiter used by
// other authenticated server routes.
// eslint-disable-next-line boundaries/no-unknown
import { createRateLimiter } from '../../middleware/rate-limit.js';

import connectorAuthProfileRoutes from './connector-auth-profile.routes.js';
import {
  connectorAuthServiceCapability,
  type ConnectorAuthServiceCapability,
} from './connector-auth-public-capabilities.js';
import connectorAuthReadinessRoutes from './connector-auth-readiness.routes.js';
import { connectorPolicyV2OwnerSetupRoutes,
  connectorPolicyV2ProvisioningRoutes,
  connectorPolicyV2ClaimsLegacyPaths,
  connectorPolicyV2SubstrateRoutes,
  resolveConnectorRuntimeInstallationOrigin } from './connector-substrate-only.production.js';
import connectorOAuthV2Routes, { createConnectorOAuthV2Callback } from './connector-oauth-v2.routes.js';
import connectorUserGrantRoutes from './connector-user-grant.routes.js';

const router = express.Router();

const reconcileRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Too many connector reconciliation requests. Try again shortly.',
  code: 'CONNECTOR_RECONCILE_RATE_LIMITED',
  key: (req: express.Request) => `${callerId(req) ?? 'unknown'}:${req.params.id}`,
});

const oauthFirstStartRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Too many account linking requests. Try again shortly.',
  code: 'CONNECTOR_OAUTH_START_RATE_LIMITED',
  key: (req: express.Request) => {
    const service = typeof req.body?.service === 'string' ? req.body.service.trim().toLowerCase() : 'unknown';
    return `${callerId(req) ?? 'unknown'}:${service}`;
  },
});

const oauthExistingStartRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Too many account linking requests. Try again shortly.',
  code: 'CONNECTOR_OAUTH_START_RATE_LIMITED',
  key: (req: express.Request) => `${callerId(req) ?? 'unknown'}:${req.params.id}`,
});

const passesRateLimit = (
  limiter: express.RequestHandler,
  req: express.Request,
  res: express.Response,
): boolean => {
  let allowed = false;
  limiter(req, res, () => { allowed = true; });
  return allowed;
};

/** Trusted catalog decision used to migrate rows that still store mcp-remote args. */
export const catalogUsesManagedOAuthBridge = (service: string): boolean =>
  catalogEntryFor(service)?.args?.some((arg) => arg.includes(BUILT_IN_SERVERS_TOKEN)) ?? false;

type AuthedRequest = express.Request & {
  user?: { id?: number; userId?: number; role?: string };
};

const callerId = (req: express.Request): number | null => {
  const user = (req as AuthedRequest).user;
  const id = user?.id ?? user?.userId;
  return typeof id === 'number' ? id : null;
};

const oauthCallbackPreflight = (res: express.Response): string | null => {
  const resolved = resolveConnectorRuntimeInstallationOrigin();
  if (resolved) return resolved.callbackUrl;
  res.status(503).json({ error: 'Connector authentication is unavailable.',
    code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE' });
  return null;
};

/** Legacy writers never fall back to feature flags or environment OAuth configuration. */
const refuseLegacyConnectorWriter = (res: express.Response): boolean => {
  if (!connectorPolicyV2ClaimsLegacyPaths()) return false;
  const installed = resolveConnectorRuntimeInstallationOrigin();
  res.status(installed ? 409 : 503).json({
    error: installed ? 'Use the Policy V2 connector account flow.' : 'Connector authentication is unavailable.',
    code: installed ? 'CONNECTOR_LEGACY_PATH_DISABLED' : 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
  });
  return true;
};

/**
 * Owner/admin gate, read in-handler from `req.user` (populated by
 * authenticateToken at the mount point). A module route must not import
 * server/middleware/** — same idiom as provider.routes.ts and
 * project-stats.routes.ts.
 *
 * Fail-closed: an absent or unrecognised role is refused. Returns true when the
 * request has already been answered, so callers `return` immediately.
 */
const isManager = (req: express.Request): boolean => {
  const role = (req as AuthedRequest).user?.role;
  return role === 'owner' || role === 'admin';
};

/**
 * Refuses unless the caller may act on THIS connector: their own personal one,
 * or any connector at all when they are owner/admin.
 *
 * Answers 404 rather than 403 for someone else's personal connector — the same
 * answer an id that does not exist gets — so this endpoint cannot be used to
 * enumerate which colleagues connected which platforms.
 *
 * Returns true when the request has already been answered.
 */
const refusedOnConnector = (
  req: express.Request,
  res: express.Response,
  connectorId: string,
): boolean => {
  const userId = callerId(req);
  if (userId === null) {
    res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    return true;
  }
  let connector;
  try {
    connector = connectorsService.get(connectorId);
  } catch (error) {
    fail(res, error);
    return true;
  }
  if (connector.credentialMode === 'per_member') {
    if (connector.ownerUserId !== userId) {
      res.status(404).json({ error: 'Connector not found.', code: 'CONNECTOR_NOT_FOUND' });
      return true;
    }
    return false;
  }
  if (!isManager(req)) {
    res.status(403).json({
      error: 'Only an owner or admin can change a shared connector.',
      code: 'INSUFFICIENT_ROLE',
    });
    return true;
  }
  return false;
};

// ── THE CREATE BODY ──────────────────────────────────────────────────────────

/**
 * The complete set of fields a client may send when registering a connector.
 *
 * Everything NOT here — `id`, `command`, `args`, `transport`, `url`,
 * `keyEnvVar`, `keyHeader`, `keyHeaderPrefix`, `authMode`, `displayName`,
 * `allowsSharing` — is PACKAGING, and packaging comes from the catalog. It used
 * to come from the request: this handler spread `{...req.body}` into the
 * service, whose merge let a caller's value beat the catalog's, so a member with
 * an ordinary `user` role could post a command, its arguments and the NAME OF
 * ANY VARIABLE nassaj runs with, and nassaj would launch that command and hand
 * it that variable. Proved live with `/bin/echo` and `JWT_SECRET`, answered 201
 * (B-542).
 *
 * REFUSED, NOT SILENTLY DROPPED. Two reasons. Silence is the shape of the bug
 * being fixed — a field nobody expected travelled the whole way to the row with
 * nothing anywhere to say so. And the tolerant-reader argument for ignoring
 * unknown fields (an older server meeting a newer client) does not apply: this
 * server SERVES the client, from the same build, so the two cannot be different
 * versions. An unrecognised field can only be a stale caller or a probe, and
 * both are better told. It is also the stance PATCH already takes.
 */
const CREATE_BODY_FIELDS: readonly string[] = [
  'service',
  'accountLabel',
  'credentialMode',
  'extraEnv',
  'additionalFields',
  'apiKey',
];

/** What survives validation of a create body. */
type CreateConnectorBody = {
  service: string;
  accountLabel?: string;
  credentialMode?: 'per_member' | 'org_shared';
  extraEnv?: Record<string, string>;
  additionalFields?: Record<string, string>;
  apiKey?: string;
};

/** Environment variable names, as every shell and every MCP server spells them. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longest a platform id or an account label may be — the id column's own limit. */
const LABEL_MAX = 64;

const badRequest = (message: string, code: string): AppError =>
  new AppError(message, { code, statusCode: 400 });

/**
 * Validates the only caller-controlled environment values against the service's
 * trusted catalog entry. A syntactically valid name such as NODE_OPTIONS is
 * still code-execution control when handed to a spawned Node process, so shape
 * validation alone is not a security boundary (B-566).
 */
const readExtraEnv = (service: string, raw: unknown): Record<string, string> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('extraEnv must be an object of string values.', 'CONNECTOR_BAD_EXTRA_ENV');
  }
  const allowed = new Set(
    (catalogEntryFor(service)?.extraEnv ?? []).map((item) => item.envVar),
  );
  const extras: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_VAR_NAME.test(name) || typeof value !== 'string' || !allowed.has(name)) {
      throw badRequest(
        'extraEnv may contain only the configuration fields declared for this platform.',
        'CONNECTOR_BAD_EXTRA_ENV',
      );
    }
    extras[name] = value;
  }
  return extras;
};

const readAdditionalFields = (service: string, raw: unknown): Record<string, string> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('additionalFields must be an object of string values.', 'CONNECTOR_BAD_ADDITIONAL_FIELDS');
  }
  const definitions = new Map(
    (catalogEntryFor(service)?.extraEnv ?? []).map((field) => [field.id, field]),
  );
  const extras: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const definition = definitions.get(id);
    if (!definition || typeof value !== 'string') {
      throw badRequest(
        'additionalFields may contain only the public fields declared for this platform.',
        'CONNECTOR_BAD_ADDITIONAL_FIELDS',
      );
    }
    extras[definition.envVar] = value;
  }
  return extras;
};

/**
 * Validates a create body against the allow-list and the shapes each field must
 * have. Throws an AppError the caller can hand straight to {@link fail}.
 */
const readCreateBody = (raw: unknown): CreateConnectorBody => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('The request body must be a JSON object.', 'CONNECTOR_BAD_BODY');
  }
  const body = raw as Record<string, unknown>;

  const unexpected = Object.keys(body).filter((key) => !CREATE_BODY_FIELDS.includes(key));
  if (unexpected.length > 0) {
    // Echoed back trimmed: the names came from the caller, and a body large
    // enough to be interesting is a body large enough to fill a log line.
    const named = unexpected.slice(0, 5).map((key) => key.slice(0, 40)).join(', ');
    throw badRequest(
      `Unexpected field(s) in the request: ${named}. A connector's packaging comes from the catalog, not from the caller.`,
      'CONNECTOR_UNKNOWN_FIELD',
    );
  }

  const { service, accountLabel, credentialMode, extraEnv, additionalFields, apiKey } = body;

  if (typeof service !== 'string' || service.trim() === '' || service.length > LABEL_MAX) {
    throw badRequest('service must be a non-empty string naming a platform.', 'CONNECTOR_BAD_SERVICE');
  }
  if (accountLabel !== undefined && (typeof accountLabel !== 'string' || accountLabel.length > LABEL_MAX)) {
    throw badRequest(`accountLabel must be a string of at most ${LABEL_MAX} characters.`, 'CONNECTOR_BAD_LABEL');
  }
  if (
    credentialMode !== undefined &&
    credentialMode !== 'per_member' &&
    credentialMode !== 'org_shared'
  ) {
    throw badRequest('credentialMode must be per_member or org_shared.', 'CONNECTOR_BAD_MODE');
  }
  if (apiKey !== undefined && typeof apiKey !== 'string') {
    throw badRequest('apiKey must be a string.', 'CONNECTOR_BAD_KEY');
  }

  let extras: Record<string, string> | undefined;
  if (extraEnv !== undefined && additionalFields !== undefined) {
    throw badRequest(
      'Send additionalFields, not additionalFields together with legacy extraEnv.',
      'CONNECTOR_BAD_ADDITIONAL_FIELDS',
    );
  }
  if (additionalFields !== undefined) {
    extras = readAdditionalFields(service.trim(), additionalFields);
  } else if (extraEnv !== undefined) {
    extras = readExtraEnv(service.trim(), extraEnv);
  }

  return {
    service: service.trim(),
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(credentialMode === undefined ? {} : { credentialMode }),
    ...(extras === undefined ? {} : { extraEnv: extras }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
};

type PublicCatalogEntry = Pick<CatalogEntry,
  | 'service' | 'displayName' | 'summary' | 'logo' | 'logoExt' | 'official'
  | 'vendorUrl' | 'keyHelpUrl' | 'keyLabel' | 'allowsSharing'
> & {
  authMode: 'key' | 'oauth';
  oauthAvailability?: 'ready' | 'server_not_configured';
  additionalFields?: ReadonlyArray<{ id: string; label: string; hint?: string }>;
  /** ADR-132 M1.0 additive contract. Trusted endpoints never cross this DTO. */
  authMetadata: {
    profileId: string;
    method: AuthMethod;
    readiness: ProviderAuthReadiness;
    accountBundle?: { id: string; label: string };
    canSubmitCredential: ConnectorAuthServiceCapability['canSubmitCredential'];
    canStartOAuth: ConnectorAuthServiceCapability['canStartOAuth'];
    canStoreUnverified: ConnectorAuthServiceCapability['canStoreUnverified'];
    credentialInputSchema: ConnectorAuthServiceCapability['credentialInputSchema'];
    submitSemantics: ConnectorAuthServiceCapability['submitSemantics'];
  };
};

const oauthAvailability = (entry: CatalogEntry): 'ready' | 'server_not_configured' =>
  entry.oauthClient && resolveConfiguredClient(entry.oauthClient) === null
    ? 'server_not_configured'
    : 'ready';

/** A DTO constructor, not a spread: packaging and operator setup can never leak. */
export const publicCatalogEntry = (
  entry: CatalogEntry,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PublicCatalogEntry => {
  const authMode = entry.authMode ?? 'key';
  const fields = entry.extraEnv ?? [];
  const authSpec = providerAuthSpecFor(entry.service);
  if (authSpec === null) {
    throw new Error(`Connector catalog service has no trusted auth profile: ${entry.service}`);
  }
  const capability = connectorAuthServiceCapability(entry.service, env);
  if (capability === null) {
    throw new Error(`Connector catalog service has no trusted capability: ${entry.service}`);
  }
  return {
    service: entry.service,
    displayName: entry.displayName,
    summary: entry.summary,
    ...(entry.logo ? { logo: entry.logo } : {}),
    ...(entry.logoExt ? { logoExt: entry.logoExt } : {}),
    official: entry.official,
    ...(entry.vendorUrl ? { vendorUrl: entry.vendorUrl } : {}),
    ...(entry.keyHelpUrl ? { keyHelpUrl: entry.keyHelpUrl } : {}),
    ...(entry.keyLabel ? { keyLabel: entry.keyLabel } : {}),
    allowsSharing: entry.allowsSharing,
    authMode,
    authMetadata: {
      profileId: authSpec.profileId,
      method: authSpec.method,
      readiness: providerAuthReadiness(authSpec, env),
      canSubmitCredential: capability.canSubmitCredential,
      canStartOAuth: capability.canStartOAuth,
      canStoreUnverified: capability.canStoreUnverified,
      credentialInputSchema: capability.credentialInputSchema,
      submitSemantics: capability.submitSemantics,
      ...(authSpec.accountBundle ? {
        accountBundle: {
          id: authSpec.accountBundle.id,
          label: authSpec.accountBundle.label,
        },
      } : {}),
    },
    ...(authMode === 'oauth' ? { oauthAvailability: oauthAvailability(entry) } : {}),
    ...(fields.length > 0
      ? { additionalFields: fields.map(({ id, label, hint }) => ({ id, label, ...(hint ? { hint } : {}) })) }
      : {}),
  };
};

/** Turns a thrown AppError into its own status; anything else is a 500. */
const fail = (res: express.Response, error: unknown): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode ?? 400).json({ error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  res.status(400).json({ error: message });
};

/** OAuth start errors never relay discovery URLs, provider bodies, or setup. */
const failOAuthStart = (res: express.Response, error: unknown): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode ?? 400).json({
      error: error.code === 'CONNECTOR_OAUTH_APP_MISSING'
        ? 'This platform is not ready for account linking.'
        : 'Could not start account linking.',
      code: error.code,
    });
    return;
  }
  res.status(500).json({
    error: 'Could not start account linking.',
    code: 'CONNECTOR_OAUTH_START_FAILED',
  });
};

router.get('/', (req, res) => {
  try {
    const userId = callerId(req);
    if (userId === null) {
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    res.json({ connectors: connectorsService.listFor(userId) });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * The engine support matrix, served rather than hardcoded in the client so the
 * page cannot drift from the providers actually registered (ADR-098 §4). A
 * member who pastes a key and then opens an engine that cannot host it must see
 * that up front, not as a silent absence of tools.
 */
router.get('/targets', (_req, res) => {
  try {
    res.json({ targets: providerMcpService.listMcpTargets() });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * The ready-made platforms. Served rather than bundled into the client so a new
 * platform is a server-side data edit, and so the client cannot show an entry
 * the server would not accept.
 */
/**
 * Public catalog v2. Operator setup and executable packaging are intentionally
 * absent: the member only needs platform presentation, input ids, and the
 * coarse fact that browser linking is ready or unavailable.
 */
router.get('/catalog', (_req, res) => {
  res.json({
    schemaVersion: 2,
    catalog: CONNECTOR_CATALOG.map(entry => publicCatalogEntry(entry)),
  });
});

router.use('/auth-profiles', connectorAuthProfileRoutes);
router.use('/auth-readiness', connectorAuthReadinessRoutes);
router.use('/v2/installation', connectorPolicyV2SubstrateRoutes);
router.use('/v2/owner/setup', connectorPolicyV2OwnerSetupRoutes);
router.use('/v2/owner/provisioning', connectorPolicyV2ProvisioningRoutes);
router.use('/grants', connectorUserGrantRoutes);
router.use('/oauth-v2', connectorOAuthV2Routes);

router.post('/', async (req, res) => {
  const userId = callerId(req);
  if (userId === null) {
    res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    return;
  }
  try {
    const body = readCreateBody(req.body);
    if (body.apiKey !== undefined || catalogEntryFor(body.service)?.authMode === 'oauth') {
      if (refuseLegacyConnectorWriter(res)) return;
    }
    const wantsShared = body.credentialMode === 'org_shared';
    if (wantsShared) {
      throw new AppError('Creating shared connectors is temporarily unavailable.', {
        code: 'CONNECTOR_ORG_SHARED_CREATION_DISABLED',
        statusCode: 409,
      });
    }

    // A platform absent from the catalog has no packaging, and taking the
    // caller's instead is the door B-542 walked through. Refused BY NAME here
    // rather than left to fail deeper, where the row-level check answers "a
    // stdio connector requires a command" — true, and no help to anyone.
    if (!catalogEntryFor(body.service)) {
      throw new AppError(`"${body.service}" is not a platform nassaj can connect.`, {
        code: 'CONNECTOR_UNKNOWN_SERVICE',
        statusCode: 400,
      });
    }

    const connector = await connectorsService.create({
      service: body.service,
      accountLabel: body.accountLabel,
      extraEnv: body.extraEnv,
      apiKey: body.apiKey,
      // Ownership is server-side: a client cannot claim a personal connector for
      // somebody else by putting their id in the body.
      credentialMode: wantsShared ? 'org_shared' : 'per_member',
      ownerUserId: wantsShared ? null : userId,
      createdBy: userId,
    });
    auditLogDb.record('connector_created', {
      userId: callerId(req),
      metadata: { connectorId: connector.id, service: connector.service },
    });
    res.status(201).json({ connector });
  } catch (error) {
    fail(res, error);
  }
});

const OAUTH_CREATE_FIELDS = new Set(['service', 'accountLabel']);

const readOAuthCreateBody = (raw: unknown): { service: string; accountLabel?: string } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('The request body must be a JSON object.', 'CONNECTOR_BAD_BODY');
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !OAUTH_CREATE_FIELDS.has(key))) {
    throw badRequest('OAuth start accepts only service and accountLabel.', 'CONNECTOR_UNKNOWN_FIELD');
  }
  if (typeof body.service !== 'string' || body.service.trim() === '' || body.service.length > LABEL_MAX) {
    throw badRequest('service must name an OAuth platform.', 'CONNECTOR_BAD_SERVICE');
  }
  if (body.accountLabel !== undefined
    && (typeof body.accountLabel !== 'string' || body.accountLabel.length > LABEL_MAX)) {
    throw badRequest(`accountLabel must be a string of at most ${LABEL_MAX} characters.`, 'CONNECTOR_BAD_LABEL');
  }
  const accountLabel = typeof body.accountLabel === 'string'
    ? body.accountLabel.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    : undefined;
  return { service: body.service.trim().toLowerCase(), ...(accountLabel ? { accountLabel } : {}) };
};

const requireReadyOAuthEntry = (service: string): CatalogEntry => {
  const entry = catalogEntryFor(service);
  if (!entry || (entry.authMode ?? 'key') !== 'oauth') {
    throw badRequest('This platform does not support browser linking.', 'CONNECTOR_NOT_OAUTH');
  }
  if (oauthAvailability(entry) !== 'ready') {
    throw new AppError('This platform is not ready for account linking.', {
      code: 'CONNECTOR_OAUTH_APP_MISSING',
      statusCode: 409,
    });
  }
  return entry;
};

const beginOAuthForConnector = async (
  userId: number,
  connector: Pick<ConnectorRow, 'id' | 'service' | 'args'>,
  redirectUri: string,
): Promise<{ authorizeUrl: string }> => {
  const preset = requireReadyOAuthEntry(connector.service);
  const clientSpec = preset.oauthClient;
  const remoteUrl = remoteUrlFromArgs(preset.args ?? connector.args)
    ?? remoteUrlFromArgs(connector.args)
    ?? clientSpec?.tokenUrl
    ?? null;
  if (!remoteUrl) {
    throw badRequest('This platform cannot be linked right now.', 'CONNECTOR_NO_REMOTE_URL');
  }
  const { authorizeUrl } = await beginLink({
    userId,
    connectorId: connector.id,
    remoteUrl,
    redirectUri,
    configuredClient: clientSpec,
    builtIn: catalogUsesManagedOAuthBridge(connector.service),
  });
  return { authorizeUrl };
};

const firstOAuthStarts = new Map<string, Promise<{ authorizeUrl: string }>>();

/** Creates and starts the first personal OAuth account in one browser action. */
router.post('/oauth/start', async (req, res) => {
  const userId = callerId(req);
  if (userId === null) {
    res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    return;
  }
  if (refuseLegacyConnectorWriter(res)) return;
  const redirectUri = oauthCallbackPreflight(res);
  if (redirectUri === null) return;
  try {
    const body = readOAuthCreateBody(req.body);
    requireReadyOAuthEntry(body.service);
    if (!passesRateLimit(oauthFirstStartRateLimiter, req, res)) return;
    const key = `${userId}:${body.service}:${body.accountLabel ?? ''}`;
    let operation = firstOAuthStarts.get(key);
    if (!operation) {
      operation = (async () => {
        // Re-read operator configuration at the mutation boundary. An app that
        // disappeared between catalog display and this POST creates zero rows.
        requireReadyOAuthEntry(body.service);
        const created = await connectorsService.create({
          service: body.service,
          accountLabel: body.accountLabel,
          credentialMode: 'per_member',
          ownerUserId: userId,
          createdBy: userId,
        });
        const exact = connectorsDb.get(created.id);
        if (!exact) throw new AppError('Could not start account linking.', {
          code: 'CONNECTOR_OAUTH_START_FAILED', statusCode: 500,
        });
        const priorEvenRevision = exact.sourceRevision;
        const oddRevision = connectorsDb.beginSourceMutation(exact.id, priorEvenRevision);
        if (oddRevision === null) {
          throw new AppError('Could not claim account linking.', {
            code: 'CONNECTOR_OAUTH_START_CONFLICT', statusCode: 409,
          });
        }
        let result: { authorizeUrl: string };
        try {
          result = await beginOAuthForConnector(userId, exact, redirectUri);
        } catch (error) {
          connectorsDb.removeExactClaimedNewbornPersonalOAuth(
            exact.id,
            userId,
            oddRevision,
            priorEvenRevision,
          );
          throw error;
        }
        if (connectorsDb.releaseSourceMutationUnchanged(exact.id, oddRevision) === null) {
          // beginLink already durably stored pending state. Never compensate it
          // as a pre-pending failure: an exact-release conflict must stay
          // fail-closed for the callback rather than orphaning its state.
          throw new AppError('Could not release account linking claim.', {
            code: 'CONNECTOR_OAUTH_START_CONFLICT', statusCode: 409,
          });
        }
        return result;
      })();
      firstOAuthStarts.set(key, operation);
      void operation.finally(() => {
        if (firstOAuthStarts.get(key) === operation) firstOAuthStarts.delete(key);
      }).catch(() => undefined);
    }
    res.status(201).json(await operation);
  } catch (error) {
    failOAuthStart(res, error);
  }
});

router.put('/:id/key', async (req, res) => {
  if (refuseLegacyConnectorWriter(res)) return;
  if (refusedOnConnector(req, res, req.params.id)) return;
  try {
    const result = await connectorsService.setKey(req.params.id, req.body?.apiKey);
    // Recorded because rotation is the ONLY effective revocation under ADR-098:
    // when a key changes, who changed it and when is the question that gets
    // asked afterwards. The key itself is not part of the record.
    auditLogDb.record('connector_key_set', {
      userId: callerId(req),
      metadata: { connectorId: req.params.id },
    });
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

router.post(
  '/:id/reconcile',
  (req, res) => {
    if (refuseLegacyConnectorWriter(res)) return;
    // Authentication is mounted before this router. Within this module, the
    // rollout guard precedes rate-limit bookkeeping and every connector,
    // credential, filesystem, and provider read.
    if (!isConnectorPlacementWriterEnabled()) {
      res.status(409).json({
        error: 'Connector reconciliation is disabled.',
        code: 'CONNECTOR_RECONCILER_DISABLED',
      });
      return;
    }
    if (refusedOnConnector(req, res, req.params.id)) return;
    const userId = callerId(req);
    if (userId === null) {
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    reconcileRateLimiter(req, res, () => {
      void (async () => {
        try {
          auditLogDb.record('connector_reconcile_requested', {
            userId,
            metadata: { connectorId: req.params.id },
          });
          const result = await connectorsService.reconcile(req.params.id, userId);
          const connector = connectorsService.get(req.params.id, userId);
          const verified = result.state === 'verified'
            && connector.placementStatus === 'healthy'
            && connector.availableNextSession;
          res.status(verified ? 200 : 207).json({ result, connector });
        } catch (error) {
          if (error instanceof AppError) {
            res.status(error.statusCode ?? 400).json({ error: error.message, code: error.code });
            return;
          }
          console.error('Connector reconciliation failed', {
            connectorId: req.params.id,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          res.status(500).json({
            error: 'Connector reconciliation failed.',
            code: 'CONNECTOR_RECONCILE_FAILED',
          });
        }
      })();
    });
  },
);

router.patch('/:id', async (req, res) => {
  if (refusedOnConnector(req, res, req.params.id)) return;
  try {
    // THREE EXPLICIT SHAPES, and nothing implicit. This route used to end in
    // `setEnabled(Boolean(req.body?.enabled))`, so a PATCH carrying any other
    // field — a typo, a newer client, a future property — read as
    // `enabled: false` and quietly withdrew the connector from every member.
    // An unrecognised body is now an error, not a disable.
    const body = req.body ?? {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw badRequest('The request body must be a JSON object.', 'CONNECTOR_BAD_BODY');
    }
    const allowedPatchFields = new Set(['credentialMode', 'extraEnv', 'additionalFields', 'enabled']);
    const unexpected = Object.keys(body).filter((key) => !allowedPatchFields.has(key));
    if (unexpected.length > 0) {
      throw badRequest(
        'A connector owner/account identity is server-controlled; PATCH accepts only credentialMode, additionalFields, legacy extraEnv or enabled.',
        'CONNECTOR_UNKNOWN_FIELD',
      );
    }
    if (Object.keys(body).length !== 1) {
      throw badRequest(
        'Change exactly one of credentialMode, additionalFields, legacy extraEnv or enabled per request.',
        'CONNECTOR_BAD_PATCH',
      );
    }

    // Isolation is answered AFTER the row exists (one-click add), so it lives
    // here. Sharing with the team stays an owner/admin decision exactly as on
    // create — otherwise the check would be a formality any member could step
    // around by adding personally and switching a moment later.
    if (body.credentialMode !== undefined) {
      const mode = body.credentialMode;
      if (mode !== 'per_member' && mode !== 'org_shared') {
        throw new AppError('credentialMode must be per_member or org_shared.', {
          code: 'CONNECTOR_BAD_MODE',
          statusCode: 400,
        });
      }
      if (mode === 'org_shared' && !isManager(req)) {
        res.status(403).json({
          error: 'Only an owner or admin can share a connector with the team.',
          code: 'INSUFFICIENT_ROLE',
        });
        return;
      }
      res.json({ connector: await connectorsService.setCredentialMode(req.params.id, mode) });
      return;
    }

    if (body.extraEnv !== undefined) {
      const connector = connectorsService.get(req.params.id, callerId(req) ?? undefined);
      const extraEnv = readExtraEnv(connector.service, body.extraEnv);
      res.json({ connector: await connectorsService.setExtraEnv(req.params.id, extraEnv) });
      return;
    }

    if (body.additionalFields !== undefined) {
      const connector = connectorsService.get(req.params.id, callerId(req) ?? undefined);
      const extraEnv = readAdditionalFields(connector.service, body.additionalFields);
      res.json({ connector: await connectorsService.setExtraEnv(req.params.id, extraEnv) });
      return;
    }

    if (body.enabled !== undefined) {
      if (refuseLegacyConnectorWriter(res)) return;
      if (typeof body.enabled !== 'boolean') {
        throw badRequest('enabled must be a boolean.', 'CONNECTOR_BAD_ENABLED');
      }
      res.json({ connector: await connectorsService.setEnabled(req.params.id, body.enabled) });
      return;
    }

    throw new AppError('Nothing to change: send credentialMode, extraEnv or enabled.', {
      code: 'CONNECTOR_EMPTY_PATCH',
      statusCode: 400,
    });
  } catch (error) {
    fail(res, error);
  }
});


router.delete('/:id', async (req, res) => {
  if (refusedOnConnector(req, res, req.params.id)) return;
  try {
    const result = await connectorsService.remove(req.params.id);
    if (result.removed) {
      auditLogDb.record('connector_removed', {
        userId: callerId(req),
        metadata: { connectorId: req.params.id },
      });
    }
    res.status(result.revocationPending ? 202 : 200).json(result);
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Starts the browser grant for an OAuth connector and hands back the URL to
 * open. The member's browser does the visiting; nassaj keeps the PKCE verifier.
 *
 * A POST rather than a redirect because the caller is authenticated JS, and
 * because the response must not be something a third-party page can trigger by
 * linking to it.
 */
router.post('/:id/oauth/start', async (req, res) => {
  if (refuseLegacyConnectorWriter(res)) return;
  const redirectUri = oauthCallbackPreflight(res);
  if (redirectUri === null) return;
  if (!passesRateLimit(oauthExistingStartRateLimiter, req, res)) return;
  if (refusedOnConnector(req, res, req.params.id)) return;
  const userId = callerId(req);
  if (userId === null) {
    res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    return;
  }
  try {
    const connector = connectorsService.get(req.params.id, userId);
    if (connector.authMode !== 'oauth') {
      throw new AppError('This connector authenticates with a pasted key, not a browser grant.', {
        code: 'CONNECTOR_NOT_OAUTH',
        statusCode: 400,
      });
    }
    const source = connectorsDb.get(connector.id);
    if (!source || source.credentialMode !== 'per_member' || source.ownerUserId !== userId) {
      throw new AppError('Connector not found.', { code: 'CONNECTOR_NOT_FOUND', statusCode: 404 });
    }
    const oddRevision = connectorsDb.beginSourceMutation(source.id, source.sourceRevision);
    if (oddRevision === null) {
      throw new AppError('Could not claim account linking.', {
        code: 'CONNECTOR_OAUTH_START_CONFLICT', statusCode: 409,
      });
    }
    try {
      const result = await beginOAuthForConnector(userId, source, redirectUri);
      if (connectorsDb.releaseSourceMutationUnchanged(source.id, oddRevision) === null) {
        throw new AppError('Could not release account linking claim.', {
          code: 'CONNECTOR_OAUTH_START_CONFLICT', statusCode: 409,
        });
      }
      res.json(result);
    } catch (error) {
      connectorsDb.releaseSourceMutationUnchanged(source.id, oddRevision);
      throw error;
    }
  } catch (error) {
    failOAuthStart(res, error);
  }
});

/**
 * Copy for the end-of-flow page, in the two languages nassaj fully translates.
 *
 * This page is rendered by the server in a bare browser tab, so it cannot reach
 * i18next — and it used to be pinned to `lang="ar" dir="rtl"` with Arabic-only
 * copy (B-524). Every member finishing an OAuth link landed on an Arabic page
 * no matter what language the app was running in, RTL layout included.
 */
const PAGE_COPY = {
  ar: {
    dir: 'rtl',
    ok: 'تم الربط',
    failed: 'تعذّر الربط',
    back: 'العودة إلى نسّاج',
    denied: 'لم توافق المنصّة على طلب الربط. أعد المحاولة من صفحة الموصلات.',
    incomplete: 'العودة من المنصّة وصلت ناقصة — أعد المحاولة من صفحة الموصلات.',
    success: 'تم حفظ الربط وتهيئة الإعداد للجلسات الجديدة. سيظهر الموصل بدءاً من جلستك التالية؛ ولم يُختبر وصول المنصّة بعد.',
    distributionFailed: 'تم اعتماد الحساب، لكن تعذّر تجهيز الأدوات في كل الجلسات. ارجع إلى صفحة الموصلات وأعد المحاولة بعد معالجة الوجهات المتعثرة.',
    generic: 'تعذّر إكمال الربط.',
  },
  en: {
    dir: 'ltr',
    ok: 'Account linked',
    failed: 'Linking failed',
    back: 'Back to Nassaj',
    denied: 'The platform did not approve the link. Start again from the Connectors page.',
    incomplete: 'The redirect came back incomplete — try again from the Connectors page.',
    success: 'The link was saved and configured for new sessions. It will appear from your next session; platform reachability has not been tested yet.',
    distributionFailed: 'The account was authorized, but the tools could not be prepared in every session. Return to Connectors and retry after fixing the failed targets.',
    generic: 'Could not complete the link.',
  },
} as const;

/** Testable public wording for the post-callback availability contract. */
export const oauthCallbackSuccessMessage = (language: 'ar' | 'en'): string =>
  PAGE_COPY[language].success;

/**
 * The tab carries no session, so the member's stored UI language is out of
 * reach; `Accept-Language` is the only signal this request actually has.
 * Arabic stays the default — nassaj is Arabic-first — and anything that asks
 * for English before Arabic gets English.
 */
const pageCopy = (req: express.Request) => {
  const header = String(req.headers['accept-language'] ?? '').toLowerCase();
  const ar = header.indexOf('ar');
  const en = header.indexOf('en');
  return en >= 0 && (ar < 0 || en < ar) ? PAGE_COPY.en : PAGE_COPY.ar;
};

/** Escape all HTML text, including fixed copy, so future copy remains safe. */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[character]!);

/** Minimal end-of-flow page: the member is in a browser tab, not in the app. */
const resultPage = (copy: typeof PAGE_COPY.ar | typeof PAGE_COPY.en, ok: boolean, message: string): string =>
  `<!doctype html>
<html lang="${copy === PAGE_COPY.en ? 'en' : 'ar'}" dir="${copy.dir}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ok ? copy.ok : copy.failed)}</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1020;color:#e8eaf2">
<main style="max-width:32rem;padding:2rem;text-align:center">
<h1 style="font-size:1.25rem;margin:0 0 .75rem">${escapeHtml(ok ? `✔ ${copy.ok}` : `✘ ${copy.failed}`)}</h1>
<p style="opacity:.8;line-height:1.7;margin:0 0 1.5rem">${escapeHtml(message)}</p>
<a href="/" style="color:#8ab4ff">${escapeHtml(copy.back)}</a>
</main></body></html>`;

/** OAuth is green only after at least one target accepted it and none failed. */
export const oauthDistributionReady = (
  distribution: ReadonlyArray<{ ok: boolean }>,
): boolean => distribution.length > 0 && distribution.every((result) => result.ok);

type OAuthDistributionService = Pick<
  typeof connectorsService,
  'get' | 'setEnabled' | 'distribute'
>;

/**
 * Places a completed OAuth grant without trapping retries in disabled state.
 *
 * A failed direct distribution contains the row by disabling it. On the next
 * browser grant, calling `distribute` again would therefore return [] forever.
 * `setEnabled(true)` is the service's explicit retry transaction: it arms the
 * row, performs exactly one distribution, and rolls the flag back on failure.
 */
export async function ensureOAuthConnectorDistributed(
  connectorId: string,
  userId: number,
  service: OAuthDistributionService = connectorsService,
): Promise<boolean> {
  const connector = service.get(connectorId, userId);
  if (!connector.enabled) {
    await service.setEnabled(connectorId, true);
    return true;
  }
  return oauthDistributionReady(await service.distribute(connectorId));
}

/**
 * Where the platform sends the member back — mounted WITHOUT authentication,
 * outside `/api`, because this request is a redirect from the platform and
 * carries no session or API key. Its authorisation is the unguessable `state`
 * minted at the start; nothing else about the request is trusted.
 */
export const connectorsOAuthCallbackRoutes = express.Router();

connectorsOAuthCallbackRoutes.get('/callback', createConnectorOAuthV2Callback());

connectorsOAuthCallbackRoutes.get('/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const denied = typeof req.query.error === 'string' ? req.query.error : '';
  const copy = pageCopy(req);

  if (connectorPolicyV2ClaimsLegacyPaths()) {
    res.status(409).send(resultPage(copy, false, copy.generic));
    return;
  }

  if (denied) {
    // Query/provider diagnostics are untrusted. Keep them out of executable
    // HTML and show a fixed remediation message instead.
    res.status(400).send(resultPage(copy, false, copy.denied));
    return;
  }
  if (!state || !code) {
    res.status(400).send(resultPage(copy, false, copy.incomplete));
    return;
  }

  try {
    const { userId, connectorId } = await completeLink({ state, code });
    // Distribution is what makes the grant visible to the engines; without it
    // the tokens sit on disk and no tool appears, which reads as a failed link.
    if (!await ensureOAuthConnectorDistributed(connectorId, userId)) {
      res.status(502).send(resultPage(copy, false, copy.distributionFailed));
      return;
    }
    auditLogDb.record('connector_oauth_linked', { userId, metadata: { connectorId } });
    res.send(resultPage(copy, true, copy.success));
  } catch (error) {
    res.status(error instanceof AppError ? (error.statusCode ?? 400) : 400)
      .send(resultPage(copy, false, copy.generic));
  }
});

export default router;
