import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, KeyRound, RefreshCw, Settings, Star } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useAntigravityActiveModel } from "../../hooks/useAntigravityActiveModel";
import { usePaletteOps } from "../../../../contexts/PaletteOpsContext";
import { useVendorKeyStatuses } from "../../../provider-auth/hooks/useVendorKeyStatuses";
import {
  isVendorProvider,
  type VendorProvider,
} from "../../../provider-auth/vendorProviders";
import { isProviderGloballyDisabled } from "../../../../../shared/disabledProviders";
import { engineProviderLabel } from "../../../../../shared/engineProviders";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import { PLACEHOLDER_FALLBACK_MODELS } from "../../../../constants/providerModelFallbacks";
import type { ProviderAuthStatusMap } from "../../../provider-auth/types";
import type { SettingsDeepLink } from "../../../settings/types/types";
import { isProviderVisible, isProviderDisabled } from "../../../provider-auth/providerAuthFilter";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
} from "../../../../shared/view/ui";
import { getProviderDisplayName } from "../../constants/providerCapabilities";

import {
  readCollapsedMap,
  writeCollapsedMap,
  resolveExpandedNoSearch,
  type CollapsedMap,
} from "./providerGroupCollapse";
import { rowsForBody, type PickerRow } from "./modelPickerRows";
import { isFavorite, resolveFavoriteRows } from "./modelFavorites";
import { useFavoriteModels } from "../../../../hooks/useFavoriteModels";

// Globally disabled providers (T-864, shared/disabledProviders.ts) never make
// it into the picker: the full list stays here for upstream-sync friendliness
// and the filter below drops the disabled ids.
const ALL_PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Google" },
  { id: "antigravity", name: "Antigravity (agy)" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "hermes", name: "Hermes (Nous)" },
  { id: "kimi", name: "Kimi" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "glm", name: "GLM" },
];

const PROVIDER_META = ALL_PROVIDER_META.filter((meta) => !isProviderGloballyDisabled(meta.id));

/**
 * English fallbacks for the engine sentence on every row (B-245). Kept beside
 * the picker rather than inside modelPickerRows.ts so that module stays free of
 * presentation, and so a missing translation degrades to a true sentence rather
 * than a raw key.
 */
const ENGINE_LINE_FALLBACK: Record<string, string> = {
  subscription: "via {{engine}} · your subscription",
  native: "via {{engine}} · its own engine",
  yourKey: "via {{host}} · your key",
  zen: "via OpenCode Zen · needs a balance",
  needsKey: "via {{host}} · add a {{engine}} key",
  upstream: "via {{engine}}",
};

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  /** Active "Claude engine on a vendor endpoint" selection (ADR-037), or null. */
  engineProvider: VendorProvider | null;
  /** Sets/clears the engine provider; used to clear it when a plain model is picked. */
  setEngineProvider: (next: VendorProvider | null) => void;
  /** Selects the Claude engine routed through a vendor endpoint + a vendor model. */
  onSelectClaudeEngineProvider: (vendor: VendorProvider, model: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  hermesModel: string;
  setHermesModel: (model: string) => void;
  kimiModel: string;
  setKimiModel: (model: string) => void;
  deepseekModel: string;
  setDeepSeekModel: (model: string) => void;
  glmModel: string;
  setGlmModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  providerModelsRefreshing: boolean;
  providerAuthStatus: ProviderAuthStatusMap;
  onHardRefreshProviderModels: () => void;
  /** @param force When true, bypasses the 30-second TTL on the caller side. */
  onRefreshAuthStatus: (force?: boolean) => Promise<void>;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /** Opens settings, optionally deep-linking to a specific agent/category (B-256). */
  onShowSettings?: (dest?: SettingsDeepLink) => void;
};

type ProviderGroup = {
  id: LLMProvider;
  name: string;
  models: { value: string; label: string; description?: string }[];
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getCurrentModel(p: LLMProvider, models: Record<LLMProvider, string>): string {
  return models[p];
}

/**
 * Clickable, keyboard-operable disclosure header for a model-picker group
 * (T-871). The WHOLE header toggles the group; the chevron rotates to the
 * inline-start on collapse (RTL-aware) and stays pointing down when open.
 *
 * It intentionally does NOT use cmdk's `heading` prop: that node is rendered
 * `aria-hidden`, so an interactive control inside it would fail WCAG
 * (aria-hidden-focus). Rendered as the group's first child instead, it is a
 * normal focusable button; cmdk still hides the whole group (header included)
 * when a search matches none of its items.
 */
function CollapsibleGroupHeader({
  expanded,
  onToggle,
  spaced,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** Adds a small top gap so it aligns with the between-groups separator. */
  spaced: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onKeyDown={(e) => {
        // cmdk's root keydown also handles Enter (it selects the highlighted
        // item). Stop it here so activating the header ONLY toggles the group
        // instead of also picking a model.
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.stopPropagation();
        }
      }}
      aria-expanded={expanded}
      className={[
        "flex w-full items-center justify-between gap-1.5 rounded-sm px-2 py-1.5",
        "text-xs font-medium uppercase tracking-wider text-muted-foreground",
        "transition-colors hover:bg-accent/40 hover:text-foreground focus:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        spaced ? "mt-1" : "",
      ].join(" ").trim()}
    >
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
      <ChevronDown
        className={[
          "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
          expanded ? "" : "-rotate-90 rtl:rotate-90",
        ].join(" ").trim()}
        aria-hidden="true"
      />
    </button>
  );
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  engineProvider,
  setEngineProvider,
  onSelectClaudeEngineProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  geminiModel,
  setGeminiModel,
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
  providerModelCatalog,
  providerModelsLoading,
  providerModelsRefreshing,
  providerAuthStatus,
  onHardRefreshProviderModels,
  onRefreshAuthStatus,
  setInput,
  onShowSettings,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const { openSettings } = usePaletteOps();
  const [dialogOpen, setDialogOpen] = useState(false);
  // ADR-030: gate the three hosted vendor providers in the picker behind a
  // configured API key. Fetch existence only (never the value).
  const { statuses: vendorKeyStatuses } = useVendorKeyStatuses();

  // Per-user favourites — stored server-side in user_ui_preferences, no
  // localStorage. isLoading hides the group until the first GET resolves so
  // we don't flash an empty favourites section on every dialog open.
  const { favorites, handleToggleFavorite, isLoading: favoritesLoading } = useFavoriteModels();

  // Tracks whether this component's own refresh cycle is in progress.
  // Used to correctly disable the refresh button while both models AND auth
  // status are fetching (providerModelsRefreshing only covers the models half).
  const [isLocalRefreshing, setIsLocalRefreshing] = useState(false);
  // Prevents launching a second concurrent refresh (e.g. rapid double-click).
  const refreshInFlightRef = useRef(false);

  // T-871: per-group collapse state for the picker. `searchQuery` mirrors the
  // cmdk search box (uncontrolled — we only observe it) so an active search can
  // override collapse; `collapsedMap` is the persisted `{ [groupId]: collapsed }`
  // preference, seeded once from localStorage. Neither touches the provider/model
  // selection state (owned elsewhere) or the installed/authenticated filtering.
  const [searchQuery, setSearchQuery] = useState("");
  const isSearching = searchQuery.trim().length > 0;
  const [collapsedMap, setCollapsedMap] = useState<CollapsedMap>(() =>
    readCollapsedMap(typeof window !== "undefined" ? window.localStorage : null),
  );

  // Flip and persist one group's collapse. `currentExpandedNoSearch` is the
  // group's effective open state ignoring search, so storing it as the new
  // COLLAPSED flag toggles the group (open→collapsed, collapsed→open).
  const toggleGroup = useCallback((groupId: string, currentExpandedNoSearch: boolean) => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [groupId]: currentExpandedNoSearch };
      writeCollapsedMap(next, typeof window !== "undefined" ? window.localStorage : null);
      return next;
    });
  }, []);

  // Trigger a refresh of auth status when the dialog opens (non-forced: TTL
  // applies here because opening the picker is not an explicit user refresh).
  useEffect(() => {
    if (!dialogOpen) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    Promise.all([onRefreshAuthStatus()]).finally(() => {
      refreshInFlightRef.current = false;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const handleRefreshClick = useCallback(async () => {
    if (providerModelsRefreshing || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsLocalRefreshing(true);
    try {
      // force=true bypasses the 30-second TTL on refreshAuthStatus so an
      // explicit button press always fetches a fresh auth status, not just
      // models. Without force the auth part is silently dropped within 30 s of
      // the dialog open, leaving the provider filter on stale data.
      await Promise.all([
        onHardRefreshProviderModels(),
        onRefreshAuthStatus(true),
      ]);
    } finally {
      refreshInFlightRef.current = false;
      setIsLocalRefreshing(false);
    }
  }, [providerModelsRefreshing, onHardRefreshProviderModels, onRefreshAuthStatus]);

  // agy supports model selection (CLI `--model`), so antigravity is a fully
  // selectable provider like the others: the chosen catalog model is stored in
  // `antigravity-model` and sent to the backend. We additionally surface agy's
  // currently-active model (from the active-model hook) as an informational
  // banner. The backend serves the live agy catalog with a fallback.
  const isAntigravity = provider === "antigravity";
  const {
    label: antigravityActiveLabel,
    loading: antigravityActiveLoading,
    error: antigravityActiveError,
  } = useAntigravityActiveModel(isAntigravity);

  // Compute per-provider visibility and disabled state via shared filter helpers.
  // Logic lives in providerAuthFilter.ts — no inline duplication here.
  const providerVisibilityMap = useMemo<Record<LLMProvider, boolean>>(() => {
    const result = {} as Record<LLMProvider, boolean>;
    for (const p of PROVIDER_META) {
      result[p.id] = isProviderVisible(providerAuthStatus[p.id]);
    }
    return result;
  }, [providerAuthStatus]);

  const providerDisabledMap = useMemo<Record<LLMProvider, boolean>>(() => {
    const result = {} as Record<LLMProvider, boolean>;
    for (const p of PROVIDER_META) {
      result[p.id] = isProviderDisabled(providerAuthStatus[p.id]);
    }
    return result;
  }, [providerAuthStatus]);

  const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
    return PROVIDER_META
      .filter((p) => providerVisibilityMap[p.id])
      .map((p) => {
        const models = providerModelCatalog[p.id]?.OPTIONS ?? [];
        return {
          id: p.id,
          name: p.name,
          // Hide models for disabled (not-authenticated) providers so the group
          // appears but no models are selectable. After catalog load, also hide
          // groups that have 0 models (empty catalog + no loading).
          models: providerDisabledMap[p.id] ? [] : models,
        };
      })
      // Post-load: drop groups with 0 models when catalog has finished loading
      // and the group is not just disabled-awaiting-auth.
      .filter((g) => {
        if (providerDisabledMap[g.id]) return true; // keep disabled groups for CTA
        if (providerModelsLoading) return true; // fail-open during load
        return g.models.length > 0;
      });
  }, [providerModelCatalog, providerVisibilityMap, providerDisabledMap, providerModelsLoading]);

  // Flat list of all rows across all visible groups — used by resolveFavoriteRows
  // to handle stale favourites: a favourite key that is no longer in this flat
  // set is skipped in the UI but kept in storage (may return if provider does).
  const allFlatRows = useMemo<PickerRow[]>(() => {
    return visibleProviderGroups.flatMap((group) =>
      rowsForBody(group.id, providerModelCatalog, vendorKeyStatuses),
    );
  }, [visibleProviderGroups, providerModelCatalog, vendorKeyStatuses]);

  // Rows to show in the pinned favourites group. Empty while favourites load.
  const favoriteRows = useMemo<PickerRow[]>(
    () => (favoritesLoading ? [] : resolveFavoriteRows(allFlatRows, favorites)),
    [allFlatRows, favorites, favoritesLoading],
  );

  // Resolve the read-only label shown for antigravity: live agy value, a clear
  // loading placeholder, or an "unknown" fallback when agy reports nothing.
  const antigravityModelDisplay = useMemo(() => {
    if (antigravityActiveLoading) {
      return t("providerSelection.antigravity.loading", { defaultValue: "Loading…" });
    }
    if (antigravityActiveError || !antigravityActiveLabel) {
      return t("providerSelection.antigravity.unknown", { defaultValue: "Unknown" });
    }
    return antigravityActiveLabel;
  }, [antigravityActiveLoading, antigravityActiveError, antigravityActiveLabel, t]);


  const modelByProvider = useMemo<Record<LLMProvider, string>>(
    () => ({
      claude: claudeModel,
      cursor: cursorModel,
      codex: codexModel,
      gemini: geminiModel,
      antigravity: antigravityModel,
      opencode: opencodeModel,
      hermes: hermesModel,
      kimi: kimiModel,
      deepseek: deepseekModel,
      glm: glmModel,
      // sakana has no dedicated state/prop in this component yet; seed with
      // the placeholder default so Record<LLMProvider, string> is exhaustive.
      sakana: PLACEHOLDER_FALLBACK_MODELS.DEFAULT,
    }),
    [
      claudeModel,
      cursorModel,
      codexModel,
      geminiModel,
      antigravityModel,
      opencodeModel,
      hermesModel,
      kimiModel,
      deepseekModel,
      glmModel,
    ],
  );

  const currentModel = getCurrentModel(provider, modelByProvider);

  const currentModelLabel = useMemo(() => {
    // In engine-on-vendor mode the active model id is a vendor model, so resolve
    // its label against the vendor catalog rather than the Claude one.
    const lookupProvider =
      provider === "claude" && engineProvider ? engineProvider : provider;
    const config = getModelConfig(lookupProvider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, engineProvider, currentModel, providerModelCatalog]);

  const setModelForProvider = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      if (providerId === "claude") {
        setClaudeModel(modelValue);
        localStorage.setItem("claude-model", modelValue);
      } else if (providerId === "codex") {
        setCodexModel(modelValue);
        localStorage.setItem("codex-model", modelValue);
      } else if (providerId === "gemini") {
        setGeminiModel(modelValue);
        localStorage.setItem("gemini-model", modelValue);
      } else if (providerId === "antigravity") {
        setAntigravityModel(modelValue);
        localStorage.setItem("antigravity-model", modelValue);
      } else if (providerId === "opencode") {
        setOpenCodeModel(modelValue);
        localStorage.setItem("opencode-model", modelValue);
      } else if (providerId === "hermes") {
        setHermesModel(modelValue);
        localStorage.setItem("hermes-model", modelValue);
      } else if (providerId === "kimi") {
        setKimiModel(modelValue);
        localStorage.setItem("kimi-model", modelValue);
      } else if (providerId === "deepseek") {
        setDeepSeekModel(modelValue);
        localStorage.setItem("deepseek-model", modelValue);
      } else if (providerId === "glm") {
        setGlmModel(modelValue);
        localStorage.setItem("glm-model", modelValue);
      } else {
        setCursorModel(modelValue);
        localStorage.setItem("cursor-model", modelValue);
      }
    },
    [
      setClaudeModel,
      setCursorModel,
      setCodexModel,
      setGeminiModel,
      setAntigravityModel,
      setOpenCodeModel,
      setHermesModel,
      setKimiModel,
      setDeepSeekModel,
      setGlmModel,
    ],
  );

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      setProvider(providerId);
      localStorage.setItem("selected-provider", providerId);
      // Picking any plain model leaves engine-on-vendor mode. (Switching to a
      // non-Claude provider also clears it in the hook, but a plain *Claude*
      // model keeps provider==='claude', so clear it explicitly here.)
      setEngineProvider(null);
      setModelForProvider(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setEngineProvider, setModelForProvider, textareaRef],
  );

  const handleEngineSelect = useCallback(
    (vendorId: VendorProvider, modelValue: string) => {
      onSelectClaudeEngineProvider(vendorId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [onSelectClaudeEngineProvider, textareaRef],
  );

  // True only while the Claude engine is actively pointed at a vendor endpoint.
  const isEngineActive = provider === "claude" && engineProvider != null;

  // Component-level selection check — used by the favourites group which
  // renders rows from multiple bodies and has no single `group.id` in scope.
  // Derives the body from `row.key` (format: `${body}:...`).
  const isRowSelectedGlobal = useCallback(
    (row: PickerRow): boolean => {
      if (row.engineProvider) {
        return (
          isEngineActive &&
          engineProvider === row.engineProvider &&
          claudeModel === row.model
        );
      }
      const rowBody = row.key.split(":")[0] as LLMProvider;
      return (
        provider === rowBody &&
        modelByProvider[rowBody] === row.model &&
        !(rowBody === "claude" && isEngineActive)
      );
    },
    [isEngineActive, engineProvider, claudeModel, provider, modelByProvider],
  );
  // One label source for the engine axis (ADR-073 §6): the same name in the
  // group heading, the active-selection card and the "ready" line, so what the
  // user reads is always the engine that will actually be called.
  const engineProviderName = engineProvider ? engineProviderLabel(engineProvider) : null;

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99]"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <SessionProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {isEngineActive
                          ? t("providerSelection.engineOnVendor", {
                              provider: engineProviderName,
                              defaultValue: "Claude engine on {{provider}}",
                            })
                          : getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {/* Show the selected catalog model for every provider,
                            including agy (now fully selectable). */}
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                    {isAntigravity && (
                      <p
                        className="mt-0.5 truncate text-[11px] text-muted-foreground/70"
                        aria-live="polite"
                      >
                        {t("providerSelection.antigravity.activeModel", {
                          defaultValue: "agy active model: {{model}}",
                          model: antigravityModelDisplay,
                        })}
                      </p>
                    )}
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>Model Selector</DialogTitle>
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Choose a model</p>
                <button
                  type="button"
                  onClick={handleRefreshClick}
                  disabled={providerModelsRefreshing || isLocalRefreshing}
                  aria-label={
                    (providerModelsRefreshing || isLocalRefreshing)
                      ? t("providerSelection.refresh.refreshing", { defaultValue: "Refreshing…" })
                      : t("providerSelection.refresh.button", { defaultValue: "Refresh models and auth status" })
                  }
                  title={
                    (providerModelsRefreshing || isLocalRefreshing)
                      ? t("providerSelection.refresh.refreshing", { defaultValue: "Refreshing…" })
                      : t("providerSelection.refresh.button", { defaultValue: "Refresh models and auth status" })
                  }
                  className="flex h-7 w-7 items-center justify-center rounded border border-border/50 bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <RefreshCw
                    className={["h-3.5 w-3.5", (providerModelsRefreshing || isLocalRefreshing) ? "animate-spin" : ""].join(" ").trim()}
                    aria-hidden="true"
                  />
                </button>
              </div>
              <Command>
                <CommandInput
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                  onValueChange={setSearchQuery}
                />
                <CommandList className="max-h-[350px]">
                  <CommandEmpty>
                    {t("providerSelection.noModelsFound", {
                      defaultValue: "No models found.",
                    })}
                  </CommandEmpty>

                  {/* ── Favourites group ── pinned at top, expanded by default.
                      Hidden during search to avoid confusing duplicates: the same
                      model appears in its body group when all groups expand on
                      search, so the favourites copy would show twice. Hiding it
                      keeps search results clean without losing the model from
                      results (it still appears in its body group). */}
                  {!isSearching && favoriteRows.length > 0 && (() => {
                    // The favourites group defaults to EXPANDED (opposite of the
                    // START_COLLAPSED default that applies to body groups — the
                    // whole point of a pinned favourites section is immediate
                    // visibility). A stored user preference still wins.
                    const FAV_GROUP_ID = "__favorites__";
                    const favStoredCollapsed = collapsedMap[FAV_GROUP_ID];
                    const favExpandedNoSearch = favStoredCollapsed !== undefined
                      ? !favStoredCollapsed
                      : true; // default open
                    return (
                      <CommandGroup
                        key={FAV_GROUP_ID}
                        className="[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                      >
                        <CollapsibleGroupHeader
                          expanded={favExpandedNoSearch}
                          onToggle={() => toggleGroup(FAV_GROUP_ID, favExpandedNoSearch)}
                          spaced={false}
                        >
                          <Star className="h-3.5 w-3.5 shrink-0 fill-current text-amber-400" aria-hidden="true" />
                          <span className="truncate">
                            {t("providerSelection.favorites.group", { defaultValue: "Favourites" })}
                          </span>
                        </CollapsibleGroupHeader>
                        {favExpandedNoSearch && favoriteRows.map((row) => {
                          const engineText = t(
                            `providerSelection.engineLine.${row.engine.key}`,
                            {
                              ...row.engine.vars,
                              defaultValue: ENGINE_LINE_FALLBACK[row.engine.key] ?? "via {{engine}}",
                            },
                          );
                          const isFav = isFavorite(row.key, favorites);
                          return (
                            <CommandItem
                              key={`fav:${row.key}`}
                              value={`fav ${row.label} ${row.description || ''} ${engineText}`}
                              onSelect={() => {
                                if (row.engineProvider) {
                                  handleEngineSelect(row.engineProvider, row.model);
                                  return;
                                }
                                // Determine which body this row belongs to by its key prefix.
                                const bodyId = row.key.split(':')[0] as typeof visibleProviderGroups[number]['id'];
                                handleModelSelect(bodyId, row.model);
                              }}
                              className="ms-4 border-s border-border/40 ps-4 group"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{row.label}</div>
                                <div className="truncate text-xs text-muted-foreground">{engineText}</div>
                                {row.description && (
                                  <div className="truncate text-[11px] text-muted-foreground/70">
                                    {row.description}
                                  </div>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {/* Star: always filled in the favourites group; toggles on click.
                                    stopPropagation prevents cmdk from treating the star click as
                                    a model selection (pointerdown + click both intercepted). */}
                                <button
                                  type="button"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleFavorite(row.key);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                                      e.stopPropagation();
                                      e.preventDefault();
                                      handleToggleFavorite(row.key);
                                    }
                                  }}
                                  aria-label={
                                    isFav
                                      ? t("providerSelection.favorites.removeAriaLabel", {
                                          model: row.label,
                                          defaultValue: "Remove {{model}} from favourites",
                                        })
                                      : t("providerSelection.favorites.addAriaLabel", {
                                          model: row.label,
                                          defaultValue: "Add {{model}} to favourites",
                                        })
                                  }
                                  aria-pressed={isFav}
                                  className="rounded p-0.5 text-amber-400 transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <Star
                                    className="h-3.5 w-3.5 fill-current"
                                    aria-hidden="true"
                                  />
                                </button>
                                {isRowSelectedGlobal(row) && (
                                  <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                                )}
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    );
                  })()}

                  {visibleProviderGroups.map((group, idx) => {
                    const isProviderDisabled = providerDisabledMap[group.id];
                    // ADR-030: a vendor provider with no configured API key is
                    // shown but locked, with a CTA to add a key instead of models.
                    const isLockedVendor =
                      isVendorProvider(group.id) && !vendorKeyStatuses[group.id];
                    // B-245: one row per runnable combination. For the Claude body
                    // this already includes its engine rows, so there is no longer a
                    // second pass of "Claude engine on X" groups after every body —
                    // the axis lives inside the body it belongs to.
                    const allRows = rowsForBody(group.id, providerModelCatalog, vendorKeyStatuses);
                    // agy resolves its model inside its own CLI; one informational
                    // row is all this picker can honestly offer for it.
                    const rows: PickerRow[] = group.id === "antigravity" ? allRows.slice(0, 1) : allRows;
                    // T-871: only a group that actually lists rows is collapsible
                    // (disabled/locked/loading groups show a CTA — nothing to fold).
                    const isCollapsible =
                      !isProviderDisabled && !isLockedVendor && rows.length > 0;
                    const expandedNoSearch = resolveExpandedNoSearch({
                      storedCollapsed: collapsedMap[group.id],
                    });
                    const expanded = isSearching || expandedNoSearch;

                    /** True when this row is the run the composer will actually make. */
                    const isRowSelected = (row: PickerRow): boolean => (
                      row.engineProvider
                        ? isEngineActive && engineProvider === row.engineProvider && claudeModel === row.model
                        : provider === group.id
                          && currentModel === row.model
                          && !(group.id === "claude" && isEngineActive)
                    );

                    return (
                      <CommandGroup
                        key={group.id}
                        className={
                          idx > 0
                            ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                            : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                        }
                        heading={
                          isCollapsible ? undefined : (
                            <span className="flex items-center gap-1.5">
                              <SessionProviderLogo provider={group.id} className={["h-3.5 w-3.5 shrink-0", isProviderDisabled ? "opacity-50" : ""].join(" ").trim()} />
                              <span className={isProviderDisabled ? "opacity-50" : ""}>{group.name}</span>
                            </span>
                          )
                        }
                      >
                        {isCollapsible && (
                          <CollapsibleGroupHeader
                            expanded={expanded}
                            onToggle={() => toggleGroup(group.id, expandedNoSearch)}
                            spaced={idx > 0}
                          >
                            <SessionProviderLogo provider={group.id} className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{group.name}</span>
                          </CollapsibleGroupHeader>
                        )}
                        {isProviderDisabled ? (
                          // Provider is installed but not authenticated — show CTA only.
                          <div className="ms-4 border-s border-border/40 py-2 ps-4">
                            <p className="mb-1.5 text-[11px] text-muted-foreground">
                              {t("providerSelection.providerUnavailable", { defaultValue: "Provider not available" })}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setDialogOpen(false);
                                openSettings('agents');
                              }}
                              className="inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={t("providerSelection.signIn", { defaultValue: "Sign in" })}
                            >
                              <Settings className="h-3 w-3" aria-hidden="true" />
                              {t("providerSelection.signIn", { defaultValue: "Sign in" })}
                            </button>
                          </div>
                        ) : (
                          <>
                            {isLockedVendor ? (
                              <CommandItem
                                value={`${group.name} add api key`}
                                onSelect={() => {
                                  setDialogOpen(false);
                                  onShowSettings?.({ tab: 'agents', agent: group.id, category: 'account' });
                                }}
                                className="ms-4 border-s border-border/40 ps-4"
                              >
                                <KeyRound className="me-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                  {t("providerSelection.addApiKey", {
                                    provider: group.name,
                                    defaultValue: "Add {{provider}} API key to enable",
                                  })}
                                </span>
                              </CommandItem>
                            ) : null}
                            {!isLockedVendor && rows.length === 0 && providerModelsLoading ? (
                              <CommandItem disabled className="ms-4 border-s border-border/40 ps-4 text-muted-foreground">
                                {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                              </CommandItem>
                            ) : null}
                            {((isCollapsible && !expanded) ? [] : (isLockedVendor ? [] : rows)).map((row) => {
                              // The engine sentence is part of the searchable text:
                              // typing "z.ai" or "zen" finds the runs on them.
                              const engineText = t(`providerSelection.engineLine.${row.engine.key}`, {
                                ...row.engine.vars,
                                defaultValue: ENGINE_LINE_FALLBACK[row.engine.key] ?? "via {{engine}}",
                              });
                              return (
                                <CommandItem
                                  key={row.key}
                                  value={`${group.name} ${row.label} ${row.description || ''} ${engineText}`}
                                  onSelect={() => {
                                    if (row.locked) {
                                      setDialogOpen(false);
                                      onShowSettings?.({ tab: 'agents', agent: group.id, category: 'account' });
                                      return;
                                    }
                                    if (row.engineProvider) {
                                      handleEngineSelect(row.engineProvider, row.model);
                                      return;
                                    }
                                    handleModelSelect(group.id, row.model);
                                  }}
                                  className="ms-4 border-s border-border/40 ps-4 group"
                                >
                                  {row.locked && (
                                    <KeyRound className="me-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className={["truncate", row.locked ? "text-muted-foreground" : ""].join(" ").trim()}>
                                      {row.label}
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">{engineText}</div>
                                    {row.description && (
                                      <div className="truncate text-[11px] text-muted-foreground/70">
                                        {row.description}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    {/* Star button — invisible on non-favourite rows until hover/focus.
                                        stopPropagation on pointerdown + click prevents cmdk from
                                        treating a star click as a model-select action. Not shown on
                                        locked rows (they open settings, not a model run). */}
                                    {!row.locked && (() => {
                                      const isFav = isFavorite(row.key, favorites);
                                      return (
                                        <button
                                          type="button"
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleToggleFavorite(row.key);
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                                              e.stopPropagation();
                                              e.preventDefault();
                                              handleToggleFavorite(row.key);
                                            }
                                          }}
                                          aria-label={
                                            isFav
                                              ? t("providerSelection.favorites.removeAriaLabel", {
                                                  model: row.label,
                                                  defaultValue: "Remove {{model}} from favourites",
                                                })
                                              : t("providerSelection.favorites.addAriaLabel", {
                                                  model: row.label,
                                                  defaultValue: "Add {{model}} to favourites",
                                                })
                                          }
                                          aria-pressed={isFav}
                                          className={[
                                            "rounded p-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            isFav
                                              ? "text-amber-400 hover:text-amber-500"
                                              : "text-muted-foreground/40 opacity-0 hover:text-amber-400 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
                                          ].join(" ").trim()}
                                        >
                                          <Star
                                            className={["h-3.5 w-3.5", isFav ? "fill-current" : ""].join(" ").trim()}
                                            aria-hidden="true"
                                          />
                                        </button>
                                      );
                                    })()}
                                    {isRowSelected(row) && (
                                      <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                                    )}
                                  </div>
                                </CommandItem>
                              );
                            })}
                          </>
                        )}
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {isEngineActive
              ? t("providerSelection.readyPrompt.claudeEngine", {
                  provider: engineProviderName,
                  model: currentModelLabel,
                  defaultValue:
                    "Ready: the Claude engine runs on {{provider}} with {{model}}. Start typing your message below.",
                })
              : {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: claudeModel,
                }),
                cursor: t("providerSelection.readyPrompt.cursor", {
                  model: cursorModel,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: codexModel,
                }),
                gemini: t("providerSelection.readyPrompt.gemini", {
                  model: geminiModel,
                }),
                antigravity: t("providerSelection.readyPrompt.antigravity", {
                  model: antigravityModel,
                  defaultValue: "Ready with Antigravity (agy) {{model}}",
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: opencodeModel,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
                hermes: t("providerSelection.readyPrompt.hermes", {
                  model: hermesModel,
                  defaultValue: "Ready with Hermes {{model}}",
                }),
                kimi: t("providerSelection.readyPrompt.kimi", {
                  model: kimiModel,
                  defaultValue: "Ready to use Kimi with {{model}}. Start typing your message below.",
                }),
                deepseek: t("providerSelection.readyPrompt.deepseek", {
                  model: deepseekModel,
                  defaultValue: "Ready to use DeepSeek with {{model}}. Start typing your message below.",
                }),
                glm: t("providerSelection.readyPrompt.glm", {
                  model: glmModel,
                  defaultValue: "Ready to use GLM with {{model}}. Start typing your message below.",
                }),
                sakana: t("providerSelection.readyPrompt.sakana", {
                  defaultValue: "Ready with Sakana",
                }),
              }[provider]
            }
          </p>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
            <Trans
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>
        </div>
      </div>
    );
  }

  return null;
}
