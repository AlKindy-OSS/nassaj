/**
 * شارات الكود السطري (backtick واحد) القابلة للنقر.
 *
 * يتحقق أن:
 * - رابط http(s) وحيد: النقر الأيسر يفتحه في تبويب جديد (بعد مهلة قصيرة تُلغى
 *   بنقرة ثانية) بـnoopener/noreferrer، والنقر الأيمن ينسخه بدل القائمة الافتراضية.
 * - نقر مزدوج على رابط لا يفتح تبويباً.
 * - نصّ عادي: كلا النقرتين تنسخ.
 * - النسخ يُظهر تلميحاً مرئياً مؤقّتاً (شارة حيّة + وصفٌ دائم منفصل عن اسم العنصر).
 * - كتل الكود المسيّجة، والكتلة المسنَّدة بأربع مسافات من سطر واحد، والسياج غير
 *   المغلَق أثناء البثّ — كلّها لا تتأثر (لا شارة نقر عليها).
 * - سحب تحديد نصّي منتهٍ **داخل الشارة نفسها** يمنع فعل النقر؛ تحديد في مكان
 *   آخر من الرسالة لا يمنعه.
 * - لوحة المفاتيح: Enter و Space يُنفّذان الفعل الأساسي.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.inlineCode.test.tsx
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

import { Markdown } from './Markdown';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: () => ({ canUseRaw: false, loading: false }),
  useRawExecQueue: () => ({ commands: [], canUseRaw: false, loading: false, refresh: () => {} }),
  invalidateRawExecConfig: () => {},
  refreshRawExecConfig: () => {},
}));

const writeText = vi.fn().mockResolvedValue(undefined);

/** محاكاة تحديدٍ فارغ — لا نصّ محدَّد في الصفحة، لا يتقاطع مع أيّ عنصر. */
function mockEmptySelection() {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => '',
    isCollapsed: true,
    rangeCount: 0,
    containsNode: () => false,
  } as unknown as Selection);
}

/** محاكاة تحديدٍ حيّ يتقاطع مع عنصر بعينه (وحده) — لمحاكاة سحبٍ منتهٍ داخله. */
function mockSelectionIntersecting(target: Node) {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => 'some selected text',
    isCollapsed: false,
    rangeCount: 1,
    containsNode: (node: Node) => node === target,
  } as unknown as Selection);
}

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
  vi.spyOn(window, 'open').mockImplementation(() => null);
  mockEmptySelection();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderMd(md: string) {
  return render(<Markdown>{md}</Markdown>);
}

describe('شارة الكود السطري — رابط http(s) وحيد', () => {
  it('النقر الأيسر يفتح الرابط في تبويب جديد بأمان (بعد المهلة القصيرة)', () => {
    vi.useFakeTimers();
    renderMd('`http://100.105.15.53:3030/org/Life-Trip/settings`');
    const pill = screen.getByText('http://100.105.15.53:3030/org/Life-Trip/settings');
    fireEvent.click(pill);
    expect(window.open).not.toHaveBeenCalled(); // مؤجَّل، لا فوري
    vi.advanceTimersByTime(300);
    expect(window.open).toHaveBeenCalledWith(
      'http://100.105.15.53:3030/org/Life-Trip/settings',
      '_blank',
      'noopener,noreferrer',
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('النقر الأيمن ينسخ الرابط فوراً ويمنع القائمة الافتراضية', () => {
    renderMd('`https://example.com/x`');
    const pill = screen.getByText('https://example.com/x');
    const event = fireEvent.contextMenu(pill);
    expect(event).toBe(false); // preventDefault() called ⇒ fireEvent returns false
    expect(writeText).toHaveBeenCalledWith('https://example.com/x');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('نقر مزدوج على رابط لا يفتح تبويباً', () => {
    vi.useFakeTimers();
    renderMd('`https://example.com/dbl`');
    const pill = screen.getByText('https://example.com/dbl');
    // نقرة أولى (detail=1) تُجدوِل الفتح المؤجَّل...
    fireEvent.click(pill, { detail: 1 });
    // ...ثم نقرة ثانية سريعة (detail=2، كما يُصدرها المتصفّح فعلياً) تُلغيه.
    fireEvent.click(pill, { detail: 2 });
    fireEvent.doubleClick(pill);
    vi.advanceTimersByTime(500);
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe('شارة الكود السطري — نصّ عادي', () => {
  it('النقر الأيسر ينسخ النصّ فوراً', () => {
    renderMd('`life-trip`');
    fireEvent.click(screen.getByText('life-trip'));
    expect(writeText).toHaveBeenCalledWith('life-trip');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('النقر الأيمن ينسخ النصّ أيضاً', () => {
    renderMd('`Life Trip`');
    fireEvent.contextMenu(screen.getByText('Life Trip'));
    expect(writeText).toHaveBeenCalledWith('Life Trip');
  });

  it('Enter من لوحة المفاتيح ينسخ (الفعل الأساسي لنصّ غير رابط)', () => {
    renderMd('`life-trip`');
    fireEvent.keyDown(screen.getByText('life-trip'), { key: 'Enter' });
    expect(writeText).toHaveBeenCalledWith('life-trip');
  });

  it('مفتاح المسافة (Space) ينسخ أيضاً', () => {
    renderMd('`life-trip`');
    fireEvent.keyDown(screen.getByText('life-trip'), { key: ' ' });
    expect(writeText).toHaveBeenCalledWith('life-trip');
  });

  it('يُظهر تلميح «تمّ النسخ» في شارة حالة حيّة بعد النقر', async () => {
    const { container } = renderMd('`life-trip`');
    fireEvent.click(screen.getByText('life-trip'));
    const status = await screen.findByRole('status');
    expect(within(status).getByText('codeBlock.copied')).toBeTruthy();
    void container;
  });

  it('لا يستبدل aria-label اسمَ العنصر — النصّ الظاهر يبقى الاسم المحسوب', () => {
    renderMd('`life-trip`');
    const pill = screen.getByText('life-trip');
    expect(pill.hasAttribute('aria-label')).toBe(false);
    // الوصف الإضافي (aria-describedby) منفصل، لا يُبدِل اسم العنصر.
    const describedbyId = pill.getAttribute('aria-describedby');
    expect(describedbyId).toBeTruthy();
    expect(document.getElementById(describedbyId as string)?.textContent).toBeTruthy();
  });
});

describe('سحب التحديد يمنع فعل النقر — محصور بالعنصر نفسه', () => {
  it('لا نسخ حين ينتهي التحديد داخل هذه الشارة تحديداً', () => {
    renderMd('`life-trip`');
    const pill = screen.getByText('life-trip');
    mockSelectionIntersecting(pill);
    fireEvent.click(pill);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('تحديد لا يتقاطع مع الشارة (في مكان آخر من الصفحة) لا يمنع النقر', () => {
    renderMd('`life-trip`');
    const pill = screen.getByText('life-trip');
    const elsewhere = document.createElement('span');
    document.body.appendChild(elsewhere);
    mockSelectionIntersecting(elsewhere);
    fireEvent.click(pill);
    expect(writeText).toHaveBeenCalledWith('life-trip');
    document.body.removeChild(elsewhere);
  });
});

describe('كتل الكود لا تتأثر — لا شارة نقر عليها', () => {
  it('سياج ```` ```bash ```` مكتمل لا يحمل شارة نقر', () => {
    const { container } = renderMd('```bash\necho hi\n```');
    expect(container.querySelector('code[role="button"]')).toBeNull();
  });

  it('كتلة مسنَّدة بأربع مسافات من سطر واحد لا تصير شارة نقر', () => {
    // `para` تفصل الكتلة المسنَّدة عن أوّل الرسالة (والفراغ اللازم قبلها).
    const { container } = renderMd('para\n\n    echo hi\n');
    expect(container.querySelector('code[role="button"]')).toBeNull();
  });

  it('سياج ```` ```bash ```` غير مغلَق أثناء البثّ لا يصير شارة نقر', () => {
    const { container } = render(<Markdown streaming>{'```bash'}</Markdown>);
    expect(container.querySelector('code[role="button"]')).toBeNull();
  });

  it('سياج ```` ```image ```` غير مغلَق أثناء البثّ لا يصير شارة نقر (ولا صورة)', () => {
    const { container } = render(<Markdown streaming>{'```image'}</Markdown>);
    expect(container.querySelector('code[role="button"]')).toBeNull();
  });
});
