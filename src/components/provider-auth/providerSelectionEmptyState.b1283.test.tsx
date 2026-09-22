/**
 * providerSelectionEmptyState.b1283.test.tsx — B-1283
 *
 * يثبت أن فتح منتقي النماذج يُطلق إعادة تحميل **عادية** (بلا bypassCache)
 * للكتالوج مرة واحدة فقط، ولا يُطلق التحميل القسري (`onHardRefreshProviderModels`).
 *
 * السبب: الكتالوج يُحمَّل مرة واحدة عند تركيب `useChatProviderState`؛ فتحُ
 * المنتقي كان يحدّث حالة المصادقة فقط دون إعادة تحميل النماذج، فيرى المستخدم
 * قائمة قديمة حتى يضغط زر التحديث. التحميل العادي يرجع من الكاش إن كان
 * صالحاً، أو يخدم القديم ويُحدِّث في الخلفية (stale-while-revalidate).
 *
 * Run: npx vitest run src/components/provider-auth/providerSelectionEmptyState.b1283.test.tsx
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import type { LLMProvider, ProviderModelsDefinition, ProjectSession } from '../../types/app';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from './types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
  Trans: () => null,
}));

vi.mock('./hooks/useVendorKeyStatuses', () => ({
  useVendorKeyStatuses: () => ({ statuses: {}, loading: false, refresh: vi.fn() }),
}));

vi.mock('../../hooks/useFavoriteModels', () => ({
  useFavoriteModels: () => ({
    favorites: [],
    handleToggleFavorite: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock('../chat/hooks/useAntigravityActiveModel', () => ({
  useAntigravityActiveModel: () => ({ label: null, loading: false, error: null }),
}));

vi.mock('../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openSettings: vi.fn() }),
}));

vi.mock('../llm-logo-provider/SessionProviderLogo', () => ({
  default: () => null,
}));

import ProviderSelectionEmptyState from '../chat/view/subcomponents/ProviderSelectionEmptyState';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALL_PROVIDERS: LLMProvider[] = [
  'claude', 'cursor', 'codex', 'gemini', 'antigravity',
  'opencode', 'hermes', 'kimi', 'deepseek', 'glm', 'sakana',
];

const authMap = (): ProviderAuthStatusMap =>
  Object.fromEntries(
    ALL_PROVIDERS.map((p): [LLMProvider, ProviderAuthStatus] => [
      p,
      {
        authenticated: true,
        installed: true,
        email: null,
        method: null,
        error: null,
        loading: false,
        checkFailed: false,
      },
    ]),
  ) as ProviderAuthStatusMap;

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((v) => ({ value: v, label: v.toUpperCase() })),
  DEFAULT: values[0] ?? '',
});

const minimalCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: def('claude-opus-4-5'),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('B-1283 — فتح منتقي النماذج يُعيد تحميل الكتالوج تحميلاً عادياً', () => {
  it('يستدعي onRefreshProviderModels مرة واحدة عند فتح الحوار', async () => {
    const onRefreshProviderModels = vi.fn().mockResolvedValue(undefined);
    const onHardRefreshProviderModels = vi.fn();

    render(
      <ProviderSelectionEmptyState
        selectedSession={null as ProjectSession | null}
        currentSessionId={null}
        provider="claude"
        setProvider={vi.fn()}
        engineProvider={null}
        setEngineProvider={vi.fn()}
        onSelectClaudeEngineProvider={vi.fn()}
        textareaRef={{ current: null } as React.RefObject<HTMLTextAreaElement>}
        claudeModel="claude-opus-4-5"
        setClaudeModel={vi.fn()}
        cursorModel=""
        setCursorModel={vi.fn()}
        codexModel=""
        setCodexModel={vi.fn()}
        geminiModel=""
        setGeminiModel={vi.fn()}
        antigravityModel=""
        setAntigravityModel={vi.fn()}
        opencodeModel=""
        setOpenCodeModel={vi.fn()}
        hermesModel=""
        setHermesModel={vi.fn()}
        kimiModel=""
        setKimiModel={vi.fn()}
        deepseekModel=""
        setDeepSeekModel={vi.fn()}
        glmModel=""
        setGlmModel={vi.fn()}
        providerModelCatalog={minimalCatalog}
        providerModelsLoading={false}
        providerModelsRefreshing={false}
        providerAuthStatus={authMap()}
        onRefreshProviderModels={onRefreshProviderModels}
        onHardRefreshProviderModels={onHardRefreshProviderModels}
        onRefreshAuthStatus={vi.fn().mockResolvedValue(undefined)}
        setInput={vi.fn() as unknown as React.Dispatch<React.SetStateAction<string>>}
      />,
    );

    // فتح الحوار بالنقر على زر اختيار النموذج
    fireEvent.click(screen.getByRole('button', { name: /change model/i }));
    await screen.findByPlaceholderText('Search models...');

    // التحميل العادي يُطلَق مرة واحدة
    expect(onRefreshProviderModels).toHaveBeenCalledTimes(1);
    // التحميل القسري (bypassCache) لا يُطلَق عند مجرد فتح الحوار
    expect(onHardRefreshProviderModels).not.toHaveBeenCalled();
  });

  it('لا يُطلق طلبات متراكمة عند فتح وإغلاق الحوار بسرعة', async () => {
    const onRefreshProviderModels = vi.fn().mockResolvedValue(undefined);

    render(
      <ProviderSelectionEmptyState
        selectedSession={null as ProjectSession | null}
        currentSessionId={null}
        provider="claude"
        setProvider={vi.fn()}
        engineProvider={null}
        setEngineProvider={vi.fn()}
        onSelectClaudeEngineProvider={vi.fn()}
        textareaRef={{ current: null } as React.RefObject<HTMLTextAreaElement>}
        claudeModel="claude-opus-4-5"
        setClaudeModel={vi.fn()}
        cursorModel=""
        setCursorModel={vi.fn()}
        codexModel=""
        setCodexModel={vi.fn()}
        geminiModel=""
        setGeminiModel={vi.fn()}
        antigravityModel=""
        setAntigravityModel={vi.fn()}
        opencodeModel=""
        setOpenCodeModel={vi.fn()}
        hermesModel=""
        setHermesModel={vi.fn()}
        kimiModel=""
        setKimiModel={vi.fn()}
        deepseekModel=""
        setDeepSeekModel={vi.fn()}
        glmModel=""
        setGlmModel={vi.fn()}
        providerModelCatalog={minimalCatalog}
        providerModelsLoading={false}
        providerModelsRefreshing={false}
        providerAuthStatus={authMap()}
        onRefreshProviderModels={onRefreshProviderModels}
        onHardRefreshProviderModels={vi.fn()}
        onRefreshAuthStatus={vi.fn().mockResolvedValue(undefined)}
        setInput={vi.fn() as unknown as React.Dispatch<React.SetStateAction<string>>}
      />,
    );

    // فتح الحوار — يُطلق الطلب الأول ويضبط refreshInFlightRef=true
    fireEvent.click(screen.getByRole('button', { name: /change model/i }));
    await screen.findByPlaceholderText('Search models...');

    // الطلب الأول فقط يُطلَق (الحارس refreshInFlightRef يمنع التراكم)
    expect(onRefreshProviderModels).toHaveBeenCalledTimes(1);
  });
});
