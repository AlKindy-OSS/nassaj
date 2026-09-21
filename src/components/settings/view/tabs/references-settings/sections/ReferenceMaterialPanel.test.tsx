/**
 * T-1315 (‏٥-ب) — سطح المواد المرجعية: مسارا **التعديل** و**الإضافة**، وأخطرهما
 * حالة `canManage: false`.
 *
 * كان هذا المجلّد بصفر اختبار رغم أنه يحمل مسارَي الكتابة إلى موادّ **حاكمة**
 * (تعليمات/ذاكرة/وكلاء/مهارات) يقرؤها كل وكيل قبل أن يبدأ. وثلاث خصائص هنا
 * لا يكشفها فحصُ الأنواع ولا اختبارُ الخادم:
 *
 *  1. **لا يُرسم زرٌّ معطَّل عند انعدام الصلاحية** — الزرّ يغيب أصلاً. زرٌّ رماديّ
 *     يقول «تستطيع لو…» ويدعو إلى النقر؛ والغياب يقول الحقيقة بلا دعوة.
 *  2. **الصلاحية لا تُشتقّ في العميل**: بوّابتان مستقلّتان يعلنهما الخادم
 *     (‏`canManage` للسطح و`canEdit`/`canCreateSibling` للمادة بعينها)، وأيُّ
 *     واحدةٍ مغلقةٍ تكفي للمنع. لو اشتقّ العميل إحداهما من الأخرى لصار للصلاحية
 *     مصدران يفترقان.
 *  3. **لا كتابة تُرسل** في تلك الحالة — لا `onSave` ولا `onCreate`.
 *
 * Run: NODE_ENV=test npx vitest run \
 *   src/components/settings/view/tabs/references-settings/sections/ReferenceMaterialPanel.test.tsx
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  // المفاتيح مملوكة لملفّات i18n؛ المقصود هنا البنية لا الترجمة، فيُعاد المفتاح
  // نفسه ويُستعلَم به — فلا يرتبط الاختبار بنصٍّ عربيٍّ قد يُصاغ غداً.
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

const { default: ReferenceMaterialPanel } = await import('./ReferenceMaterialPanel');
const { REFERENCE_SCOPE_ORDER } = await import('../types');

type PanelProps = Parameters<typeof ReferenceMaterialPanel>[0];
type Item = PanelProps['items'][number];

const ITEM: Item = {
  id: 'CLAUDE.md',
  title: 'CLAUDE.md',
  titleTechnical: true,
  scope: 'global',
  fields: [],
  body: 'المحتوى الحاكم',
  bodyPath: '/home/x/CLAUDE.md',
  canEdit: true,
} as Item;

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const onSave = vi.fn();
  const onCreate = vi.fn();
  const onSelect = vi.fn();
  const props = {
    items: [ITEM],
    isLoading: false,
    failed: false,
    failureCode: null,
    onRetry: vi.fn(),
    materialLabel: 'التعليمات',
    scopeFilter: 'all',
    canManage: true,
    canCreate: true,
    saving: false,
    saveFailed: false,
    onSelect,
    onSave,
    onCreate,
    ...overrides,
  } as unknown as PanelProps;
  render(<ReferenceMaterialPanel {...props} />);
  return { onSave, onCreate, onSelect };
}

/** يفتح صفّ المادة في لوح التفاصيل — كل مسار تعديل يمرّ من هنا. */
function openItem() {
  fireEvent.click(screen.getByText('CLAUDE.md'));
}

const editButton = () => screen.queryByRole('button', { name: 'references.actions.edit' });
const addButton = () => screen.queryByRole('button', { name: 'references.actions.add' });

afterEach(cleanup);

describe('ReferenceMaterialPanel — مسار التعديل', () => {
  it('التعديل يُرسل معرّف المادة والمسوّدة كما حُرِّرت', () => {
    const { onSave } = renderPanel();
    openItem();
    fireEvent.click(editButton()!);

    const textarea = screen.getByLabelText('references.content.title');
    fireEvent.change(textarea, { target: { value: 'نصّ معدَّل' } });
    fireEvent.click(screen.getByRole('button', { name: 'references.actions.save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('CLAUDE.md', 'نصّ معدَّل');
  });

  it('الإلغاء يغلق التحرير بلا إرسال — لا حفظ بالخطأ', () => {
    const { onSave } = renderPanel();
    openItem();
    fireEvent.click(editButton()!);
    fireEvent.click(screen.getByRole('button', { name: 'references.actions.cancel' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'references.actions.save' })).toBeNull();
  });

  it('فشل الحفظ يُعلَن بـrole=alert ولا يُغلق التحرير فيضيع النصّ', () => {
    renderPanel({ saveFailed: true });
    openItem();
    fireEvent.click(editButton()!);

    expect(screen.getByRole('alert').textContent).toBe('references.actions.saveFailed');
  });
});

describe('ReferenceMaterialPanel — مسار الإضافة', () => {
  it('الإضافة تُرسل الاسم مشذَّباً والمحتوى كما هو', () => {
    const { onCreate } = renderPanel();
    fireEvent.click(addButton()!);

    fireEvent.change(screen.getByLabelText('references.actions.name'), {
      target: { value: '  AGENTS.md  ' },
    });
    fireEvent.change(screen.getByLabelText('references.content.title'), {
      target: { value: 'عقد الوكيل' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'references.actions.create' }));

    expect(onCreate).toHaveBeenCalledWith('AGENTS.md', 'عقد الوكيل', undefined);
  });

  it('اسم فارغ يُعطّل زرّ الإنشاء فلا تُنشأ مادّة بلا اسم', () => {
    const { onCreate } = renderPanel();
    fireEvent.click(addButton()!);

    const create = screen.getByRole('button', { name: 'references.actions.create' });
    expect(create).toHaveProperty('disabled', true);
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('ReferenceMaterialPanel — انعدام الصلاحية (canManage: false)', () => {
  it('لا يُرسم زرّ إضافة **ولا معطَّلاً**: الزرّ غائب لا رمادي', () => {
    renderPanel({ canManage: false });

    expect(addButton()).toBeNull();
    // ولا زرٌّ معطَّل تحت أي اسم — الغياب هو الشرط، لا التعطيل.
    const disabled = screen.queryAllByRole('button').filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled).toHaveLength(0);
  });

  it('لا يُرسم زرّ تعديل رغم أن المادة نفسها canEdit=true', () => {
    renderPanel({ canManage: false });
    openItem();

    expect(editButton()).toBeNull();
    // المحتوى يبقى **مقروءاً**: انعدامُ الصلاحية منعُ كتابةٍ لا حجبُ قراءة.
    expect(screen.getByText('المحتوى الحاكم')).toBeTruthy();
  });

  it('لا مسار كتابة يُرسل أصلاً — لا onSave ولا onCreate', () => {
    const { onSave, onCreate } = renderPanel({ canManage: false });
    openItem();
    screen.queryAllByRole('button').forEach((button) => fireEvent.click(button));

    expect(onSave).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('الصلاحية لا تُشتقّ في العميل: canManage=true وحده لا يكفي إن قال الخادم canEdit=false', () => {
    renderPanel({ canManage: true, items: [{ ...ITEM, canEdit: false }] as Item[] });
    openItem();

    expect(editButton()).toBeNull();
  });

  it('البوّابتان مستقلّتان: canCreate=false يمنع الإضافة ولو كان canManage=true', () => {
    renderPanel({ canManage: true, canCreate: false });

    expect(addButton()).toBeNull();
  });

  it('كلتا البوّابتين مفتوحتين ⇒ يظهر الزرّان — وإلا كان الاختبار يمرّ بحكم البناء', () => {
    renderPanel();
    expect(addButton()).not.toBeNull();
    openItem();
    expect(editButton()).not.toBeNull();
  });
});

describe('ReferenceMaterialPanel — عقد النطاقات', () => {
  it('ترتيب المجموعات يبدأ بالأعمّ أثراً وينتهي بما لا قناة له', () => {
    expect(REFERENCE_SCOPE_ORDER[0]).toBe('global');
    expect(REFERENCE_SCOPE_ORDER[REFERENCE_SCOPE_ORDER.length - 1]).toBe('no-channel');
  });

  it('مادة عامّة الأثر تحمل شريط تحذير — «ماذا يقع إن مسسته؟»', () => {
    renderPanel();
    openItem();
    expect(screen.getByText('references.scope.banner.global')).toBeTruthy();
  });
});
