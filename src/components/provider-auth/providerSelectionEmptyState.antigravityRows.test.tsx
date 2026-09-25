/**
 * providerSelectionEmptyState.antigravityRows.test.tsx — T-1163
 *
 * الحارس ضدّ عودة القصّ. كان في العارض سطرٌ واحد:
 *
 *   const rows = group.id === "antigravity" ? allRows.slice(0, 1) : allRows;
 *
 * كتبه عهدٌ كان يظنّ أن `agy` لا يقبل `--model`. حين صار يقبله (مقيس على 1.1.9)
 * بقي السطر، فظلّ المنتقي يعرض صفّاً واحداً («agy default») ويخفي كتالوج
 * `agy models` كاملاً — **والخادم يخدمه سليماً طوال الوقت**. لذلك لم يكشفه أي
 * اختبار خادمي ولا فحص قدرات: العطل كان في آخر متر وحده.
 *
 * ما يحرسه هذا الملف تفاضلي لا مطلق: لا يكفي أن يظهر صفٌّ لـantigravity — لا
 * بدّ أن تظهر صفوفه **كلها**، وأن يُقاس ذلك بمزوّد آخر بنفس عدد النماذج كي لا
 * يمرّ الاختبار على قصٍّ عامّ يصيب الجميع.
 *
 * Run: npx vitest run src/components/provider-auth/providerSelectionEmptyState.antigravityRows.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import type {
  LLMProvider,
  ProviderModelsDefinition,
  ProjectSession,
} from '../../types/app';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from './types';

// ─── Mocks (مطابقة لحارس B-266 المجاور) ─────────────────────────────────────

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
import { COLLAPSE_STORAGE_KEY } from '../chat/view/subcomponents/providerGroupCollapse';

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
  'claude', 'cursor', 'codex', 'antigravity', 'opencode',
  'hermes', 'kimi', 'deepseek', 'glm', 'sakana',
];

const authMap = (): ProviderAuthStatusMap =>
  Object.fromEntries(ALL_PROVIDERS.map((p) => [p, status()])) as ProviderAuthStatusMap;

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((v) => ({ value: v, label: v.toUpperCase() })),
  DEFAULT: values[0] ?? '',
});

/**
 * لقطة مختصرة من `agy models` (1.1.9). الأسماء هنا هي القيم نفسها كما يخدمها
 * antigravity-models-cli.client.ts — value === label — فالمقارنة على النصّ
 * المعروض تقيس ما يراه المستخدم فعلاً.
 */
const AGY_MODELS = [
  'auto',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-low',
  'gemini-3.1-pro-high',
  'claude-opus-4-6-thinking',
];

function renderPicker(catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>) {
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
      claudeModel="none-selected"
      setClaudeModel={noop}
      cursorModel=""
      setCursorModel={noop}
      codexModel=""
      setCodexModel={noop}
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
      providerModelCatalog={catalog}
      providerModelsLoading={false}
      providerModelsRefreshing={false}
      providerAuthStatus={authMap()}
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
  // المجموعات تبدأ مطويّة، والصفوف المطويّة لا تُرسم أصلاً — ففتحُها شرطُ
  // القياس لا تفصيلَ تجميل.
  window.localStorage.setItem(
    COLLAPSE_STORAGE_KEY,
    JSON.stringify({ antigravity: false, codex: false }),
  );
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

describe('T-1163 — منتقي النماذج يعرض كتالوج agy كاملاً', () => {
  it('يعرض كل صفوف antigravity لا الصفّ الأول وحده', async () => {
    renderPicker({ antigravity: def(...AGY_MODELS) });
    await openDialog();

    for (const value of AGY_MODELS) {
      expect(
        screen.queryByText(value.toUpperCase()),
        `صفّ "${value}" مفقود — عاد القصّ إلى مجموعة antigravity`,
      ).toBeTruthy();
    }
  });

  it('القياس تفاضلي: نفس العدد يظهر كاملاً لمزوّد آخر', async () => {
    // لو أعاد أحدهم قصّاً **عامّاً** لكل المجموعات، لسقط هذا مع سابقه؛ ولو قصّ
    // antigravity وحدها لسقط الأول فقط. الاختباران معاً يميّزان الحالتين.
    const others = AGY_MODELS.map((_, i) => `codex-model-${i}`);
    renderPicker({ antigravity: def(...AGY_MODELS), codex: def(...others) });
    await openDialog();

    const shown = (values: string[]) =>
      values.filter((v) => screen.queryByText(v.toUpperCase()) !== null).length;

    expect(shown(AGY_MODELS)).toBe(AGY_MODELS.length);
    expect(shown(others)).toBe(others.length);
  });
});
