/**
 * CommandResultModal.engineLock.test.tsx — B-312
 *
 * لوحة `/models` كانت تكتب معرّف نموذج Claude على جلسة تُنفَّذ على نقطة مورّد،
 * فيُرسَل في الدور التالي إلى محرّك لا يعرفه (نوبة فاشلة لا تبديل نموذج).
 * هذه الاختبارات تُثبِّت الحارس بمحوريه:
 *   (أ) الجلسة المختومة: لا كتابة، وسبب ظاهر، وكتالوج المحرّك بدل كتالوج الجسد.
 *   (ب) الجلسة المستنبَط محرّكها من النموذج وحده (ختم مفقود — B-311/B-262).
 *   (ج) الجلسة الرسمية: لا انحدار — الاختيار يعمل كما كان.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/CommandResultModal.engineLock.test.tsx
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enChat from '../../../../i18n/locales/en/chat.json';
import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import CommandResultModal from './CommandResultModal';

/**
 * اللوحة صارت تقرأ نصّها من i18n لا من حروف مثبَّتة (B-524)، وهذه الاختبارات
 * تؤكّد على **النصّ المعروض** لا على المفتاح — فبلا تهيئة يعيد `t` اسم المفتاح
 * وتمرّ التأكيدات كذباً أو تسقط بلا معنى. الحزمة الإنجليزية هي المُهيَّأة هنا
 * لأن التأكيدات مكتوبة بها.
 */
beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { chat: enChat } },
      interpolation: { escapeValue: false },
    });
  }
});

afterEach(cleanup);

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((value) => ({ value, label: value })),
  DEFAULT: values[0],
});

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: def('opus[1m]', 'sonnet', 'haiku'),
  glm: def('glm-5.2'),
};

const payloadFor = (model: string) => ({
  kind: 'models' as const,
  data: {
    current: { provider: 'claude', providerLabel: 'Claude', model },
    availableModels: ['opus[1m]', 'sonnet', 'haiku'],
    defaultModel: 'opus[1m]',
  },
});

type SelectModel = (
  provider: LLMProvider,
  model: string,
  sessionId?: string | null,
) => Promise<{ scope: 'default' | 'session'; changed: boolean; model: string }>;

const renderPanel = (opts: {
  model: string;
  stamp?: string | null;
  onSelect: SelectModel;
}) =>
  render(
    <CommandResultModal
      payload={payloadFor(opts.model)}
      onClose={vi.fn()}
      providerModelCatalog={CATALOG}
      providerModelCacheCatalog={{}}
      providerModelsRefreshing={false}
      providerModelsFallbackProviders={[]}
      onHardRefreshProviderModels={vi.fn()}
      currentSessionId="session-eng"
      onSelectProviderModel={opts.onSelect}
      sessionEngineProvider={opts.stamp ?? null}
    />,
  );

describe('(أ) جلسة مختومة بمحرّك', () => {
  it('لا يُستدعى onSelectProviderModel ولو نُقر على صفّ نموذج', async () => {
    const onSelect = vi.fn() as unknown as SelectModel & { mock: unknown };
    renderPanel({ model: 'glm-5.2', stamp: 'glm', onSelect });

    const row = screen.getByRole('button', { name: /read-only: GLM engine/i });
    expect(row.hasAttribute('disabled')).toBe(true);
    await act(async () => { fireEvent.click(row); });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('يُعلن السبب باسم المحرّك من ENGINE_PROVIDER_LABEL، ويدلّ على المبدّل', () => {
    renderPanel({ model: 'glm-5.2', stamp: 'glm', onSelect: vi.fn() as unknown as SelectModel });
    const notices = screen.getAllByRole('status').map((n) => n.textContent ?? '');
    // B-352: التبرير تغيّر — اللوحة تحرّك محوراً واحداً فتبقى للقراءة، لكنها
    // لم تعد تدّعي أن محرّك محادثة قائمة لا يُبدَّل (نُقض ميدانياً)، بل تُحيل
    // إلى المبدّل الذي يحرّك المحورين معاً.
    expect(notices.some((n) => /GLM/.test(n) && /composer toolbar/i.test(n))).toBe(true);
    expect(notices.some((n) => /cannot be changed/i.test(n))).toBe(false);
  });

  it('يعرض كتالوج المحرّك لا كتالوج Claude', () => {
    renderPanel({ model: 'glm-5.2', stamp: 'glm', onSelect: vi.fn() as unknown as SelectModel });
    // صفّ المحرّك موجود، ونماذج Claude غائبة تماماً عن القائمة
    expect(screen.getAllByText('glm-5.2').length).toBeGreaterThan(0);
    expect(screen.queryByText('sonnet')).toBeNull();
    expect(screen.queryByText('haiku')).toBeNull();
  });

  it('كتالوج محرّك غير محمَّل يُعرض فارغاً بدل نماذج الجسد', () => {
    render(
      <CommandResultModal
        payload={payloadFor('glm-5.2')}
        onClose={vi.fn()}
        providerModelCatalog={{ claude: def('opus[1m]', 'sonnet') }}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        providerModelsFallbackProviders={[]}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId="session-eng"
        onSelectProviderModel={vi.fn() as unknown as SelectModel}
        sessionEngineProvider="glm"
      />,
    );
    expect(screen.queryByText('sonnet')).toBeNull();
    expect(screen.getByText(/No models match that search/i)).toBeDefined();
  });
});

describe('(ب) ختم مفقود — الاستنباط من النموذج وحده (B-311)', () => {
  it('يُقفل السطح حين النموذج الفعّال من كتالوج محرّك مؤهَّل بلا ختم', async () => {
    const onSelect = vi.fn() as unknown as SelectModel & { mock: unknown };
    renderPanel({ model: 'glm-5.2', stamp: null, onSelect });

    const row = screen.getByRole('button', { name: /read-only: GLM engine/i });
    await act(async () => { fireEvent.click(row); });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('(ج) جلسة رسمية — لا انحدار', () => {
  it('الاختيار يعمل ويُستدعى onSelectProviderModel بمعرّف الصفّ', async () => {
    const onSelect = vi
      .fn()
      .mockResolvedValue({ scope: 'session' as const, changed: true, model: 'sonnet' }) as unknown as SelectModel;
    renderPanel({ model: 'opus[1m]', stamp: null, onSelect });

    const row = screen.getByRole('button', { name: 'Use model sonnet' });
    expect(row.hasAttribute('disabled')).toBe(false);
    await act(async () => { fireEvent.click(row); });
    expect(onSelect).toHaveBeenCalledWith('claude', 'sonnet', 'session-eng');
  });
});
