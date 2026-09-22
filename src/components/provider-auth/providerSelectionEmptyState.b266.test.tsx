/**
 * providerSelectionEmptyState.b266.test.tsx — B-266
 *
 * العيب تفاضلي لا مطلق: «No models found» كانت تظهر فوق مجموعات **غير فارغة**
 * لأن `CommandEmpty` في cmdk يَعدّ الصفوف **المعروضة**، والمجموعة المطويّة لا
 * تعرض صفاً. لذلك اختبارٌ يمرّ على الحالة الفارغة وحدها لا يحرس شيئاً: كلا
 * السلوكين (المعيب والسليم) يُظهر الرسالة هناك.
 *
 * الحارس هنا يقابل ثلاث حالات بعضها ببعض:
 *  (أ) مجموعات مطويّة **غير فارغة**  ⇒ لا رسالة إطلاقاً  ← تسقط قبل الإصلاح
 *  (ب) لا مزوّد مرئياً أصلاً          ⇒ الرسالة تظهر     ← الحالة الفارغة فعلاً
 *  (ج) بحث لا يطابق شيئاً             ⇒ الرسالة تظهر     ← اعتماد cmdk المشروع
 *
 * موضع الملف: المكوّن المُختبَر يقع تحت `src/components/chat/…`، لكن مجلد chat
 * كان محجوزاً لجلسة موازية وقت كتابة هذا الحارس، فوُضع مع تبعيّاته المباشرة
 * (‏providerAuthFilter / useVendorKeyStatuses / vendorProviders) تحت provider-auth.
 * نقله إلى جوار المكوّن لاحقاً لا يغيّر شيئاً سوى مسارات الاستيراد.
 *
 * Run: npx vitest run src/components/provider-auth/providerSelectionEmptyState.b266.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import type {
  LLMProvider,
  ProviderModelsDefinition,
  ProjectSession,
} from '../../types/app';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from './types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
  // `Trans` is used once for the ⌘K hint; the literal is irrelevant here.
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
import { COLLAPSE_STORAGE_KEY, START_COLLAPSED } from '../chat/view/subcomponents/providerGroupCollapse';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const EMPTY_MESSAGE = 'No models found.';

const status = (over: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus => ({
  authenticated: true,
  installed: true,
  email: null,
  method: null,
  error: null,
  loading: false,
  checkFailed: false,
  ...over,
});

const ALL_PROVIDERS: LLMProvider[] = [
  'claude',
  'cursor',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'hermes',
  'kimi',
  'deepseek',
  'glm',
  'sakana',
];

const authMap = (over: Partial<ProviderAuthStatus>): ProviderAuthStatusMap =>
  Object.fromEntries(
    ALL_PROVIDERS.map((p) => [p, status(over)]),
  ) as ProviderAuthStatusMap;

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((v) => ({ value: v, label: v.toUpperCase() })),
  DEFAULT: values[0] ?? '',
});

function renderPicker(props: {
  authStatus: ProviderAuthStatusMap;
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
}) {
  const noop = () => {};
  return render(
    <ProviderSelectionEmptyState
      selectedSession={null as ProjectSession | null}
      currentSessionId={null}
      provider="claude"
      setProvider={noop}
      engineProvider={null}
      setEngineProvider={noop}
      onSelectClaudeEngineProvider={noop}
      textareaRef={{ current: null } as React.RefObject<HTMLTextAreaElement>}
      // Deliberately NOT one of the catalog values: the trigger card echoes the
      // selected model's label, and reusing a catalog label there would make the
      // list assertions match that card instead of the list.
      claudeModel="none-selected"
      setClaudeModel={noop}
      cursorModel=""
      setCursorModel={noop}
      codexModel=""
      setCodexModel={noop}
      geminiModel=""
      setGeminiModel={noop}
      antigravityModel=""
      setAntigravityModel={noop}
      opencodeModel=""
      setOpenCodeModel={noop}
      hermesModel=""
      setHermesModel={noop}
      kimiModel=""
      setKimiModel={noop}
      deepseekModel=""
      setDeepSeekModel={noop}
      glmModel=""
      setGlmModel={noop}
      providerModelCatalog={props.catalog}
      providerModelsLoading={false}
      providerModelsRefreshing={false}
      providerAuthStatus={props.authStatus}
      onRefreshProviderModels={vi.fn().mockResolvedValue(undefined)}
      onHardRefreshProviderModels={noop}
      onRefreshAuthStatus={vi.fn().mockResolvedValue(undefined)}
      setInput={noop as unknown as React.Dispatch<React.SetStateAction<string>>}
    />,
  );
}

async function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: /change model/i }));
  await screen.findByPlaceholderText('Search models...');
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
  // cmdk + radix reach for APIs jsdom does not implement.
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('B-266 — «No models found» must describe the DATA, not the fold', () => {
  it('precondition: groups start collapsed, so the fold is the default state', () => {
    // If this ever flips, case (أ) below stops exercising the collapsed path
    // and the guard silently turns into a no-op. Fail loudly instead.
    expect(START_COLLAPSED).toBe(true);
    expect(window.localStorage.getItem(COLLAPSE_STORAGE_KEY)).toBeNull();
  });

  it('(أ) stays silent while collapsed groups DO have models — the B-266 regression', async () => {
    renderPicker({
      authStatus: authMap({}),
      catalog: { claude: def('opus', 'sonnet'), codex: def('gpt-5') },
    });
    await openDialog();

    // The groups are there and folded: their headers render, their rows do not.
    expect(screen.getByRole('button', { name: /Anthropic/ })).toHaveProperty(
      'ariaExpanded',
      'false',
    );
    expect(screen.queryByText('OPUS')).toBeNull();

    // …and precisely because no row is rendered, cmdk used to call the list
    // empty. It is not empty — it is folded.
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('(أ2) still silent after the user folds a group that was expanded', async () => {
    window.localStorage.setItem(
      COLLAPSE_STORAGE_KEY,
      JSON.stringify({ claude: false }),
    );
    renderPicker({ authStatus: authMap({}), catalog: { claude: def('opus') } });
    await openDialog();

    expect(screen.getByText('OPUS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }));

    await waitFor(() => expect(screen.queryByText('OPUS')).toBeNull());
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('(ب) speaks up when there really is nothing to pick', async () => {
    renderPicker({
      // Every provider confirmed not installed ⇒ no visible group at all.
      authStatus: authMap({ installed: false, authenticated: false }),
      catalog: {},
    });
    await openDialog();

    const empty = await screen.findByTestId('picker-empty');
    expect(empty.textContent).toBe(EMPTY_MESSAGE);
    // Announced, not just painted (WCAG 4.1.3 status message).
    expect(empty.getAttribute('role')).toBe('status');
  });

  it('(ج) speaks up when an active search matches nothing', async () => {
    renderPicker({
      authStatus: authMap({}),
      catalog: { claude: def('opus', 'sonnet') },
    });
    await openDialog();

    fireEvent.change(screen.getByPlaceholderText('Search models...'), {
      target: { value: 'zzzzz-no-such-model' },
    });

    await waitFor(() => expect(screen.getByText(EMPTY_MESSAGE)).toBeTruthy());
  });

  it('(ج2) a MATCHING search shows the row and no empty message', async () => {
    renderPicker({
      authStatus: authMap({}),
      catalog: { claude: def('opus', 'sonnet') },
    });
    await openDialog();

    fireEvent.change(screen.getByPlaceholderText('Search models...'), {
      target: { value: 'opus' },
    });

    await waitFor(() => expect(screen.getByText('OPUS')).toBeTruthy());
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });
});
