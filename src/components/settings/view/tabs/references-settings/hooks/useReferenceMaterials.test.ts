/**
 * T-1315 (شرط معلَّق من مراجعة سابقة) — أول اختبار للسطح الأمامي للمواد المرجعية.
 *
 * كان هذا السطح بصفر اختبار رغم أن فيه **مسارَي الكتابة والإنشاء**: تعديل مادة
 * حاكمة (تعليمات/ذاكرة/وكلاء/مهارات) وإنشاء أخرى. الخادم مغطّى
 * (‏reference-materials.routes.test.ts) لكن تغطيةَ الخادم لا تقول شيئاً عن
 * العميل: طريقةَ HTTP، والمسارَ المُرمَّز، والحمولةَ، وإلى أين تذهب الحالة حين
 * يفشل الطلب. وفشلُ الحفظ الصامت هنا معناه أن المستخدم يظنّ مادّةً حاكمة
 * حُفظت وهي لم تُحفظ.
 *
 * يغطّي: النجاح، الفشل (‏!ok)، ترميز المعرّف، وعدم كتابة أي شيء قبل الطلب.
 *
 * Run: NODE_ENV=test npx vitest run \
 *   src/components/settings/view/tabs/references-settings/hooks/useReferenceMaterials.test.ts
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { useReferenceMaterials } = await import('./useReferenceMaterials');

/** استجابة مغلَّفة بنفس مغلّف الـAPI الحقيقي: `{ data: … }`. */
function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

function fail(status: number, code?: string) {
  return { ok: false, status, json: async () => ({ error: code ? { code } : undefined }) };
}

const ENTRY = {
  id: 'CLAUDE.md',
  material: 'instructions',
  title: 'CLAUDE.md',
  affectedScope: 'all_members',
  canEdit: true,
  canCreateSibling: true,
};

/** قائمة أولية ناجحة بمدخلة واحدة — نقطة انطلاق كل اختبار كتابة. */
function seedList() {
  authenticatedFetch.mockResolvedValueOnce(
    ok({ entries: [ENTRY], total: 1, canManage: true }) as never,
  );
}

async function mountLoaded() {
  seedList();
  const view = renderHook(() => useReferenceMaterials('instructions' as never, true));
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

beforeEach(() => {
  authenticatedFetch.mockReset();
});

afterEach(cleanup);

describe('useReferenceMaterials — مسار الكتابة (update)', () => {
  it('يرسل PUT إلى مسار المادة بمعرّف مُرمَّز وحمولة المحتوى وحدها', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(ok({ item: { ...ENTRY, content: 'جديد' } }) as never);

    act(() => view.result.current.update('CLAUDE.md', 'جديد'));
    await waitFor(() => expect(view.result.current.saving).toBe(false));

    const [url, init] = authenticatedFetch.mock.calls[1];
    expect(url).toBe('/api/references/instructions/CLAUDE.md');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ content: 'جديد' });
  });

  it('يُرمِّز المعرّف فلا يتسرّب محرف مسار خام إلى الـURL', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(ok({ item: ENTRY }) as never);

    act(() => view.result.current.update('a/b .md', 'x'));
    await waitFor(() => expect(view.result.current.saving).toBe(false));

    expect(authenticatedFetch.mock.calls[1][0]).toBe('/api/references/instructions/a%2Fb%20.md');
  });

  it('النجاح يستبدل المدخلة بالنسخة العائدة من الخادم لا بالنصّ المحلي', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(
      ok({ item: { ...ENTRY, content: 'ما ثبّته الخادم' } }) as never,
    );

    act(() => view.result.current.update('CLAUDE.md', 'ما أرسله المستخدم'));
    await waitFor(() => expect(view.result.current.saving).toBe(false));

    expect(view.result.current.items[0].content).toBe('ما ثبّته الخادم');
    expect(view.result.current.saveFailed).toBe(false);
  });

  it('الفشل يرفع saveFailed ولا يكتب المحتوى محلياً — لا حفظٌ وهمي', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(fail(403, 'forbidden') as never);

    act(() => view.result.current.update('CLAUDE.md', 'محاولة مرفوضة'));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(true));

    expect(view.result.current.saving).toBe(false);
    expect(view.result.current.items[0].content).toBeUndefined();
  });

  it('استجابة ناجحة بلا item تُعدّ فشلاً لا نجاحاً صامتاً', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(ok({ canManage: true }) as never);

    act(() => view.result.current.update('CLAUDE.md', 'x'));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(true));
  });
});

describe('useReferenceMaterials — مسار الإنشاء (create)', () => {
  it('يرسل POST إلى مجموعة المادة بالاسم والمحتوى والمزوّد', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(ok({ item: ENTRY }) as never);
    authenticatedFetch.mockResolvedValueOnce(
      ok({ entries: [ENTRY], total: 1, canManage: true }) as never,
    );

    act(() => view.result.current.create('AGENTS.md', 'محتوى', 'codex'));
    await waitFor(() => expect(view.result.current.saving).toBe(false));

    const [url, init] = authenticatedFetch.mock.calls[1];
    expect(url).toBe('/api/references/instructions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'AGENTS.md', content: 'محتوى', provider: 'codex' });
  });

  it('النجاح يُعيد تحميل القائمة من الخادم بدل التخمين محلياً', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(ok({ item: ENTRY }) as never);
    authenticatedFetch.mockResolvedValueOnce(
      ok({ entries: [ENTRY, { ...ENTRY, id: 'AGENTS.md', title: 'AGENTS.md' }], total: 2, canManage: true }) as never,
    );

    act(() => view.result.current.create('AGENTS.md', 'محتوى'));
    await waitFor(() => expect(view.result.current.items).toHaveLength(2));

    expect(view.result.current.items[1].name).toBe('AGENTS.md');
  });

  it('الفشل يرفع saveFailed ولا يُعيد التحميل — القائمة تبقى كما كانت', async () => {
    const view = await mountLoaded();
    authenticatedFetch.mockResolvedValueOnce(fail(409, 'exists') as never);

    act(() => view.result.current.create('AGENTS.md', 'محتوى'));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(true));

    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.items).toHaveLength(1);
  });
});
