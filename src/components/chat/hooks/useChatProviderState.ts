import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { ENGINE_VENDOR_PROVIDERS, type VendorProvider } from '../../provider-auth/vendorProviders';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';
import {
  FALLBACK_DEFAULT_MODEL,
  PROVIDER_FALLBACK_MODELS,
  sanitizeStoredModel,
  sanitizeStoredProvider,
} from '../../../constants/providerModelFallbacks';
import { onApplyServerPreference } from '../../../preferences/preferencesSync';
import { filterDisabledProviders } from '../../../../shared/disabledProviders';
// انعكاس المزوّد العام في متجر قراءة-فقط ليستهلكه الهيدر (وغيره) تفاعلياً بلا
// prop-drilling؛ الكتابة تبقى هنا لا في المتجر (انظر selectedProviderStore.ts).
import { setSelectedProvider as mirrorSelectedProvider } from '../../../stores/selectedProviderStore';
import { getProviderCapabilities } from '../constants/providerCapabilities';

import { pickStoredOrCurrent } from './normalizeProviderModel';
import { claudeSlotCatalogProvider } from './claudeModelSlot';

// Re-export pure engine-provider storage helpers so existing callers keep their
// import path (from './useChatProviderState') without touching ChatInterface.tsx
// or other view files. The implementations live in engineProviderSession.ts
// (React-free, testable in node:test). The EngineProvider type also moves there.
export type { EngineProvider } from './engineProviderSession';
export {
  readStoredEngineProvider,
  readSessionEngineProvider,
  stampSessionEngineProvider,
  writePendingEngineStamp,
  consumePendingEngineStamp,
} from './engineProviderSession';

import {
  type EngineProvider,
  readStoredEngineProvider,
  readSessionEngineProvider,
} from './engineProviderSession';


// FALLBACK_DEFAULT_MODEL is imported from providerModelFallbacks.ts (single
// source of truth). The former local copy had claude:'opus' which is not a
// valid Claude model value, and was missing hermes and sakana entries.

// T-904 (ADR-047 م0): قارئة رفيعة فوق واصف القدرات — لا تُعرِّف مجموعات
// الأذونات بنفسها، تقرأها من PROVIDER_UI_CAPABILITIES (مصدر وحيد للحقيقة).
export const getPermissionModesForProvider = (provider: LLMProvider | string): PermissionMode[] =>
  getProviderCapabilities(provider).permissions.modes;

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
    // Sent by the server when it served a stale cache entry and launched a
    // background refresh (stale-while-revalidate). The client re-fetches this
    // provider once after REVALIDATING_REFETCH_DELAY_MS so it picks up the
    // refreshed catalog without the user pressing the manual refresh button.
    revalidating?: boolean;
  };
};

type ChangeActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string;
    supported?: boolean;
    changed?: boolean;
    model?: string | null;
  };
};

type ClearActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: string;
    sessionId?: string;
    cleared?: boolean;
    model?: string;
    source?: string;
  };
};

export function useChatProviderState({ selectedSession, selectedProject }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(() => {
    return sanitizeStoredProvider(localStorage.getItem('selected-provider'));
  });
  // "Claude engine on a vendor endpoint" (ADR-037, m-FE-9). When set to a vendor
  // id (kimi/deepseek/glm) the Claude engine is driven through that vendor's
  // Anthropic-compatible endpoint: the chat keeps provider='claude' but sends
  // options.engineProvider=<p> + the vendor model id. null = the normal Claude
  // path (official Anthropic). Persisted next to selected-provider; only ever
  // meaningful while provider==='claude'.
  const [engineProvider, setEngineProvider] = useState<EngineProvider>(() => {
    return readStoredEngineProvider();
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return sanitizeStoredModel('cursor', localStorage.getItem('cursor-model'));
  });
  // B-235: while an engine is engaged, the `claude-model` slot carries a VENDOR
  // model id (`glm-5.2`), not a Claude one — that is the whole point of the
  // engine axis (ADR-037/ADR-073: the body is Claude Code, the model id belongs
  // to the engine). Validating it against the CLAUDE catalog therefore rejected
  // the very value the user had just chosen and replaced it with the Claude
  // default. `engineProvider` is resolved just above, so the boot read is
  // governed by the engine that is actually stamped.
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return sanitizeStoredModel(
      claudeSlotCatalogProvider(engineProvider),
      localStorage.getItem('claude-model'),
    );
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return sanitizeStoredModel('codex', localStorage.getItem('codex-model'));
  });
  const [opencodeModel, setOpenCodeModel] = useState<string>(() => {
    return sanitizeStoredModel('opencode', localStorage.getItem('opencode-model'));
  });
  const [hermesModel, setHermesModel] = useState<string>(() => {
    return sanitizeStoredModel('hermes', localStorage.getItem('hermes-model'));
  });
  // Antigravity (agy) does not expose model selection from the UI; the real
  // model is chosen inside agy's own settings. We still carry a tiny piece of
  // state so the provider plugs into existing model-aware helpers uniformly.
  const [antigravityModel, setAntigravityModel] = useState<string>(() => {
    return sanitizeStoredModel('antigravity', localStorage.getItem('antigravity-model'));
  });
  // Hosted vendor providers (ADR-036). Selection persists in localStorage and is
  // reconciled against the live catalog below, exactly like the CLI providers.
  const [kimiModel, setKimiModel] = useState<string>(() => {
    return localStorage.getItem('kimi-model') || FALLBACK_DEFAULT_MODEL.kimi;
  });
  const [deepseekModel, setDeepSeekModel] = useState<string>(() => {
    return localStorage.getItem('deepseek-model') || FALLBACK_DEFAULT_MODEL.deepseek;
  });
  const [glmModel, setGlmModel] = useState<string>(() => {
    return localStorage.getItem('glm-model') || FALLBACK_DEFAULT_MODEL.glm;
  });
  const [qwenModel, setQwenModel] = useState<string>(() => {
    return localStorage.getItem('qwen-model') || FALLBACK_DEFAULT_MODEL.qwen;
  });

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);
  // Set of providers whose live catalog failed to load and are currently
  // serving the embedded fallback catalog. Empty when everything loaded live.
  const [providerModelsFallbackProviders, setProviderModelsFallbackProviders] = useState<
    LLMProvider[]
  >([]);

  const lastProviderRef = useRef(provider);
  const providerModelsRequestIdRef = useRef(0);

  // SWR re-fetch delay: after this many ms the server's background refresh has
  // almost certainly written a fresh cache entry, so a normal (no bypassCache)
  // re-fetch will return the updated catalog without triggering another SWR cycle.
  // Declared as a module-level constant-by-convention kept close to its usage site
  // so it is readable in tests (fake timers advance by this exact value).
  const REVALIDATING_REFETCH_DELAY_MS = 3_000;

  // Tracks providers already scheduled for a SWR re-fetch in this load cycle
  // (reset on every full load, NOT on individual SWR re-fetches).
  const revalidatingScheduledRef = useRef<Set<LLMProvider>>(new Set());
  // Stores the live timer handles so we can cancel them on new load or unmount.
  const revalidatingTimersRef = useRef<Map<LLMProvider, ReturnType<typeof setTimeout>>>(new Map());

  // Live mirror of `engineProvider` for the once-registered ([] deps) server
  // preference subscription below, which must not close over a stale engine.
  const engineProviderRef = useRef(engineProvider);
  engineProviderRef.current = engineProvider;

  // Persisted setter for the engine provider so the choice survives reloads.
  // The global key 'claude-engine-provider' is the same constant used by
  // engineProviderSession.ts (readStoredEngineProvider / writePendingEngineStamp).
  const persistEngineProvider = useCallback((next: EngineProvider) => {
    setEngineProvider(next);
    if (next) {
      localStorage.setItem('claude-engine-provider', next);
    } else {
      localStorage.removeItem('claude-engine-provider');
    }
  }, []);

  // Selects "Claude engine on <vendor>": keeps provider='claude' but routes the
  // engine through the vendor endpoint and pins the chosen vendor model id as the
  // Claude model (passed through unchanged server-side because an engine host is
  // engaged — ADR-037). Reused by the picker.
  const selectClaudeEngineProvider = useCallback(
    (vendor: VendorProvider, model: string) => {
      setProvider('claude');
      localStorage.setItem('selected-provider', 'claude');
      persistEngineProvider(vendor);
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
    },
    [persistEngineProvider],
  );

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    if (targetProvider === 'claude') {
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
      return;
    }

    if (targetProvider === 'cursor') {
      setCursorModel(model);
      localStorage.setItem('cursor-model', model);
      return;
    }

    if (targetProvider === 'codex') {
      setCodexModel(model);
      localStorage.setItem('codex-model', model);
      return;
    }

    if (targetProvider === 'hermes') {
      setHermesModel(model);
      localStorage.setItem('hermes-model', model);
      return;
    }

    if (targetProvider === 'kimi') {
      setKimiModel(model);
      localStorage.setItem('kimi-model', model);
      return;
    }

    if (targetProvider === 'deepseek') {
      setDeepSeekModel(model);
      localStorage.setItem('deepseek-model', model);
      return;
    }

    if (targetProvider === 'glm') {
      setGlmModel(model);
      localStorage.setItem('glm-model', model);
      return;
    }

    if (targetProvider === 'qwen') {
      setQwenModel(model);
      localStorage.setItem('qwen-model', model);
      return;
    }

    setOpenCodeModel(model);
    localStorage.setItem('opencode-model', model);
  }, []);

  // Re-fetches a single provider's catalog (normal, no bypassCache) after the
  // server has had time to complete its background revalidation. Called only from
  // the SWR timer inside loadProviderModels — never schedules another re-fetch
  // even if the response again carries revalidating:true (the guard in
  // revalidatingScheduledRef prevents looping). Uses functional setState so it
  // patches the catalog in place; the current selection is untouched.
  const fetchSingleProviderSWR = useCallback(
    async (p: LLMProvider, callerRequestId: number) => {
      // Drop if a new full load superseded this cycle.
      if (providerModelsRequestIdRef.current !== callerRequestId) return;
      try {
        const response = await authenticatedFetch(`/api/providers/${p}/models`);
        // Guard again after the async gap.
        if (providerModelsRequestIdRef.current !== callerRequestId) return;
        const body = (await response.json()) as ProviderModelsApiResponse;
        if (!response.ok || !body.success || !body.data?.models || !body.data?.cache) return;
        // Intentionally ignore body.data.revalidating here — the guard in
        // revalidatingScheduledRef already contains this provider, so a second
        // SWR cycle would be a no-op anyway.
        setProviderModelCatalog((prev) => ({ ...prev, [p]: body.data!.models! }));
        setProviderModelCacheCatalog((prev) => ({ ...prev, [p]: body.data!.cache! }));
        // If the live fetch recovered a provider that was in fallback, remove it.
        setProviderModelsFallbackProviders((prev) => prev.filter((fp) => fp !== p));
      } catch (error) {
        console.warn(`SWR re-fetch failed for provider "${p}".`, error);
      }
    },
    [],
  );

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    // Globally disabled providers (T-864) are dropped from the catalog fan-out:
    // no /models request is made for them at all — EXCEPT where the id is still
    // an eligible ENGINE (ADR-073). A provider can be retired as an agent system
    // while its endpoint remains a legal engine for the Claude body (`glm`), and
    // the "Claude engine on X" picker groups need that catalog to offer any
    // model at all. Body axis and engine axis, unioned once, here.
    const providers: LLMProvider[] = Array.from(new Set<LLMProvider>([
      ...filterDisabledProviders<LLMProvider>([
        'claude', 'cursor', 'codex', 'antigravity', 'opencode', 'hermes',
        'kimi', 'deepseek', 'glm', 'qwen',
      ]),
      ...ENGINE_VENDOR_PROVIDERS,
    ]));
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;

    // New full load cycle — cancel any pending SWR timers from the previous
    // cycle (new session open, refresh button, local-models-changed event) and
    // reset the "already scheduled" guard so providers can be re-scheduled if
    // they are still stale in the new cycle.
    revalidatingTimersRef.current.forEach((timer) => clearTimeout(timer));
    revalidatingTimersRef.current.clear();
    revalidatingScheduledRef.current.clear();

    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    // A single provider that errors out (HTTP failure, malformed body, or a
    // thrown fetch) must not blank the catalog for the others, and must never
    // leave a catalog entry undefined — an undefined entry disables the
    // self-sanitizer and lets stale values like "auto" leak to the server.
    // Each provider therefore resolves independently and falls back to the
    // embedded catalog on any failure.
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          const response = await authenticatedFetch(
            `/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`,
          );
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!response.ok || !body.success || !body.data?.models || !body.data?.cache) {
            return { provider: p, data: null as ProviderModelsApiResponse['data'] | null };
          }

          return { provider: p, data: body.data };
        } catch (error) {
          console.warn(`Failed to load live models for provider "${p}"; using fallback catalog.`, error);
          return { provider: p, data: null as ProviderModelsApiResponse['data'] | null };
        }
      }),
    );

    if (providerModelsRequestIdRef.current !== requestId) {
      return;
    }

    const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
    const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};
    const fallbackProviders: LLMProvider[] = [];

    results.forEach(({ provider: p, data }) => {
      if (data?.models && data?.cache) {
        nextCatalog[p] = data.models;
        nextCacheCatalog[p] = data.cache;
        return;
      }

      // Failed provider: keep the catalog populated with the embedded fallback
      // so the sanitizer always has a valid option list to work against.
      nextCatalog[p] = PROVIDER_FALLBACK_MODELS[p];
      fallbackProviders.push(p);
    });

    if (fallbackProviders.length > 0) {
      console.warn(
        `Provider model catalog using embedded fallback for: ${fallbackProviders.join(', ')}.`,
      );
    }

    setProviderModelCatalog(nextCatalog);
    setProviderModelCacheCatalog(nextCacheCatalog);
    setProviderModelsFallbackProviders(fallbackProviders);

    // Schedule a single SWR re-fetch for each provider the server marked as
    // stale-while-revalidating. We serve the old catalog immediately (above) so
    // there is no blank flash. After REVALIDATING_REFETCH_DELAY_MS the server's
    // background refresh has almost certainly completed, and a normal (no
    // bypassCache) re-fetch will return the updated models.
    //
    // Invariants upheld here:
    //  • One timer per provider per load cycle (revalidatingScheduledRef guards).
    //  • We do NOT re-schedule on `degraded` alone — a degraded-but-non-expired
    //    fallback is intentionally valid for 5 min; re-fetching it changes nothing.
    //  • The timer self-removes from revalidatingTimersRef before calling the
    //    fetcher, so the map stays clean if the fetcher itself errors.
    results.forEach(({ provider: p, data }) => {
      if (data?.revalidating && !revalidatingScheduledRef.current.has(p)) {
        revalidatingScheduledRef.current.add(p);
        const timer = setTimeout(() => {
          revalidatingTimersRef.current.delete(p);
          void fetchSingleProviderSWR(p, requestId);
        }, REVALIDATING_REFETCH_DELAY_MS);
        revalidatingTimersRef.current.set(p, timer);
      }
    });

    if (providerModelsRequestIdRef.current === requestId) {
      setProviderModelsLoading(false);
      setProviderModelsRefreshing(false);
    }
  }, [fetchSingleProviderSWR]);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  // Cancel any pending SWR re-fetch timers on unmount to prevent setState after
  // unmount warnings and orphaned network requests. Capture the Map object (not
  // .current) so the cleanup function references the same stable Map instance
  // while avoiding the react-hooks/exhaustive-deps ref-in-cleanup lint warning.
  useEffect(() => {
    const timerMap = revalidatingTimersRef.current;
    return () => {
      timerMap.forEach((timer) => clearTimeout(timer));
      timerMap.clear();
    };
  }, []);

  useEffect(() => {
    const refreshLocalModels = () => { void loadProviderModels(); };
    window.addEventListener('local-models-changed', refreshLocalModels);
    return () => window.removeEventListener('local-models-changed', refreshLocalModels);
  }, [loadProviderModels]);

  // Reflect account-sourced provider/model selections live after sign-in. The
  // sync layer has already written localStorage; we refresh React state and let
  // the per-provider reconcile effects above re-validate against the catalog.
  useEffect(() => {
    const offProvider = onApplyServerPreference('selected-provider', (raw) => {
      setProvider(sanitizeStoredProvider(raw));
    });
    const offClaude = onApplyServerPreference('claude-model', (raw) => {
      // B-235: same rule as the boot read — the slot is governed by the engine
      // when one is engaged. Read through the ref because this subscription is
      // registered once ([] deps) and would otherwise close over the engine
      // value as it stood at mount.
      setClaudeModel(sanitizeStoredModel(claudeSlotCatalogProvider(engineProviderRef.current), raw));
    });
    const offCursor = onApplyServerPreference('cursor-model', (raw) => {
      setCursorModel(sanitizeStoredModel('cursor', raw));
    });
    const offCodex = onApplyServerPreference('codex-model', (raw) => {
      setCodexModel(sanitizeStoredModel('codex', raw));
    });
    const offOpencode = onApplyServerPreference('opencode-model', (raw) => {
      setOpenCodeModel(sanitizeStoredModel('opencode', raw));
    });
    const offAntigravity = onApplyServerPreference('antigravity-model', (raw) => {
      setAntigravityModel(sanitizeStoredModel('antigravity', raw));
    });
    const offHermes = onApplyServerPreference('hermes-model', (raw) => {
      setHermesModel(sanitizeStoredModel('hermes', raw));
    });
    return () => {
      offProvider();
      offClaude();
      offCursor();
      offCodex();
      offOpencode();
      offAntigravity();
      offHermes();
    };
  }, []);

  // Normalize a stored/current model against the authoritative catalog entry
  // and persist the result. The catalog is always populated (live or fallback),
  // so this runs even when the live API fails — which is what prevents a stuck
  // "auto" value from ever reaching the server.
  const reconcileProviderModel = useCallback(
    (
      storageKey: string,
      def: ProviderModelsDefinition | undefined,
      current: string,
      setter: (value: string) => void,
    ) => {
      if (!def) {
        return;
      }
      const next = pickStoredOrCurrent(localStorage.getItem(storageKey), current, def);
      if (next !== current) {
        setter(next);
      }
      if (localStorage.getItem(storageKey) !== next) {
        localStorage.setItem(storageKey, next);
      }
    },
    [],
  );

  /**
   * The catalog that governs the `claude-model` slot. B-235: it is the ENGINE's
   * catalog whenever an engine is engaged, and Claude's otherwise.
   *
   * This is not a cosmetic detail — it was the whole bug. `selectClaudeEngineProvider`
   * writes the chosen vendor model id (`glm-5.2`) into `claude-model`, and the
   * reconcile below then ran it against the Claude catalog (`default`, `opus[1m]`,
   * `sonnet`, `haiku`, …), found no match, and wrote the Claude DEFAULT back over
   * it — in the same commit as the selection. The engine stamp survived, the model
   * did not: the run went out as "engine=glm + a Claude model id", the picker's
   * check mark never matched, and the chat advertised an engine it was not
   * actually asking for a model on. Silent substitution at the model level is the
   * same class of failure ADR-073 §7 outlawed at the vendor level.
   *
   * Switching direction is handled by the same expression: clearing the engine
   * re-governs the slot with the Claude catalog (so a leftover vendor id is
   * normalized back to a Claude model), and opening a session stamped with an
   * engine re-governs it with that engine's catalog (so a leftover Claude id is
   * normalized to that engine's default). The slot itself stays global — only the
   * engine is per-session — which is unchanged behaviour.
   */
  const claudeModelCatalog = providerModelCatalog[claudeSlotCatalogProvider(engineProvider)];

  useEffect(() => {
    reconcileProviderModel('claude-model', claudeModelCatalog, claudeModel, setClaudeModel);
  }, [claudeModelCatalog, claudeModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel('cursor-model', providerModelCatalog.cursor, cursorModel, setCursorModel);
  }, [providerModelCatalog.cursor, cursorModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel('codex-model', providerModelCatalog.codex, codexModel, setCodexModel);
  }, [providerModelCatalog.codex, codexModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel(
      'opencode-model',
      providerModelCatalog.opencode,
      opencodeModel,
      setOpenCodeModel,
    );
  }, [providerModelCatalog.opencode, opencodeModel, reconcileProviderModel]);

  useEffect(() => {
    reconcileProviderModel('hermes-model', providerModelCatalog.hermes, hermesModel, setHermesModel);
  }, [providerModelCatalog.hermes, hermesModel, reconcileProviderModel]);

  useEffect(() => {
    const kimi = providerModelCatalog.kimi;
    if (kimi) {
      const next = pickStoredOrCurrent('kimi-model', kimiModel, kimi);
      if (next !== kimiModel) {
        setKimiModel(next);
      }
      if (localStorage.getItem('kimi-model') !== next) {
        localStorage.setItem('kimi-model', next);
      }
    }
  }, [providerModelCatalog.kimi, kimiModel]);

  useEffect(() => {
    const deepseek = providerModelCatalog.deepseek;
    if (deepseek) {
      const next = pickStoredOrCurrent('deepseek-model', deepseekModel, deepseek);
      if (next !== deepseekModel) {
        setDeepSeekModel(next);
      }
      if (localStorage.getItem('deepseek-model') !== next) {
        localStorage.setItem('deepseek-model', next);
      }
    }
  }, [providerModelCatalog.deepseek, deepseekModel]);

  useEffect(() => {
    const glm = providerModelCatalog.glm;
    if (glm) {
      const next = pickStoredOrCurrent('glm-model', glmModel, glm);
      if (next !== glmModel) {
        setGlmModel(next);
      }
      if (localStorage.getItem('glm-model') !== next) {
        localStorage.setItem('glm-model', next);
      }
    }
  }, [providerModelCatalog.glm, glmModel]);

  useEffect(() => {
    const qwen = providerModelCatalog.qwen;
    if (qwen) {
      const next = pickStoredOrCurrent('qwen-model', qwenModel, qwen);
      if (next !== qwenModel) setQwenModel(next);
      if (localStorage.getItem('qwen-model') !== next) localStorage.setItem('qwen-model', next);
    }
  }, [providerModelCatalog.qwen, qwenModel]);

  useEffect(() => {
    if (!selectedSession?.id) {
      return;
    }

    // T-904: seed against the OPEN SESSION's own provider (mirrors
    // ChatInterface's displayProvider = selectedSession?.__provider ??
    // provider), not the global picker — so a global switch away from
    // claude never re-seeds an open claude session's permission mode
    // against another provider's mode set.
    const sessionProvider = selectedSession.__provider ?? provider;
    const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null;
    const validModes = getPermissionModesForProvider(sessionProvider);
    setPermissionMode(savedMode && validModes.includes(savedMode) ? savedMode : 'default');

    // T-915 (privacy fix): engineProvider (ADR-037) must be scoped to the OPEN
    // SESSION exactly like permissionMode above, never inherited from the
    // global picker's last choice. Before this, engineProvider was cleared only
    // when the global provider switched away from claude (see the effect
    // below) — so opening an unrelated, already-existing claude session while
    // the global pick was still a vendor (e.g. "Claude via Kimi", chosen for a
    // different new chat) sent that session's traffic through the vendor
    // unintentionally. Fail-safe: no per-session stamp (old session predating
    // this feature, or a non-claude session) => null (official Anthropic),
    // never the global key.
    setEngineProvider(sessionProvider === 'claude' ? readSessionEngineProvider(selectedSession.id) : null);
  }, [selectedSession?.id, selectedSession?.__provider, provider]);

  // Provider is driven solely by explicit user selection (localStorage).
  // Session's __provider is informational only — we never auto-override the
  // user's active choice when navigating to a project that has old sessions.

  useEffect(() => {
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    // Engine-on-vendor only applies to the Claude path; selecting any other
    // provider clears it so we never send a stale engineProvider with, e.g.,
    // a non-Claude run. (Switching back to Claude does NOT auto-restore it.)
    if (provider !== 'claude') {
      persistEngineProvider(null);
    }
    lastProviderRef.current = provider;
  }, [provider, persistEngineProvider]);

  // عكس المزوّد العام الحيّ في متجر قراءة-فقط. هذا التأثير وحده ما يُبقي المتجر
  // محدَّثاً؛ لا نُلمس أيّ موقع كتابة (المنتقي، selectClaudeEngineProvider، auth
  // fallback، تفضيل خادمي) — كلها تُحدّث حالة `provider` فتنعكس هنا تلقائياً في
  // كل مشترك (كـHeaderUsageIndicator) بلا prop-drilling ولا حلقات كتابة.
  useEffect(() => {
    mirrorSelectedProvider(provider);
  }, [provider]);

  // محور المحرّك **لا يُعكَس من هنا**: الختم الخام وحده لا يكفي (يغيب على أي
  // جهاز آخر لأنه في localStorage)، فالانعكاس يقع في ChatInterface حيث تتوفّر
  // مدخلات `resolveEffectiveEngine` كاملةً — كاتبٌ واحد لتلك الفتحة.

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    // T-904: rotate within the OPEN SESSION's own mode set, not the global
    // picker's — see the seeding effect above for the same rationale.
    const sessionProvider = selectedSession?.__provider ?? provider;
    const modes = getPermissionModesForProvider(sessionProvider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id, selectedSession?.__provider]);

  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setStoredProviderModel(targetProvider, model);
      return {
        scope: 'default' as const,
        changed: false,
        model,
      };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as ChangeActiveModelApiResponse;
    if (!response.ok || !body.success || !body.data?.supported) {
      throw new Error('Unable to change the active model for this session.');
    }

    return {
      scope: 'session' as const,
      changed: body.data.changed === true,
      model: body.data.model || model,
    };
  }, [setStoredProviderModel]);

  /**
   * ADR-099/T-1237: ينقل جلسةً قائمة إلى محرّك آخر (ومعه نموذجه).
   *
   * لماذا نداء مستقلّ بدل تمرير المحرّك مع الرسالة: قيمة المحرّك في حمولة الدور
   * يتجاهلها الخادم عمداً منذ ADR-088 (لا تأتي إلا من وسم بائت أو حمولة ملفَّقة).
   * النقل نيّةٌ تُعلَن مرّة، وتُدقَّق، وتُسجَّل — لا معاملٌ يُهرَّب كل دور.
   *
   * **الإقرار مصدره الخادم لا العميل:** نطلب بلا `acknowledgedExport`، فإن كان
   * ثمّة تاريخ يُصدَّر ردّ الخادم بـ428 ومعه عدد الأدوار، فنعرض التأكيد ونعيد
   * النداء مقرّين. فلا يقرّر العميل متى يجب السؤال — وهو ما يجعل تجاوزه عبثاً.
   */
  const restampSessionEngine = useCallback(async (
    sessionId: string,
    engine: string,
    model: string,
    confirmExport: (turns: number) => Promise<boolean> | boolean,
  ): Promise<{ engine: string; model: string; outcome: string }> => {
    const call = async (acknowledgedExport: boolean) => authenticatedFetch(
      `/api/providers/claude/sessions/${encodeURIComponent(sessionId)}/engine`,
      { method: 'POST', body: JSON.stringify({ engine, model, acknowledgedExport }) },
    );

    let response = await call(false);
    let body = await response.json() as {
      success?: boolean;
      data?: { engine: string; model: string; outcome: string };
      error?: { code?: string; message?: string; details?: { turnsExported?: number } };
    };

    if (response.status === 428) {
      // B-461: العدد داخل `details` — المعالج العام هو ما يسلسله، لا جذر الخطأ.
      const turns = Number(body?.error?.details?.turnsExported ?? 0);
      if (!(await confirmExport(turns))) {
        throw new Error('ENGINE_RESTAMP_CANCELLED');
      }
      response = await call(true);
      body = await response.json();
    }

    if (!response.ok || !body?.success || !body.data) {
      throw new Error(body?.error?.code || 'ENGINE_RESTAMP_FAILED');
    }
    return body.data;
  }, []);

  /**
   * B-252: يزيل تثبيت النموذج الصريح للجلسة.
   * DELETE /api/providers/:provider/sessions/:sessionId/active-model
   * يُعيد النموذج الذي سيسري بعد الإزالة (افتراضي المزوّد الحالي).
   */
  const clearSessionModel = useCallback(async (
    targetProvider: string,
    sessionId: string,
  ): Promise<{ cleared: boolean; model: string }> => {
    const response = await authenticatedFetch(
      `/api/providers/${encodeURIComponent(targetProvider)}/sessions/${encodeURIComponent(sessionId)}/active-model`,
      { method: 'DELETE' },
    );
    const body = (await response.json()) as ClearActiveModelApiResponse;
    if (!response.ok || !body.success) {
      throw new Error('Unable to clear the active model override for this session.');
    }
    return {
      cleared: body.data?.cleared === true,
      model: body.data?.model ?? '',
    };
  }, []);

  return {
    provider,
    setProvider,
    engineProvider,
    setEngineProvider: persistEngineProvider,
    selectClaudeEngineProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    antigravityModel,
    setAntigravityModel,
    opencodeModel,
    setOpenCodeModel,
    hermesModel,
    setHermesModel,
    kimiModel,
    setKimiModel,
    deepseekModel,
    setDeepSeekModel,
    glmModel,
    setGlmModel,
    qwenModel,
    setQwenModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    providerModelsFallbackProviders,
    providerModelsHasError: providerModelsFallbackProviders.length > 0,
    // عادي (بلا bypassCache): يرجع من الكاش إن كان صالحاً، وإلا خدم الخادم
    // المدخل القديم فوراً وأعاد تحميله خلفياً (stale-while-revalidate).
    // يُستدعى عند فتح منتقي النماذج لضمان عرض قائمة محدَّثة بلا ثمن باهظ.
    refreshProviderModels: () => loadProviderModels(),
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
    restampSessionEngine,
    clearSessionModel,
  };
}
