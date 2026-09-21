/**
 * T-1737 — بوابة عرض سياج `image` في Markdown.
 *
 * يتحقق أن:
 * - سياج ```image يُصيَّر صورة (أو حالة خطأ) بدلاً من كتلة كود.
 * - المسارات المحلية تُبنى بشكل صحيح مع sessionId.
 * - المصادر الفارغة والروابط البعيدة تُظهر حالة خطأ مرئية.
 * - البثّ يمنع العرض حتى اكتمال النصّ.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.imageFence.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { ChatActionsContext, type ChatActionsContextValue } from '../../context/ChatActionsContext';
import { Markdown } from './Markdown';

// ─── محاكاة الاعتماديات ─────────────────────────────────────────────────

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 1, username: 'owner' } }),
}));

vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: () => ({ canUseRaw: false, loading: false }),
  useRawExecQueue: () => ({ commands: [], canUseRaw: false, loading: false, refresh: () => {} }),
  invalidateRawExecConfig: () => {},
  refreshRawExecConfig: () => {},
}));

// نحاكي authenticatedFetch لإعادة blob فارغ ناجح (200)
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  blob: () => Promise.resolve(new Blob([''], { type: 'image/png' })),
  status: 200,
});

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: Parameters<typeof mockFetch>) => mockFetch(...args),
}));

// URL.createObjectURL غير متاح في jsdom
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
global.URL.revokeObjectURL = vi.fn();

// ─── بناء السياق والاختبار ─────────────────────────────────────────────

const BASE_CTX: ChatActionsContextValue = {
  catalog: [],
  runAction: async () => ({ status: 'error' as const, code: 'test' }),
  userRole: 'owner',
  inlineExecEnabled: true,
  liveStatusOf: () => null,
  sessionId: 'session-abc',
};

function renderFence(
  fenceBody: string,
  {
    streaming = false,
    ctx = BASE_CTX,
  }: { streaming?: boolean; ctx?: ChatActionsContextValue } = {},
) {
  const md = '```image\n' + fenceBody + '\n```';
  return render(
    <ChatActionsContext.Provider value={ctx}>
      <Markdown streaming={streaming}>{md}</Markdown>
    </ChatActionsContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
});

// ─── الاختبارات ────────────────────────────────────────────────────────

describe('سياج image — عرض المكوّن', () => {
  it('لا يُصيَّر figure أثناء البثّ', () => {
    renderFence('/srv/x.png', { streaming: true });
    // أثناء البثّ: لا figure — السياج يُعرَض كسياج ثانوي ريثما يكتمل المسار
    expect(document.querySelector('figure')).toBeNull();
    // ولا عنصر img بدور 'img' (لا صورة ولا خطأ من AssistantImageBlock)
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('يُصيَّر بعد اكتمال البثّ (streaming=false)', () => {
    renderFence('/home/operator/x.png', { streaming: false });
    // الصورة أو حالة خطأ يجب أن تكون موجودة
    const fig = document.querySelector('figure');
    expect(fig).not.toBeNull();
  });

  it('يُرسَل الطلب إلى نقطة نهاية assistant-images مع path وsession', async () => {
    renderFence('/home/operator/x.png');
    // انتظر إكمال useEffect
    await new Promise((r) => setTimeout(r, 0));
    const calls = mockFetch.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [url] = calls[0] as [string];
    expect(url).toContain('/api/assistant-images');
    expect(url).toContain('path=');
    expect(url).toContain('session=session-abc');
  });

  it('يُظهر خطأ "الروابط البعيدة معطّلة" لـ https://', () => {
    renderFence('https://example.com/img.png');
    expect(screen.getByRole('img', { name: 'الروابط البعيدة معطّلة' })).toBeDefined();
  });

  it('يُظهر خطأ لمصدر فارغ', () => {
    renderFence('');
    expect(screen.getByRole('img', { name: 'طلب صورة غير صالح' })).toBeDefined();
  });

  it('يُظهر caption تحت الصورة', async () => {
    renderFence('/home/operator/img.png\nوصف الصورة');
    await new Promise((r) => setTimeout(r, 0));
    // الـfigure يجب أن يحوي caption
    const caption = document.querySelector('figcaption');
    expect(caption?.textContent).toBe('وصف الصورة');
  });

  it('يُمرَّر data: URL مباشرةً كـ<img>', async () => {
    const dataUrl = 'data:image/png;base64,AA==';
    renderFence(dataUrl);
    await new Promise((r) => setTimeout(r, 0));
    // لا استدعاء fetch لـdata: URL (no needsAuth)
    const img = document.querySelector('img') as HTMLImageElement | null;
    expect(img?.src).toBe(dataUrl);
  });

  it('يُظهر خطأ عند غياب sessionId لمسار محلي', () => {
    const ctxNoSession: ChatActionsContextValue = { ...BASE_CTX, sessionId: null };
    renderFence('/home/operator/img.png', { ctx: ctxNoSession });
    expect(screen.getByRole('img', { name: 'طلب صورة غير صالح' })).toBeDefined();
  });
});

describe('سياج image — تمييز رموز HTTP (loadErrorMessageFor)', () => {
  /**
   * يتحقق أن resolveAssistantImageError يُستدعى برمز HTTP الفعلي من
   * authenticatedFetch لا برمز ثابت — الإصلاح الأساسي لهذه الدورة.
   */
  async function renderFenceWithStatus(httpStatus: number): Promise<void> {
    mockFetch.mockResolvedValueOnce({ ok: false, status: httpStatus, blob: () => Promise.resolve(new Blob()) });
    renderFence('/home/operator/img.png');
    await new Promise((r) => setTimeout(r, 0));
  }

  it('يُظهر "المسار غير مسموح" لرمز 403', async () => {
    await renderFenceWithStatus(403);
    expect(screen.getByRole('img', { name: 'المسار غير مسموح' })).toBeDefined();
  });

  it('يُظهر "نوع غير مدعوم" لرمز 415', async () => {
    await renderFenceWithStatus(415);
    expect(screen.getByRole('img', { name: 'نوع غير مدعوم' })).toBeDefined();
  });

  it('يُظهر "الملف غير موجود" لرمز 404', async () => {
    await renderFenceWithStatus(404);
    expect(screen.getByRole('img', { name: 'الملف غير موجود' })).toBeDefined();
  });

  it('يُظهر "الصورة أكبر من الحدّ" لرمز 413', async () => {
    await renderFenceWithStatus(413);
    expect(screen.getByRole('img', { name: 'الصورة أكبر من الحدّ' })).toBeDefined();
  });

  it('يُظهر "تعذّر تحميل الصورة" لخطأ الشبكة', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network failure'));
    renderFence('/home/operator/img.png');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('img', { name: 'تعذّر تحميل الصورة' })).toBeDefined();
  });
});
