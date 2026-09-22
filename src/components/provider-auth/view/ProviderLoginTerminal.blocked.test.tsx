/**
 * ProviderLoginTerminal.blocked.test.tsx
 *
 * الحالة الرابعة للنافذة: **رفض خادمي** لا خروجَ عملية. الفحوص هنا تحرس أربعة
 * قرارات صريحة اتُّخذت في المكوّن:
 *   (١) درع لوحة المفاتيح يسقط عند الرفض (لا pty ليُكتب فيه ⇒ الدرع فخّ)؛
 *   (٢) النصّ يُشتقّ من **رمز** السبب لا من جملة الخادم الإنجليزية، ونصّ الخادم
 *       يُعرض معزولاً بـ<bdi> حين لا يكون الرمز كافياً؛
 *   (٣) الرفض المصفَّر (`null`) يعيد النافذة إلى حالتها الطبيعية بلا «أعد
 *       التشغيل» — لأن قتل جلسة سليمة كان العيب؛
 *   (٤) التركيز لا يُنتزع من طرفية أخذ المشغّل لوحة مفاتيحها.
 *
 * Run: npx vitest run src/components/provider-auth/view/ProviderLoginTerminal.blocked.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { useEffect } from 'react';

import type { Project } from '../../../types/app';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; code?: number }) => {
      const base = opts?.defaultValue ?? key;
      return opts?.code !== undefined ? base.replace('{{code}}', String(opts.code)) : base;
    },
    i18n: { language: 'ar' },
  }),
}));

type ShellError = { message: string; code: string | null };

let pushShellError: ((error: ShellError | null) => void) | null = null;
let completeRun: ((code: number) => void) | null = null;
let mountCount = 0;

function StandaloneShellStub({
  onShellError,
  onComplete,
}: {
  onShellError?: ((error: ShellError | null) => void) | null;
  onComplete?: (code: number) => void;
}) {
  pushShellError = onShellError ?? null;
  completeRun = onComplete ?? null;
  // تركيب حقيقي لا إعادة رسم: قتل الجلسة يعني إعادة تركيب، وهو ما نقيسه.
  useEffect(() => {
    mountCount += 1;
  }, []);
  return <textarea data-testid="pty-input" readOnly />;
}

vi.mock('../../standalone-shell/view/StandaloneShell', () => ({
  default: StandaloneShellStub,
}));

import ProviderLoginTerminal from './ProviderLoginTerminal';

const project = { name: 'p', path: '/p', fullPath: '/p', displayName: 'p' } as unknown as Project;

function mountModal() {
  render(
    <ProviderLoginTerminal
      project={project}
      command="claude /login"
      provider="claude"
      onClose={() => {}}
    />,
  );
}

const raise = (error: ShellError | null) => {
  act(() => {
    pushShellError?.(error);
  });
};

beforeEach(() => {
  pushShellError = null;
  completeRun = null;
  mountCount = 0;
});

afterEach(cleanup);

describe('ProviderLoginTerminal — الرفض الخادمي', () => {
  it('يستبدل حالة «قيد التحضير» بسبب مقروء بدل الانتظار الأبدي', () => {
    mountModal();
    expect(screen.getByTestId('login-run-status').textContent).toContain('Starting the sign-in');

    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });

    const status = screen.getByTestId('login-run-status').textContent ?? '';
    expect(status).toContain('The terminal session could not start.');
    expect(status).toContain('source-update maintenance window');
    expect(status).not.toContain('Starting the sign-in');
  });

  it('يُسقط درع لوحة المفاتيح: لا pty ليُكتب فيه', () => {
    mountModal();
    expect(screen.queryByTestId('login-keyboard-shield')).not.toBeNull();

    raise({ message: 'Project not found', code: null });

    expect(screen.queryByTestId('login-keyboard-shield')).toBeNull();
  });

  it('يعرض رمز السبب في جزيرة LTR حين يرسله الخادم', () => {
    mountModal();
    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });

    const codeElement = screen.getByTestId('login-error-code');
    expect(codeElement.getAttribute('dir')).toBe('ltr');
    expect(codeElement.textContent).toBe('update_maintenance_active');
  });

  it('إطار بلا رمز: لا عنصر رمز، ونصّ الخادم الإنجليزي معزول بـ<bdi>', () => {
    mountModal();
    raise({ message: 'Invalid project path', code: null });

    expect(screen.queryByTestId('login-error-code')).toBeNull();
    const serverText = screen.getByTestId('login-error-server-text');
    expect(serverText.tagName.toLowerCase()).toBe('bdi');
    expect(serverText.textContent).toBe('Invalid project path');
  });

  it('رمز معروف يُغني عن نصّ الخادم الإنجليزي داخل الجملة العربية', () => {
    mountModal();
    raise({ message: 'Running arbitrary shell commands is restricted', code: 'forbidden' });

    expect(screen.queryByTestId('login-error-server-text')).toBeNull();
    expect(screen.getByTestId('login-run-status').textContent).toContain('Your role may not run');
  });

  it('B-1260: رفض ربط Claude في الوضع المشترك يعرض رسالة «اطلب مالكاً/مسؤولاً» لا طرفيةً صامتة', () => {
    mountModal();
    raise({
      message: 'Linking Claude on this shared server is limited to administrators.',
      code: 'shared_link_admin_only',
    });

    // النافذة لا تُغلق صامتةً: تعرض حالة رفض مقروءة بزرّ «أعد التشغيل».
    expect(screen.queryByTestId('login-retry')).not.toBeNull();
    const status = screen.getByTestId('login-run-status').textContent ?? '';
    expect(status).toContain('owner or admin');
    // الرمز حمل المعنى، فلا يُعرض نصّ الخادم الإنجليزي الخام.
    expect(screen.queryByTestId('login-error-server-text')).toBeNull();
  });

  it('تصفير الرفض يعيد النافذة لحالتها الطبيعية بلا قتل الجلسة', () => {
    mountModal();
    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });
    expect(screen.queryByTestId('login-retry')).not.toBeNull();

    // ما يرسله الـhook حين يثبت أن الـPTY حيّ (إخراج لاحق أو سوكت جديد).
    raise(null);

    expect(screen.queryByTestId('login-retry')).toBeNull();
    expect(screen.getByTestId('login-run-status').textContent).toContain('Starting the sign-in');
    expect(screen.queryByTestId('login-keyboard-shield')).not.toBeNull();
    // ولم تُقتل الجلسة: لم يُعَد تركيب الطرفية.
    expect(mountCount).toBe(1);
  });

  it('لا ينتزع التركيز من طرفية أخذ المشغّل لوحة مفاتيحها', () => {
    mountModal();
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));
    const pty = screen.getByTestId('pty-input');
    pty.focus();
    expect(document.activeElement).toBe(pty);

    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });

    expect(document.activeElement).toBe(pty);
    // اللافتة معروضة رغم ذلك: الإعلان لا يتطلّب خطف التركيز.
    expect(screen.getByTestId('login-run-status').textContent).toContain(
      'The terminal session could not start.',
    );
  });

  it('ينقل التركيز إلى الفعل حين كان الدرع قائماً (لا مدخل يُسرق)', () => {
    mountModal();
    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });

    expect(document.activeElement).toBe(screen.getByTestId('login-retry'));
  });

  it('«أعد التشغيل» يُركّب جلسة جديدة ويمسح الرفض', () => {
    mountModal();
    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });

    fireEvent.click(screen.getByTestId('login-retry'));

    expect(mountCount).toBe(2);
    expect(screen.queryByTestId('login-error-code')).toBeNull();
    expect(screen.getByTestId('login-run-status').textContent).toContain('Starting the sign-in');
  });

  it('خروج ناجح لاحق لا يُحجب برفض قديم', () => {
    mountModal();
    raise({ message: 'Update maintenance is active', code: 'update_maintenance_active' });

    act(() => {
      completeRun?.(0);
    });

    expect(screen.getByTestId('login-run-status').textContent).toContain('Sign-in finished.');
  });
});
