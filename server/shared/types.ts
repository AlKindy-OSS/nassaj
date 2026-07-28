import type { IncomingMessage } from 'node:http';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
  // JWT-authenticated identity stamped on the socket at connect time
  // (chat-websocket.service). Lets broadcasters personalize per-user fields
  // (e.g. `isMember` in projects_updated) without re-authenticating. Never
  // sourced from client input; absent/null for unauthenticated sockets.
  userId?: string | number | null;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'antigravity'
  | 'opencode'
  | 'kimi'
  | 'deepseek'
  | 'glm'
  | 'hermes'
  | 'sakana';

/**
 * One selectable model row (matches the documentation `public/modelConstants.js` option shape).
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
  /**
   * Marks this catalog as a degraded/fallback result rather than a live fetch
   * from the provider (e.g. the provider's network/auth was unavailable and a
   * built-in fallback was served).
   *
   * Provider adapters that can fail gracefully set this so the provider-models
   * cache layer stores the result under a short TTL and re-attempts the live
   * fetch soon, instead of pinning a stale fallback for the normal long TTL.
   * Adapters that always return a live/authoritative catalog leave it unset.
   */
  degraded?: boolean;
};

/**
 * Cache metadata returned alongside one provider model catalog.
 *
 * `updatedAt` is when the current cached snapshot was last refreshed from the
 * provider itself. `expiresAt` is the backend cache expiry timestamp, and
 * `source` tells callers whether the current response came from in-memory cache,
 * persisted disk cache, or a fresh provider fetch.
 */
export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

/**
 * Full provider model lookup result returned by the backend service layer.
 *
 * Use this shape when a caller needs both the selectable model catalog and the
 * cache metadata that explains how current the catalog is.
 */
export type ProviderModelsResult = {
  models: ProviderModelsDefinition;
  cache: ProviderModelsCacheInfo;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Input payload used when one session needs to use a different model on its
 * next resumed turn.
 *
 * This is a backend-owned session override, not a claim that the provider has
 * already switched the currently running session in-place. Provider adapters
 * persist this request so the next CLI/SDK resume can inject the chosen model
 * using the provider-specific mechanism supported by that runtime.
 */
export type ProviderChangeActiveModelInput = {
  sessionId: string;
  model: string;
};

/**
 * Provider-neutral session model-change state.
 *
 * `supported` indicates whether the provider adapter supports the app's
 * session-scoped resume override flow. `changed` is the persisted boolean the
 * resume layer checks before forcing a model on the next resumed turn. When
 * `changed` is `false`, `model` is `null` and the runtime should use the
 * normal request/default model selection path.
 */
export type ProviderSessionActiveModelChange = {
  provider: LLMProvider;
  sessionId: string;
  supported: boolean;
  changed: boolean;
  model: string | null;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  /**
   * Derived background-workflow completion correction (ADR-048). Synthesized by
   * the workflow-reconcile service — NOT persisted to any transcript — when a
   * session's background `run.stopped` notification was emitted before the
   * orphaned workflow actually finished writing its `result` rows on disk.
   * Carries `isTaskNotification:true`/`taskStatus:'completed'` so it rides the
   * existing task-notification card path on the frontend.
   */
  | 'task_reconcile'
  /**
   * Optional read-only WebSocket fan-out variant of `task_reconcile` (ADR-048,
   * mirrors ADR-041 replay) telling live viewers a previously-stopped workflow
   * has been reconciled as complete. Idempotent; absence of this event never
   * changes correctness because the REST `task_reconcile` row is authoritative.
   */
  | 'workflow_reconciled';

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Authenticated sender of this message (users.id) — multi-user sessions.
   *
   * Present only on kind:'text' role:'user' messages whose author is known:
   * stamped from the JWT-authenticated socket on the live run path, and from
   * the message_authors sidecar table on history loads. Absent for messages
   * recorded before author tracking existed and for provider-internal user
   * rows — clients must treat a missing value as "author unknown" and fall
   * back (never assume the viewing user authored it).
   */
  userId?: number;
  /**
   * Provenance of a kind:'text' role:'user' message that was NOT typed by a
   * human (mirrors SDKMessageOrigin.kind from the Claude Agent SDK):
   * - 'coordinator'       — coordinator → subagent prompt (Task/Agent tool)
   * - 'peer'              — message routed from a peer session
   * - 'channel'           — message injected from a channel
   * - 'task-notification' — background-task completion notification
   *
   * Absent = human keyboard input. All messages recorded before this field
   * existed are also absent and MUST keep being treated as human-authored
   * (no regression). When present, the message never carries `userId` and the
   * UI must render it as a machine-routed prompt (e.g. coordinator→agent
   * directive), never as a message the viewing user wrote.
   */
  originKind?: 'coordinator' | 'peer' | 'channel' | 'task-notification' | (string & {});
  /**
   * Coordinator attribution for assistant output in multi-user sessions
   * (B-MU-UX-FIX-ASSISTANT-AUTHOR). The users.id of the participant who spawned
   * the run that produced this assistant message — sourced from the
   * JWT-authenticated socket (ws.userId) on the live run path, and derived from
   * the message_authors sidecar (the author of the preceding user prompt) on
   * history loads.
   *
   * Present only on assistant-authored messages (role:'assistant') whose
   * coordinator is known. Absent (treated as null) for:
   * - user-authored messages (those carry `userId` instead),
   * - provider-internal/status events,
   * - assistant messages recorded before coordinator tracking existed or whose
   *   originating prompt was not attributed.
   * Clients MUST treat a missing/null value as "coordinator unknown" and fall
   * back to the session owner (never assume the viewing user spawned the run).
   */
  coordinatorId?: number | null;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /**
   * Background-task notification fields (ADR-048, C5). Present on the derived
   * kind:'task_reconcile' correction row (and any kind:'workflow_reconciled'
   * event): `isTaskNotification` routes it through the frontend's existing
   * task-notification card path, `taskStatus` carries the reconciled state —
   * 'completed' when every started work item produced a result
   * (agentsDone == agentsTotal), or 'settled' when real output landed but a
   * subagent stayed hanging (agentsDone < agentsTotal). `wfId` identifies the
   * workflow so the card can replace/append the matching stopped card, and
   * `agentsDone`/`agentsTotal` show progress (matched resultKeys vs startedKeys).
   * The derived row intentionally has NO output file path — the journal does not
   * record one.
   */
  isTaskNotification?: boolean;
  taskStatus?: 'completed' | 'settled' | (string & {});
  wfId?: string;
  agentsDone?: number;
  agentsTotal?: number;
  images?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  subagentTools?: unknown;
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  [key: string]: unknown;
};

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
  /**
   * Authenticated caller context, injected server-side and never trusted from
   * clients (B-153, mirrors `UpsertProviderMcpServerInput.userId`). Providers
   * whose skill roots live under an isolated config home (codex: CODEX_HOME)
   * resolve them for this user through `resolveProviderEnv`; providers whose
   * skill library is shared by design (claude: `.claude/skills` is symlinked
   * back to the operator tree by provisionUserDirs) ignore it.
   */
  userId?: string | number | null;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
  /** Authenticated caller context, injected server-side and never trusted from clients (B-153). */
  userId?: string | number | null;
};

/**
 * Shared options accepted by provider skill removal operations.
 *
 * Carries the same server-injected caller context as the list/create inputs so
 * a removal resolves the SAME skill root the matching listing resolved (B-153).
 */
export type ProviderSkillRemoveOptions = {
  userId?: string | number | null;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
  /** Authenticated caller context, injected server-side and never trusted from clients. */
  userId?: string | number | null;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
  // Private-project visibility (B-PRIV). 'public' (default) is visible to every
  // authenticated user; 'private' is visible only to its creator, explicit
  // project_members, and users derived from session participation.
  visibility: ProjectVisibility;
  // users.id of the creator (nullable for legacy rows created before this column
  // existed). Used both for visibility resolution and management authorization.
  created_by: number | null;
};

/** Visibility mode of a project row. */
export type ProjectVisibility = 'public' | 'private';

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- CLAUDE USAGE MODEL ------------
/**
 * A single rate-limit window as exposed by the Claude usage contract.
 *
 * `utilization` is a percentage (0-100). `resetsAt` is an ISO-8601 timestamp
 * marking when the window resets.
 */
export type ClaudeUsageWindow = {
  utilization: number;
  resetsAt: string | null;
};

/**
 * Extra (pay-as-you-go) usage block, present only for accounts that have it
 * enabled. Mirrors the Anthropic `extra_usage` object in normalized casing.
 *
 * `monthlyLimit` / `usedCredits` are in CENTS (minor currency units), exactly
 * as the upstream oauth/usage endpoint reports them (5127 = $51.27); the
 * frontend converts to currency units at the formatting edge (formatCredits).
 */
export type ClaudeExtraUsage = {
  enabled: boolean;
  monthlyLimit: number | null; // cents
  usedCredits: number | null; // cents
  utilization: number | null;
  currency: string | null;
};

/**
 * Stable response contract for `GET /api/providers/claude/usage`.
 *
 * The frontend depends on this exact shape. Any window the upstream API reports
 * as `null` is surfaced as `null` here (never fabricated) — including
 * `weeklyOpus`, which current Max plans report as null. The frontend hides
 * null windows; the Opus row reappears automatically if upstream populates it.
 */
export type ClaudeUsageSummary = {
  plan: string | null;
  session: ClaudeUsageWindow | null;
  weeklyAllModels: ClaudeUsageWindow | null;
  weeklySonnet: ClaudeUsageWindow | null;
  weeklyOpus: ClaudeUsageWindow | null;
  extraUsage: ClaudeExtraUsage | null;
  fetchedAt: string;
  stale: boolean;
};

/**
 * Read-only view of the model Antigravity (agy CLI) most recently propagated to
 * its backend, parsed from the CLI session log. `label` is null when no
 * selection has been recorded yet (or the log is unavailable).
 */
export type AntigravityActiveModel = {
  label: string | null;
  fetchedAt: string;
};

// ---------------------------
//----------------- SESSION COST MODEL ------------
/**
 * Token counters behind one model's cost line, kept separate per billed
 * component because they are priced at different rates (a cache READ is an order
 * of magnitude cheaper than fresh input, and the two cache WRITE tiers differ
 * from each other).
 */
export type SessionCostTokens = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

/**
 * One model's share of a conversation's cost.
 *
 * `costUsd` is `null` — never `0` — when no official price is published for the
 * model: a missing price is unknown, not free, and the UI must say so.
 */
export type SessionCostModelBreakdown = {
  model: string;
  costUsd: number | null;
  requests: number;
  tokens: SessionCostTokens;
};

/**
 * Response contract of `GET /api/providers/costs/session/:sessionId`.
 *
 * Three fields carry the honesty guarantees and must never be collapsed:
 *  • `available:false` + `reason` — the provider persists no usage for this
 *    conversation, so there is no number at all (as opposed to a number of 0).
 *  • `metered:false` — usage rides a subscription plan (Claude Max/Pro, ChatGPT,
 *    GLM coding plan, consumer Gemini). The amount is then the API-EQUIVALENT
 *    VALUE of the usage, NOT money billed.
 *  • `complete:false` + `unpricedModels` — part of the conversation ran on
 *    models with no published price, so the total is a floor, not the whole.
 *
 * `provider` stays a plain string (not `LLMProvider`) because the pricing engine
 * classifies providers by name and may cover a provider before the union does.
 */
export type SessionCostSummary = {
  sessionId: string;
  provider: string;
  available: boolean;
  reason?: string;
  metered: boolean;
  totalUsd: number;
  complete: boolean;
  unpricedModels: string[];
  subagentRequests: number;
  pricesAsOf: string;
  perModel: SessionCostModelBreakdown[];
};

/**
 * Provenance of a subscription's billing-cycle anchor day. Lives here (not in
 * the cost module) because it is part of the wire contract the client renders.
 */
export type BillingAnchorSource = 'manual' | 'detected' | 'derived' | 'unknown';

/**
 * One row of `GET /api/providers/costs/subscriptions`: what a provider's usage
 * has been worth during the CURRENT billing cycle.
 *
 * The cycle is derived from `anchorDay` (the day of month the plan renews), so
 * `cycleStart`/`cycleEnd` are ISO instants the frontend can display without
 * recomputing the boundary. The same `available` / `metered` / `complete`
 * honesty rules as `SessionCostSummary` apply.
 *
 * `anchorSource` is a fourth honesty field and is REQUIRED: the same
 * `anchorDay: 1` means "the owner chose the 1st", "the plan really renews on the
 * 1st", "we guessed from the oldest usage we could see", or "we know nothing and
 * assumed the calendar month". Rendering the day without its provenance is the
 * ADR-078 failure mode (a made-up number that looks measured).
 */
export type ProviderSubscriptionCost = {
  provider: string;
  displayName: string;
  plan: string | null;
  anchorDay: number;
  /**
   * Where `anchorDay` came from:
   *  • `manual`   — the owner set it; it overrides every detection.
   *  • `detected` — a real field from real subscription data (Codex: the
   *    `chatgpt_subscription_active_start` claim in the local id_token; Claude:
   *    `oauthAccount.subscriptionCreatedAt` in `.claude.json`, which the CLI
   *    caches from `/api/oauth/profile`).
   *  • `derived`  — AN ESTIMATE from the oldest recorded usage. The UI must say
   *    so; it is not a billing fact.
   *  • `unknown`  — no source at all; the calendar month is assumed.
   */
  anchorSource: BillingAnchorSource;
  /** Machine-readable provenance for auditing (null for manual/unknown). */
  anchorEvidence?: string | null;
  /** ISO timestamp of the signal the anchor was read/derived from. */
  anchorObservedAt?: string | null;
  cycleStart: string;
  cycleEnd: string;
  available: boolean;
  reason?: string;
  metered: boolean;
  totalUsd: number;
  sessions: number;
  complete: boolean;
  unpricedModels: string[];
};

/**
 * Response contract of `GET /api/projects/:projectId/cost`.
 *
 * What a whole PROJECT's conversations have been worth, read from the cost
 * ledger (which is built by scanning the transcripts on disk, not by walking the
 * `sessions` table — the ledger exists precisely because the indexed-sessions
 * total understated the real figure ~3.2x).
 *
 * Honesty fields, same rules as `SessionCostSummary` (ADR-078):
 *  • `totalUsd: null` — the ledger holds nothing for this project (never scanned,
 *    or the project's providers persist no usage). `null` means "unknown"; a
 *    project with no priced usage must not be rendered as `$0.00`.
 *  • `complete:false` + `unpricedModels` — part of the spend ran on models with
 *    no published price, so the total is a FLOOR, not the whole.
 *  • `pricesAsOf` dates every amount in the payload. Amounts are API-equivalent
 *    VALUE for flat subscriptions (Claude Max, ChatGPT), not money billed.
 *
 * `firstDay`/`lastDay` are `YYYY-MM-DD` (the ledger's day grain), null when the
 * ledger has no rows for the project.
 */
export type ProjectCostSummary = {
  projectId: string;
  totalUsd: number | null;
  complete: boolean;
  unpricedModels: string[];
  firstDay: string | null;
  lastDay: string | null;
  pricesAsOf: string;
};

/** One day of a project's spend curve. `costUsd` is what could be PRICED that day. */
export type ProjectStatsDailyPoint = {
  /** `YYYY-MM-DD`. */
  day: string;
  costUsd: number;
};

/**
 * One non-human actor of a project (base model or subagent) with how many times
 * it was invoked. Sourced from the session-agents cache, never re-derived from
 * transcripts inside a request.
 */
export type ProjectStatsAgentRow = {
  name: string;
  invocations: number;
};

/**
 * A project's spend grouped by VENDOR (Anthropic, OpenAI, …) — the axis a bill
 * is actually paid along, which is not the same as the harness that ran the
 * model (Codex can drive an Anthropic model and vice-versa).
 */
export type ProjectStatsVendorRow = {
  vendor: string;
  displayName: string;
  /** `null` = nothing in this group carries an official price. Not zero. */
  totalUsd: number | null;
  requests: number;
};

/** A project's spend grouped by model id. `totalUsd: null` = unpriced model. */
export type ProjectStatsModelRow = {
  model: string;
  totalUsd: number | null;
  requests: number;
};

/**
 * Response contract of `GET /api/projects/:projectId/stats`.
 *
 * `agents: null` is a THIRD state and is load-bearing: the agent roster is read
 * from the session-agents cache, so `null` means "no session of this project has
 * been parsed yet — unknown", while `[]` means "parsed, and there were none".
 * Collapsing the two would show an empty roster as a measured fact.
 *
 * `conversations` counts the conversations the LEDGER saw on disk, not the rows
 * in the `sessions` table — the two differ, and the ledger's number is the true
 * one (the whole reason this surface exists).
 */
export type ProjectStatsSummary = {
  projectId: string;
  totalUsd: number | null;
  complete: boolean;
  unpricedModels: string[];
  daily: ProjectStatsDailyPoint[];
  /** Days with any recorded activity — `daily.length`, stated so the UI need not infer it. */
  activeDays: number;
  /** `YYYY-MM-DD` of the first/last day with activity; null when the ledger is empty. */
  firstActivity: string | null;
  lastActivity: string | null;
  conversations: number;
  agents: ProjectStatsAgentRow[] | null;
  byVendor: ProjectStatsVendorRow[];
  byModel: ProjectStatsModelRow[];
  pricesAsOf: string;
};

/**
 * Response envelope of `POST /api/projects/cost-ledger/scan` — the manual,
 * owner/admin-only rebuild of the ledger. Deliberately NOT reachable from a GET:
 * a scan walks thousands of transcript files.
 *
 * `scan` is the ledger's own summary, forwarded VERBATIM and intentionally left
 * unshaped: this surface is an operator diagnostic, and re-declaring the summary
 * here would be this module inventing a contract it does not own — the exact
 * failure mode ADR-078 is about. The client renders it as opaque detail.
 */
export type ProjectCostScanResponse = {
  success: true;
  scan: unknown;
};
