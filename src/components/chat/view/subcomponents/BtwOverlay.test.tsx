/**
 * T-849 — BtwOverlay (عرض القناة الجانبية).
 *
 * يثبت: عرض السؤال + الإجابة المتدفّقة، حالة الخطأ (role=alert) بنصّها المترجم،
 * السقوط لرسالة الخادم الخام عند كود غير معروف، التلميحين C4/C5، زرّ الإغلاق،
 * وحوار مُتاح (role=dialog + aria-modal + aria-labelledby). state=null ⇒ لا عرض.
 *
 * i18n مُحاكى: t يُرجع defaultValue إن وُجد وإلا المفتاح، لتسهيل التحقق.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/BtwOverlay.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
  }),
}));

import type { BtwState } from '../../hooks/useBtwSideChannel';
import BtwOverlay from './BtwOverlay';

afterEach(cleanup);

describe('BtwOverlay', () => {
  it('لا يعرض شيئاً حين state = null', () => {
    const { container } = render(<BtwOverlay state={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('يعرض السؤال والإجابة المتدفّقة والتلميحين', () => {
    const state: BtwState = {
      btwId: 'b1', forkStatus: 'idle',
      question: 'لماذا السماء زرقاء؟',
      answer: 'بسبب تشتّت رايلي',
      status: 'streaming',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);

    expect(screen.getByText('لماذا السماء زرقاء؟')).toBeDefined();
    expect(screen.getByText('بسبب تشتّت رايلي')).toBeDefined();
    // مؤشّر الحالة «يكتب…» (المفتاح مُرجَع من المحاكاة)
    expect(screen.getByText('btw.status.streaming')).toBeDefined();
    // التلميحان C4 (الحصة) وC5 (حدّ السياق)
    expect(screen.getByText('btw.hints.quota')).toBeDefined();
    expect(screen.getByText('btw.hints.context')).toBeDefined();
  });

  it('يعرض تنبيه خطأ (role=alert) بنصّ مترجَم لكود معروف', () => {
    const state: BtwState = {
      btwId: 'b1', forkStatus: 'idle',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'timeout',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('btw.errors.timeout');
  });

  it('يسقط لرسالة الخادم الخام عند كود خطأ غير معروف', () => {
    const state: BtwState = {
      btwId: 'b1', forkStatus: 'idle',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'weird_unmapped_code',
      errorMessage: 'رسالة خادم خام',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('رسالة خادم خام');
  });

  it('sdk_error: يعرض رسالة الخادم الحقيقية بدل النصّ العام حين تتوفّر', () => {
    const state: BtwState = {
      btwId: 'b1', forkStatus: 'idle',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'sdk_error',
      errorMessage: 'ENGINE_PROVIDER_UNAVAILABLE: kimi',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('ENGINE_PROVIDER_UNAVAILABLE: kimi');
    // لا يبتلعها خلف النصّ العام
    expect(alert.textContent).not.toContain('btw.errors.sdk_error');
  });

  it('sdk_error: يسقط للنصّ العام حين لا رسالة خادم', () => {
    const state: BtwState = {
      btwId: 'b1', forkStatus: 'idle',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'sdk_error',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('btw.errors.sdk_error');
  });

  it('sdk_error: يقتطع رسالة الخادم الطويلة بـ«…» كي لا تكسر التخطيط', () => {
    const long = 'ط'.repeat(400);
    const state: BtwState = {
      btwId: 'b1', forkStatus: 'idle',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'sdk_error',
      errorMessage: long,
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const text = screen.getByRole('alert').textContent || '';
    expect(text).toContain('…');
    // 300 محرف + «…» فقط (لا الأربعمئة كاملة)
    expect(text).not.toContain('ط'.repeat(301));
    expect(text).toContain('ط'.repeat(300));
  });

  it('يستدعي onClose عند الضغط على زرّ الإغلاق', () => {
    const onClose = vi.fn();
    const state: BtwState = { btwId: 'b1', forkStatus: 'idle', question: 'س', answer: 'ج', status: 'complete' };
    render(<BtwOverlay state={state} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('btw.close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('حوار مُتاح: role=dialog + aria-modal + aria-labelledby', () => {
    const state: BtwState = { btwId: 'b1', forkStatus: 'idle', question: 'س', answer: '', status: 'pending' };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('btw-overlay-title');
    // العنوان المُشار إليه موجود فعلاً
    expect(document.getElementById('btw-overlay-title')).not.toBeNull();
  });

  it('يعرض مؤشّر «مكتمل» عند اكتمال الإجابة', () => {
    const state: BtwState = { btwId: 'b1', forkStatus: 'idle', question: 'س', answer: 'الجواب', status: 'complete' };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    expect(screen.getByText('btw.status.complete')).toBeDefined();
    expect(screen.getByText('الجواب')).toBeDefined();
  });

  it('زرّ الإغلاق يحمل كلاسات focus-visible:ring مطابقة لعرف المشروع', () => {
    const state: BtwState = { btwId: 'b1', forkStatus: 'idle', question: 'س', answer: '', status: 'pending' };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const btn = screen.getByLabelText('btw.close');
    // يجب أن يتضمّن نمط focus-visible:ring-2 وfocus-visible:ring-ring
    // وfocus-visible:outline-none دون outline-none مجرّدة (انحدار a11y)
    expect(btn.className).toContain('focus-visible:outline-none');
    expect(btn.className).toContain('focus-visible:ring-2');
    expect(btn.className).toContain('focus-visible:ring-ring');
    expect(btn.className).not.toContain(' outline-none'); // لا outline-none مجرّدة على الزرّ
  });

  it('حاوية الحوار قابلة للتركيز البرمجي (tabIndex=-1) دون حلقة مرئية', () => {
    const state: BtwState = { btwId: 'b1', forkStatus: 'idle', question: 'س', answer: '', status: 'pending' };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    // tabIndex={-1}: قابل للتركيز البرمجي فقط (لا يُدرَج في تسلسل Tab)
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    // outline-none على الحاوية كي لا تظهر حلقة بلا سبب للمستخدم
    expect(dialog.className).toContain('outline-none');
  });

  // ── T-1090: الفرك ────────────────────────────────────────────────────────
  describe('الفرك', () => {
    const completeState: BtwState = {
      btwId: 'b1',
      question: 'س',
      answer: 'الجواب',
      status: 'complete',
      forkStatus: 'idle',
    };

    it('يعرض زرّ الفرك على إجابة مكتملة حين يُمرَّر onFork', () => {
      render(<BtwOverlay state={completeState} onClose={() => {}} onFork={() => {}} />);
      expect(screen.getByText('btw.fork.actionFull')).toBeDefined();
    });

    it('لا زرّ فرك بلا onFork (لا زرّ معطّل بلا سبب)', () => {
      render(<BtwOverlay state={completeState} onClose={() => {}} />);
      expect(screen.queryByText('btw.fork.actionFull')).toBeNull();
    });

    it('لا زرّ فرك أثناء البثّ ولا على إجابة فارغة', () => {
      const { unmount } = render(
        <BtwOverlay
          state={{ ...completeState, status: 'streaming' }}
          onClose={() => {}}
          onFork={() => {}}
        />,
      );
      expect(screen.queryByText('btw.fork.actionFull')).toBeNull();
      unmount();

      render(
        <BtwOverlay state={{ ...completeState, answer: '   ' }} onClose={() => {}} onFork={() => {}} />,
      );
      expect(screen.queryByText('btw.fork.actionFull')).toBeNull();
    });

    it('يعرض الوضعين معاً: السياق الكامل والمحادثة الجديدة', () => {
      render(<BtwOverlay state={completeState} onClose={() => {}} onFork={() => {}} />);
      expect(screen.getByText('btw.fork.actionFull')).toBeDefined();
      expect(screen.getByText('btw.fork.actionFresh')).toBeDefined();
    });

    it('كل زرّ يمرّر وضعه: full للسياق الكامل وfresh للمحادثة الجديدة', () => {
      const onFork = vi.fn();
      render(<BtwOverlay state={completeState} onClose={() => {}} onFork={onFork} />);

      fireEvent.click(screen.getByText('btw.fork.actionFull'));
      expect(onFork).toHaveBeenLastCalledWith('full');

      fireEvent.click(screen.getByText('btw.fork.actionFresh'));
      expect(onFork).toHaveBeenLastCalledWith('fresh');
      expect(onFork).toHaveBeenCalledTimes(2);
    });

    it('اختصار «f» = الكامل (كما في الـCLI) و«n» = محادثة جديدة', () => {
      const onFork = vi.fn();
      render(<BtwOverlay state={completeState} onClose={() => {}} onFork={onFork} />);
      fireEvent.keyDown(document, { key: 'f' });
      expect(onFork).toHaveBeenLastCalledWith('full');
      fireEvent.keyDown(document, { key: 'n' });
      expect(onFork).toHaveBeenLastCalledWith('fresh');
      expect(onFork).toHaveBeenCalledTimes(2);
    });

    it('اختصار «f» لا يعمل مع مُعدِّل ولا من داخل حقل كتابة', () => {
      const onFork = vi.fn();
      render(<BtwOverlay state={completeState} onClose={() => {}} onFork={onFork} />);
      fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
      fireEvent.keyDown(document, { key: 'f', metaKey: true });

      const input = document.createElement('input');
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: 'f' });
      input.remove();

      expect(onFork).not.toHaveBeenCalled();
    });

    it('أثناء الفرك: الزرّان معطّلان، والمؤشّر على الوضع المضغوط وحده', () => {
      const onFork = vi.fn();
      render(
        <BtwOverlay
          state={{ ...completeState, forkStatus: 'forking', forkMode: 'fresh' }}
          onClose={() => {}}
          onFork={onFork}
        />,
      );
      // الوضع الجاري يعرض «يُفرِّع…»، والآخر يبقى بعنوانه لكنه معطّل.
      const running = screen.getByText('btw.fork.pending').closest('button');
      const other = screen.getByText('btw.fork.actionFull').closest('button');
      expect(running?.hasAttribute('disabled')).toBe(true);
      expect(other?.hasAttribute('disabled')).toBe(true);
      expect(screen.queryByText('btw.fork.actionFresh')).toBeNull();

      fireEvent.keyDown(document, { key: 'f' });
      fireEvent.keyDown(document, { key: 'n' });
      expect(onFork).not.toHaveBeenCalled();
    });

    it('خطأ الفرك يظهر في تنبيهه المستقلّ والإجابة تبقى معروضة', () => {
      render(
        <BtwOverlay
          state={{ ...completeState, forkStatus: 'error', forkErrorCode: 'not_writable' }}
          onClose={() => {}}
          onFork={() => {}}
        />,
      );
      expect(screen.getByRole('alert').textContent).toContain('btw.fork.errors.not_writable');
      // الإجابة نفسها لم تتأثّر
      expect(screen.getByText('الجواب')).toBeDefined();
      // ويبقى الفرك قابلاً لإعادة المحاولة
      expect(screen.getByText('btw.fork.actionFull')).toBeDefined();
    });

    it('كود فرك غير معروف يسقط لرسالة الخادم الخام', () => {
      render(
        <BtwOverlay
          state={{
            ...completeState,
            forkStatus: 'error',
            forkErrorCode: 'weird_code',
            forkErrorMessage: 'رسالة فرك خام',
          }}
          onClose={() => {}}
          onFork={() => {}}
        />,
      );
      expect(screen.getByRole('alert').textContent).toContain('رسالة فرك خام');
    });
  });
});
