import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Activity,
  BadgeCheck,
  Check,
  CircleHelp,
  Clipboard,
  Coins,
  Cpu,
  Gauge,
  Package,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  Timer,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import { engineProviderLabel } from '../../../../../shared/engineProviders';
import type { LLMProvider, ProviderModelsCacheInfo, ProviderModelsDefinition } from '../../../../types/app';
import { resolveEffectiveEngine } from './engineGuard';
import type {
  CommandModalPayload,
  CostCommandData,
  HelpCommandData,
  ModelCommandData,
  StatusCommandData,
} from '../../hooks/useChatComposerState';

type CommandResultModalProps = {
  payload: CommandModalPayload | null;
  onClose: () => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>>;
  providerModelsRefreshing: boolean;
  providerModelsFallbackProviders: LLMProvider[];
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  onSelectProviderModel: (
    provider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => Promise<{
    scope: 'default' | 'session';
    model: string;
  }>;
  /**
   * المصدر الحيّ لنموذج الجلسة من ChatInterface. بيانات أمر `/models` لقطة
   * وقت التنفيذ فقط؛ تمرير هذه القيمة يبقي اللوحة والمنتقي المدمج متزامنين
   * بعد اختيارٍ متفائل أو مصالحةٍ لاحقة مع الخادم.
   */
  activeSessionModel?: string;
  /**
   * B-312: engine stamp of the OPEN session (ADR-037), or null on the official
   * Anthropic path. Non-null (or an engine inferred from the active model —
   * engineGuard.ts) means this run answers on a vendor endpoint, so picking a
   * Claude model id here would pin a model that engine cannot serve. The
   * `/models` panel then goes read-only, exactly like InlineModelSwitcher.
   */
  sessionEngineProvider?: string | null;
};

type CommandEntry = {
  name: string;
  description?: string;
  namespace?: string;
};

type ModelOption = {
  value: string;
  label?: string;
  description?: string;
};

const formatUpdatedAt = (value?: string) => {
  if (!value) {
    return 'Not cached yet';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Not cached yet';
  }

  return parsed.toLocaleString();
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
};

const FALLBACK_COMMANDS: CommandEntry[] = [
  { name: '/models', description: 'Browse available models for the active provider.' },
  { name: '/cost', description: 'Review token usage for the active session.' },
  { name: '/status', description: 'Inspect runtime, version, provider, and environment status.' },
  { name: '/memory', description: 'Open the project CLAUDE.md memory file.' },
  { name: '/config', description: 'Open settings and configuration.' },
  { name: '/help', description: 'Show command documentation and syntax.' },
];

const getProviderLabel = (provider: string | undefined, fallback = 'Unknown') => {
  if (!provider) {
    return fallback;
  }

  return PROVIDER_LABELS[provider] || provider;
};

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
};

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  compact = false,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  tone?: 'neutral' | 'primary' | 'success';
  compact?: boolean;
}) {
  const toneClass =
    tone === 'primary'
      ? 'border-primary/35 bg-primary/10 text-primary'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
        : 'border-border/70 bg-background/75 text-muted-foreground';

  return (
    <div
      className={`group rounded-2xl border border-border/70 bg-background/75 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      <div className={`inline-flex rounded-xl border ${compact ? 'mb-2 p-1.5' : 'mb-3 p-2'} ${toneClass}`}>
        <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`${compact ? 'mt-0.5 text-[13px]' : 'mt-1 text-sm'} break-all font-semibold text-foreground`}>{value}</p>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-xl border-border/70 bg-background/75 ps-9 pe-3 shadow-none focus-visible:ring-primary/40"
      />
    </div>
  );
}

function HelpContent({ data }: { data: HelpCommandData }) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const commands = (Array.isArray(data.commands) && data.commands.length > 0
    ? data.commands
    : FALLBACK_COMMANDS) as CommandEntry[];

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return commands;
    }

    return commands.filter((command) => {
      const haystack = `${command.name} ${command.description || ''} ${command.namespace || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [commands, query]);

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-h-0 flex-col gap-3">
        <SearchField value={query} onChange={setQuery} placeholder={t('commandResult.help.filterPlaceholder')} />

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-2 sm:grid-cols-2">
            {filteredCommands.map((command, index) => (
              <div
                key={`${command.namespace || 'builtin'}-${command.name}`}
                className="settings-content-enter rounded-2xl border border-border/70 bg-background/75 p-3 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-muted/25"
                style={{ animationDelay: `${Math.min(index * 18, 160)}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <code className="rounded-lg border border-primary/20 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                    {command.name}
                  </code>
                  <Badge variant="secondary" className="shrink-0 text-[10px] capitalize">
                    {command.namespace || 'builtin'}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  {command.description || t('commandResult.help.noDescription')}
                </p>
              </div>
            ))}
          </div>

          {filteredCommands.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
              {t('commandResult.help.noMatch')}
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TerminalSquare className="h-4 w-4 text-primary" />
            {t('commandResult.help.syntax')}
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p><code className="text-foreground">/command arg1 arg2</code></p>
            <p><Trans i18nKey="commandResult.help.allArgs" ns="chat" components={{ code: <code className="text-foreground" /> }} /></p>
            <p><Trans i18nKey="commandResult.help.positionalArgs" ns="chat" components={{ code: <code className="text-foreground" /> }} /></p>
            <p><Trans i18nKey="commandResult.help.fileRef" ns="chat" components={{ code: <code className="text-foreground" /> }} /></p>
          </div>
        </div>

        <div className="rounded-2xl border border-primary/25 bg-primary/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('commandResult.help.quickTip')}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            <Trans i18nKey="commandResult.help.quickTipBody" ns="chat" components={{ code: <code className="text-foreground" /> }} />
          </p>
        </div>
      </aside>
    </div>
  );
}

function ModelsContent({
  data,
  providerModelCatalog,
  providerModelCacheCatalog,
  providerModelsRefreshing,
  providerModelsFallbackProviders,
  onHardRefreshProviderModels,
  currentSessionId,
  onSelectProviderModel,
  activeSessionModel,
  sessionEngineProvider,
}: {
  data: ModelCommandData;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>>;
  providerModelsRefreshing: boolean;
  providerModelsFallbackProviders: LLMProvider[];
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  onSelectProviderModel: CommandResultModalProps['onSelectProviderModel'];
  activeSessionModel?: string;
  sessionEngineProvider?: string | null;
}) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const [changingModel, setChangingModel] = useState<string | null>(null);
  const [pendingSessionModel, setPendingSessionModel] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const currentProvider = (data?.current?.provider || 'claude') as LLMProvider;
  const currentModel = activeSessionModel || data?.current?.model || t('commandResult.status.unknown');
  const providerLabel = data?.current?.providerLabel || getProviderLabel(currentProvider);
  // B-312: is this session answered by a vendor engine (ADR-037)? Either it
  // carries a stamp, or its active model betrays one (engineGuard.ts). If so the
  // panel is READ-ONLY: pinning a Claude id here would send a model the engine
  // cannot serve, and re-pointing the engine needs the restamp contract (B-246).
  const effectiveEngine = resolveEffectiveEngine(
    sessionEngineProvider,
    currentProvider,
    currentModel,
    providerModelCatalog,
  );
  const isEngineLocked = effectiveEngine !== null;
  // ADR-073 §6: one label source for the engine axis, never the wire id.
  const engineLabel = effectiveEngine ? engineProviderLabel(effectiveEngine) : null;
  // While locked, the list must come from the ENGINE's catalog — the body's
  // catalog is exactly what must not be offered.
  const catalogProvider = (effectiveEngine ?? currentProvider) as LLMProvider;
  const isUsingFallbackCatalog = providerModelsFallbackProviders.includes(catalogProvider);
  const liveDefinition = providerModelCatalog[catalogProvider];
  const currentCache = providerModelCacheCatalog[catalogProvider] ?? data?.cache;
  const availableOptions = useMemo<ModelOption[]>(() => {
    if (liveDefinition?.OPTIONS && liveDefinition.OPTIONS.length > 0) {
      return liveDefinition.OPTIONS;
    }

    // The server payload enumerates the BODY's models; on a locked panel that is
    // the wrong axis, so an unloaded engine catalog shows nothing rather than
    // Claude ids the engine would reject.
    if (isEngineLocked) {
      return [];
    }

    if (Array.isArray(data?.availableOptions) && data.availableOptions.length > 0) {
      return data.availableOptions;
    }

    const availableModels = Array.isArray(data?.availableModels) ? data.availableModels : [];
    return availableModels.map((model) => ({ value: model, label: model }));
  }, [data, liveDefinition, isEngineLocked]);
  const defaultModel = liveDefinition?.DEFAULT || data?.defaultModel || currentModel;

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return availableOptions;
    }

    return availableOptions.filter((option) => {
      const haystack = `${option.value} ${option.label || ''} ${option.description || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [availableOptions, query]);

  const activeOption = availableOptions.find((option) => option.value === currentModel);
  const hasConcreteSessionId = typeof currentSessionId === 'string' && currentSessionId.trim().length > 0;

  const copyModel = (model: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(model).catch(() => undefined);
    }
    setCopiedModel(model);
    window.setTimeout(() => {
      setCopiedModel((current) => (current === model ? null : current));
    }, 1300);
  };

  const handleSelectModel = async (model: string) => {
    // B-312 fail-closed: never write a model id for a session an engine answers.
    // The buttons are disabled too; this is the guard that does not depend on
    // rendering (keyboard activation, future callers).
    if (isEngineLocked) {
      return;
    }
    setChangingModel(model);
    try {
      const result = await onSelectProviderModel(currentProvider, model, currentSessionId);
      if (result.scope === 'session') {
        setPendingSessionModel(result.model);
        setSelectionNotice(`Next response will resume with ${result.model}.`);
        return;
      }

      setPendingSessionModel(null);
      setSelectionNotice(`Default ${providerLabel} model set to ${result.model}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to change the model right now.';
      setSelectionNotice(message);
    } finally {
      setChangingModel(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      {isEngineLocked && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-2xl border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] leading-4 text-foreground"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span>
            <Trans
              i18nKey="commandResult.models.engineLocked"
              ns="chat"
              values={{ engine: engineLabel, provider: providerLabel }}
              components={{ strong: <strong /> }}
            />
          </span>
        </div>
      )}
      {isUsingFallbackCatalog && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-warning"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('commandResult.models.fallbackCatalog', { provider: providerLabel })}
          </span>
        </div>
      )}
      <div className="rounded-2xl border border-border/70 bg-muted/20 p-2.5">
        <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.55fr)_minmax(12rem,0.7fr)_minmax(15rem,0.9fr)] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="rounded-lg border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                {providerLabel}
              </Badge>
              <Badge variant="secondary" className="rounded-lg px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground">
                {t('commandResult.models.countBadge', { count: availableOptions.length })}
              </Badge>
            </div>

            <div className="mt-2 rounded-xl border border-primary/15 bg-primary/[0.06] px-3 py-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">{t('commandResult.models.activeModel')}</p>
              <p className="mt-1 break-all font-mono text-[0.98rem] font-semibold leading-5 text-foreground sm:text-[1.05rem]">
                {currentModel}
              </p>
              {activeOption?.label && activeOption.label !== currentModel && (
                <p className="mt-1 text-[11px] font-medium text-foreground/85">{activeOption.label}</p>
              )}
              {activeOption?.description && (
                <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{activeOption.description}</p>
              )}
              {pendingSessionModel && pendingSessionModel !== currentModel && (
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                  {t('commandResult.models.nextResponse', { model: pendingSessionModel })}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-xl border border-border/60 bg-background/55 px-2.5 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-foreground/80">{t('commandResult.models.default')}</p>
              <p className="mt-1 break-all font-mono text-[11px] font-medium text-foreground">{defaultModel}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/55 px-2.5 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-foreground/80">{t('commandResult.models.updated')}</p>
              <p className="mt-1 text-[11px] font-medium text-foreground">{formatUpdatedAt(currentCache?.updatedAt)}</p>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/55 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-foreground/80">
                {t('commandResult.models.catalogRefresh')}
              </p>
              <Badge variant="secondary" className="rounded-md px-1.5 py-0 text-[9px] uppercase tracking-[0.14em]">
                {t('commandResult.models.allProviders')}
              </Badge>
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {t('commandResult.models.cacheNote')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onHardRefreshProviderModels}
              disabled={providerModelsRefreshing}
              className="mt-2 h-8 w-full rounded-xl px-3"
            >
              <RefreshCw className={providerModelsRefreshing ? 'animate-spin' : ''} />
              {providerModelsRefreshing ? 'Refreshing catalogs...' : 'Refresh from providers'}
            </Button>
          </div>
        </div>

        <div className="mt-2 border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground">
          {isEngineLocked
            ? `Read-only: this conversation is pinned to the ${engineLabel} engine.`
            : hasConcreteSessionId
              ? 'Selecting a model stores a session override and applies it on the next response for this session.'
              : 'Selecting a model updates the default model used for new turns in this provider.'}
          {selectionNotice && <span className="ml-2 text-foreground">{selectionNotice}</span>}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-3xl border border-border/70 bg-muted/15 p-3 sm:p-4">
        <div className="mb-2.5 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="min-w-0">
            <SearchField value={query} onChange={setQuery} placeholder={`Search ${providerLabel} models...`} />
          </div>
          <Badge variant="secondary" className="h-9 justify-center rounded-xl px-3 font-mono text-xs">
            {filteredOptions.length} shown
          </Badge>
        </div>

        {filteredOptions.length > 0 ? (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid gap-2 md:grid-cols-2">
              {filteredOptions.map((option, index) => {
                const isCurrent = option.value === currentModel;
                const wasCopied = copiedModel === option.value;
                const isPendingSelection = option.value === pendingSessionModel;
                const isChanging = option.value === changingModel;
                return (
                  <div
                    key={option.value}
                    className={`settings-content-enter group flex min-h-[4.5rem] items-start gap-3 rounded-2xl border p-3 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                      isCurrent
                        ? 'border-primary/45 bg-primary/10'
                        : isPendingSelection
                          ? 'border-emerald-500/35 bg-emerald-500/10'
                          : 'border-border/70 bg-background/80 hover:border-primary/30 hover:bg-background'
                    }`}
                    style={{ animationDelay: `${Math.min(index * 14, 180)}ms` }}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectModel(option.value)}
                      disabled={Boolean(changingModel) || isEngineLocked}
                      className="min-w-0 flex-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                      title={
                        isEngineLocked
                          ? `Running on the ${engineLabel} engine — switch from the composer toolbar`
                          : undefined
                      }
                      aria-label={
                        isEngineLocked
                          ? `${option.value} (read-only: ${engineLabel} engine)`
                          : `Use model ${option.value}`
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span className="break-all font-mono text-sm font-semibold text-foreground">{option.value}</span>
                        {isCurrent && <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />}
                      </span>
                      {option.label && option.label !== option.value && (
                        <span className="mt-1 block text-xs text-muted-foreground">{option.label}</span>
                      )}
                      {option.description && (
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                      )}
                      {isCurrent && <span className="mt-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{t('commandResult.models.currentSelection')}</span>}
                      {isPendingSelection && !isCurrent && (
                        <span className="mt-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
                          {t('commandResult.models.nextResponseSelection')}
                        </span>
                      )}
                      {isChanging && (
                        <span className="mt-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                          {t('commandResult.models.applying')}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyModel(option.value)}
                      className="rounded-lg border border-border/70 bg-muted/30 p-2 text-muted-foreground transition-colors group-hover:text-primary"
                      aria-label={t('commandResult.models.copyModelId', { model: option.value })}
                    >
                      {wasCopied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-background/60 px-4 py-10 text-center text-sm text-muted-foreground">
            {t('commandResult.models.noMatch')}
          </div>
        )}
      </div>
    </div>
  );
}

function CostContent({ data }: { data: CostCommandData }) {
  const used = Number(data.tokenUsage?.used ?? 0);
  const total = Number(data.tokenUsage?.total ?? 0);
  const { t } = useTranslation('chat');
  const model = data.model || t('commandResult.status.unknown');
  const provider = getProviderLabel(data.provider, data.provider || t('commandResult.status.unknown'));
  const hasBreakdown =
    typeof data.tokenBreakdown?.input === 'number' ||
    typeof data.tokenBreakdown?.output === 'number';
  const usageRows = [
    { label: t('commandResult.cost.totalTokens'), value: formatNumber(used), icon: Activity },
    ...(hasBreakdown
      ? [
          {
            label: t('commandResult.cost.inputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.input ?? 0)),
            icon: TerminalSquare,
          },
          {
            label: t('commandResult.cost.outputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.output ?? 0)),
            icon: Coins,
          },
        ]
      : [
          {
            label: t('commandResult.cost.breakdown'),
            value: t('commandResult.cost.unavailable'),
            icon: TerminalSquare,
          },
        ]),
    ...(total > 0
      ? [{ label: 'Context window', value: formatNumber(total), icon: Gauge }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/75">
        {usageRows.map((row) => {
          const Icon = row.icon;

          return (
            <div
              key={row.label}
              className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
              </div>
              <span className="shrink-0 font-mono text-sm font-semibold text-foreground">{row.value}</span>
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('commandResult.cost.provider')}</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{provider}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('commandResult.cost.model')}</p>
            <p className="mt-1 break-all font-mono text-sm text-foreground">{model}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusContent({ data }: { data: StatusCommandData }) {
  const { t } = useTranslation('chat');
  const unknown = t('commandResult.status.unknown');
  const memoryRssMb = data.memoryUsage?.rssMb;
  const rows = [
    { label: t('commandResult.status.rows.package'), value: data.packageName || 'claude-code-ui', icon: Package },
    { label: t('commandResult.status.rows.version'), value: data.version || unknown, icon: BadgeCheck, tone: 'success' as const },
    { label: t('commandResult.status.rows.uptime'), value: data.uptime || unknown, icon: Timer },
    { label: t('commandResult.status.rows.provider'), value: getProviderLabel(data.provider, data.provider || unknown), icon: Server, tone: 'primary' as const },
    { label: t('commandResult.status.rows.model'), value: data.model || unknown, icon: Cpu },
    { label: t('commandResult.status.rows.node'), value: data.nodeVersion || unknown, icon: TerminalSquare },
    { label: t('commandResult.status.rows.platform'), value: data.platform || unknown, icon: Activity },
    { label: t('commandResult.status.rows.memory'), value: typeof memoryRssMb === 'number' ? `${memoryRssMb} MB RSS` : unknown, icon: Gauge },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-3xl border border-emerald-500/25 bg-emerald-500/10 p-4">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('commandResult.status.runtimeOnline')}</p>
            <p className="text-xs text-muted-foreground">{t('commandResult.status.processResponding', { pid: data.pid ? `#${data.pid}` : t('commandResult.status.statusWord') })}</p>
          </div>
        </div>
        <Badge className="rounded-full bg-emerald-500 text-white hover:bg-emerald-500">{t('commandResult.status.healthy')}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <MetricCard key={row.label} label={row.label} value={String(row.value)} icon={row.icon} tone={row.tone} />
        ))}
      </div>
    </div>
  );
}

export default function CommandResultModal({
  payload,
  onClose,
  providerModelCatalog,
  providerModelCacheCatalog,
  providerModelsRefreshing,
  providerModelsFallbackProviders,
  onHardRefreshProviderModels,
  currentSessionId,
  onSelectProviderModel,
  activeSessionModel,
  sessionEngineProvider = null,
}: CommandResultModalProps) {
  const { t } = useTranslation('chat');
  const isOpen = Boolean(payload);
  const kind = payload?.kind;
  const isModelsModal = kind === 'models';

  const modalMeta = {
    help: {
      eyebrow: t('commandResult.meta.help.eyebrow'),
      title: t('commandResult.meta.help.title'),
      subtitle: t('commandResult.meta.help.subtitle'),
      icon: CircleHelp,
    },
    models: {
      eyebrow: t('commandResult.meta.models.eyebrow'),
      title: t('commandResult.meta.models.title'),
      subtitle: t('commandResult.meta.models.subtitle'),
      icon: Cpu,
    },
    cost: {
      eyebrow: t('commandResult.meta.cost.eyebrow'),
      title: t('commandResult.meta.cost.title'),
      subtitle: t('commandResult.meta.cost.subtitle'),
      icon: Coins,
    },
    status: {
      eyebrow: t('commandResult.meta.status.eyebrow'),
      title: t('commandResult.meta.status.title'),
      subtitle: t('commandResult.meta.status.subtitle'),
      icon: Activity,
    },
  } as const;

  const activeMeta = kind ? modalMeta[kind] : null;
  const HeaderIcon = activeMeta?.icon || Sparkles;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(92dvh,48rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl sm:w-[min(94vw,64rem)]">
        <DialogTitle>{activeMeta?.title || 'Command Result'}</DialogTitle>

        <div
          className={`relative shrink-0 overflow-hidden border-b border-border/70 bg-gradient-to-br from-primary/15 via-background to-muted/40 ${
            isModelsModal ? 'px-4 pb-3 pt-3 sm:px-5 sm:pb-4 sm:pt-4' : 'px-4 pb-4 pt-4 sm:px-6 sm:pb-5 sm:pt-5'
          }`}
        >
          <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
          <div className="pointer-events-none absolute right-0 top-0 h-full w-1/2 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.16),transparent_58%)]" />

          <div className="relative flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3 sm:items-center">
              <div
                className={`rounded-2xl border border-primary/30 bg-primary/10 text-primary shadow-sm ${
                  isModelsModal ? 'p-2.5' : 'p-3'
                }`}
              >
                <HeaderIcon className={isModelsModal ? 'h-4 w-4' : 'h-5 w-5'} />
              </div>
              <div className="min-w-0">
                <p className="text-[12px] font-bold uppercase tracking-[0.22em] text-primary">
                  {activeMeta?.eyebrow}
                </p>
                <p className={`mt-1 font-semibold tracking-tight text-foreground ${isModelsModal ? 'text-xl sm:text-2xl' : 'text-xl sm:text-2xl'}`}>
                  {activeMeta?.title}
                </p>
                <p className={`mt-1 max-w-2xl ${isModelsModal ? 'text-sm leading-5 text-foreground/75' : 'text-sm leading-5 text-muted-foreground'}`}>
                  {activeMeta?.subtitle}
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground hover:bg-background/70 hover:text-foreground"
              aria-label={t('commandResult.closeAria')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="settings-content-enter min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
          {payload?.kind === 'help' && <HelpContent data={payload.data as HelpCommandData} />}
          {payload?.kind === 'models' && (
            <ModelsContent
              data={payload.data as ModelCommandData}
              providerModelCatalog={providerModelCatalog}
              providerModelCacheCatalog={providerModelCacheCatalog}
              providerModelsRefreshing={providerModelsRefreshing}
              providerModelsFallbackProviders={providerModelsFallbackProviders}
              onHardRefreshProviderModels={onHardRefreshProviderModels}
              currentSessionId={currentSessionId}
              onSelectProviderModel={onSelectProviderModel}
              activeSessionModel={activeSessionModel}
              sessionEngineProvider={sessionEngineProvider}
            />
          )}
          {payload?.kind === 'cost' && <CostContent data={payload.data as CostCommandData} />}
          {payload?.kind === 'status' && <StatusContent data={payload.data as StatusCommandData} />}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5" />
            <span>{t('commandResult.escHint')}</span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose} className="rounded-xl">
            {t('commandResult.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
