import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderModelsResult,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  readProviderSessionActiveModelChange,
  removeProviderSessionActiveModelChange,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Short TTL applied when a provider returns a degraded/fallback catalog
 * (`ProviderModelsDefinition.degraded === true`). A degraded result must not be
 * pinned for the normal multi-day TTL: the live fetch is re-attempted within
 * minutes so the catalog recovers quickly once the provider's token/network is
 * back. Five minutes mirrors the catalog client's circuit-breaker cooldown, so
 * the next refresh lands right around when the breaker reopens.
 */
export const PROVIDER_MODELS_DEGRADED_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Schema/content version of the persisted catalog file. A mismatch makes
 * {@link readProviderModelsCacheFile} discard the WHOLE file, so this constant is
 * the only lever that retires already-written catalogs before their TTL.
 *
 * ⚠️ BUMP THIS whenever a model id that OUR OWN CODE declares is added, renamed or
 * REMOVED — carrier ids in particular (`GLM_CARRIER_MODELS` → `opencode.json` →
 * `glm/<id>` in the opencode listing). Deleting an id from the code does not reach
 * a catalog already on disk: entries live for {@link PROVIDER_MODELS_CACHE_TTL_MS}
 * (three days) under `~/.cloudcli/provider-models-cache.json`.
 *
 * B-234 (2026-07-27) — measured, not hypothetical: B-220 deleted the phantom
 * `glm-5.2[1m]` (z.ai answers `1211 Unknown Model`) from every code path and the
 * live `opencode models` listing was clean, yet the cached `opencode::user:*`
 * entries written at 09:59Z kept offering `glm/glm-5.2[1m]` until 2026-07-30. The
 * picker showed it, the operator chose it, and the run died with "OpenCode CLI
 * exited with code 1". A code-only deletion is not a deletion while this number
 * stays put. `provider-models-cache-version.test.ts` fails if the carrier catalog
 * changes without this number changing.
 *
 * 2 — B-234: retires every catalog written before the `glm-5.2[1m]` deletion.
 */
export const PROVIDER_MODELS_CACHE_VERSION = 2;

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  cachePath?: string;
  activeModelChangesPath?: string;
  now?: () => number;
};

type ProviderModelsOptions = {
  bypassCache?: boolean;
};

/**
 * Composite in-memory/persisted cache key: the provider, optionally scoped to a
 * user. The Claude catalog is per-subscription (it is probed under the user's own
 * CLAUDE_CONFIG_DIR), so each user's catalog must cache independently; otherwise
 * one account's model list would leak to another. Providers that ignore `userId`
 * (everything except Claude today) always resolve to the bare-provider key, so
 * their caching is byte-for-byte unchanged. A bare `LLMProvider` value is itself
 * a valid CacheKey (the shared/no-user bucket), so existing string keys on disk
 * keep loading.
 */
type CacheKey = string & { readonly __brand?: 'ProviderModelsCacheKey' };

const buildCacheKey = (
  provider: LLMProvider,
  userId?: string | number | null,
): CacheKey => (
  userId === null || userId === undefined || userId === ''
    ? provider
    : `${provider}::user:${String(userId)}`
);

type ProviderModelsCacheEntry = {
  updatedAt: number;
  expiresAt: number;
  models: ProviderModelsDefinition;
};

type ProviderModelsCacheFile = {
  version: number;
  entries: Record<string, ProviderModelsCacheEntry>;
};

const getProviderModelsCachePath = (): string => path.join(
  os.homedir(),
  '.cloudcli',
  'provider-models-cache.json',
);

const toProviderModelsCacheInfo = (
  entry: ProviderModelsCacheEntry,
  source: ProviderModelsCacheInfo['source'],
): ProviderModelsCacheInfo => ({
  updatedAt: new Date(entry.updatedAt).toISOString(),
  expiresAt: new Date(entry.expiresAt).toISOString(),
  source,
});

const isProviderModelOption = (
  value: unknown,
): value is ProviderModelsDefinition['OPTIONS'][number] => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).value === 'string'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).label === 'string'
  && (
    typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'undefined'
    || typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'string'
  )
);

const isProviderModelsDefinition = (value: unknown): value is ProviderModelsDefinition => (
  Boolean(value)
  && typeof value === 'object'
  && Array.isArray((value as ProviderModelsDefinition).OPTIONS)
  && (value as ProviderModelsDefinition).OPTIONS.every(isProviderModelOption)
  && typeof (value as ProviderModelsDefinition).DEFAULT === 'string'
);

const isProviderModelsCacheEntry = (value: unknown): value is ProviderModelsCacheEntry => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsCacheEntry).updatedAt === 'number'
  && typeof (value as ProviderModelsCacheEntry).expiresAt === 'number'
  && isProviderModelsDefinition((value as ProviderModelsCacheEntry).models)
);

const readProviderModelsCacheFile = async (
  cachePath: string,
): Promise<ProviderModelsCacheFile | null> => {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderModelsCacheFile>;
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return null;
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter((entry): entry is [string, ProviderModelsCacheEntry] =>
        isProviderModelsCacheEntry(entry[1]),
      ),
    );

    return {
      version: PROVIDER_MODELS_CACHE_VERSION,
      entries,
    };
  } catch {
    return null;
  }
};

const writeProviderModelsCacheFile = async (
  cachePath: string,
  entries: Map<CacheKey, ProviderModelsCacheEntry>,
  now: number,
): Promise<void> => {
  const serializableEntries = Object.fromEntries(
    [...entries.entries()].filter(([, entry]) => entry.expiresAt > now),
  );
  const payload: ProviderModelsCacheFile = {
    version: PROVIDER_MODELS_CACHE_VERSION,
    entries: serializableEntries,
  };

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const cachePath = dependencies.cachePath ?? getProviderModelsCachePath();
  const activeModelChangesPath = dependencies.activeModelChangesPath;
  const now = dependencies.now ?? (() => Date.now());
  // Keyed by CacheKey (provider, optionally user-scoped) so a per-subscription
  // Claude catalog never collides with another user's. Non-isolated providers
  // resolve to the bare-provider key and are unaffected.
  const memoryCache = new Map<CacheKey, ProviderModelsCacheEntry>();
  const pendingRequests = new Map<CacheKey, Promise<ProviderModelsResult>>();
  let persistedCacheLoaded = false;
  let persistedCacheLoadPromise: Promise<void> | null = null;

  const pruneExpiredMemoryEntry = (
    cacheKey: CacheKey,
    currentTime: number,
    source: ProviderModelsCacheInfo['source'],
  ): ProviderModelsResult | null => {
    const cachedEntry = memoryCache.get(cacheKey);
    if (!cachedEntry) {
      return null;
    }

    if (cachedEntry.expiresAt > currentTime) {
      return {
        models: cachedEntry.models,
        cache: toProviderModelsCacheInfo(cachedEntry, source),
      };
    }

    // Expired: do NOT evict here. The entry is retained so the
    // stale-while-revalidate path can serve it instantly while a fresh fetch
    // runs in the background; a successful refresh overwrites it via
    // setCacheEntry. Returning null signals "not fresh" to the caller.
    return null;
  };

  /**
   * Returns the cached entry for a cache key regardless of expiry, without
   * evicting it. Used by the stale-while-revalidate path so an expired-but-still
   * usable catalog can be served instantly while a fresh fetch runs in the
   * background. Returns `null` only when nothing is cached at all.
   */
  const peekMemoryEntry = (cacheKey: CacheKey): ProviderModelsCacheEntry | null =>
    memoryCache.get(cacheKey) ?? null;

  /**
   * Kicks off a background refresh for a (provider, user) if one is not already
   * running, and never throws into the caller. The returned (already-cached)
   * result is served immediately; this refresh updates the cache for the next
   * request. Errors are swallowed so a failing live fetch can never reject the
   * non-blocking request path (the provider adapter itself degrades to its
   * fallback catalog on failure).
   */
  const triggerBackgroundRefresh = (
    provider: LLMProvider,
    cacheKey: CacheKey,
    userId?: string | number | null,
  ): void => {
    if (pendingRequests.has(cacheKey)) {
      return;
    }
    void loadAndCacheModels(provider, cacheKey, userId).catch(() => {
      // Background refresh failure is non-fatal: the stale entry stays served and
      // the next request retries. The adapter already degrades on its own errors.
    });
  };

  const loadPersistedCache = async (): Promise<void> => {
    if (persistedCacheLoaded) {
      return;
    }

    if (!persistedCacheLoadPromise) {
      persistedCacheLoadPromise = (async () => {
        const cacheFile = await readProviderModelsCacheFile(cachePath);

        // Load every persisted entry, including expired ones. Fresh entries are
        // served directly; expired entries are retained so the
        // stale-while-revalidate path can serve them instantly after a restart
        // while a background refresh runs. The disk writer already drops entries
        // whose TTL lapsed before the previous persist, so this only keeps
        // recently-expired snapshots worth revalidating against.
        for (const [key, entry] of Object.entries(cacheFile?.entries ?? {})) {
          memoryCache.set(key as CacheKey, entry);
        }

        persistedCacheLoaded = true;
      })().finally(() => {
        persistedCacheLoadPromise = null;
      });
    }

    await persistedCacheLoadPromise;
  };

  const persistCache = async (): Promise<void> => {
    try {
      await writeProviderModelsCacheFile(cachePath, memoryCache, now());
    } catch (error) {
      console.warn('Unable to persist provider models cache:', error);
    }
  };

  const setCacheEntry = async (
    cacheKey: CacheKey,
    models: ProviderModelsDefinition,
  ): Promise<ProviderModelsCacheEntry> => {
    const currentTime = now();
    // A degraded/fallback catalog is cached only briefly so the live fetch is
    // re-attempted soon; an authoritative live catalog keeps the long TTL.
    const ttl = models.degraded === true
      ? PROVIDER_MODELS_DEGRADED_CACHE_TTL_MS
      : PROVIDER_MODELS_CACHE_TTL_MS;
    const entry: ProviderModelsCacheEntry = {
      updatedAt: currentTime,
      expiresAt: currentTime + ttl,
      models,
    };

    memoryCache.set(cacheKey, entry);
    await persistCache();
    return entry;
  };

  const loadAndCacheModels = (
    provider: LLMProvider,
    cacheKey: CacheKey,
    userId?: string | number | null,
  ): Promise<ProviderModelsResult> => {
    // `userId` reaches the adapter so credential-isolating providers (Claude)
    // probe under the right subscription; non-isolated adapters ignore it.
    const request = resolveProvider(provider).models.getSupportedModels(userId ?? null)
      .then(async (models) => {
        const entry = await setCacheEntry(cacheKey, models);
        return {
          models,
          cache: toProviderModelsCacheInfo(entry, 'fresh'),
        };
      })
      .finally(() => {
        pendingRequests.delete(cacheKey);
      });

    pendingRequests.set(cacheKey, request);
    return request;
  };

  const getProviderModels = async (
    provider: LLMProvider,
    options: ProviderModelsOptions = {},
    userId?: string | number | null,
  ): Promise<ProviderModelsResult> => {
    // Scope the whole cache lookup to (provider, user). Callers that pass no
    // userId (e.g. the send hot path) use the shared bare-provider key, so their
    // behaviour is unchanged.
    const cacheKey = buildCacheKey(provider, userId);

    if (options.bypassCache) {
      const pendingRequest = pendingRequests.get(cacheKey);
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadAndCacheModels(provider, cacheKey, userId);
    }

    const cachedModels = pruneExpiredMemoryEntry(cacheKey, now(), 'memory');
    if (cachedModels) {
      return cachedModels;
    }

    const pendingRequest = pendingRequests.get(cacheKey);
    if (pendingRequest) {
      return pendingRequest;
    }

    await loadPersistedCache();

    const persistedModels = pruneExpiredMemoryEntry(cacheKey, now(), 'disk');
    if (persistedModels) {
      return persistedModels;
    }

    const postLoadPendingRequest = pendingRequests.get(cacheKey);
    if (postLoadPendingRequest) {
      return postLoadPendingRequest;
    }

    // Stale-while-revalidate: if a now-expired entry is still cached, serve it
    // immediately (non-blocking) and refresh in the background. This keeps the
    // live Claude probe (which can take seconds) off the request hot path — the
    // UI always gets an instant answer and the catalog updates for next time.
    const staleEntry = peekMemoryEntry(cacheKey);
    if (staleEntry) {
      triggerBackgroundRefresh(provider, cacheKey, userId);
      return {
        models: staleEntry.models,
        cache: toProviderModelsCacheInfo(staleEntry, 'memory'),
      };
    }

    // No cache at all (cold start) — there is nothing to serve, so await the
    // fetch this once. The adapter degrades to its fallback on failure, so this
    // still resolves quickly under normal conditions.
    return loadAndCacheModels(provider, cacheKey, userId);
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const changeActiveModel = async (
    provider: LLMProvider,
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> => resolveProvider(provider).models.changeActiveModel(input);

  const getChangedActiveModel = async (
    provider: LLMProvider,
    sessionId: string,
  ): Promise<ProviderSessionActiveModelChange> => readProviderSessionActiveModelChange(provider, sessionId, {
    filePath: activeModelChangesPath,
  });

  // Unpins a session (B-252): removes its (provider, sessionId) override so the
  // resume path stops replaying an explicit re-pick. Reports whether an override
  // actually existed and was removed; a no-op when none was stored. Writes to the
  // SAME store {@link getChangedActiveModel} reads (honouring the injected test
  // path), so a subsequent read reports `changed: false`.
  const clearChangedActiveModel = async (
    provider: LLMProvider,
    sessionId: string,
  ): Promise<{ cleared: boolean }> => removeProviderSessionActiveModelChange(provider, sessionId, {
    filePath: activeModelChangesPath,
  });

  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    // A brand-new conversation (no session id yet) is the ONE place the caller's
    // current selection is honoured: the freshly minted session inherits it
    // (B-167 requirement 3). Every existing session resolves its model from its
    // OWN state below, never from the caller's global picker selection.
    if (!sessionId?.trim()) {
      return normalizedRequestedModel || undefined;
    }

    // An explicit in-conversation model re-pick wins and is scoped to this one
    // session (B-167 requirement 2): the change store is keyed by (provider,
    // sessionId), so it can never bleed into another conversation.
    const changedModel = await getChangedActiveModel(provider, sessionId);
    if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
      return changedModel.model.trim();
    }

    // No explicit re-pick: pin the session to the model it is ACTUALLY running on,
    // read from the provider's own per-session store (opencode.db, the Claude
    // transcript, the Cursor session store …) — NOT the caller's global picker
    // selection. This is the B-167 fix (requirement 1): the frontend sends its
    // current global model on every turn, and this path used to forward it
    // verbatim, so picking a model for a NEW conversation leaked onto every
    // existing session's next turn. Providers without a per-session model memory
    // fall back to their catalog default here (still isolated from the leak);
    // the requested global is used only as a last resort.
    try {
      const sessionModel = (await getCurrentActiveModel(provider, sessionId)).model?.trim();
      if (sessionModel) {
        return sessionModel;
      }
    } catch {
      // Fall through to the requested model when the per-session lookup fails.
    }

    return normalizedRequestedModel || undefined;
  };

  /**
   * Seeds the per-session model store at session CREATION so a provider WITHOUT
   * a per-session model memory of its own (gemini / codex / hermes / hosted
   * vendors) is pinned to the model it was created with — a later model pick in a
   * DIFFERENT conversation can then never bleed onto this session's next turn
   * (B-167 / T-874 requirement 2). It writes through the SAME change store that
   * {@link resolveResumeModel} consults via {@link getChangedActiveModel}, so the
   * seeded value is returned on the next resume instead of the catalog default.
   *
   * Providers that DO carry their own per-session model (claude transcript,
   * opencode.db, cursor store, the agy brain) must NOT be seeded — their own
   * store is already authoritative — so callers only invoke this for the
   * memoryless providers.
   *
   * Idempotent and best-effort:
   *   * an empty/whitespace model (no explicit selection) seeds nothing, so the
   *     provider's own default keeps applying uniformly on every turn;
   *   * an existing explicit re-pick is never overwritten (the seed only fills an
   *     empty slot at creation, it never clobbers a later user choice);
   *   * a write/read failure is swallowed — seeding must never break the spawn
   *     that created the session.
   *
   * Note: it deliberately calls {@link writeProviderSessionActiveModelChange}
   * directly rather than the provider adapter's `changeActiveModel`, because some
   * memoryless adapters (hermes) intentionally throw `NOT_IMPLEMENTED` for
   * `changeActiveModel`; the nassaj-owned change store is provider-agnostic.
   */
  const seedSessionModel = async (
    provider: LLMProvider,
    sessionId: string | undefined | null,
    model: string | undefined | null,
  ): Promise<void> => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (!normalizedSessionId || !normalizedModel) {
      return;
    }

    try {
      const existing = await getChangedActiveModel(provider, normalizedSessionId);
      if (existing.changed) {
        // A later explicit re-pick already owns this session; never clobber it.
        return;
      }

      await writeProviderSessionActiveModelChange(
        provider,
        { sessionId: normalizedSessionId, model: normalizedModel },
        { filePath: activeModelChangesPath },
      );
    } catch {
      // Best-effort: a seeding failure must not break session creation.
    }
  };

  const clearCache = (): void => {
    memoryCache.clear();
    pendingRequests.clear();
    persistedCacheLoaded = false;
    persistedCacheLoadPromise = null;
  };

  return {
    getProviderModels,
    getCurrentActiveModel,
    getChangedActiveModel,
    clearChangedActiveModel,
    changeActiveModel,
    resolveResumeModel,
    seedSessionModel,
    clearCache,
  };
};

export const providerModelsService = createProviderModelsService();
