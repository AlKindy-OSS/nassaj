/**
 * connectors.service — the business rules over the connector registry and the
 * encrypted secret behind it (T-1226/T-1227, ADR-098).
 *
 * WHAT THIS OWNS
 *   • Creating/removing a connector, and storing its key encrypted.
 *   • Turning one connector row + one member into the MCP server entry that
 *     member's engines should see, with the secret injected at build time.
 *   • Distributing that entry into every member's own config tree, and undoing
 *     it when the connector goes away.
 *
 * THE KEY IS NEVER RETURNED. Every function here reports existence
 * (`configured: true|false`) and never the value — same contract as
 * provider-secrets.service. The one place a plaintext key exists is inside
 * `buildMcpInput`, on its way into the MCP writer, and it is never logged there.
 *
 * WHERE THE SECRET LIVES FOLLOWS WHO OWNS IT (ADR-098 rev2).
 *   SHARED   → one copy under SYSTEM_SECRET_SCOPE, fanned out to every member at write
 *              time. Rotation is one write, not N — a per-member copy would make
 *              rotation a loop that can half-fail and leave members on a dead key.
 *   PERSONAL → one copy under the OWNER's own scope, distributed to that member
 *              only. Nobody else's tree is touched, so a personal key never
 *              reaches a colleague through nassaj.
 *
 * `scopeFor` is the single place that decision is made; every read and write of
 * connector material goes through it so the two modes cannot drift apart.
 *
 * WHAT DISTRIBUTION HONESTLY IS. The key is written into each member's engine
 * config. That is a COPY on disk in that member's tree — exactly the protection
 * level the existing kimi/deepseek/glm keys already have, and no more (ADR-098
 * threat model). Removing a member's access means rotating the key at the
 * platform, not deleting a row here.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { grantFilePath } from '@/modules/connectors/connector-oauth-flow.js';
import {
  isGrantRevocationPending,
  markGrantRevocationPending,
} from '@/modules/connectors/grant-file.js';
import {
  connectorPlacementsDb,
  connectorsDb,
  userDb,
  type ConnectorPlacementPublicTargetStatus,
  type ConnectorRow,
} from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import {
  deleteNamespacedSecret,
  hasNamespacedSecret,
  setNamespacedSecret,
  SYSTEM_SECRET_SCOPE,
} from '@/services/isolation/provider-secrets-store.js';
import type { UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Relative, like every other shared/ import on the server side: the `@/*` alias
// maps to server/ only.
import { BUILT_IN_SERVERS_TOKEN, catalogEntryFor } from '../../../shared/connector-catalog.js';

import {
  ConnectorPackagePolicyError,
  resolvePinnedCatalogPackage,
} from './connector-npm-package-policy.js';
import {
  buildConnectorPlacementInput,
  mcpServerNameFor,
} from './connector-placement-definition.js';
import { isConnectorPlacementWriterEnabled } from './connector-placement-writer.js';
import {
  isAuthorizedConnectorGrantMaterialReference,
  type ConnectorGrantMaterialReference,
} from './connector-user-grant.service.js';

export { mcpServerNameFor } from './connector-placement-definition.js';

/**
 * Where the MCP servers nassaj ships live at runtime, resolved from THIS
 * module's own location rather than from cwd or configuration: the connectors
 * module and the servers are built into the same tree, so their relative
 * position is the one fact that holds on every install and every operator's
 * directory layout.
 *
 * Resolved at DISTRIBUTION time, not when the row is created, so a connector
 * added on one machine still points at the right place if the install moves.
 */
function builtInServersDir(): string {
  // source:      server/modules/connectors -> server/mcp-servers
  // compiled:    dist-server/server/modules/connectors -> dist-server/server/mcp-servers
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp-servers');
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new AppError('The built-in connector servers are missing from this installation.', {
      code: 'CONNECTOR_BUILT_IN_SERVERS_MISSING',
      statusCode: 500,
    });
  }
  return dir;
}

/**
 * A connector whose server is shipped by nassaj rather than fetched by npx.
 *
 * Answered by the CATALOG, from the row's `service`, and never by reading the
 * row's own arguments. "Built-in" is a privilege: it is what lets a connector
 * take its key from nassaj's own environment, and what makes nassaj launch the
 * server with its own `process.execPath`. Deriving it from `args` meant the
 * caller who supplied those args decided whether they had that privilege —
 * writing `{{NASSAJ_MCP_SERVERS}}` anywhere in an argument was enough, and a
 * plain member could then name any variable nassaj runs with and have it handed
 * to a command of their choosing (B-542, proved live with `JWT_SECRET`).
 *
 * A row whose service left the catalog therefore stops being built-in, which is
 * the correct answer: nassaj no longer ships a server for it.
 */
function isBuiltIn(connector: ConnectorRow): boolean {
  return catalogEntryFor(connector.service)?.args?.some((arg) =>
    arg.includes(BUILT_IN_SERVERS_TOKEN),
  ) ?? false;
}

/** Catalog packaging supersedes legacy stored args for shipped servers. */
function builtInCatalogArgs(connector: ConnectorRow): readonly string[] {
  // Only OAuth needs this compatibility migration: pre-B-750 rows legitimately
  // persist mcp-remote packaging. Key-based built-ins must continue validating
  // the exact stored args so a corrupt/escaping row cannot be silently masked.
  return connector.authMode === 'oauth'
    ? (catalogEntryFor(connector.service)?.args ?? connector.args)
    : connector.args;
}

/** Only grant.json is concurrency-governed; legacy mcp-remote tokens are not. */
function hasLockedOAuthGrant(userId: number, connectorId: string): boolean {
  const file = grantFilePath(userId, connectorId);
  return !isGrantRevocationPending(file)
    && (fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false);
}

function hasLockedOAuthGrantFile(userId: number, connectorId: string): boolean {
  return fs.statSync(grantFilePath(userId, connectorId), { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Substitutes the built-in servers directory into a row's arguments, and
 * refuses any result that lands outside it.
 *
 * The substitution is a plain string replace, so `{{NASSAJ_MCP_SERVERS}}/../..`
 * is a perfectly ordinary-looking argument that resolves anywhere on the disk.
 * Containment is checked AFTER `path.resolve`, because that is the only form in
 * which `..` has been spent; comparing the raw string would compare a path to a
 * recipe. A refusal throws rather than silently dropping the argument: a server
 * launched with one argument missing fails in a way nobody can read.
 */
function resolveBuiltInArgs(args: readonly string[], connectorId: string): string[] {
  const dir = builtInServersDir();
  const resolvedArgs = args.map((arg) => {
    if (!arg.includes(BUILT_IN_SERVERS_TOKEN)) {
      return arg;
    }
    const resolved = path.resolve(arg.split(BUILT_IN_SERVERS_TOKEN).join(dir));
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      // The path itself is deliberately absent from the message: the caller who
      // would read it is the one who tried to leave the directory.
      throw new AppError(
        `Connector "${connectorId}" points outside the servers nassaj ships.`,
        { code: 'CONNECTOR_PATH_ESCAPE', statusCode: 400 },
      );
    }
    // Catalog entries name the production `.js` artifact. In the source tree
    // (tsx/dev and tests) only the sibling `.ts` exists; modern Node executes it
    // with type stripping. Prefer the named artifact, then that exact sibling —
    // never an arbitrary extension search.
    const sourceSibling = resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : resolved;
    const installed = fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()
      ? resolved
      : fs.statSync(sourceSibling, { throwIfNoEntry: false })?.isFile()
        ? sourceSibling
        : null;
    if (!installed) {
      throw new AppError(`Connector "${connectorId}" names a built-in server that is not installed.`, {
        code: 'CONNECTOR_BUILT_IN_SERVER_MISSING',
        statusCode: 500,
      });
    }
    return installed;
  });
  // Source checkouts contain TypeScript while production packages contain the
  // compiled JavaScript sibling. A child `node file.ts` cannot resolve this
  // project's `.js` specifiers back to their TS sources; the same tsx loader
  // used by server:dev can. The compiled path stays dependency-free.
  return resolvedArgs.some((arg) => arg.endsWith('.ts'))
    ? ['--import', 'tsx', ...resolvedArgs]
    : resolvedArgs;
}

/** A connector as reported to a client: the row, plus whether a key is stored. */
export type ConnectorPlacementAggregate =
  | 'not_configured'
  | 'paused'
  | 'untracked'
  | 'pending'
  | 'reconciling'
  | 'partial'
  | 'degraded'
  | 'blocked'
  | 'healthy';

export type ConnectorTargetStatus = {
  provider: 'claude' | 'codex';
  state: ConnectorPlacementPublicTargetStatus['state'] | 'untracked';
  healthy: boolean;
  desiredGeneration: number;
  appliedGeneration: number;
  attemptCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
};

export type ConnectorStatus = Omit<ConnectorRow, 'sourceRevision'> & {
  /** Credential/grant existence only; it is not a runtime health claim. */
  configured: boolean;
  degraded: boolean;
  availableNextSession: boolean;
  /** True only when this caller can safely invoke the armed manual reconciler. */
  retryAvailable: boolean;
  availability: 'not_configured' | 'degraded' | 'available_next_session';
  /** Aggregate of the two required per-member engine placements. */
  placementStatus: ConnectorPlacementAggregate;
  /** Public operational state only; fingerprints and material never enter this DTO. */
  targets: ConnectorTargetStatus[];
  /** Where the credential comes from — see {@link CredentialSource}. */
  credentialSource: CredentialSource;
};

/**
 * Per-provider outcome of one distribution pass.
 *
 * `userId: null` means the write went to an operator-homed config shared by
 * everyone (opencode/cursor) — not that the member is unknown. Keeping the
 * distinction in the result is what stops a shared write from being read as a
 * per-member one.
 */
export type DistributionResult = {
  connectorId: string;
  userId: number | null;
  provider: string;
  ok: boolean;
  error?: string;
};

/** Refuse to turn a partial connector placement into a green success response. */
function requireSuccessfulDistribution(results: DistributionResult[]): void {
  if (results.length === 0) {
    throw new AppError('Connector distribution reached no eligible destination.', {
      code: 'CONNECTOR_DISTRIBUTION_FAILED',
      statusCode: 502,
    });
  }
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return;
  const destinations = failures.map((result) => result.provider).join(', ');
  throw new AppError(`Connector distribution failed for: ${destinations}.`, {
    code: 'CONNECTOR_DISTRIBUTION_FAILED',
    statusCode: 502,
  });
}

type CleanupResult = {
  provider: string;
  removed: boolean;
  verified: boolean;
  state: 'removed' | 'absent' | 'failed' | 'unverified';
  error?: string;
};

/** Cleanup is a precondition for state loss, not a best-effort epilogue. */
function requireSuccessfulCleanup(results: CleanupResult[]): void {
  if (results.length === 0) {
    throw new AppError('Connector cleanup reached no eligible destination.', {
      code: 'CONNECTOR_CLEANUP_FAILED',
      statusCode: 502,
    });
  }
  const failures = results.filter((result) => !result.verified);
  if (failures.length === 0) return;
  const destinations = failures.map((result) => result.provider).join(', ');
  throw new AppError(`Connector cleanup failed for: ${destinations}.`, {
    code: 'CONNECTOR_CLEANUP_FAILED',
    statusCode: 502,
  });
}

/**
 * The secret store scope a connector's key belongs in: the owner's own scope for
 * a personal connector, the operator-wide scope for a shared one.
 *
 * A personal row with no owner would silently fall back to the shared store and
 * publish one member's key to everyone, so it throws instead — the repository
 * already refuses to create such a row, and this is the second lock.
 */
function scopeFor(connector: ConnectorRow): number | typeof SYSTEM_SECRET_SCOPE {
  if (connector.credentialMode !== 'per_member') {
    return SYSTEM_SECRET_SCOPE;
  }
  if (connector.ownerUserId === null) {
    throw new AppError(`Connector "${connector.id}" is personal but has no owner.`, {
      code: 'CONNECTOR_OWNERLESS',
      statusCode: 500,
    });
  }
  return connector.ownerUserId;
}

/**
 * WHERE a connector's credential comes from — not merely whether one exists.
 *
 *   'oauth_grant'  the member approved it in a browser; the grant is theirs and
 *                  cannot be shared (rotating refresh tokens make sharing a
 *                  correctness bug, not just a policy one).
 *   'stored'       somebody pasted a key, held encrypted in the scope that
 *                  matches the connector's mode.
 *   'operator_env' nobody pasted anything: the key comes from the environment
 *                  nassaj itself runs with, so it serves EVERY member at once.
 *   null           nothing is configured.
 *
 * The distinction is reported to the page rather than collapsed into a boolean
 * because it answers the question a member actually has — "is this mine or
 * everyone's?" — and because `operator_env` used to read as "no key" while the
 * connector worked perfectly, which is the most confusing state of all.
 */
export type CredentialSource = 'oauth_grant' | 'stored' | 'operator_env' | null;

function credentialSource(connector: ConnectorRow, userId?: number): CredentialSource {
  if (connector.authMode === 'oauth') {
    return null;
  }
  if (hasNamespacedSecret(scopeFor(connector), 'connector', connector.id)) {
    return 'stored';
  }
  return null;
}

/**
 * Read-only credential-presence probe for reconciliation planning.
 *
 * Returns only a boolean and never the credential, its path, or its encrypted
 * representation. Keeping this next to `credentialSource` prevents a planner
 * from inventing a second, drifting definition of "configured".
 */
export function isConnectorCredentialConfigured(
  connector: ConnectorRow,
  userId?: number,
): boolean {
  return credentialSource(connector, userId) !== null;
}

const PLACEMENT_TARGETS = ['claude', 'codex'] as const;

function statusFor(
  connector: ConnectorRow,
  userId?: number,
  placementRows: readonly ConnectorPlacementPublicTargetStatus[] = [],
): ConnectorStatus {
  const source = credentialSource(connector, userId);
  const configured = source !== null;
  const ownedRows = placementRows.filter((row) =>
    row.connectorId === connector.id
      && row.memberUserId === userId
      && row.contractVersion === 'mcp-user-v1',
  );
  const rowsByProvider = new Map(ownedRows.map((row) => [row.bodyProvider, row]));
  const targets: ConnectorTargetStatus[] = PLACEMENT_TARGETS.map((provider) => {
    const row = rowsByProvider.get(provider);
    return row
      ? {
        provider,
        state: row.state,
        healthy: row.state === 'healthy' && row.desiredAppliedMatch,
        desiredGeneration: row.desiredGeneration,
        appliedGeneration: row.appliedGeneration,
        attemptCount: row.attemptCount,
        nextRetryAt: row.nextRetryAt,
        lastErrorCode: row.lastErrorCode,
      }
      : {
        provider,
        state: 'untracked',
        healthy: false,
        desiredGeneration: 0,
        appliedGeneration: 0,
        attemptCount: 0,
        nextRetryAt: null,
        lastErrorCode: null,
      };
  });
  const tracked = targets.filter((target) => target.state !== 'untracked');
  const healthyCount = targets.filter((target) => target.healthy).length;
  let placementStatus: ConnectorPlacementAggregate;
  if (!configured) placementStatus = 'not_configured';
  else if (!connector.enabled || connector.credentialMode !== 'per_member') placementStatus = 'paused';
  else if (tracked.length === 0) placementStatus = 'untracked';
  else if (healthyCount === PLACEMENT_TARGETS.length) placementStatus = 'healthy';
  else if (targets.some((target) => target.state === 'blocked')) placementStatus = 'blocked';
  else if (targets.some((target) => target.state === 'applying' || target.state === 'removing')) {
    placementStatus = 'reconciling';
  } else if (healthyCount > 0 || tracked.length !== PLACEMENT_TARGETS.length) {
    placementStatus = 'partial';
  } else if (targets.some((target) => target.state === 'degraded')) {
    placementStatus = 'degraded';
  } else placementStatus = 'pending';

  const availableNextSession = placementStatus === 'healthy';
  const retryAvailable = isConnectorPlacementWriterEnabled()
    && configured
    && connector.enabled
    && connector.sourceRevision % 2 === 0
    && connector.credentialMode === 'per_member'
    && userId !== undefined
    && connector.ownerUserId === userId
    && (placementStatus === 'untracked'
      || placementStatus === 'pending'
      || placementStatus === 'partial'
      || placementStatus === 'degraded');
  const { sourceRevision: _sourceRevision, ...publicConnector } = connector;
  void _sourceRevision;
  return {
    ...publicConnector,
    configured,
    degraded: configured && !availableNextSession,
    availableNextSession,
    retryAvailable,
    availability: !configured
      ? 'not_configured'
      : availableNextSession
        ? 'available_next_session'
        : 'degraded',
    placementStatus,
    targets,
    credentialSource: source,
  };
}

function requireConnector(id: string): ConnectorRow {
  const connector = connectorsDb.get(id);
  if (!connector) {
    throw new AppError(`Connector "${id}" was not found.`, {
      code: 'CONNECTOR_NOT_FOUND',
      statusCode: 404,
    });
  }
  return connector;
}

function sourceMutationError(): AppError {
  return new AppError('The connector source is being changed; retry this action.', {
    code: 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE',
    statusCode: 409,
  });
}

function requireRegistryMutation(completed: boolean): void {
  if (!completed) throw sourceMutationError();
}

/** Serializes one durable secret mutation behind the connector seqlock. */
function promoteConnectorSecret(connector: ConnectorRow, promote: () => void): void {
  const oddRevision = connectorsDb.beginSourceMutation(connector.id, connector.sourceRevision);
  if (oddRevision === null) throw sourceMutationError();
  let promotionError: unknown;
  try {
    promote();
  } catch (error) {
    promotionError = error;
  }
  const stableRevision = connectorsDb.finishSourceMutation(connector.id, oddRevision);
  if (stableRevision === null) throw sourceMutationError();
  if (promotionError !== undefined) throw promotionError;
}

/**
 * Builds the MCP entry for one connector, with the stored key injected.
 *
 * Returns null when no key is stored: distributing a connector with an empty
 * credential would register a server that fails on every call, which reads to
 * the member as "the tool is broken" rather than "nobody has pasted the key".
 */
export function buildConnectorMcpInput(
  connector: ConnectorRow,
  userId: number,
  credentialOverride?: string,
  materialReference?: ConnectorGrantMaterialReference,
): UpsertProviderMcpServerInput | null {
  if (!isAuthorizedConnectorGrantMaterialReference(
    materialReference, userId, connector.service,
  )) return null;
  const catalogEntry = catalogEntryFor(connector.service);
  const catalogPackageLaunch = catalogEntry?.command === 'npx'
    ? resolvePinnedCatalogPackage(catalogEntry)
    : null;

  // An OAuth connector has no key to inject. What it needs instead is a private
  // place to keep the grant `mcp-remote` obtained, so each member refreshes their
  // own tokens. That isolation is not decoration: Canva's refresh tokens are
  // SINGLE-USE, so two members sharing one auth directory would invalidate each
  // other's grant on the next refresh and both would be logged out.
  if (connector.authMode === 'oauth') {
    if (!materialReference?.grantId || materialReference.kind !== 'v2' || !isBuiltIn(connector)) {
      return null;
    }
    // A server nassaj ships reads the grant FILE and refreshes it itself, so it
    // needs the path plus the operator's app credentials — the same app the
    // grant was obtained with, or the refresh is rejected. A server run through
    // `mcp-remote` instead needs only the directory, because that tool owns both
    // the tokens and their refresh.
    if (isBuiltIn(connector)) {
      const input = buildConnectorPlacementInput(connector, userId, {
        transport: 'stdio',
        command: process.execPath,
        args: resolveBuiltInArgs(builtInCatalogArgs(connector), connector.id),
        env: connector.extraEnv,
      });
      return {
        ...input,
        env: {
          ...input.env,
          NASSAJ_OAUTH_V2_CONNECTOR_ID: connector.id,
          NASSAJ_OAUTH_V2_USER_ID: String(userId),
          NASSAJ_OAUTH_V2_SERVICE_ID: connector.service,
          NASSAJ_OAUTH_V2_GRANT_ID: materialReference.grantId,
          NASSAJ_OAUTH_V2_SECRET_REF: materialReference.secretRef,
        },
      };
    }
    return null;
  }

  if (credentialOverride === undefined) {
    return null;
  }
  const secret = credentialOverride;

  if (connector.transport === 'http') {
    const input = buildConnectorPlacementInput(connector, userId, {
      transport: 'http',
      url: connector.url ?? '',
    });
    return {
      ...input,
      headers: connector.keyHeader
        ? { [connector.keyHeader]: `${connector.keyHeaderPrefix}${secret}` }
        : {},
    };
  }

  const input = buildConnectorPlacementInput(connector, userId, {
    transport: 'stdio',
    // `process.execPath` for a built-in server rather than the bare word `node`:
    // the engine that launches it may not have the same PATH nassaj does (the
    // measured OpenCode case), and a server that cannot be spawned looks
    // identical to a server with a bad key.
    command: isBuiltIn(connector)
      ? process.execPath
      : (catalogPackageLaunch?.command ?? connector.command ?? ''),
    args: isBuiltIn(connector)
      ? resolveBuiltInArgs(builtInCatalogArgs(connector), connector.id)
      : (catalogPackageLaunch?.args ?? connector.args),
    env: connector.extraEnv,
  });
  return {
    ...input,
    // Extras first so a stored extra can never overwrite the credential: the key
    // is the one value this function exists to place.
    env: {
      ...input.env,
      ...(connector.keyEnvVar ? { [connector.keyEnvVar]: secret } : {}),
    },
  };
}

/** Build only inside the temporal capability issued by the central grant gate. */
async function buildCentrallyEligibleConnectorMcpInput(
  connector: ConnectorRow,
  userId: number,
): Promise<UpsertProviderMcpServerInput | null> {
  const { withProductionConnectorGrantCapability } = await import(
    './connector-user-grant.production.js'
  );
  return withProductionConnectorGrantCapability(
    connector.id,
    userId,
    connector.service,
    ({ reference, credential }) => buildConnectorMcpInput(
      connector, userId, credential?.toString('utf8'), reference,
    ),
  );
}

/**
 * Writes one MCP entry to one provider and turns the outcome into a row.
 *
 * A provider that cannot manage MCP at all (antigravity) throws here; that is
 * recorded as a failed row rather than allowed to abort the sweep, so one
 * unsupported engine never strands the connector on the engines that do work.
 * The error message is kept, the payload (which holds the key) is not.
 */
async function writeOne(
  connectorId: string,
  provider: string,
  input: UpsertProviderMcpServerInput,
  userId: number | null,
): Promise<DistributionResult> {
  try {
    await providerMcpService.upsertProviderMcpServer(provider, { ...input, userId });
    return { connectorId, userId, provider, ok: true };
  } catch (error) {
    return {
      connectorId,
      userId,
      provider,
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Derives a connector id from the platform, the optional account label, and —
 * for a PERSONAL connector — whose it is. The member never types a slug, and the
 * charset matches what both the table and the secret store accept.
 *
 * THE OWNER IS PART OF A PERSONAL ID because that id is the table's PRIMARY KEY.
 * Without it, two members connecting the same platform derived the same string,
 * so the second one was refused outright — `notion` already existed — while the
 * partial index that actually governs personal rows (service, account_label,
 * owner_user_id) would happily have allowed them. The index permitted what the
 * primary key forbade, and the member on the losing side of that disagreement
 * simply could not connect a platform a colleague had connected first (B-556).
 *
 * A SHARED connector keeps the bare slug: there is at most one per platform for
 * the whole install by design, and the bare form is the id every already-stored
 * row and every already-distributed config entry carries.
 *
 * Truncation eats the STEM, never the owner suffix — an id that lost its `-u7`
 * would collide with the very row it was derived to differ from.
 */
function buildConnectorId(
  service: string,
  accountLabel?: string,
  ownerUserId?: number | null,
): string {
  const slug = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const base = slug(service) || 'connector';
  const suffix = typeof ownerUserId === 'number' ? `-u${ownerUserId}` : '';
  const normalizedLabel = normalizeAccountLabel(accountLabel);
  if (!normalizedLabel) {
    return `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
  }

  // The readable slug is presentation only. Identity comes from SHA-256 over
  // the complete normalized label, so punctuation that slugging removes and a
  // long shared prefix cannot make two accounts collide. Existing row ids are
  // never recomputed or renamed; this format applies to newly-created rows.
  const digest = crypto
    .createHash('sha256')
    .update(normalizedLabel, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const servicePart = base.slice(0, 24).replace(/-+$/, '') || 'connector';
  const readable = slug(normalizedLabel) || 'account';
  const readableBudget = Math.max(1, 64 - suffix.length - servicePart.length - digest.length - 2);
  const readablePart = readable.slice(0, readableBudget).replace(/-+$/, '') || 'a';
  return `${servicePart}-${readablePart}-${digest}${suffix}`;
}

/** Canonical presentation form used by both the id and the stored row. */
function normalizeAccountLabel(value?: string): string {
  return value?.normalize('NFKC').trim().replace(/\s+/gu, ' ') ?? '';
}

/**
 * Turns the storage engine's own words into an answer a member can act on.
 *
 * EVERY uniqueness rule a connector can break is enforced by SQLite — the
 * primary key on `id`, and the two partial indexes (one shared, one personal) —
 * so the only thing the browser ever received was the driver's message
 * verbatim: `UNIQUE constraint failed: connectors.id`, delivered as a 400
 * (B-556). It names our column layout to somebody who cannot use it and says
 * nothing about what to do next.
 *
 * Matched on the common prefix rather than on any one column list, because
 * WHICH rule fires is not the caller's business and is not even stable: the
 * personal index answers before the primary key when a duplicate breaks both.
 * All three wordings are pinned against a real database in
 * connectors.db.integration.test.ts. Anything that is not a uniqueness failure
 * passes through untouched rather than being flattened into one vague code.
 */
function classifyCreateFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : '';
  if (/UNIQUE constraint failed/i.test(message)) {
    return new AppError(
      'This platform is already connected under that account. Remove the existing connection first, or add the new one with a different account label.',
      { code: 'CONNECTOR_ALREADY_EXISTS', statusCode: 409 },
    );
  }
  return error;
}

/**
 * Whose trees a connector occupies — the owner alone when personal, everybody
 * when shared. Cleanup must use the same set the write used, or a personal
 * connector is swept from trees it was never in while its own is left behind.
 */
function sweepTargets(connector: ConnectorRow): Array<{ id: number }> {
  const users = userDb.listUsers();
  return connector.credentialMode === 'per_member'
    ? users.filter((user) => user.id === connector.ownerUserId)
    : users;
}

/**
 * Removes every placement that may have been touched by a failed fan-out.
 * This deliberately sweeps more than the successful result rows: a writer may
 * have committed bytes and then thrown before returning success.
 */
async function compensateDistribution(connector: ConnectorRow): Promise<CleanupResult[]> {
  requireRegistryMutation(connectorsDb.setEnabled(connector.id, false));
  const cleanup: CleanupResult[] = [];
  for (const user of sweepTargets(connector)) {
    cleanup.push(...await providerMcpService.removeMcpServerFromAllProviders({
      name: mcpServerNameFor(connector),
      scope: 'user',
      userId: user.id,
    }));
  }
  return cleanup;
}

export const connectorsService = {
  /**
   * What ONE member may see: every shared connector plus their own personal
   * ones. A member is never shown another member's personal connector — it would
   * be a row they can neither use nor explain.
   */
  listFor(userId: number): ConnectorStatus[] {
    const connectors = connectorsDb.listVisibleTo(userId);
    const statuses = connectorPlacementsDb.listPublicStatuses(
      connectors.map((connector) => connector.id),
      userId,
    );
    return connectors.map((connector) => statusFor(connector, userId, statuses));
  },

  get(id: string, userId?: number): ConnectorStatus {
    const connector = requireConnector(id);
    const statuses = userId === undefined
      ? []
      : connectorPlacementsDb.listPublicStatuses([id], userId);
    return statusFor(connector, userId, statuses);
  },

  /** Explicit, manual-only placement retry; importing lazily avoids a module cycle. */
  async reconcile(id: string, userId: number, env: NodeJS.ProcessEnv = process.env) {
    const { reconcileConnectorPlacements } = await import('./connector-placement-composition.js');
    return reconcileConnectorPlacements(id, userId, env);
  },

  /**
   * Registers a connector, personal or shared.
   *
   * PERSONAL is the safe default for a caller with no say in the matter: it
   * touches nobody else's tree. SHARED is refused for a platform whose terms
   * require each person to authenticate individually — `allowsSharing: false`
   * and "share it anyway" cannot both be honoured, so it is rejected rather than
   * warned about. The same platform may still be added personally.
   *
   * THIS FUNCTION TRUSTS ITS CALLER, deliberately: a CLI, a migration or a test
   * may hand it a fully specified row, including a platform the catalog has
   * never heard of. Whoever reaches it already has the machine. The boundary
   * that does NOT trust its caller is the HTTP route, which accepts a platform
   * and a credential and derives everything else from the catalog (B-542) —
   * see CREATE_BODY_FIELDS in connectors.routes.ts. Do not read the permissive
   * merge below as the system's answer to an untrusted request; it is not the
   * one being asked.
   */
  async create(
    input: Partial<Parameters<typeof connectorsDb.create>[0]> & {
      service: string;
      apiKey?: string;
    },
  ): Promise<ConnectorStatus> {
    // Shared credentials cannot be made safe while every agent runs under the
    // same OS identity. Keep legacy rows readable/manageable, but refuse to
    // create any new shared blast radius until the isolation gateway is armed.
    if (input.credentialMode === 'org_shared') {
      throw new AppError('Creating shared connectors is temporarily unavailable.', {
        code: 'CONNECTOR_ORG_SHARED_CREATION_DISABLED',
        statusCode: 409,
      });
    }

    // A known platform fills in its own packaging (command, args, env var,
    // endpoint, sharing policy). The caller may still override any of it — the
    // catalog is a default, not a lock — but the common path sends `service`
    // plus a key and nothing else.
    const preset = catalogEntryFor(input.service);
    // Read BEFORE the id, because a personal id carries its owner and a shared
    // one does not. Deriving the id first and the mode afterwards would have to
    // guess which shape it was building.
    const credentialMode = 'per_member' as const;
    const accountLabel = normalizeAccountLabel(input.accountLabel);
    const merged = {
      ...input,
      accountLabel,
      id:
        input.id ??
        buildConnectorId(
          input.service,
          accountLabel,
          credentialMode === 'per_member' ? input.ownerUserId : null,
        ),
      displayName: input.displayName ?? preset?.displayName ?? input.service,
      transport: input.transport ?? preset?.transport ?? 'stdio',
      command: input.command ?? preset?.command ?? null,
      args: input.args ?? preset?.args ?? [],
      url: input.url ?? preset?.url ?? null,
      keyEnvVar: input.keyEnvVar ?? preset?.keyEnvVar ?? null,
      keyHeader: input.keyHeader ?? preset?.keyHeader ?? null,
      keyHeaderPrefix: input.keyHeaderPrefix ?? preset?.keyHeaderPrefix ?? '',
      extraEnv: input.extraEnv ?? {},
      authMode: input.authMode ?? preset?.authMode ?? 'key',
      // The sharing policy is the platform's, so a client cannot raise it by
      // sending `allowsSharing: true` for a platform the catalog says is
      // per-person. Only a platform absent from the catalog falls back to the
      // caller's claim.
      allowsSharing: preset ? preset.allowsSharing : input.allowsSharing !== false,
    };

    const { apiKey, ...row } = merged;
    let created: ConnectorRow;
    try {
      created = connectorsDb.create({ ...row, credentialMode });
    } catch (error) {
      throw classifyCreateFailure(error);
    }

    if (typeof apiKey === 'string' && apiKey.trim() !== '') {
      promoteConnectorSecret(created, () => {
        setNamespacedSecret(scopeFor(created), 'connector', created.id, apiKey);
      });
      try {
        requireSuccessfulDistribution(await this.distribute(created.id));
      } catch (error) {
        // Partial placements may already carry this credential. Retain it for
        // reconciliation/retry, but contain the row so refresh stays non-green.
        requireRegistryMutation(connectorsDb.setEnabled(created.id, false));
        throw error;
      }
    }

    return this.get(created.id);
  },

  /**
   * Stores (or replaces) a connector's key and re-distributes it everywhere.
   *
   * This IS the rotation path (T-1229): pasting a new key here overwrites the one
   * copy in the store and rewrites every member's config. That is the only
   * revocation that actually works — a member who already read the old key keeps
   * the old string, and it stops working because the PLATFORM stopped honouring
   * it, not because we changed a row.
   */
  async setKey(id: string, apiKey: string): Promise<ConnectorStatus & { distribution: DistributionResult[] }> {
    const connector = requireConnector(id);
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('The API key must be a non-empty string.', {
        code: 'CONNECTOR_KEY_REQUIRED',
        statusCode: 400,
      });
    }
    promoteConnectorSecret(connector, () => {
      setNamespacedSecret(scopeFor(connector), 'connector', id, apiKey);
    });
    // A previous failed placement is retained as disabled/non-green. Pasting the
    // key again is the pending card's retry action, so arm this explicit retry
    // before distribution; failure below contains it again.
    requireRegistryMutation(connectorsDb.setEnabled(id, true));
    let distribution: DistributionResult[];
    try {
      distribution = await this.distribute(id);
      requireSuccessfulDistribution(distribution);
    } catch (error) {
      // Rolling the secret back is unsafe after partial placement: successful
      // targets may already use the new value. Keep it and mark the connection
      // non-usable until an explicit retry succeeds everywhere.
      requireRegistryMutation(connectorsDb.setEnabled(id, false));
      throw error;
    }
    return {
      ...this.get(id, connector.ownerUserId ?? undefined),
      distribution,
    };
  },

  /**
   * Writes one connector into every engine that can host it.
   *
   * TWO SHAPES, NOT ONE. A proven target whose MCP writer follows the caller is
   * written once per member. A future proven operator-homed target would be
   * written once with no member attached. Today the audited connector target
   * set is deliberately Claude + Codex; Gemini/OpenCode/Cursor remain excluded
   * until their writer→launched-reader contracts are demonstrated (B-740).
   *
   * The generic split remains here so reinstating a target after proof does not
   * require a second fan-out implementation. `userId: null` marks an actual
   * operator-homed write; it is never used as a claim that a member was reached.
   */
  async distribute(id: string): Promise<DistributionResult[]> {
    const connector = requireConnector(id);
    const results: DistributionResult[] = [];
    if (!connector.enabled) {
      return results;
    }

    const targets = providerMcpService.listMcpTargets();
    // A personal connector reaches its owner and nobody else. A shared one
    // reaches everybody. This single line is the whole difference between the
    // two modes at distribution time.
    const users =
      connector.credentialMode === 'per_member'
        ? userDb.listUsers().filter((user) => user.id === connector.ownerUserId)
        : userDb.listUsers();

    // Per-member providers: one write per (member, provider).
    for (const user of users) {
      let input: UpsertProviderMcpServerInput | null;
      try {
        input = await buildCentrallyEligibleConnectorMcpInput(connector, user.id);
      } catch (error) {
        if (!(error instanceof ConnectorPackagePolicyError)) throw error;
        results.push({
          connectorId: connector.id,
          userId: user.id,
          provider: 'all',
          ok: false,
          error: error.code,
        });
        await compensateDistribution(connector);
        return results;
      }
      if (!input) {
        // No key stored yet — nothing to distribute anywhere, and saying so once
        // beats one misleading failure per (member, provider).
        requireRegistryMutation(connectorsDb.setEnabled(id, false));
        return results;
      }
      for (const target of targets.filter((t) => t.writesPerUserConfig)) {
        results.push(await writeOne(connector.id, target.provider, input, user.id));
      }
    }

    // A future proven operator-homed engine shares ONE config file, so a SHARED
    // connector is written once. A PERSONAL connector is never written there:
    // placing one member's key in a file every member reads violates its scope.
    if (connector.credentialMode === 'org_shared') {
      const sharedInput = await buildCentrallyEligibleConnectorMcpInput(
        connector, users[0]?.id ?? 0,
      );
      if (sharedInput) {
        for (const target of targets.filter((t) => !t.writesPerUserConfig)) {
          results.push(await writeOne(connector.id, target.provider, sharedInput, null));
        }
      }
    } else {
      for (const target of targets.filter((t) => !t.writesPerUserConfig)) {
        results.push({
          connectorId: connector.id,
          userId: connector.ownerUserId,
          provider: target.provider,
          ok: false,
          error: 'SHARED_CONFIG_SKIPPED_FOR_PERSONAL_CONNECTOR',
        });
      }
    }

    // `distribute` is also called directly by the OAuth callback. Containment
    // therefore belongs here, not only in key-based callers: any empty/partial
    // placement must survive refresh as disabled + non-green.
    if (results.length === 0 || results.some((result) => !result.ok)) {
      await compensateDistribution(connector);
    }
    return results;
  },

  /**
   * Distributes every enabled connector into ONE member's tree. This is the hook
   * a newly provisioned member needs (T-1227): without it, distribution is a
   * one-time fan-out and every member who joins later is silently missing every
   * connector — the exact failure that cost B-384.
   */
  async distributeAllToUser(userId: number): Promise<DistributionResult[]> {
    const results: DistributionResult[] = [];
    // V2 grants use the fenced placement composition so Claude and Codex consume
    // one resolved grant identity. This hook is the new-member/new-session path;
    // both flags are fail-closed and OFF on fresh installations.
    if (process.env.NASSAJ_CONNECTOR_GRANTS_V2 === '1'
      && isConnectorPlacementWriterEnabled(process.env)) {
      const { reconcileConnectorPlacements } = await import('./connector-placement-composition.js');
      for (const connector of connectorsDb.listEnabledForUser(userId)) {
        const reconciled = await reconcileConnectorPlacements(connector.id, userId, process.env);
        results.push({
          connectorId: connector.id,
          userId,
          provider: 'all',
          ok: reconciled.state === 'verified',
          ...(reconciled.state === 'verified' ? {} : { error: 'CONNECTOR_GRANT_PLACEMENT_INCOMPLETE' }),
        });
      }
      return results;
    }
    // Per-member targets only: the operator-homed configs already hold every
    // connector, so a new member inherits those by virtue of the file being
    // shared. Re-writing them here would repeat a completed write once per join.
    const targets = providerMcpService
      .listMcpTargets()
      .filter((target) => target.writesPerUserConfig);

    for (const connector of connectorsDb.listEnabledForUser(userId)) {
      const resultStart = results.length;
      let input: UpsertProviderMcpServerInput | null;
      try {
        input = await buildCentrallyEligibleConnectorMcpInput(connector, userId);
      } catch (error) {
        // A row that refuses to build — the path-containment check is the only
        // thing that throws here — must not strand the rest. This loop runs when
        // somebody JOINS, so an escape would cost the new member every OTHER
        // connector as well. Recorded as a failed row instead of thrown;
        // `provider: 'all'` says no engine was reached, not that one failed.
        results.push({
          connectorId: connector.id,
          userId,
          provider: 'all',
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        await compensateDistribution(connector);
        continue;
      }
      if (!input) {
        await compensateDistribution(connector);
        continue;
      }
      for (const target of targets) {
        results.push(await writeOne(connector.id, target.provider, input, userId));
      }
      if (results.slice(resultStart).some((result) => !result.ok)) {
        await compensateDistribution(connector);
      }
    }
    return results;
  },

  /**
   * User deletion cannot cascade a personal connector row: doing so would lose
   * the only lifecycle handle before its engine placements and credential have
   * been reconciled. This is a read-only precondition; it deliberately performs
   * no cleanup or mutation.
   */
  assertUserDeletionAllowed(userId: number): void {
    if (connectorsDb.list().some((connector) => connector.ownerUserId === userId)) {
      throw new AppError(
        'Remove this user\'s connectors through their connector lifecycle before deleting the account.',
        { code: 'CONNECTOR_LIFECYCLE_REQUIRED', statusCode: 409 },
      );
    }
  },

  /**
   * Removes a connector: its registrations from every member's config, its
   * encrypted key, then the row — in that order.
   *
   * Order matters. Dropping the row first would leave the config entries with no
   * definition to clean them up from, so every member would keep a dead MCP
   * server pointing at a revoked key with nothing in the UI to explain it.
   *
   * THE GRANT GOES WITH THE ROW. For an OAuth connector the tokens on disk ARE
   * the credential — there is no key to rotate and no row to invalidate — so a
   * delete that swept the registrations and the secret store but left the auth
   * directory standing was not a withdrawal of access at all: the tokens kept
   * refreshing themselves, and adding the same platform back reported
   * `configured` immediately, still signed in as whoever approved it the first
   * time (B-543). Cleared for every member the connector reached, using the same
   * target set as the sweep so a personal grant and a shared one are each
   * removed from exactly the trees they were written to.
   */
  async remove(id: string): Promise<{ removed: boolean; revocationPending?: boolean; cleanupRequired?: boolean }> {
    const connector = requireConnector(id);
    const name = mcpServerNameFor(connector);

    if (connector.authMode === 'oauth') {
      const targets = sweepTargets(connector);
      // Durable DB containment precedes the first filesystem lock/await. A
      // partial tombstone pass therefore remains disabled and retryable.
      requireRegistryMutation(connectorsDb.setEnabled(id, false));
      let cleanupRequired = false;
      const drainedUsers = new Set<number>();
      const markerFailures: number[] = [];
      // The durable withdrawal marker must win before any cleanup can fail.
      for (const user of targets) {
        try {
          const marker = await markGrantRevocationPending(grantFilePath(user.id, connector.id));
          if (marker.drained) drainedUsers.add(user.id);
          else cleanupRequired = true;
        } catch {
          markerFailures.push(user.id);
        }
      }
      if (markerFailures.length > 0) {
        throw new AppError(
          `Could not persist OAuth revocation marker for user targets: ${markerFailures.join(', ')}.`,
          { code: 'CONNECTOR_OAUTH_REVOCATION_MARKER_FAILED', statusCode: 503 },
        );
      }
      for (const user of targets) {
        if (!drainedUsers.has(user.id)) continue;
        try {
          requireSuccessfulCleanup(await providerMcpService.removeMcpServerFromAllProviders({
            name, scope: 'user', userId: user.id,
          }));
        } catch {
          cleanupRequired = true;
        }
      }
      return { removed: false, revocationPending: true, cleanupRequired };
    }

    // Contain before the first filesystem mutation. An early member/provider
    // may be swept successfully before a later cleanup fails; the retained row
    // must not remain eligible for a future-session distribution in that
    // partial state. The row and credential stay as the retry handle.
    requireRegistryMutation(connectorsDb.setEnabled(id, false));
    for (const user of sweepTargets(connector)) {
      const cleanup = await providerMcpService.removeMcpServerFromAllProviders({
        name,
        scope: 'user',
        userId: user.id,
      });
      requireSuccessfulCleanup(cleanup);
    }

    // Only now is registry/credential loss safe. This removes future-session
    // placements; it does not claim to terminate MCP children already held by a
    // live model session.
    deleteNamespacedSecret(scopeFor(connector), 'connector', connector.id);
    return { removed: connectorsDb.remove(id) };
  },

  /**
   * Enables/disables distribution without losing the row or the key.
   *
   * DISABLING DOES NOT DROP AN OAUTH GRANT, deliberately — the one asymmetry
   * with `remove`. Disabling is a pause the operator expects to undo, and the
   * grant is the single credential nassaj cannot restore on its own: clearing it
   * would send the member back through a browser consent screen to recover from
   * a switch somebody flicked off and on again. Withdrawing access is what
   * DELETING a connector is for, and keeping the two acts distinct is what makes
   * "disabled" mean something other than "deleted slowly".
   */
  async setEnabled(id: string, enabled: boolean): Promise<ConnectorStatus> {
    const connector = requireConnector(id);

    if (enabled) {
      if (connector.enabled) return this.get(id, connector.ownerUserId ?? undefined);
      requireRegistryMutation(connectorsDb.setEnabled(id, true));
      try {
        requireSuccessfulDistribution(await this.distribute(id));
      } catch (error) {
        requireRegistryMutation(connectorsDb.setEnabled(id, false));
        throw error;
      }
    } else {
      // Contain first. Even if cleanup fails, no future distribution pass may
      // treat the row as enabled. A disabled row is NOT a no-op: retrying this
      // action is the recovery path for a prior unverified/failed cleanup.
      requireRegistryMutation(connectorsDb.setEnabled(id, false));
      const name = mcpServerNameFor(connector);
      for (const user of sweepTargets(connector)) {
        const cleanup = await providerMcpService.removeMcpServerFromAllProviders({
          name,
          scope: 'user',
          userId: user.id,
        });
        requireSuccessfulCleanup(cleanup);
      }
    }

    return this.get(id, connector.ownerUserId ?? undefined);
  },

  /**
   * Replaces the non-secret startup values (Slack's workspace id and friends).
   *
   * Re-distributes because those values travel in the server's environment
   * exactly like the key does: changing them without redistributing leaves every
   * member's engine booting the connector with the OLD value, which fails in a
   * way that looks like a bad key.
   */
  async setExtraEnv(id: string, extraEnv: Record<string, string>): Promise<ConnectorStatus> {
    const connector = requireConnector(id);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(extraEnv ?? {})) {
      if (typeof v === 'string' && v.trim() !== '') clean[k] = v.trim();
    }
    requireRegistryMutation(connectorsDb.setExtraEnv(id, clean));
    // Extra configuration is commonly entered before the key/browser grant.
    // In that unlinked state no placement exists or is expected, so do not call
    // `distribute` (whose empty-result containment would correctly disable an
    // attempted placement).
    if (credentialSource(connector, connector.ownerUserId ?? undefined) === null) {
      return this.get(id, connector.ownerUserId ?? undefined);
    }
    try {
      const distribution = await this.distribute(id);
      requireSuccessfulDistribution(distribution);
    } catch (error) {
      requireRegistryMutation(connectorsDb.setEnabled(id, false));
      throw error;
    }
    return this.get(id);
  },

  /**
   * Moves a stored credential between "mine" and "the team's".
   *
   * Needed because adding a platform is now ONE CLICK (owner request,
   * 2026-08-07): the row is created first and the key form comes afterwards, so
   * the isolation question — which used to be answered before the row existed —
   * is answered on a row that already does. The move is not cosmetic: it changes
   * WHO the credential reaches, so it sweeps the old audience before
   * distributing to the new one, and refuses a platform that forbids sharing.
   */
  async setCredentialMode(id: string, mode: 'per_member' | 'org_shared'): Promise<ConnectorStatus> {
    const connector = requireConnector(id);
    if (connector.credentialMode === mode) return this.get(id);
    // B-741 containment: moving the row without moving its encrypted credential
    // atomically either loses the key or exposes a personal key team-wide. Keep
    // the existing connection intact until the transaction/ledger phase exists.
    throw new AppError(
      'Changing a connector between personal and shared is temporarily disabled. Remove it and connect it again with the intended visibility.',
      { code: 'CONNECTOR_MODE_CHANGE_DISABLED', statusCode: 409 },
    );
  },
};
