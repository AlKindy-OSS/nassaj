import os from 'node:os';
import path from 'node:path';

import express, { type Request, type Response } from 'express';

import costRoutes from '@/modules/providers/cost.routes.js';
import resourceRoutes from '@/modules/providers/resources.routes.js';
import { DeviceBoundSseStream } from '@/modules/account-wallet/index.js';
import { antigravityActiveModelService } from '@/modules/providers/services/antigravity-active-model.service.js';
import {
  providerQuotaService,
  resolveQuotaVendor,
} from '@/modules/providers/services/usage/provider-quota.service.js';
import { claudeUsageService } from '@/modules/providers/services/claude-usage.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { companyCredentialsService } from '@/modules/providers/services/company-credentials.service.js';
import { providerCredentialsService } from '@/modules/providers/services/provider-credentials.service.js';
import { providerGovernanceLinkService } from '@/modules/providers/services/provider-governance-link.service.js';
import {
  providerGovernanceService,
  resolveGovernanceLinkPlan,
  type ProviderGovernanceChannel,
  type ProviderGovernanceLinkRefusal,
} from '@/modules/providers/services/provider-governance.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { readSessionSkills } from '@/modules/providers/services/skill-observations.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { readSessionActivity } from '@/modules/providers/services/session-activity.service.js';
import type { HistoryPayloadMode } from '@/modules/providers/services/session-history-light.service.js';
import { assertSessionAccessible, readMessageDelivery, sessionsService } from '@/modules/providers/services/sessions.service.js';
import { notifySessionMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';
import { workflowStatusService } from '@/modules/providers/services/workflow-status.service.js';
import { isEngineSwitchBlocked } from '@/modules/providers/services/engine-switch-liveness.service.js';
import {
  agentStatusService,
  isValidAgentId,
} from '@/modules/providers/services/agent-status.service.js';
import {
  auditLogDb,
  canAccessProjectPath,
  captureWorkspaceTopologyFence,
  closedSessionsDb,
  isProjectMembershipEnforced,
  isWorkspaceTopologyFenceCurrent,
  projectsDb,
  sessionAgentsDb,
  sessionsDb,
  userDb,
  type WorkspaceTopologyFence,
} from '@/modules/database/index.js';
import { OFFICIAL_ENGINE, PIN_SOURCE } from '@/services/isolation/engine-pin.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
import { coerceUserId } from '@/modules/projects/index.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderChangeActiveModelInput,
  ProviderQuotaWindows,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
// Deliberately use the narrow leaf modules: the database barrel is expensive and
// creates circular test mocks for routes that only need the permission seam.
// eslint-disable-next-line boundaries/dependencies
import { runPermissionExecutionAdapter } from '@/modules/execution-permissions/adapter.js';
// eslint-disable-next-line boundaries/dependencies
import { authorizeRuntimeUserProviderEffect } from '@/modules/execution-permissions/runtime-user-effect.js';

import {
  ELIGIBLE_ENGINE_PROVIDERS,
  type EligibleEngineProviderId,
} from '../../../shared/engineProviders.js';

import localModelsRoutes from './local-models.routes.js';
import { HistoryHttpSink } from './services/history-response.service.js';

const router = express.Router();
router.use('/local', localModelsRoutes);

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

// Pulls the authenticated user id off the request. `req.user` is populated by the
// authenticateToken middleware that guards this whole router (see index.js mount).
// A null id maps the per-user secrets store to its single-operator shared file.
const readAuthenticatedUserId = (req: Request): string | number | null =>
  (req as Request & { user?: { id?: string | number } }).user?.id ?? null;

// Normalized numeric id of the authenticated caller, or null when unresolved.
// Used by ownership-gated session reads (B-105) where the value must be a DB
// user id, not the raw secrets-store key. `req.user` is set by authenticateToken
// (the whole router is mounted behind it), so a null here means no usable
// identity and the gate downstream refuses access fail-closed.
const readRequesterUserId = (req: Request): number | null =>
  coerceUserId((req as Request & { user?: { id?: string | number } }).user?.id ?? null);

type IdentityFencedRequest = Request & { assertCurrentIdentity?: () => boolean };

const accessFenceError = (
  code: 'identity_changed' | 'project_access_changed',
  notStarted: boolean,
): AppError => new AppError(
  code === 'identity_changed'
    ? 'Identity changed during request.'
    : 'Project access changed during request.',
  {
    code,
    statusCode: 409,
    details: { notStarted, ...(notStarted ? {} : { effectState: 'outcome_unknown' }) },
  },
);

/** Captures one session's immutable project/topology authority after its mandate check. */
function captureSessionRequestFence(
  req: Request,
  sessionId: string,
  access: 'read' | 'write' | 'restamp',
): WorkspaceTopologyFence | null {
  const fenced = req as IdentityFencedRequest;
  if (fenced.assertCurrentIdentity?.() !== true) throw accessFenceError('identity_changed', true);
  const userId = readRequesterUserId(req);
  const session = assertSessionAccessible(sessionId, userId, access);
  if (!isProjectMembershipEnforced()) return null;
  const workspaceFence = captureWorkspaceTopologyFence(session.project_path ?? '', userId, {
    sessionId,
    consent: access === 'read' ? 'read' : 'control',
  });
  if (!workspaceFence) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND', statusCode: 404,
    });
  }
  return workspaceFence;
}

/** Rechecks identity and the exact captured project immediately at a boundary. */
function assertSessionRequestFence(
  req: Request,
  workspaceFence: WorkspaceTopologyFence | null,
  notStarted: boolean,
): void {
  if ((req as IdentityFencedRequest).assertCurrentIdentity?.() !== true) {
    throw accessFenceError('identity_changed', notStarted);
  }
  if (workspaceFence && !isWorkspaceTopologyFenceCurrent(workspaceFence)) {
    throw accessFenceError('project_access_changed', notStarted);
  }
}

function assertRequestIdentity(req: Request, notStarted: boolean): void {
  if ((req as IdentityFencedRequest).assertCurrentIdentity?.() !== true) {
    throw accessFenceError('identity_changed', notStarted);
  }
}

/** Reuses the exact registered-project token pair so stream checks stay O(projects). */
export function retainDistinctWorkspaceFence(
  fences: Set<WorkspaceTopologyFence>,
  candidate: WorkspaceTopologyFence,
): WorkspaceTopologyFence {
  if (candidate.kind === 'project') {
    for (const existing of fences) {
      if (existing.kind === 'project'
          && existing.userId === candidate.userId
          && existing.subjectAccessToken === candidate.subjectAccessToken
          && existing.projectStructureToken === candidate.projectStructureToken) {
        return existing;
      }
    }
  }
  fences.add(candidate);
  return candidate;
}

const BULK_SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

/** Parses a bounded, order-preserving set of session ids for bulk mutations. */
function parseBulkSessionIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('Request body must be an object with an ids array.', {
      code: 'INVALID_BULK_IDS', statusCode: 400,
    });
  }
  const ids = (payload as Record<string, unknown>).ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
    throw new AppError('ids must contain between 1 and 100 session ids.', {
      code: 'INVALID_BULK_IDS', statusCode: 400,
    });
  }
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!BULK_SESSION_ID_PATTERN.test(id)) {
      throw new AppError('ids contains an invalid session id.', {
        code: 'INVALID_BULK_IDS', statusCode: 400,
      });
    }
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  return uniqueIds;
}

function parseBulkSessionAction(payload: unknown): 'archive' | 'restore' | 'close' | 'reopen' | 'delete_permanently' {
  const action = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).action
    : null;
  if (action === 'archive' || action === 'restore' || action === 'close' || action === 'reopen' || action === 'delete_permanently') {
    return action;
  }
  throw new AppError('action must be archive, restore, close, reopen, or delete_permanently.', {
    code: 'INVALID_BULK_ACTION', statusCode: 400,
  });
}

type BulkMutationResult =
  | { id: string; success: true; result: unknown }
  | { id: string; success: false; error: { code: string; message: string } };

function bulkFailure(id: string, error: unknown): BulkMutationResult {
  // Mutation authorization deliberately has the same not-found answer as an
  // unknown id. Never turn a per-id failure into an existence oracle.
  if (error instanceof AppError) {
    return { id, success: false, error: { code: error.code, message: error.message } };
  }
  return { id, success: false, error: { code: 'BULK_ACTION_FAILED', message: 'Bulk action failed.' } };
}

function notifyChangedSession(sessionId: string, provider: string | null | undefined): void {
  notifySessionMetadataChanged((provider ?? 'claude') as Parameters<typeof notifySessionMetadataChanged>[0], sessionId);
}

// Reads the raw API key from a key-set body without ever logging or echoing it.
// Presence/emptiness is enforced by the service so the 400 contract lives in one place.
const readApiKeyFromBody = (payload: unknown): unknown => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  return (payload as Record<string, unknown>).apiKey;
};

// Reads the authenticated caller's role (owner/admin/member). Set by
// authenticateToken alongside req.user.id. Absent → treated as no elevated role.
const readAuthenticatedUserRole = (req: Request): string | null =>
  (req as Request & { user?: { role?: string } }).user?.role ?? null;

const runAuthorizedProviderSideQuery = <T>(
  req: Request,
  purpose: 'quota' | 'balance',
  provider: string,
  effect: () => Promise<T>,
): Promise<T> => {
  const execution = authorizeRuntimeUserProviderEffect({
    authenticatedPrincipal: (req as Request & { user?: unknown }).user,
    provider,
    engine: `${provider}_${purpose}`,
    entrypoint: `provider.routes.${purpose}`,
    purpose,
    effectFootprint: 'external',
    projectId: `system:provider-${purpose}`,
    workspacePath: process.cwd(),
  });
  return runPermissionExecutionAdapter(execution, effect);
};

// Optional credential target (opencode: anthropic|openai|openrouter). Read from
// the body on writes and from the query string on read/delete. Absent → the
// writer's default target.
const readOptionalTarget = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/** Why this caller may not write this credential. `undefined` when they may. */
export type CredentialWriteRefusal = 'shared_requires_admin';

/**
 * The T-866 authorization rule, evaluated ONCE for both the gate and the UI
 * (B-362). A write that would touch the OPERATOR's shared credentials (provider
 * not isolated per policy) is restricted to owner/admin; isolated per-user
 * writes are allowed for any authenticated member (their own tree — userId comes
 * from the token only).
 *
 * WHY THIS IS A FUNCTION AND NOT TWO IFs. The gate below existed; the UI had no
 * way to ask it. `GET /:provider/api-key/capability` is role-free BY DESIGN (it
 * says so at its handler) — it answers "how is this key written", never "may
 * YOU write it". So the entry surface rendered a field, a Save button and a
 * "get a key" link to every member, for the four opencode slots that default to
 * `shared` — and refused with 403 only AFTER they had bought a key and pasted
 * it. Nobody caught it because the only account that never sees that slot is the
 * operator's: they are `owner`, so every manual check passed.
 *
 * Deciding the same rule in two places is how those two answers drift, so the
 * gate and the status endpoint now read this one function.
 */
const evaluateCredentialWrite = (
  req: Request,
  provider: string,
): { writable: boolean; reason?: CredentialWriteRefusal } => {
  if (!providerCredentialsService.requiresElevatedRole(provider)) {
    return { writable: true };
  }
  const role = readAuthenticatedUserRole(req);
  if (role === 'owner' || role === 'admin') {
    return { writable: true };
  }
  return { writable: false, reason: 'shared_requires_admin' };
};

/**
 * Platform mode, read at CALL time from the same variable `server/constants/config.js`
 * defines it from (`VITE_IS_PLATFORM === 'true'`). Not imported from there because
 * that module is outside the module-boundary graph this folder is allowed to reach;
 * duplicating one comparison is cheaper than widening the boundary rule, and reading
 * it per call (rather than at import) means a test can set it without module games.
 *
 * WHY IT GATES A GOVERNANCE WRITE AT ALL: platform mode does not authenticate
 * differently — it DISABLES authentication and answers every request as the first
 * user, so `role === 'owner'` there means "anyone who opened a socket"
 * (middleware/auth.js:49-58, B-186). ADR-093 §3.2-1 names this exact hole.
 */
const isPlatformMode = (): boolean => process.env.VITE_IS_PLATFORM === 'true';

/**
 * The ONE authorization rule for the ADR-093 §4 link action, read by both answers:
 * the GET that decides whether a button is offered, and the POST that performs the
 * write. Deciding it twice is how a surface starts promising what the endpoint
 * refuses (B-362).
 *
 * Returns null when the caller may link this channel, else the refusal to show.
 */
const evaluateGovernanceLink = (
  req: Request,
  channel: ProviderGovernanceChannel,
): ProviderGovernanceLinkRefusal | null => {
  if (!channel.linkable) {
    // A mechanism-level refusal (claude's symlink, shared agy, no mechanism) —
    // already decided by the plan; the role cannot change it.
    return channel.linkRefusal ?? 'no_mechanism';
  }
  if (readAuthenticatedUserId(req) === null) {
    return 'owner_required';
  }
  if (isPlatformMode()) {
    // Platform mode disables authentication, so every caller reads as the first
    // user (owner). No governance write is offered under it (B-186).
    return 'owner_required';
  }
  if (channel.linkScope === 'operator' && readAuthenticatedUserRole(req) !== 'owner') {
    // The write lands in the operator home: it re-governs every user on this node.
    return 'owner_required';
  }
  return null;
};

/** Folds the caller's authorization into the channel the client receives. */
const applyLinkAuthorization = (
  req: Request,
  channel: ProviderGovernanceChannel,
): ProviderGovernanceChannel => {
  const refusal = evaluateGovernanceLink(req, channel);
  return refusal === null
    ? { ...channel, linkable: true, linkRefusal: null }
    : { ...channel, linkable: false, linkRefusal: refusal };
};

/** Throws 403/400 when the link action is not allowed for this caller. */
const assertGovernanceLinkAllowed = (
  req: Request,
  provider: LLMProvider,
  userId: string | number | null,
): void => {
  const plan = resolveGovernanceLinkPlan(provider, userId);
  const refusal = evaluateGovernanceLink(req, {
    ...NO_CHANNEL_SHAPE,
    linkable: plan.linkable,
    linkScope: plan.linkScope,
    linkRefusal: plan.refusal,
  });
  if (refusal === null) {
    return;
  }
  const forbidden = refusal === 'owner_required';
  throw new AppError(
    forbidden
      ? 'Establishing governance in the operator home requires the owner.'
      : 'This engine has no governance channel to establish.',
    {
      code: forbidden ? 'GOVERNANCE_LINK_FORBIDDEN' : 'GOVERNANCE_LINK_UNAVAILABLE',
      statusCode: forbidden ? 403 : 400,
      details: { refusal },
    },
  );
};

/** Field filler for the authorization probe above — only the link fields matter. */
const NO_CHANNEL_SHAPE: ProviderGovernanceChannel = {
  id: 'probe',
  scope: 'user',
  path: null,
  link: null,
  mechanism: 'none',
  verification: 'none',
  enforcement: 'none',
  status: 'ungoverned',
  reason: 'no_mechanism',
  linkable: false,
  linkScope: null,
  linkRefusal: 'no_mechanism',
};

/** Throws 403 when `evaluateCredentialWrite` refuses. */
const assertCredentialWriteAllowed = (req: Request, provider: string): void => {
  if (evaluateCredentialWrite(req, provider).writable) {
    return;
  }
  throw new AppError('Configuring shared provider credentials requires an admin or owner.', {
    code: 'CREDENTIAL_WRITE_FORBIDDEN',
    statusCode: 403,
  });
};

/**
 * Authorization gate for EVERY MCP mutation, at every scope (B-345).
 *
 * An MCP server definition is not configuration — it is an executable: the
 * payload carries `command`, `args`, `env` and `headers`, and the harness spawns
 * it verbatim. Every provider on this box runs as the same uid, so a definition
 * written by one member executes with every other member's credentials the next
 * time any of them opens a session in that workspace.
 *
 * The previous gate only fired on `scope === 'user'`, leaving `local` writable
 * by any authenticated member — and `local` lands in the OPERATOR's
 * `~/.claude.json`, keyed by workspace, ignoring userId entirely. That path was
 * dormant only because the reader looked for a key the writer never produced
 * (B-344); repairing the reader without this gate would have turned a dormant
 * write into cross-user code execution.
 *
 * The line is WHERE THE FILE LIVES, not who owns the project:
 *  - `user` and `local` on a SHARED provider write the operator's own config
 *    file, which every member's sessions load → owner/admin, the bar
 *    `/mcp/servers/global` already keeps.
 *  - `user` and `local` on an ISOLATED provider write
 *    `~/.nassaj-users/<caller>/…`, a file only that member's own spawns read →
 *    any authenticated member, for their own tree (T-1177, see below).
 *  - `project` writes `<workspace>/.mcp.json`, which is inside the project and
 *    already fenced by `resolveAuthorizedWorkspacePath` — the same file a member
 *    could commit to the repo anyway. Gating it would take away a legitimate
 *    per-project capability without closing anything.
 *
 * WHY THE MEMBER CASE IS SAFE, AND WHY IT WAS NOT BEFORE (T-1177, after B-384).
 * The original blanket role check was correct when it was written: BOTH sides of
 * the claude provider used the operator's `~/.claude.json`, so a member's entry
 * really did execute inside every other member's session. B-384 moved the writer
 * onto the same per-user file the spawn reads, so on an isolated provider the
 * blast radius of a member's definition is now exactly their own sessions —
 * where they can already run arbitrary commands through their own agent turns.
 * Keeping the gate would deny a capability without closing anything, which is
 * the same trade the `project` scope was already deliberately allowed on.
 *
 * The condition is READ FROM THE SHARING POLICY rather than hard-coded per
 * provider: it is the same predicate `resolveProviderEnv` uses to place the file,
 * so the gate and the destination cannot disagree, and flipping a provider back
 * to `shared` through the admin route re-arms the bar on the next request. The
 * policy is cached in-process (the spawn hot path reads it constantly) and that
 * cache is refreshed synchronously on write — so the honest guarantee is that
 * this gate keeps no decision of its OWN, not that no cache exists anywhere.
 * Writing `app_config` behind the service would leave both this gate and the
 * spawn placement stale together, never one without the other.
 *
 * Reads are untouched — listing is already workspace-authorized.
 */
const assertGenericMcpProviderEnabled = (provider: string): void => {
  if (provider === 'gemini') {
    throw new AppError(
      'Gemini MCP management is disabled because the installed runtime is agy.',
      { code: 'GEMINI_GENERIC_MCP_DISABLED', statusCode: 403 },
    );
  }
};

const assertMcpWriteAllowed = (req: Request, scope: McpScope, provider: string): void => {
  assertGenericMcpProviderEnabled(provider);
  if (!providerMcpService.providerSupportsMcp(provider)) {
    throw new AppError('This provider MCP surface is not enabled.', {
      code: 'MCP_WRITE_FORBIDDEN',
      statusCode: 403,
    });
  }
  if (scope === 'project') {
    return;
  }
  // BOTH halves are required, and neither implies the other. The policy says where
  // the SPAWN reads; `writesPerUserConfig` says whether the WRITER follows the
  // caller. opencode is the counter-example that makes this compound predicate
  // mandatory: an admin can mark it `isolated` while its writer still resolves
  // `os.homedir()/.config/opencode` with no userId, so trusting the policy alone
  // would hand every member a write into the operator's file (B-345, reopened).
  if (isProviderIsolated(provider) && providerMcpService.providerWritesPerUserMcpConfig(provider)) {
    return;
  }
  const role = readAuthenticatedUserRole(req);
  if (role !== 'owner' && role !== 'admin') {
    throw new AppError(
      'Registering or removing an MCP server requires an admin or owner: the definition is executed by every session in this workspace.',
      { code: 'MCP_WRITE_FORBIDDEN', statusCode: 403 },
    );
  }
};

/**
 * Appends one line to the append-only audit log for every MCP mutation (T-1177).
 *
 * An MCP definition is executable, and members may now register one on a per-user
 * provider. "Which servers exist on this install, put there by whom" must therefore
 * be answerable after the fact — before this, the MCP routes recorded nothing at
 * all. `command`/`args` are recorded because they ARE the security-relevant
 * content; `env` and `headers` are deliberately NOT, since they carry tokens.
 */
const recordMcpMutation = (
  req: Request,
  action: 'mcp_server_upsert' | 'mcp_server_remove',
  details: { provider: string; scope: McpScope; name: string; command?: string; args?: string[] },
): void => {
  auditLogDb.record(action, {
    userId: coerceUserId(readAuthenticatedUserId(req)) ?? undefined,
    metadata: {
      provider: details.provider,
      scope: details.scope,
      name: details.name,
      role: readAuthenticatedUserRole(req) ?? 'unknown',
      command: details.command,
      args: details.args,
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
  });
};

// MCP scopes whose config file is resolved RELATIVE to the caller-supplied
// workspacePath (project: <ws>/.mcp.json, <ws>/.cursor/mcp.json, … ; local:
// keyed by <ws> inside the shared home config). The 'user' scope is the only one
// that ignores it. Everything in this set must pass the containment guard below.
const isWorkspaceScopedMcpScope = (scope: McpScope | undefined): boolean =>
  scope === 'project' || scope === 'local';

/**
 * Containment + authorization guard for the caller-supplied MCP `workspacePath`
 * (B-IDOR-MCP).
 *
 * The path used to travel straight from the query string / body into
 * `path.join(workspacePath, '.mcp.json')` and a `mkdir -p` + `writeFile`, with no
 * guard whatsoever (the only check on these routes was scoped to
 * `provider === 'codex' && scope === 'user'`). Any authenticated user could
 * therefore drop a `.mcp.json` — with an arbitrary `command` — into ANY directory
 * on the host, including another user's project root, where it executes on that
 * user's next agent run. The read side is the mirror image: `.mcp.json` could be
 * read out of any directory.
 *
 * The guard resolves the supplied path exactly as the service will
 * (`path.resolve`, matching `resolveWorkspacePath` in shared/mcp/mcp.provider.ts),
 * demands that it be a REGISTERED project row, and authorizes the caller against
 * it with the matching mandate: visibility to read, write-membership to write
 * ('public' confers read, never write — B-138). It then returns the project's
 * CANONICAL stored path, which is what gets forwarded downstream, so the path
 * that was authorized is byte-for-byte the path that is written — no room for the
 * check and the write to diverge, and no traversal (`../`) survives, since only an
 * exact project root matches a row.
 *
 * Returns undefined when the caller supplied no path (the callers then refuse the
 * operation for workspace-scoped requests rather than letting the service fall
 * back to the server's own cwd). Throws 404 — never 403 — so a probe cannot
 * distinguish "not yours" from "does not exist".
 */
const resolveAuthorizedWorkspacePath = (
  req: Request,
  workspacePath: string | undefined,
  mode: 'read' | 'write',
): string | undefined => {
  if (workspacePath === undefined) {
    return undefined;
  }

  const requesterUserId = readRequesterUserId(req);
  const project = projectsDb.getProjectPath(path.resolve(workspacePath));
  const authorized =
    project !== null &&
    (mode === 'read'
      ? projectsDb.isProjectVisibleToUser(project.project_id, requesterUserId)
      : projectsDb.isProjectWritableByUser(project.project_id, requesterUserId));

  if (!project || !authorized) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  return project.project_path;
};

/**
 * A workspace-scoped MCP WRITE with no workspacePath would resolve against
 * `process.cwd()` — the server's own installation directory — so it is refused
 * outright instead of silently writing there.
 */
const assertWorkspacePathPresentForWrite = (
  scope: McpScope,
  workspacePath: string | undefined,
): void => {
  if (isWorkspaceScopedMcpScope(scope) && !workspacePath) {
    throw new AppError('workspacePath is required for project/local scoped MCP servers.', {
      code: 'MCP_WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

/**
 * The engine axis as this route accepts it: an eligible vendor engine, or the
 * official path. Kept as a named alias so the two literals never drift apart
 * between the parser, the key check and the catalog lookup.
 */
type RestampEngine = EligibleEngineProviderId | typeof OFFICIAL_ENGINE;

/**
 * ADR-099 re-stamp payload. Validates the ENGINE axis against its own declared
 * eligibility list (never a hand-written array — `deepseek` was added in
 * 15bf86c2 and every derived list followed automatically; a literal here would
 * have silently excluded it — qa-critic تحسين 14).
 */
const parseEngineRestampPayload = (
  payload: unknown,
): { engine: RestampEngine; model: string; acknowledgedExport: boolean } => {
  const body = (payload ?? {}) as Record<string, unknown>;
  const engine = typeof body.engine === 'string' ? body.engine.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';

  const eligible: readonly string[] = ELIGIBLE_ENGINE_PROVIDERS;
  if (engine !== OFFICIAL_ENGINE && !eligible.includes(engine)) {
    throw new AppError(`Unknown engine "${engine}".`, {
      code: 'INVALID_ENGINE_PROVIDER',
      statusCode: 400,
    });
  }
  if (!model) {
    throw new AppError('A model is required: the engine and the model move together.', {
      code: 'INVALID_MODEL',
      statusCode: 400,
    });
  }

  return {
    engine: engine as RestampEngine,
    model,
    acknowledgedExport: body.acknowledgedExport === true,
  };
};

/**
 * How many assistant turns this session has produced — i.e. how much history a
 * switch would replay to the new provider. Read from the same per-session model
 * cache the UI's model chips use, so it costs one indexed query and never opens
 * a transcript that may be tens of megabytes.
 *
 * Used ONLY to decide whether consent is required and to record how much was
 * exported; an undercount would weaken the prompt, never the authorization, and
 * the cache is populated by the same sync that draws the conversation.
 */
const countSessionAssistantTurns = (sessionId: string): number => {
  try {
    return sessionAgentsDb
      .listBySession(sessionId)
      .reduce((sum, row) => sum + (Number(row.invocation_count) || 0), 0);
  } catch {
    return 0;
  }
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    cwd: readOptionalQueryString(body.cwd),
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bearerTokenEnvVar: readOptionalQueryString(body.bearerTokenEnvVar),
    envHttpHeaders: typeof body.envHttpHeaders === 'object' && body.envHttpHeaders !== null
      ? Object.fromEntries(
        Object.entries(body.envHttpHeaders as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
  };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'gemini'
    || normalized === 'antigravity'
    || normalized === 'opencode'
    || normalized === 'hermes'
    || normalized === 'kimi'
    || normalized === 'deepseek'
    || normalized === 'glm'
    || normalized === 'qwen'
    || normalized === 'sakana'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

// ----------------- Cost routes (/api/providers/costs/*) -----------------
// Mounted before the generic `/:provider/*` routes so 'costs' is never captured
// as a provider name. Its own module: cost answers carry their own honesty
// contract (available / metered / complete) and their own session gate.
router.use('/costs', costRoutes);

// ----------------- Resource routes (/api/providers/resources/*) -----------------
// قبل مسارات `/:provider/*` العامة كي لا تُلتقط 'resources' اسمَ مزوّد. قياس
// موارد المحادثة والجهاز — قراءة محضة من /proc، بنفس بوابة رؤية المحادثة.
router.use('/resources', resourceRoutes);

// ----------------- Claude usage route -----------------
// Specific path declared before the generic `/:provider/*` routes so it is not
// shadowed. Calls Anthropic from the backend only; the OAuth token never leaves
// the server. Cached >= 180s per resolved credential with stale fallback on 429.
// The authenticated user is forwarded so an isolated user sees THEIR own
// subscription usage, not the operator's (ADR-014).
router.get(
  '/claude/usage',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;
      const usage = await claudeUsageService.getUsage(
        userId,
        effect => runAuthorizedProviderSideQuery(req, 'quota', 'claude', effect),
      );
      res.json(usage);
    } catch (error) {
      // Emit the flat frontend error contract `{ error, code }` with a real
      // status (never a silent 500). User-facing messages stay generic.
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      res.status(502).json({
        error: 'Claude usage is currently unavailable.',
        code: 'CLAUDE_USAGE_UNAVAILABLE',
      });
    }
  }),
);

// ----------------- Per-provider quota windows route -----------------
// Specific path declared before the generic `/:provider/*` routes so it is not
// shadowed. Quota as the PROVIDER itself reports it, read backend-side only —
// the token/key never leaves the server (ADR-014, same rule as /claude/usage).
//
// Only codex and glm have an official machine-readable quota endpoint (survey
// 2026-07-30, see provider-quota.service.ts). Everything else answers 404 with
// an explicit code: "no source" is a real answer and must be distinguishable
// from "the request failed" — a 200 with zeros would be a fabricated number.
// claude is deliberately NOT routed here; it keeps /claude/usage.
router.get(
  '/:provider/quota',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = String(req.params.provider ?? '').toLowerCase();
    const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;
    // النموذج الفعّال (اختياري) هو الدليل المستقلّ عن الجهاز على محور المحرّك:
    // جسم `claude` يشغّل `glm-5.2` ⇒ المورّد glm لا anthropic. يُقصّ طوله كي لا
    // يصير معرّفاً حرّاً بلا حدّ.
    const rawModel = typeof req.query.model === 'string' ? req.query.model.trim().slice(0, 200) : '';
    const model = rawModel || null;

    // ‏anthropic جوابٌ صريح لا فشل: يعني «استهلاك حساب Claude» فيتولّاه
    // /claude/usage. وتمييزه عن «لا مصدر» يمنع العميل من عرض نوافذ Anthropic
    // كملاذٍ عند أي تعذّر — وهو الرقم الخاطئ الذي جاء بلاغ 2026-07-30 عنه.
    if (resolveQuotaVendor(provider, model) === 'anthropic') {
      res.status(404).json({
        error: 'This model bills to the Claude account.',
        code: 'PROVIDER_QUOTA_ANTHROPIC',
      });
      return;
    }

    const windows: ProviderQuotaWindows | null = await providerQuotaService.getWindows(
      provider,
      userId,
      { runEffect: effect => runAuthorizedProviderSideQuery(req, 'quota', provider, effect) },
      model,
    );

    if (!windows) {
      res.status(404).json({
        error: 'No quota source for this provider.',
        code: 'PROVIDER_QUOTA_UNAVAILABLE',
      });
      return;
    }

    res.json(windows);
  }),
);

// ----------------- Antigravity active-model route -----------------
// Specific path declared before the generic `/:provider/*` routes so it is not
// shadowed. Read-only: reflects the model the agy CLI last propagated to its
// backend (parsed from the session log). Never changes the selection.
router.get(
  '/antigravity/active-model',
  asyncHandler(async (_req: Request, res: Response) => {
    const activeModel = await antigravityActiveModelService.getActiveModel();
    res.json(activeModel);
  }),
);

// ----------------- Active background workflows (ADR-053, T-53-B3) -----------------
// Specific path declared BEFORE the generic `/:provider/*` routes so it is not
// shadowed. Read-only visibility for B-103: the caller's still-running / orphaned
// background workflows across the sessions they own, with the declared scan cap
// surfaced in the envelope. Fail-closed — `readRequesterUserId` returns a real DB
// user id or null; a null caller yields an empty envelope and NO scan, so an
// unowned session's workflow can never leak. The whole router sits behind
// authenticateToken (mounted in index.js), so `req.user` is the authenticated
// caller. Never throws: the service degrades to an empty envelope on any anomaly.
router.get(
  '/workflows/active',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readRequesterUserId(req);
    const result = await workflowStatusService.getActiveWorkflows(userId);
    res.json(result);
  }),
);

// ----------------- Orphaned background agents (T-873(2)) -----------------
// Specific paths declared BEFORE the generic `/:provider/*` routes so they are
// not shadowed. Read-only visibility for the `Agent` path — the gap the workflow
// endpoint above cannot see (it only walks `subagents/workflows/wf_*`). Answers
// "which of MY agents stopped without handing back a result, and what had they
// produced first". NOTHING here launches or resumes an agent.
//
// Fail-closed: `readRequesterUserId` yields a real DB user id or null; a null
// caller gets an empty envelope and NO scan, and the scan itself never leaves the
// caller's own sessions. Never throws: the service degrades to empty on anomaly.
router.get(
  '/agents/orphans',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readRequesterUserId(req);
    const result = await agentStatusService.getOrphanedAgents(userId);
    res.json(result);
  }),
);

// The recovered final report of ONE agent — the automated replacement for the
// coordinator running `tail` by hand. A malformed id is a 400; anything the
// caller does not own resolves exactly like a nonexistent agent (404, no
// existence oracle) so ownership can never be probed through this route.
router.get(
  '/agents/:agentId/report',
  asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.params.agentId;
    if (!isValidAgentId(agentId)) {
      res.status(400).json({ error: 'Invalid agent id.', code: 'INVALID_AGENT_ID' });
      return;
    }

    const userId = readRequesterUserId(req);
    const report = await agentStatusService.getAgentReport(userId, agentId);
    if (!report) {
      res.status(404).json({ error: 'Agent report not found.', code: 'AGENT_REPORT_NOT_FOUND' });
      return;
    }

    res.json(report);
  }),
);

const parseChangeActiveModelPayload = (payload: unknown): ProviderChangeActiveModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    sessionId: '',
    model,
  };
};

// Only providers with NO real backend registration belong here. kimi/deepseek/glm
// are now fully-registered hosted vendor providers (VendorAuthProvider reads the
// encrypted per-user secrets store), so they must fall through to the real
// getProviderAuthStatus path below — never short-circuit as stubs. `sakana`
// remains a union-only placeholder with no provider folder/registry entry.
const STUB_API_PROVIDERS = new Set<string>(['sakana']);

router.get(
  '/:provider/auth/status',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;

    // Stub API providers: no CLI to probe — always not-configured.
    if (STUB_API_PROVIDERS.has(provider)) {
      res.json(createApiSuccessResponse({
        installed: false,
        authenticated: false,
        email: null,
        method: null,
        provider,
        error: 'Configure via Setup tab',
      }));
      return;
    }

    // Pass the authenticated user so credential-isolating providers report the
    // status of THIS user's resolved environment (CLAUDE_CONFIG_DIR), not the
    // operator's fixed home. `req.user` is set by authenticateToken middleware.
    // `userId` is already resolved at the top of this handler.
    const status = await providerAuthService.getProviderAuthStatus(provider, userId);
    res.json(createApiSuccessResponse(status));
  }),
);

// ----------------- Provider API-key management routes (T-866) -----------------
// Generalized per-user CRUD over provider credentials. Dispatch (in
// provider-credentials.service) is one of three cases per provider:
//   - facet  (claude/codex/opencode): the key is merged into that provider's OWN
//            credential file inside the caller's resolved (isolated) tree;
//   - vendor (kimi/deepseek/glm): the legacy encrypted per-user secrets store;
//   - none   (hermes/cursor/antigravity/gemini): 400 TERMINAL_ONLY.
// The whole router sits behind authenticateToken, so userId is the caller's and
// keys are isolated per user. These routes NEVER return or log the key value —
// only `{ provider, configured }`. Once a key is set, GET /:provider/auth/status
// flips authenticated=true (the auth facet reads the same surface).
//
// Authorization: a write that would touch the OPERATOR's shared credentials
// (provider marked 'shared'/unenrolled in the sharing policy) is restricted to
// owner/admin (403 otherwise); isolated per-user writes are open to any member
// for their OWN tree. Terminal-only providers short-circuit to 400 before any
// role/DB check.

// ----------------- Company-wide key routes (T-1159) -----------------
// ONE paste per COMPANY, fanned out by nassaj to every slot that company owns,
// each in its harness's own native shape. These sit ABOVE the /:provider routes
// deliberately: `/company/:id/key` is three segments and cannot collide with
// `/:provider/api-key`, but registering it first keeps that true if a future
// two-segment `/:provider/:x` route is ever added.
//
// The role rule is evaluated HERE (same `evaluateCredentialWrite` the per-slot
// gate uses) and handed to the service as a boolean, so authorization keeps
// living in exactly one place. A caller without elevated standing is NOT
// refused outright: their isolated slots are still written and the shared ones
// come back marked `forbidden`, because a member configuring their own tree is
// a legitimate call that happens to include slots they cannot touch.
//
// T-1201 — the body may carry `vendorIds` to narrow the fan-out to the slots
// the operator ticked. It is a FILTER over the company named in the path, never
// a selector of what to write: the service intersects it with that company's
// catalog slots and re-runs the role gate and the subscription skip on each
// survivor. So the request body cannot widen a member's reach, cannot reach
// another company's slot, and cannot slip a key into a subscribed harness
// without also asking for `includeSubscription`.
const isElevatedCaller = (req: Request): boolean => {
  const role = readAuthenticatedUserRole(req);
  return role === 'owner' || role === 'admin';
};

/**
 * The slots the caller ticked (T-1201). Transport-shaped only: an array of ids
 * on a write body, a comma-separated list on a DELETE query string (a DELETE
 * body is not carried reliably by every proxy).
 *
 * `undefined` when the field is absent — the pre-checkbox meaning, "every slot".
 * A present-but-malformed value is a 400 rather than a silent fall-through to
 * "every slot": a client that meant to narrow the write and was misread would
 * fan a key out to harnesses it deliberately excluded, which is precisely the
 * subscription-downgrade this feature exists to keep avoidable.
 *
 * It performs NO authorization and no company lookup — the service intersects
 * these ids with the catalog set of the company named in the PATH, so this list
 * can only shrink the write, never redirect or widen it.
 */
const readVendorIds = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(raw)) {
    throw new AppError('`vendorIds` must be an array of slot ids.', {
      code: 'INVALID_VENDOR_IDS',
      statusCode: 400,
    });
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new AppError('`vendorIds` must be an array of slot ids.', {
        code: 'INVALID_VENDOR_IDS',
        statusCode: 400,
      });
    }
    const id = entry.trim();
    if (id.length > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
};

const setCompanyKey = asyncHandler(async (req: Request, res: Response) => {
  const companyId = readPathParam(req.params.companyId, 'companyId');
  const userId = readAuthenticatedUserId(req);
  const apiKey = readApiKeyFromBody(req.body);
  const body = req.body as Record<string, unknown> | undefined;
  // Opt-in override for the one case the service refuses by default: writing a
  // key into a harness that is currently signed in by subscription.
  const includeSubscription = body?.includeSubscription === true;
  const result = await companyCredentialsService.setKey(userId, companyId, apiKey, {
    isElevated: isElevatedCaller(req),
    includeSubscription,
    authenticatedPrincipal: (req as Request & { user?: unknown }).user,
    vendorIds: readVendorIds(body?.vendorIds),
  });
  res.json(createApiSuccessResponse(result));
});

router.post('/company/:companyId/key', setCompanyKey);
router.put('/company/:companyId/key', setCompanyKey);

router.delete(
  '/company/:companyId/key',
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = readPathParam(req.params.companyId, 'companyId');
    const userId = readAuthenticatedUserId(req);
    const result = await companyCredentialsService.deleteKey(userId, companyId, {
      isElevated: isElevatedCaller(req),
      // Removal stays PER SLOT in the UI — it acts on what is stored in one
      // place, not on an intention — so the query string usually carries a
      // single id. Absent still means "every slot", for the whole-company
      // removal the older client sent.
      vendorIds: readVendorIds(req.query.vendorIds ?? (req.body as Record<string, unknown> | undefined)?.vendorIds),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// Existence + subscription state per slot — never the key itself.
router.get(
  '/company/:companyId/key',
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = readPathParam(req.params.companyId, 'companyId');
    const userId = readAuthenticatedUserId(req);
    const status = await companyCredentialsService.getStatus(userId, companyId);
    // `writable` for a COMPANY is "can this caller write ANY of its slots", not
    // "is this caller elevated". Most slots are per-user isolated and a member
    // may set them freely; answering with the bare role would hide the field
    // from every member for a company whose slots they are all allowed to
    // write — the same over-refusal B-362 fixed at the slot level.
    const writable = status.slots.some(
      (slot) => !providerCredentialsService.requiresElevatedRole(slot.provider) || isElevatedCaller(req),
    );
    res.json(createApiSuccessResponse({ ...status, writable }));
  }),
);

// POST and PUT are equivalent here: both upsert the key (set-or-replace).
const setProviderApiKey = asyncHandler(async (req: Request, res: Response) => {
  const provider = parseProvider(req.params.provider);
  if (providerCredentialsService.getCapability(provider).method === 'none') {
    throw new AppError(`Provider "${provider}" is configured from the terminal only.`, {
      code: 'TERMINAL_ONLY',
      statusCode: 400,
    });
  }
  assertCredentialWriteAllowed(req, provider);
  const userId = readAuthenticatedUserId(req);
  const apiKey = readApiKeyFromBody(req.body);
  const target = readOptionalTarget((req.body as Record<string, unknown> | undefined)?.target);
  const body = req.body as Record<string, unknown> | undefined;
  const qwenOptions = provider === 'qwen'
    ? { plan: body?.plan, region: body?.region }
    : undefined;
  const result = await providerCredentialsService.setKey(
    userId, provider, apiKey, target, qwenOptions,
    (req as Request & { user?: unknown }).user,
  );
  if (provider === 'qwen') {
    auditLogDb.record('qwen_credential_set', {
      userId: coerceUserId(userId) ?? undefined,
      metadata: {
        provider: 'qwen',
        scope: 'personal',
        configured: result.configured,
        plan: body?.plan ?? 'coding_plan',
        region: body?.region ?? 'international',
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
  }
  res.json(createApiSuccessResponse(result));
});

router.post('/:provider/api-key', setProviderApiKey);
router.put('/:provider/api-key', setProviderApiKey);

router.delete(
  '/:provider/api-key',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    if (providerCredentialsService.getCapability(provider).method === 'none') {
      throw new AppError(`Provider "${provider}" is configured from the terminal only.`, {
        code: 'TERMINAL_ONLY',
        statusCode: 400,
      });
    }
    assertCredentialWriteAllowed(req, provider);
    const userId = readAuthenticatedUserId(req);

    const target = readOptionalTarget(req.query.target);
    const result = await providerCredentialsService.deleteKey(userId, provider, target);
    if (provider === 'qwen') {
      auditLogDb.record('qwen_credential_deleted', {
        userId: coerceUserId(userId) ?? undefined,
        metadata: { provider: 'qwen', scope: 'personal', configured: result.configured },
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
    }
    res.json(createApiSuccessResponse(result));
  }),
);

// GET reports existence only — `{ provider, configured }` — never the key. It
// also carries `writable` + `reason` (B-362): this request is already made once
// per slot, and it is the only per-user, role-aware answer the entry surface
// gets, so the alternative to riding along here is a second round trip that
// would have to re-derive the same rule.
router.get(
  '/:provider/api-key',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = readAuthenticatedUserId(req);
    const target = readOptionalTarget(req.query.target);
    const result = await providerCredentialsService.getStatus(userId, provider, target);
    res.json(createApiSuccessResponse({ ...result, ...evaluateCredentialWrite(req, provider) }));
  }),
);

// Advertises how a provider's key is configured so the UI renders the right
// entry surface: { method: 'native_file'|'cli_stdin'|'none', targets? }.
// Read-only and role-free (leaks no secret, exposes no per-user state).
router.get(
  '/:provider/api-key/capability',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const capability = providerCredentialsService.getCapability(provider);
    res.json(createApiSuccessResponse({ provider, ...capability }));
  }),
);

// Reports the ENGINE GOVERNANCE state of a provider for the badge (T-900): whether
// THIS user's resolved provider home is running under authentic nassaj governance
// right now — { status, enforced, mechanism } plus, since ADR-093/T-1195, the
// additive `sources[]`: every instruction channel this engine ingests, with its
// real path, its symlink target when it is a link, how it was verified, how hard
// it is enforced, and WHY when the verdict is negative. The legacy triple is
// unchanged, so the T-900 badge keeps working against an older client and vice
// versa. Mirrors the capability route (same
// authenticateToken guard on the router) but forwards the userId, like
// /:provider/auth/status, so a credential-isolated user sees THEIR own governance,
// not the operator's. Read-only: it reflects the current disk state and never
// materializes or self-heals — a later spawn's repair is picked up on the next fetch.
// An unknown/hosted provider is honestly 'ungoverned' (never a 404 on a fresh server).
router.get(
  '/:provider/governance',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = readAuthenticatedUserId(req);
    const governance = providerGovernanceService.getGovernance(provider, userId);
    // The link affordance is decided HERE and shipped as data, never re-derived in
    // the browser: the surface must not render a button the POST below will refuse
    // (the B-362 lesson, one rule read by both answers).
    const sources = governance.sources.map((channel) => applyLinkAuthorization(req, channel));
    res.json(createApiSuccessResponse({ provider, ...governance, sources }));
  }),
);

// Establishes nassaj governance for THIS caller's resolved provider home — the
// ADR-093 §4 (T-1197) "link this agent to nassaj instructions" action, and the only
// write in this subsystem. The reading service stays write-free (§4.3): the work is
// done by provider-governance-link.service, which materializes a real 0444 COPY
// (never a symlink, §4.1) atomically.
//
// AUTHORIZATION, all server-side and all fail-closed:
//   1. an identity is required — an anonymous caller has no home of their own;
//   2. platform mode is refused outright: it authenticates EVERY request as the
//      first user, so `owner` there means "whoever opened a socket" (B-186,
//      middleware/auth.js:49-58) — the exact hole ADR-093 §3.2-1 names;
//   3. a write that lands in the OPERATOR home changes every user on this node,
//      so it is owner-only (§4.2); an isolated user writes only in their own tree.
// The body is not read at all: there is nothing a client may say about WHERE.
router.post(
  '/:provider/governance/link',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = readAuthenticatedUserId(req);
    assertGovernanceLinkAllowed(req, provider, userId);

    const result = providerGovernanceLinkService.link(provider, userId);
    auditLogDb.record('governance_link', {
      userId: coerceUserId(userId) ?? undefined,
      metadata: {
        provider,
        linkScope: result.linkScope,
        governancePath: result.governancePath,
        role: readAuthenticatedUserRole(req) ?? 'unknown',
        status: result.descriptor.status,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    // The verdict is the one RE-READ from disk by the service — never an
    // optimistic "done" assembled from the request (ADR-093 §2.4).
    const sources = result.descriptor.sources.map((channel) => applyLinkAuthorization(req, channel));
    res.json(createApiSuccessResponse({ provider, ...result.descriptor, sources }));
  }),
);

router.get(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const bypassCache = parseOptionalBooleanQuery(req.query.bypassCache, 'bypassCache') ?? false;
    // Forward the authenticated user so a credential-isolating provider (Claude)
    // probes its catalog under THIS user's subscription and caches it per user.
    // `req.user` is set by authenticateToken; null for anonymous/platform mode,
    // which uses the operator's shared environment (unchanged behaviour).
    const userId = (req as Request & { user?: { id?: string | number } }).user?.id ?? null;
    assertRequestIdentity(req, true);
    const result = await providerModelsService.getProviderModels(
      provider,
      { bypassCache },
      userId,
      (req as Request & { user?: unknown }).user,
    );
    assertRequestIdentity(req, false);
    // `revalidating` rides on the response body at the same level as `models`
    // and `cache` (JSON path `body.data.revalidating`). It is `true` only when a
    // stale catalog was served while a background refresh runs; every other path
    // reports `false` so the client always sees a stable boolean.
    res.json(createApiSuccessResponse({
      provider,
      models: result.models,
      cache: result.cache,
      revalidating: result.revalidating === true,
    }));
  }),
);

// Pins a model onto an EXISTING session. The change is persisted under the key
// (provider, sessionId) in a server-side store and replayed by the resume path on
// every subsequent turn of that session, so an unauthorized write silently
// redirects another user's conversation to a model of the attacker's choosing —
// on that user's own subscription. It therefore takes the session 'write' mandate
// (B-IDOR-SESSION) before anything is persisted; a refusal is a 404, so the route
// also stops confirming whether a probed sessionId exists.
router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const accessFence = captureSessionRequestFence(req, sessionId, 'write');
    const payload = parseChangeActiveModelPayload(req.body);
    assertSessionRequestFence(req, accessFence, true);
    const result = await providerModelsService.changeActiveModel(provider, {
      ...payload,
      sessionId,
    });
    assertSessionRequestFence(req, accessFence, false);
    res.json(createApiSuccessResponse(result));
  }),
);

// ADR-099/T-1237: re-stamps the ENGINE a session runs on, mid-conversation.
//
// Why this is a route and not a field on the turn payload: accepting an engine
// from the per-turn `claude-command` is exactly what ADR-088 closed — that value
// can only come from a stale stamp or a forged frame, so the server ignores it
// and wins. An intent to MOVE the conversation is a different act: it happens
// once, it is authenticated, it is validated before storage, and it leaves an
// audit row. The spawn path is untouched and still reads only the stored pin.
//
// The switch is refused, never half-applied, unless ALL of these hold:
//   • the caller is a participant of this session ('restamp' mandate — a project
//     writer is NOT enough; see sessions.service.ts),
//   • the target engine is eligible AND a key for it resolves (no silent vendor
//     substitution — B-222),
//   • the model belongs to that engine's catalog (or the catalog is degraded, in
//     which case the caller's model is trusted — same choice pickEngineModel made),
//   • no turn is executing (the env of a running process cannot be changed), and
//   • when history would be exported, the caller acknowledged it explicitly.
router.post(
  '/:provider/sessions/:sessionId/engine',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const userId = readRequesterUserId(req);
    // Narrower than 'write' by design (qa-critic حرج 3). A 404 on refusal keeps
    // the non-disclosure contract of every other session route.
    const accessFence = captureSessionRequestFence(req, sessionId, 'restamp');

    if (provider !== 'claude') {
      throw new AppError('Engine re-stamping applies to the Claude body only.', {
        code: 'ENGINE_RESTAMP_UNSUPPORTED',
        statusCode: 400,
      });
    }

    const { engine, model, acknowledgedExport } = parseEngineRestampPayload(req.body);

    // A vendor engine with no resolvable key must fail VISIBLY here rather than
    // at spawn time: B-222's rule is that substituting another vendor — or
    // falling through to official Anthropic — is never a safe degradation.
    // `sharedFallback: true` mirrors the spawn path (apply-claude-engine-provider-env):
    // this gate must accept exactly the keys a later turn will actually be able
    // to spend, or it refuses a re-stamp that would have run fine. It is also the
    // second existence oracle named in §6 of the design doc — a member learns an
    // org key exists from the difference between this 400 and success — which
    // closes in wave B, when the declaration becomes the thing being asked about.
    if (engine !== OFFICIAL_ENGINE
      && resolveSlotKey(credentialPrincipalId(userId, engine), engine, { sharedFallback: true }) === null) {
      throw new AppError(`No stored key for engine "${engine}".`, {
        code: 'ENGINE_PROVIDER_UNAVAILABLE',
        statusCode: 400,
      });
    }

    // Model/engine coherence. A degraded catalog (vendor timeout, breaker open)
    // must not reject a model the user legitimately holds, so an EMPTY member set
    // means "cannot verify" and the caller's value is trusted — the same
    // resolution pickEngineModel already settled on for this exact situation.
    const catalogProvider: LLMProvider = engine === OFFICIAL_ENGINE ? 'claude' : engine;
    let known: string[] = [];
    try {
      assertSessionRequestFence(req, accessFence, true);
      const { models } = await providerModelsService.getProviderModels(
        catalogProvider,
        {},
        userId,
        (req as Request & { user?: unknown }).user,
      );
      assertSessionRequestFence(req, accessFence, false);
      known = (models?.OPTIONS ?? []).map((o) => o?.value).filter(Boolean) as string[];
    } catch (error) {
      if (error instanceof AppError && (error.code === 'identity_changed'
          || error.code === 'project_access_changed')) throw error;
      known = [];
    }
    if (known.length > 0 && !known.includes(model)) {
      throw new AppError(`Model "${model}" is not in the ${engine} catalog.`, {
        code: 'ENGINE_MODEL_MISMATCH',
        statusCode: 400,
      });
    }

    const before = sessionsDb.getSessionEnginePin(sessionId);
    const fromEngine = before?.engine ?? null;
    if (fromEngine === engine) {
      res.json(createApiSuccessResponse({ sessionId, engine, model, outcome: 'unchanged' }));
      return;
    }

    // Consent. Only meaningful when there IS history to export; a switch before
    // the first turn moves nothing, so demanding a confirmation there would train
    // the user to dismiss the one that matters.
    const turnsExported = countSessionAssistantTurns(sessionId);
    if (turnsExported > 0 && acknowledgedExport !== true) {
      throw new AppError(
        'Switching engines replays this conversation to the target provider. ' +
        'Re-send with acknowledgedExport: true to confirm.',
        {
          code: 'ENGINE_EXPORT_NOT_ACKNOWLEDGED',
          statusCode: 428,
          // B-461: العدد يسافر في `details` — وهو الحقل الوحيد الذي يُسلسله
          // المعالج العام (server/index.js). كان مقروءاً في العميل من جذر
          // `error` فقرأ undefined دائماً، فأعلن التنبيهُ «0 دور» على محادثة
          // لولا أدوارها لَما طُلب الإقرار أصلاً: رقمٌ يناقض وجود النافذة نفسها.
          details: { turnsExported },
        },
      );
    }

    const blockedBefore = isEngineSwitchBlocked(sessionId);
    if (blockedBefore.busy) {
      throw new AppError('A turn is still running on this session.', {
        code: 'ENGINE_RESTAMP_SESSION_BUSY',
        statusCode: 409,
      });
    }

    const previousModel = await providerModelsService.getChangedActiveModel('claude', sessionId);
    assertSessionRequestFence(req, accessFence, true);
    const result = sessionsDb.setSessionEnginePin(sessionId, engine, PIN_SOURCE.USER_SWITCH, {
      intent: true,
    });
    if (result.outcome === 'missing_row') {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // TOCTOU (qa-critic مهم 7): the check above and the spawn's read of the pin
    // are separate moments, so a `claude-command` in flight between them would
    // start on the OLD env and then be attributed to the NEW pin. Re-checking
    // AFTER the write closes that window in the only direction that matters:
    // whoever writes last loses, and we roll ourselves back rather than let a
    // running turn inherit a pin it did not start under.
    const blockedAfter = isEngineSwitchBlocked(sessionId);
    if (blockedAfter.busy) {
      sessionsDb.setSessionEnginePin(sessionId, fromEngine ?? OFFICIAL_ENGINE, PIN_SOURCE.USER_SWITCH, {
        intent: true,
      });
      throw new AppError('A turn started while the engine was being switched.', {
        code: 'ENGINE_RESTAMP_SESSION_BUSY',
        statusCode: 409,
      });
    }

    // The model must move with the engine or the next turn sends an id the new
    // endpoint does not know — the coupling this whole feature exists to enforce.
    try {
      await providerModelsService.changeActiveModel('claude', { model, sessionId });
      auditLogDb.record('engine_restamped', {
        userId: typeof userId === 'number' ? userId : null,
        metadata: {
          sessionId,
          fromEngine,
          toEngine: engine,
          model,
          turnsExported,
          acknowledgedExport: acknowledgedExport === true,
          outcome: result.outcome,
        },
      });
    } catch (error) {
      sessionsDb.setSessionEnginePin(
        sessionId, fromEngine ?? OFFICIAL_ENGINE, PIN_SOURCE.USER_SWITCH, { intent: true },
      );
      if (previousModel.changed && previousModel.model) {
        await providerModelsService.changeActiveModel('claude', {
          sessionId, model: previousModel.model,
        });
      } else {
        await providerModelsService.clearChangedActiveModel('claude', sessionId);
      }
      throw error;
    }
    assertSessionRequestFence(req, accessFence, false);

    res.json(createApiSuccessResponse({
      sessionId, engine, model, outcome: result.outcome, turnsExported,
    }));
  }),
);

// Reads the model that WILL actually drive this session's next resumed turn — the
// value the in-conversation model switcher should reflect after a reload (T-1028 /
// B-248), NOT the caller's global picker selection. It mirrors resolveResumeModel's
// own precedence for an existing session: an explicit session-scoped re-pick wins,
// otherwise the provider's per-session active model (which itself already falls back
// to the catalog DEFAULT when nothing is stored).
//
// Pure read: it only consults the (provider, sessionId) override store and the
// provider's own active-model lookup — it NEVER persists, so POST/resolveResumeModel
// behaviour is untouched. It therefore takes the session 'read' mandate, and — like
// the POST above (B-IDOR-SESSION) — a refusal is a 404, so an unauthorized caller
// cannot use this route to confirm whether a probed sessionId exists.
router.get(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const accessFence = captureSessionRequestFence(req, sessionId, 'read');

    // The nassaj-owned, provider-agnostic override store: `changed` is true only
    // when an explicit in-conversation re-pick is persisted (and then `model` is a
    // non-empty string). `supported` reflects whether the session-scoped override
    // flow applies for this provider. This read never throws for a missing entry —
    // it returns `{ changed: false, model: null }`.
    assertSessionRequestFence(req, accessFence, true);
    const change = await providerModelsService.getChangedActiveModel(provider, sessionId);
    assertSessionRequestFence(req, accessFence, true);

    let model: string;
    let source: 'session-override' | 'provider-current';
    if (change.changed && change.model) {
      // An explicit re-pick owns this session; it is what resume will inject.
      model = change.model;
      source = 'session-override';
    } else {
      // No explicit re-pick: the provider's own per-session active model, which is
      // guaranteed populated — every adapter degrades to its catalog DEFAULT rather
      // than throwing — so a session with no stored value yields a default, not a
      // 500. Provider-store vs catalog-default are indistinguishable through this
      // contract, so both are reported as 'provider-current'.
      model = (await providerModelsService.getCurrentActiveModel(provider, sessionId)).model;
      assertSessionRequestFence(req, accessFence, true);
      source = 'provider-current';
    }

    res.json(createApiSuccessResponse({
      provider,
      sessionId,
      model,
      source,
      supported: change.supported,
      changed: change.changed,
    }));
  }),
);

// Removes a session's pinned model override (B-252) — the inverse of the POST
// above. It deletes the (provider, sessionId) entry from the nassaj-owned change
// store so the session STOPS resuming on the explicit re-pick and returns to the
// ordinary resolve flow (resolveResumeModel's provider-current branch). What that
// deletion actually RESTORES depends on the provider CLASS, and this route does
// not pretend to restore more than it can:
//   • per-session-memory providers (claude transcript, opencode.db, cursor store,
//     the agy/antigravity brain) → resume reads THEIR OWN store again, so the
//     session returns to the model it is genuinely running on.
//   • memoryless providers (codex / gemini / hermes / hosted vendors) have no
//     per-session store: getCurrentActiveModel degrades to the CURRENT CATALOG
//     DEFAULT. seedSessionModel (B-167) had written the CREATION model into this
//     SAME key, and the first explicit re-pick already OVERWROTE that seed — so
//     the deletion CANNOT restore the creation model. Its honest meaning is
//     "follow the catalog default from now on" (the session drifts with the
//     default rather than staying pinned to its creation model). The B-167
//     cross-session bleed the seed guarded (the caller's GLOBAL picker selection
//     leaking onto this session's next turn) only resurfaces in the residual case
//     where an adapter's getCurrentActiveModel yields EMPTY, letting
//     resolveResumeModel fall through to the global requestedModel — and even
//     then ONLY by an explicit user unpin, never silently. Flagged for an owner
//     decision in the B-252 report.
//
// Mandate: unpinning changes the model the user's conversation resumes on, so it
// is a session 'write' (B-IDOR-SESSION) — the SAME guard as POST — and a refusal
// is a 404 indistinguishable from a missing session, so the route confirms no
// sessionId. Idempotent: unpinning a session with no override is a 200
// { cleared: false } with NO write, never a 404.
router.delete(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const accessFence = captureSessionRequestFence(req, sessionId, 'write');

    // `cleared` reflects whether a stored override actually existed and was
    // removed; when none existed nothing is written (idempotent no-op).
    assertSessionRequestFence(req, accessFence, true);
    const { cleared } = await providerModelsService.clearChangedActiveModel(provider, sessionId);
    assertSessionRequestFence(req, accessFence, false);

    // The model the NEXT resumed turn will now use — by construction the
    // provider-current value, since no override remains. Every adapter degrades to
    // its catalog DEFAULT rather than throwing, so this is always a non-empty
    // string (never a 500), mirroring the GET route's 'provider-current' branch.
    const model = (await providerModelsService.getCurrentActiveModel(provider, sessionId)).model;
    assertSessionRequestFence(req, accessFence, false);

    res.json(createApiSuccessResponse({
      provider,
      sessionId,
      cleared,
      model,
      source: 'provider-current' as const,
    }));
  }),
);

const parseProviderSkillCreatePayload = (payload: unknown): ProviderSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const directoryName = readOptionalQueryString(record.directoryName);
    const fileName = readOptionalQueryString(record.fileName);
    const rawFiles = record.files;

    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new AppError(`Skill entry ${index + 1} files must be an array.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const files: ProviderSkillCreateFile[] | undefined = rawFiles?.map((file, fileIndex) => {
      if (!file || typeof file !== 'object') {
        throw new AppError(`Skill entry ${index + 1} file ${fileIndex + 1} must be an object.`, {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const fileRecord = file as Record<string, unknown>;
      const relativePath = readOptionalQueryString(fileRecord.relativePath);
      const fileContent = typeof fileRecord.content === 'string' ? fileRecord.content : null;
      const encoding = fileRecord.encoding === 'utf8' || fileRecord.encoding === 'base64'
        ? fileRecord.encoding
        : null;

      if (!relativePath || fileContent === null || !encoding) {
        throw new AppError(
          `Skill entry ${index + 1} file ${fileIndex + 1} requires relativePath, content, and encoding.`,
          {
            code: 'INVALID_REQUEST_BODY',
            statusCode: 400,
          },
        );
      }

      return {
        relativePath,
        content: fileContent,
        encoding,
      };
    });

    return {
      content,
      directoryName,
      fileName,
      files,
    };
  });

  return { entries };
};

// ----------------- Skills routes -----------------
// B-175/1: `ProviderSkill.sourcePath` is an ABSOLUTE filesystem path built from
// the server's home dir (`~/.claude/skills/...`, `~/.agents/skills/...`). The
// frontend only displays it, keys React list items on it and searches it — it
// never resolves it — so collapsing the home prefix to `~` keeps every one of
// those uses intact (the string stays unique and stable) while the response stops
// disclosing the operator's real home layout to every authenticated member.
// Applied on ALL three skill routes so one shape reaches the client.
const redactSkillHomePath = <T extends { sourcePath: string }>(skill: T): T => {
  const home = os.homedir();
  if (!home || !skill.sourcePath.startsWith(`${home}${path.sep}`)) {
    return skill;
  }
  return { ...skill, sourcePath: `~${skill.sourcePath.slice(home.length)}` };
};

router.get(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    // ADR-172 (qa #8, found by the route probe): under enforcement a workspace
    // inside a project the caller cannot access must not list its skills.
    if (workspacePath && isProjectMembershipEnforced()
        && !canAccessProjectPath(workspacePath, readRequesterUserId(req))) {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
    const skills = await providerSkillsService.listProviderSkills(provider, {
      workspacePath,
      // Token-sourced only; never read from the request body/query (B-153).
      userId: readAuthenticatedUserId(req),
    });
    res.json(createApiSuccessResponse({ provider, skills: skills.map(redactSkillHomePath) }));
  }),
);

router.get(
  '/:provider/sessions/:sessionId/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = normalizeProviderParam(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const cursor = readOptionalQueryString(req.query.cursor);
    if (req.query.cursor !== undefined && (!cursor || !/^[a-f0-9]{48}$/.test(cursor))) {
      throw new AppError('Invalid skill cursor.', { code: 'INVALID_QUERY_PARAMETER', statusCode: 400 });
    }
    const abort = new AbortController();
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', close);
    try {
      const skills = await readSessionSkills(sessionId, provider, readRequesterUserId(req), { cursor, signal: abort.signal });
      if (!abort.signal.aborted) res.json({ success: true, skills });
    } finally { res.off('close', close); }
  }),
);

// Skill writes touch the shared owner home (os.homedir()/.claude and siblings)
// with no per-user CLAUDE_CONFIG_DIR isolation (B-26), so one member's write
// mutates skills for everyone. The write surface is restricted to owner/admin by
// an IN-HANDLER role check (same idiom as POST /mcp/servers/global). This is done
// inside the handler rather than via mounted middleware deliberately: a route
// module must stay auth-agnostic (boundaries), and — critically — Express routing
// is case-INSENSITIVE, so a path-matching guard could be slipped via `/SKILLS`;
// reading req.user.role in the handler is immune to path casing/formatting.
// Discovery below stays open to any authenticated member.
router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const role = readAuthenticatedUserRole(req);
    if (role !== 'owner' && role !== 'admin') {
      throw new AppError('Managing provider skills requires an admin or owner.', {
        code: 'PROVIDER_SKILL_WRITE_FORBIDDEN',
        statusCode: 403,
      });
    }
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, {
      ...input,
      // Spread FIRST so a client-supplied `userId` in the body can never win over
      // the token-sourced one (B-153, same idiom as the MCP upsert route).
      userId: readAuthenticatedUserId(req),
    });
    res.json(createApiSuccessResponse({ provider, skills: skills.map(redactSkillHomePath) }));
  }),
);

router.delete(
  '/:provider/skills/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const role = readAuthenticatedUserRole(req);
    if (role !== 'owner' && role !== 'admin') {
      throw new AppError('Managing provider skills requires an admin or owner.', {
        code: 'PROVIDER_SKILL_WRITE_FORBIDDEN',
        statusCode: 403,
      });
    }
    const provider = parseProvider(req.params.provider);
    const name = readPathParam(req.params.name, 'name');
    const skill = await providerSkillsService.removeProviderSkill(provider, name, {
      userId: readAuthenticatedUserId(req),
    });
    res.json(createApiSuccessResponse({ provider, skill: redactSkillHomePath(skill) }));
  }),
);

// ----------------- MCP routes -----------------
// Two independent gates apply here (B-IDOR-MCP):
//   - user scope   → touches the OPERATOR's shared config for every provider the
//                    sharing policy does not isolate per user, and MCP entries
//                    carry `env` / `headers` (bearer tokens). The elevated-role
//                    check therefore covers ALL providers, not just codex.
//   - project/local→ resolve against a caller-supplied filesystem path, so they
//                    go through resolveAuthorizedWorkspacePath, which pins them
//                    to a registered project the caller may read/write.
router.get(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    // The retired Gemini MCP provider used to refuse listing itself; since its
    // registry entry was removed (035fe5fb1) the route keeps that 403 contract.
    assertGenericMcpProviderEnabled(provider);
    const scope = parseMcpScope(req.query.scope);
    const userId = readAuthenticatedUserId(req);

    if (!scope || scope === 'user') {
      assertCredentialWriteAllowed(req, provider);
    }

    const workspacePath = resolveAuthorizedWorkspacePath(
      req,
      readOptionalQueryString(req.query.workspacePath),
      'read',
    );

    if (scope) {
      if (isWorkspaceScopedMcpScope(scope) && !workspacePath) {
        // No project context supplied: report nothing rather than falling back
        // to the server's own cwd and disclosing its config.
        res.json(createApiSuccessResponse({ provider, scope, servers: [] }));
        return;
      }

      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath, userId });
      res.json(createApiSuccessResponse({ provider, scope, servers }));
      return;
    }

    if (!workspacePath) {
      // Grouped listing without a project: only the workspace-independent scope
      // can be answered honestly; the other two stay empty for the same reason.
      const userScopedServers = await providerMcpService.listProviderMcpServersForScope(provider, 'user', { userId });
      res.json(createApiSuccessResponse({
        provider,
        scopes: { user: userScopedServers, local: [], project: [] },
      }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath, userId });
    res.json(createApiSuccessResponse({ provider, scopes: groupedServers }));
  }),
);

/**
 * Owner/admin inventory of every member's USER-scoped MCP servers (T-1179).
 *
 * WHY THIS EXISTS. Since T-1177 a member may register their own MCP server, and an
 * MCP definition is executable. Every other MCP read resolves the file from the
 * CALLER's identity — correct for the member view, but it left the operator unable
 * to answer "what is registered on this install, and by whom". The audit log records
 * each mutation, but a log is a history, not an inventory: it cannot show what is
 * live right now after edits and removals.
 *
 * It is READ-ONLY and role-gated: this returns other people's configuration, so it
 * is owner/admin exactly like `/mcp/servers/global`. `env` and `headers` are stripped
 * on the way out — they carry tokens, and the operator needs to know a server EXISTS
 * and what it RUNS, never its member's secrets. A per-user read that throws (a member
 * with no tree yet, an unreadable file) degrades to an empty list for that member
 * rather than failing the whole inventory.
 *
 * Placed above the mutating routes for readability; there is no ordering hazard
 * today because the only `/:provider/mcp/servers/:name` route is a DELETE, so
 * `inventory` cannot be swallowed as a server name. Add a GET on that shape and
 * this one must stay first.
 */
router.get(
  '/:provider/mcp/servers/inventory',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    assertGenericMcpProviderEnabled(provider);
    const role = readAuthenticatedUserRole(req);
    if (role !== 'owner' && role !== 'admin') {
      throw new AppError('Listing every member\'s MCP servers requires an admin or owner.', {
        code: 'MCP_INVENTORY_FORBIDDEN',
        statusCode: 403,
      });
    }

    const members = userDb.listUsers();
    const inventory = await Promise.all(members.map(async (member) => {
      const servers = await providerMcpService
        .listProviderMcpServersForScope(provider, 'user', { userId: member.id })
        .catch(() => []);
      return {
        userId: member.id,
        username: member.username,
        servers: servers.map(({ env: _env, headers: _headers, ...safe }) => safe),
      };
    }));

    res.json(createApiSuccessResponse({ provider, scope: 'user', inventory }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    // Mirrors the service default (McpProvider.upsertServer: `input.scope ?? 'project'`).
    const scope = payload.scope ?? 'project';
    // B-345: 'local' too, not just 'user'. T-1177: the bar applies only when the
    // provider is shared — on an isolated one the file is the caller's own.
    assertMcpWriteAllowed(req, scope, provider);
    if (scope === 'user') {
      assertCredentialWriteAllowed(req, provider);
    }

    const workspacePath = resolveAuthorizedWorkspacePath(req, payload.workspacePath, 'write');
    assertWorkspacePathPresentForWrite(scope, workspacePath);

    const server = await providerMcpService.upsertProviderMcpServer(provider, {
      ...payload,
      workspacePath,
      userId: readAuthenticatedUserId(req),
    });
    recordMcpMutation(req, 'mcp_server_upsert', {
      provider,
      scope,
      name: payload.name,
      command: payload.command,
      args: payload.args,
    });
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    // Mirrors the service default (McpProvider.removeServer: `input.scope ?? 'project'`).
    const scope = parseMcpScope(req.query.scope) ?? 'project';
    // B-345: removal is a write too — silently deleting another member's server
    // is the same shared-file mutation as adding one (T-1177: on a shared provider).
    assertMcpWriteAllowed(req, scope, provider);
    if (scope === 'user') {
      assertCredentialWriteAllowed(req, provider);
    }

    const workspacePath = resolveAuthorizedWorkspacePath(
      req,
      readOptionalQueryString(req.query.workspacePath),
      'write',
    );
    assertWorkspacePathPresentForWrite(scope, workspacePath);

    const name = readPathParam(req.params.name, 'name');
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name,
      scope,
      workspacePath,
      userId: readAuthenticatedUserId(req),
    });
    recordMcpMutation(req, 'mcp_server_remove', { provider, scope, name });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/mcp/servers/global',
  asyncHandler(async (req: Request, res: Response) => {
    const role = readAuthenticatedUserRole(req);
    if (role !== 'owner' && role !== 'admin') {
      throw new AppError('Adding an MCP server to all providers requires an admin or owner.', {
        code: 'MCP_GLOBAL_WRITE_FORBIDDEN',
        statusCode: 403,
      });
    }
    const payload = parseMcpUpsertPayload(req.body);
    if (payload.scope === 'local') {
      throw new AppError('Global MCP add supports only "user" or "project" scopes.', {
        code: 'INVALID_GLOBAL_MCP_SCOPE',
        statusCode: 400,
      });
    }

    const scope = payload.scope === 'user' ? 'user' : 'project';
    // Owner/admin above is an authorization check, not a containment one: a
    // project-scoped global add still writes <workspacePath>/.mcp.json for every
    // provider, so the path is pinned to a registered project the caller may
    // write (B-IDOR-MCP) instead of landing anywhere on the host.
    const workspacePath = resolveAuthorizedWorkspacePath(req, payload.workspacePath, 'write');
    assertWorkspacePathPresentForWrite(scope, workspacePath);

    // Forward the authenticated caller so per-user-isolated providers (e.g.
    // codex writing into the caller's CODEX_HOME) target THIS user's tree
    // rather than the operator's. userId is token-sourced only, never trusted
    // from the body. The service spreads it into each provider's upsertServer.
    const results = await providerMcpService.addMcpServerToAllProviders({
      ...payload,
      scope,
      workspacePath,
      userId: readAuthenticatedUserId(req),
    });
    res.status(201).json(createApiSuccessResponse({ results }));
  }),
);

// ----------------- Session routes -----------------
// Every route below forwards the AUTHENTICATED caller (readRequesterUserId) into
// the service, which applies the shared session gate (B-IDOR-SESSION):
// participation in the session OR the matching mandate on its project — 'read'
// for listings, 'write' for mutations. Refusals surface as 404 so a sessionId
// probe never confirms that another user's session exists.
router.post(
  '/sessions/bulk',
  asyncHandler(async (req: Request, res: Response) => {
    const ids = parseBulkSessionIds(req.body);
    const action = parseBulkSessionAction(req.body);
    const requesterUserId = readRequesterUserId(req);
    const results: BulkMutationResult[] = [];
    let anyEffectStarted = false;

    for (const id of ids) {
      try {
        const accessFence = captureSessionRequestFence(req, id, 'write');
        const assertCurrent = (notStarted: boolean) => {
          if (!notStarted) anyEffectStarted = true;
          assertSessionRequestFence(req, accessFence, notStarted && !anyEffectStarted);
        };
        const provider = sessionsDb.getSessionById(id)?.provider;
        let result: unknown;
        if (action === 'archive') {
          result = await sessionsService.deleteOrArchiveSessionById(id, requesterUserId, { assertCurrent });
        } else if (action === 'restore') {
          assertCurrent(true);
          result = sessionsService.restoreSessionById(id, requesterUserId);
        } else if (action === 'delete_permanently') {
          result = await sessionsService.deleteOrArchiveSessionById(id, requesterUserId, {
            force: true,
            deletedFromDisk: true,
            assertCurrent,
            markEffectStarted: () => { anyEffectStarted = true; },
          });
        } else {
          // Close state is stored separately from the session row, but shares
          // the exact write entitlement used by the existing close routes.
          assertSessionAccessible(id, requesterUserId, 'write');
          assertCurrent(true);
          if (action === 'close') {
            closedSessionsDb.closeSession(id, requesterUserId ?? 0);
            anyEffectStarted = true;
            result = { sessionId: id, closed: true };
          } else {
            closedSessionsDb.reopenSession(id);
            anyEffectStarted = true;
            result = { sessionId: id, closed: false };
          }
        }
        assertCurrent(false);
        notifyChangedSession(id, provider);
        results.push({ id, success: true, result });
      } catch (error) {
        if (error instanceof AppError && (error.code === 'identity_changed'
            || error.code === 'project_access_changed')) {
          if (anyEffectStarted) {
            throw accessFenceError(error.code, false);
          }
          throw error;
        }
        results.push(bulkFailure(id, error));
      }
    }
    res.json(createApiSuccessResponse({ action, results }));
  }),
);

router.get(
  '/sessions/archived',
  asyncHandler(async (req: Request, res: Response) => {
    const sessions = sessionsService.listArchivedSessions(readRequesterUserId(req));
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const accessFence = captureSessionRequestFence(req, sessionId, 'write');
    const assertCurrent = (notStarted: boolean) =>
      assertSessionRequestFence(req, accessFence, notStarted);
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, readRequesterUserId(req), {
      force,
      deletedFromDisk,
      assertCurrent,
    });
    assertCurrent(false);
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const accessFence = captureSessionRequestFence(req, sessionId, 'write');
    assertSessionRequestFence(req, accessFence, true);
    const result = sessionsService.restoreSessionById(sessionId, readRequesterUserId(req));
    assertSessionRequestFence(req, accessFence, false);
    res.json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const accessFence = captureSessionRequestFence(req, sessionId, 'write');
    assertSessionRequestFence(req, accessFence, true);
    const result = sessionsService.renameSessionById(sessionId, readRequesterUserId(req), summary);
    assertSessionRequestFence(req, accessFence, false);
    res.json(createApiSuccessResponse(result));
  }),
);

// ج1: read-only liveness carrier for the running-operations card. Deliberately a
// SEPARATE tiny route instead of a field bolted onto the messages response — the
// history payload is large and cached-shaped, while this answer is volatile and
// must be cheap to re-ask. Contract: ALWAYS 200 with `{ isProcessing: boolean }`
// and nothing else. A session that does not exist, one the caller may not see,
// and an idle one are indistinguishable (same status, same body, no id echo), so
// the route cannot be used to probe for another user's session. No side effects:
// nothing is attached, replayed, mirrored, cached or written.
router.get(
  '/sessions/:sessionId/activity',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    res.json(readSessionActivity(sessionId, readAuthenticatedUserId(req)));
  }),
);

router.get(
  '/sessions/:sessionId/message-delivery/:clientMsgId',
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const sessionId = parseSessionId(req.params.sessionId);
    const clientMsgId = readPathParam(req.params.clientMsgId, 'clientMsgId');
    const provider = readOptionalQueryString(req.query.provider);
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(clientMsgId)
      || !provider || !/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) {
      throw new AppError('Invalid delivery identity.', { code: 'INVALID_DELIVERY_IDENTITY', statusCode: 400 });
    }
    res.json(readMessageDelivery(sessionId, readRequesterUserId(req), clientMsgId, provider));
  }),
);

/** Bounded numeric HTTP status from an AppError/HistoryBudgetError; 500 otherwise. */
function readErrorStatus(error: unknown): number {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status : 500;
}

/** Stable public error code (letters/underscores only) or null; never a message. */
function readErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : null;
}

router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    try {
      await serveSessionMessages(req, res, sessionId);
    } catch (error) {
      // T-1660: history failures returned as AppError (404/400/409/413/...) are
      // sent to the client but were never logged (the global handler logs only
      // non-AppError 500s), so the cause of an 'unavailable' banner could not be
      // established from the server side. Record bounded metadata only — status,
      // stable code and sessionId — never a transcript, path, header or token.
      const status = readErrorStatus(error);
      const code = readErrorCode(error);
      console.warn('[history] request failed', {
        sessionId, payload: readOptionalQueryString(req.query.payload) ?? 'full', status, code,
      });
      throw error;
    }
  }),
);

async function serveSessionMessages(req: Request, res: Response, sessionId: string): Promise<void> {
    const accessFence = captureSessionRequestFence(req, sessionId, 'read');
    const assertCurrent = (notStarted: boolean) =>
      assertSessionRequestFence(req, accessFence, notStarted);
    const limitRaw = readOptionalQueryString(req.query.limit);
    const offsetRaw = readOptionalQueryString(req.query.offset);
    const cursor = readOptionalQueryString(req.query.cursor);
    const payloadRaw = readOptionalQueryString(req.query.payload);
    const revision = readOptionalQueryString(req.query.revision);

    if (req.query.payload !== undefined && payloadRaw !== 'full' && payloadRaw !== 'light') {
      throw new AppError('payload must be full or light.', {
        code: 'INVALID_QUERY_PARAMETER', statusCode: 400,
      });
    }
    if (req.query.revision !== undefined && (revision === undefined || revision.length > 128)) {
      throw new AppError('revision is invalid.', {
        code: 'INVALID_QUERY_PARAMETER', statusCode: 400,
      });
    }

    if (cursor !== undefined && Buffer.byteLength(cursor) > 2048) {
      throw new AppError('cursor is invalid.', { code: 'INVALID_QUERY_PARAMETER', statusCode: 400 });
    }
    let limit: number | null = null;
    if (limitRaw !== undefined) {
      const parsedLimit = /^\d+$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 0 || parsedLimit > 500) {
        throw new AppError('limit must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsedOffset = /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : Number.NaN;
      if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
        throw new AppError('offset must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      offset = parsedOffset;
    }

    if (sessionsService.usesBoundedHistory(sessionId)) {
      await sessionsService.withHistoryLease(sessionId, readRequesterUserId(req), {
        limit, offset, cursor, payloadMode: (payloadRaw ?? 'full') as HistoryPayloadMode, revision,
        assertCurrent,
      }, new HistoryHttpSink(res));
      return;
    }
    const result = await sessionsService.fetchHistory(sessionId, readRequesterUserId(req), {
      limit,
      offset,
      cursor,
      payloadMode: (payloadRaw ?? 'full') as HistoryPayloadMode,
      revision,
      assertCurrent,
    });
    assertCurrent(true);
    res.json(result);
}

router.get('/search/sessions', asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);
  // Authorization scope for the search (B-106, widened by B-111): only sessions
  // the caller may see are ever scanned or streamed — those they participate in
  // OR that live in a project visible to them (public / shared / owned), the
  // same predicate the sidebar list layer uses. A private project the caller is
  // not a member of stays excluded (B-106 isolation preserved). Resolved from
  // req.user (set by authenticateToken guarding this router); null here means no
  // usable identity → zero results.
  const requesterUserId = readRequesterUserId(req);
  assertRequestIdentity(req, true);

  let closed = false;
  let staleCode: 'identity_changed' | 'project_access_changed' | null = null;
  const abortController = new AbortController();
  const stream = new DeviceBoundSseStream(
    res,
    (req as Request & { user?: unknown }).user,
    () => {
      closed = true;
      abortController.abort();
    },
  );
  assertRequestIdentity(req, true);
  const ensureHeaders = () => {
    if (res.headersSent) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  };
  const accessBySession = new Map<string, WorkspaceTopologyFence>();
  const distinctAccessFences = new Set<WorkspaceTopologyFence>();
  const streamAccessCurrent = (): boolean => {
    if ((req as IdentityFencedRequest).assertCurrentIdentity?.() !== true) {
      staleCode = 'identity_changed';
      abortController.abort();
      return false;
    }
    for (const fence of distinctAccessFences) {
      if (!isWorkspaceTopologyFenceCurrent(fence)) {
        staleCode = 'project_access_changed';
        abortController.abort();
        return false;
      }
    }
    return true;
  };
  const authorizeSession = (sessionId: string, projectPath: string | null): boolean => {
    if ((req as IdentityFencedRequest).assertCurrentIdentity?.() !== true) {
      staleCode = 'identity_changed'; abortController.abort(); return false;
    }
    if (!isProjectMembershipEnforced()) return true;
    let fence = accessBySession.get(sessionId);
    if (!fence) {
      const captured = captureWorkspaceTopologyFence(projectPath ?? '', requesterUserId, {
        sessionId, consent: 'read',
      }) ?? undefined;
      if (!captured) {
        staleCode = 'project_access_changed'; abortController.abort(); return false;
      }
      fence = retainDistinctWorkspaceFence(distinctAccessFences, captured);
      accessBySession.set(sessionId, fence);
    }
    if (!isWorkspaceTopologyFenceCurrent(fence)) {
      staleCode = 'project_access_changed'; abortController.abort(); return false;
    }
    return true;
  };
  req.on('close', () => {
    closed = true;
    abortController.abort();
    stream.markClientGone();
  });

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      requesterUserId,
      signal: abortController.signal,
      authorizeSession,
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }
        if (staleCode || !streamAccessCurrent()) return;
        ensureHeaders();

        if (projectResult) {
          stream.send({ projectResult, totalMatches, scannedProjects, totalProjects }, 'result');
          return;
        }

        stream.send({ totalMatches, scannedProjects, totalProjects }, 'progress');
      },
    });

    if (!staleCode) streamAccessCurrent();
    if (staleCode) {
      if (res.headersSent) stream.invalidateAccess(staleCode);
      else res.status(409).set('Cache-Control', 'no-store').json({
        error: staleCode === 'identity_changed'
          ? 'Identity changed during request' : 'Project access changed during request',
        code: staleCode,
        notStarted: true,
      });
      closed = true;
    } else if (!closed) {
      ensureHeaders();
      stream.send({}, 'done');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed && staleCode) {
      if (res.headersSent) stream.invalidateAccess(staleCode);
      else res.status(409).set('Cache-Control', 'no-store').json({
        error: staleCode === 'identity_changed'
          ? 'Identity changed during request' : 'Project access changed during request',
        code: staleCode,
        notStarted: true,
      });
      closed = true;
    } else if (!closed) {
      ensureHeaders();
      stream.send({ error: 'Search failed' }, 'error');
    }
  } finally {
    if (!closed) stream.end();
  }
}));

export default router;
