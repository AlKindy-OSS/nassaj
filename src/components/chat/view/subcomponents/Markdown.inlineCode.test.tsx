/**
 * شارات الكود السطري (backtick واحد) القابلة للنقر.
 *
 * يتحقق أن:
 * - رابط http(s) صريح أو نطاق عارٍ صارم: <a> حقيقي بـtarget=_blank وnoopener،
 *   وبجانبه زرّ نسخ؛ أسماء الملفات والمخطّطات الخطرة نصّ عادي.
 * - النقر الأيمن والضغط المطوّل لا يُعترَضان أبداً.
 * - نصّ عادي: النقر الأيسر ينسخ.
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

describe('شارة الكود السطري — رابط', () => {
  it('رابط http(s) صريح يصير <a> يفتح في تبويب جديد بأمان', () => {
    renderMd('`http://100.64.0.10:3030/org/demo-org/settings`');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('http://100.64.0.10:3030/org/demo-org/settings');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(link);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('نطاق عارٍ يصير رابط https', () => {
    renderMd('`docs.example.com`');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://docs.example.com/');
  });

  it('نطاق عارٍ بمسار يصير رابط https', () => {
    renderMd('`example.io/docs/a`');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.io/docs/a');
  });

  it('رابط بمخطّط بأحرف كبيرة وبمنفذ واستعلام يُقبل ويُطبَّع href', () => {
    renderMd('`HTTPS://Example.com:8443/a?x=1&y=2`');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com:8443/a?x=1&y=2');
  });

  it('نطاق عارٍ بمنفذ واستعلام يصير رابطاً', () => {
    renderMd('`api.example.com:8080/v1?q=1`');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://api.example.com:8080/v1?q=1');
  });

  it('logo.ai مقبول رابطاً عمداً (ai ضمن القائمة المسموحة)', () => {
    renderMd('`logo.ai`');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://logo.ai/');
  });

  it.each(['Safari.app', 'Xcode.app', 'v1.2.app', 'user@example.com', '192.168.1.1', '10.0.0.1:3000'])(
    '%s نصّ عادي لا رابط',
    (text) => {
      renderMd('`' + text + '`');
      expect(screen.queryByRole('link')).toBeNull();
    },
  );

  it('رابط ماركداون يحوي شارة كود لا يولّد <a> متداخلاً ولا زرّاً داخله', () => {
    const { container } = renderMd('[`docs.example.com`](https://docs.example.com/deep/page)');
    expect(container.querySelector('a a')).toBeNull();
    expect(container.querySelector('a button')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    const code = screen.getByText('docs.example.com');
    expect(code.getAttribute('role')).toBeNull();
    fireEvent.click(code);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('النقر على الرابط لا يُمنَع افتراضياً (يترك المتصفّح يفتحه)', () => {
    renderMd('`https://example.com/x`');
    expect(fireEvent.click(screen.getByRole('link'))).toBe(true);
  });

  it('زرّ النسخ يعمل بلوحة المفاتيح (Enter)', () => {
    renderMd('`https://example.com/x`');
    const btn = screen.getByRole('button', { name: 'نسخ الرابط' });
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn); // المتصفّح يحوّل Enter على الزرّ إلى click
    expect(writeText).toHaveBeenCalledWith('https://example.com/x');
  });

  it.each(['config.json', 'foo.ts', 'a.md', 'Markdown.tsx', 'run.sh', 'x.py'])(
    'اسم الملف %s ليس رابطاً',
    (name) => {
      renderMd('`' + name + '`');
      expect(screen.queryByRole('link')).toBeNull();
      fireEvent.click(screen.getByText(name));
      expect(writeText).toHaveBeenCalledWith(name);
    },
  );

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/x'])(
    'المخطّط غير http(s) %s نصّ عادي',
    (text) => {
      renderMd('`' + text + '`');
      expect(screen.queryByRole('link')).toBeNull();
    },
  );

  it('النقر الأيمن لا يُعترَض ولا ينسخ', () => {
    renderMd('`https://example.com/x`');
    const event = fireEvent.contextMenu(screen.getByText('https://example.com/x'));
    expect(event).toBe(true); // لم يُستدعَ preventDefault
    expect(writeText).not.toHaveBeenCalled();
  });

  it('النقر الأيمن على نصّ عادي لا يُعترَض أيضاً', () => {
    renderMd('`life-trip`');
    const event = fireEvent.contextMenu(screen.getByText('life-trip'));
    expect(event).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('زرّ النسخ بجانب الرابط ينسخ الرابط الظاهر ولا يفتح شيئاً', async () => {
    renderMd('`https://example.com/x`');
    fireEvent.click(screen.getByRole('button', { name: 'نسخ الرابط' }));
    expect(writeText).toHaveBeenCalledWith('https://example.com/x');
    expect(window.open).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toBeTruthy();
  });
});

describe('شارة الكود السطري — نصّ عادي', () => {
  it('النقر الأيسر ينسخ النصّ فوراً', () => {
    renderMd('`life-trip`');
    fireEvent.click(screen.getByText('life-trip'));
    expect(writeText).toHaveBeenCalledWith('life-trip');
    expect(window.open).not.toHaveBeenCalled();
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
