import os from 'node:os';
import path from 'node:path';

import express, { type Request, type Response } from 'express';

import costRoutes from '@/modules/providers/cost.routes.js';
import { antigravityActiveModelService } from '@/modules/providers/services/antigravity-active-model.service.js';
import { claudeUsageService } from '@/modules/providers/services/claude-usage.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerCredentialsService } from '@/modules/providers/services/provider-credentials.service.js';
import { providerGovernanceService } from '@/modules/providers/services/provider-governance.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { readSessionActivity } from '@/modules/providers/services/session-activity.service.js';
import { assertSessionAccessible, sessionsService } from '@/modules/providers/services/sessions.service.js';
import { workflowStatusService } from '@/modules/providers/services/workflow-status.service.js';
import {
  agentStatusService,
  isValidAgentId,
} from '@/modules/providers/services/agent-status.service.js';
import { projectsDb } from '@/modules/database/index.js';
import { coerceUserId } from '@/modules/projects/index.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderChangeActiveModelInput,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse, isCliInstalled } from '@/shared/utils.js';

const router = express.Router();

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

// Enforces the T-866 authorization gate: a write that would touch the OPERATOR's
// shared credentials (provider not isolated per policy) is restricted to
// owner/admin. Isolated per-user writes are allowed for any authenticated
// member (their own tree — userId comes from the token only). Throws 403.
const assertCredentialWriteAllowed = (req: Request, provider: string): void => {
  if (!providerCredentialsService.requiresElevatedRole(provider)) {
    return;
  }
  const role = readAuthenticatedUserRole(req);
  if (role !== 'owner' && role !== 'admin') {
    throw new AppError('Configuring shared provider credentials requires an admin or owner.', {
      code: 'CREDENTIAL_WRITE_FORBIDDEN',
      statusCode: 403,
    });
  }
};

// MCP scopes whose config file is resolved RELATIVE to the caller-supplied
// workspacePath (project: <ws>/.mcp.json, <ws>/.codex/config.toml, … ; local:
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
      const usage = await claudeUsageService.getUsage(userId);
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

const STUB_CLI_PROVIDERS = new Set<string>();
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

    // Stub CLI providers: check installation only — no registry entry yet.
    if (STUB_CLI_PROVIDERS.has(provider)) {
      const installed = isCliInstalled(provider);
      res.json(createApiSuccessResponse({
        installed,
        authenticated: false,
        email: null,
        method: null,
        provider,
        error: installed ? 'Authentication not yet supported' : `${provider} is not installed`,
      }));
      return;
    }

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
  const result = await providerCredentialsService.setKey(userId, provider, apiKey, target);
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
    res.json(createApiSuccessResponse(result));
  }),
);

// GET reports existence only — `{ provider, configured }` — never the key.
router.get(
  '/:provider/api-key',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const userId = readAuthenticatedUserId(req);
    const target = readOptionalTarget(req.query.target);
    const result = await providerCredentialsService.getStatus(userId, provider, target);
    res.json(createApiSuccessResponse(result));
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
// right now — { status, enforced, mechanism }. Mirrors the capability route (same
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
    res.json(createApiSuccessResponse({ provider, ...governance }));
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
    const result = await providerModelsService.getProviderModels(provider, { bypassCache }, userId);
    res.json(createApiSuccessResponse({ provider, models: result.models, cache: result.cache }));
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
    assertSessionAccessible(sessionId, readRequesterUserId(req), 'write');
    const payload = parseChangeActiveModelPayload(req.body);
    const result = await providerModelsService.changeActiveModel(provider, {
      ...payload,
      sessionId,
    });
    res.json(createApiSuccessResponse(result));
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
    assertSessionAccessible(sessionId, readRequesterUserId(req), 'read');

    // The nassaj-owned, provider-agnostic override store: `changed` is true only
    // when an explicit in-conversation re-pick is persisted (and then `model` is a
    // non-empty string). `supported` reflects whether the session-scoped override
    // flow applies for this provider. This read never throws for a missing entry —
    // it returns `{ changed: false, model: null }`.
    const change = await providerModelsService.getChangedActiveModel(provider, sessionId);

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
    assertSessionAccessible(sessionId, readRequesterUserId(req), 'write');

    // `cleared` reflects whether a stored override actually existed and was
    // removed; when none existed nothing is written (idempotent no-op).
    const { cleared } = await providerModelsService.clearChangedActiveModel(provider, sessionId);

    // The model the NEXT resumed turn will now use — by construction the
    // provider-current value, since no override remains. Every adapter degrades to
    // its catalog DEFAULT rather than throwing, so this is always a non-empty
    // string (never a 500), mirroring the GET route's 'provider-current' branch.
    const model = (await providerModelsService.getCurrentActiveModel(provider, sessionId)).model;

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
    const skills = await providerSkillsService.listProviderSkills(provider, {
      workspacePath,
      // Token-sourced only; never read from the request body/query (B-153).
      userId: readAuthenticatedUserId(req),
    });
    res.json(createApiSuccessResponse({ provider, skills: skills.map(redactSkillHomePath) }));
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

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    // Mirrors the service default (McpProvider.upsertServer: `input.scope ?? 'project'`).
    const scope = payload.scope ?? 'project';
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
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    // Mirrors the service default (McpProvider.removeServer: `input.scope ?? 'project'`).
    const scope = parseMcpScope(req.query.scope) ?? 'project';
    if (scope === 'user') {
      assertCredentialWriteAllowed(req, provider);
    }

    const workspacePath = resolveAuthorizedWorkspacePath(
      req,
      readOptionalQueryString(req.query.workspacePath),
      'write',
    );
    assertWorkspacePathPresentForWrite(scope, workspacePath);

    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
      userId: readAuthenticatedUserId(req),
    });
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
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, readRequesterUserId(req), {
      force,
      deletedFromDisk,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.restoreSessionById(sessionId, readRequesterUserId(req));
    res.json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, readRequesterUserId(req), summary);
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
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const limitRaw = readOptionalQueryString(req.query.limit);
    const offsetRaw = readOptionalQueryString(req.query.offset);

    let limit: number | null = null;
    if (limitRaw !== undefined) {
      const parsedLimit = Number.parseInt(limitRaw, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit < 0) {
        throw new AppError('limit must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsedOffset = Number.parseInt(offsetRaw, 10);
      if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
        throw new AppError('offset must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      offset = parsedOffset;
    }

    const result = await sessionsService.fetchHistory(sessionId, readRequesterUserId(req), {
      limit,
      offset,
    });
    res.json(result);
  }),
);

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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    abortController.abort();
  });

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      requesterUserId,
      signal: abortController.signal,
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

export default router;
