import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveOptions,
  ProviderAuthStatus,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderMcpServer,
  ProviderSessionActiveModelChange,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------
/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
  /**
   * Optional credential-writer facet (T-866). Present only for providers whose
   * API key can be configured from the app (claude/opencode/codex). Providers
   * without it are either hosted vendors (legacy encrypted-store path) or
   * terminal-only (the api-key routes answer 400 TERMINAL_ONLY).
   */
  readonly credentials?: IProviderCredentialWriter;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Model catalog contract for one provider.
 *
 * Implementations are responsible for resolving the provider's currently
 * supported models and converting them into the shared
 * `ProviderModelsDefinition` shape used by backend routes and frontend model
 * pickers. The `DEFAULT` field should be the most appropriate default selection
 * for that provider at the time the catalog is read.
 */
export interface IProviderModels {
  /**
   * Returns the provider's currently supported model catalog.
   *
   * `userId` lets credential-isolating providers (e.g. Claude) probe the catalog
   * under the user's own resolved environment, so the list reflects THAT
   * subscription's entitlements instead of the operator's. Providers that are not
   * per-user isolated may ignore it.
   */
  getSupportedModels(userId?: string | number | null): Promise<ProviderModelsDefinition>;

  /**
   * Returns the currently active model for one session or provider runtime.
   *
   * Implementations must use the provider-specific lookup mechanism approved
   * for that provider and fall back only to the provider catalog default when
   * no active model can be resolved.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;

  /**
   * Persists a session-scoped model override that the next resumed turn should
   * honor for this provider.
   *
   * This does not require the provider to mutate an already running remote
   * session in-place. Instead, adapters store the user's explicit model choice
   * so the backend resume path can add the correct provider-native model option
   * on the next CLI/SDK invocation for the same session.
   */
  changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange>;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   *
   * `userId` lets credential-isolating providers (e.g. Claude) report the auth
   * state of the user's actual resolved environment instead of the operator's
   * fixed home. Providers that are not per-user isolated may ignore it.
   */
  getStatus(userId?: string | number | null): Promise<ProviderAuthStatus>;

  /**
   * OPTIONAL install-only probe: reports whether the provider runtime is present
   * WITHOUT reading, resolving, or LOGGING any credential state.
   * `providerAuthService.isProviderInstalled` prefers this when a provider offers
   * it, so a bare "is the CLI here?" check (spawn error handlers building a
   * clearer message) never triggers a credential side effect. Notably it keeps
   * ClaudeProviderAuth's credentials diagnostic — which a userId-less getStatus
   * emits against the OPERATOR fallback (~/.claude) — from misreporting an expired
   * operator token as an owner auth failure (B-190). Providers without it fall
   * back to getStatus().installed unchanged.
   */
  isInstalled?(): boolean | Promise<boolean>;
}

// ---------------------------
//----------------- PROVIDER CREDENTIAL WRITER INTERFACE ------------
/**
 * How a provider's API key is physically written for a user (T-866):
 *  - 'native_file': the server merges the key into the provider's own native
 *    credential/config file inside the user's resolved (isolated) tree.
 *  - 'cli_stdin':   the server drives the provider CLI (key passed via stdin
 *    only — never argv) under the user's resolved environment.
 *  - 'none':        the provider cannot be configured from the app.
 */
export type ProviderCredentialWriteMethod = 'native_file' | 'cli_stdin' | 'none';

/**
 * Writer capability advertised to the frontend so it can render the right
 * key-entry UI. `targets` (when present) lists the internal credential targets
 * the writer accepts (e.g. opencode: 'anthropic' | 'openai' | 'openrouter');
 * absent means the provider has a single implicit target.
 */
export type ProviderCredentialWriterCapability = {
  method: ProviderCredentialWriteMethod;
  targets?: readonly string[];
};

/**
 * Existence-only result returned by every credential-writer operation and by
 * the api-key routes. NEVER carries the key value (security invariant).
 */
export type ProviderCredentialStatus = {
  provider: LLMProvider;
  configured: boolean;
};

/**
 * Credential-writer contract for one provider (T-866).
 *
 * Implementations write/delete the user's API key in the provider's OWN
 * credential surface, resolved through the central isolation seam
 * (resolveProviderEnv) so an isolated user's key lands in their tree and never
 * in the operator's. Invariants every implementation MUST hold:
 *  - the key value is never logged, never echoed in a result, never in argv;
 *  - writes are atomic (tmp + rename, file 0600, dir 0700);
 *  - a corrupt credential file degrades to "not configured", never a crash;
 *  - nothing under a `*_BASE_URL` env key is ever written (iron rule).
 */
export interface IProviderCredentialWriter {
  /**
   * Stores (or replaces) the user's API key for the optional target. Resolves
   * to `{ provider, configured: true }`; rejects with a 400-shaped error for an
   * empty key or an unsupported target.
   */
  setApiKey(
    userId: string | number | null | undefined,
    apiKey: string,
    target?: string,
  ): Promise<ProviderCredentialStatus>;

  /**
   * Removes the user's stored API key for the optional target (only that
   * target — other credentials in the same file are preserved). Idempotent;
   * resolves to `{ provider, configured: false }`.
   */
  deleteApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<ProviderCredentialStatus>;

  /**
   * Reports whether a usable key is stored for the user/target without ever
   * returning the secret. A corrupt/unreadable file reads as `false`.
   */
  isConfigured(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<boolean>;

  /** Describes how (and for which targets) this writer stores keys. */
  getWriterCapability(): ProviderCredentialWriterCapability;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written. Providers without a managed writable global skill
   * location must reject the call.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  /**
   * Removes one previously installed global user-scoped skill by directory name.
   *
   * Implementations must resolve the target inside the provider's writable user
   * skill folder, reject traversal, and surface a not-found error when the skill
   * directory is absent. Providers without a managed writable global skill
   * location must reject the call.
   *
   * `options` is optional and additive (B-153): implementations that predate it
   * may keep the single-argument signature.
   */
  removeSkill(directoryName: string, options?: ProviderSkillRemoveOptions): Promise<ProviderSkill>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  listServers(options?: { workspacePath?: string; userId?: string | number | null }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string; userId?: string | number | null }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string; userId?: string | number | null },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}
