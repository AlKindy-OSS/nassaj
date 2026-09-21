/**
 * T-849 — useBtwSideChannel (منطق القناة الجانبية).
 *
 * يثبت:
 *   • التوجيه: startBtwQuery يرسل إطار «btw-query» (لا claude-command/رسالة عادية).
 *   • التراكم: btw-chunk المتتالية تتجمّع في answer، والحالة pending→streaming→complete.
 *   • الخطأ: btw-error يُترجَم لحالة error بكوده.
 *   • fallback: لا ردّ btw-* خلال نافذة السماح → error «timeout».
 *   • لا جلسة → session_not_found فوراً بلا إرسال.
 *   • WS مغلق (ok:false) → disconnected.
 *   • العزل: إطارات بـbtwId مختلف أو أنواع غير btw-* تُتجاهَل (لا تسرّب للمحادثة).
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useBtwSideChannel.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { useBtwSideChannel, BTW_FALLBACK_TIMEOUT_MS, BTW_FORK_TIMEOUT_MS } from './useBtwSideChannel';

type Frame = {
  type?: string;
  btwId?: string;
  text?: string;
  code?: string;
  message?: string;
  forkedSessionId?: string;
} | null;
interface Props {
  sessionId: string | null;
  latestMessage: Frame;
  sendMessage: (message: unknown) => { ok: boolean; reason?: string } | void;
  onForked?: (forkedSessionId: string) => void;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountHook(initial: Partial<Props> = {}) {
  const sendMessage = vi.fn((_message: unknown) => ({ ok: true }) as { ok: boolean });
  const initialProps: Props = {
    sessionId: 's1',
    latestMessage: null,
    sendMessage,
    ...initial,
  };
  const view = renderHook((p: Props) => useBtwSideChannel(p), { initialProps });
  return { ...view, sendMessage };
}

/** Read the btwId minted by the last startBtwQuery from the sent frame. */
function sentBtwId(sendMessage: ReturnType<typeof vi.fn>): string {
  const frame = sendMessage.mock.calls[0]?.[0] as { btwId?: string } | undefined;
  return frame?.btwId ?? '';
}

describe('useBtwSideChannel', () => {
  it('startBtwQuery يرسل إطار btw-query (لا رسالة عادية) ويضع الحالة pending', () => {
    const { result, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('لماذا؟'));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const frame = sendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(frame.type).toBe('btw-query');
    expect(frame.type).not.toBe('claude-command');
    expect(frame.sessionId).toBe('s1');
    expect(frame.question).toBe('لماذا؟');
    expect(typeof frame.btwId).toBe('string');
    expect((frame.btwId as string).length).toBeGreaterThan(0);

    expect(result.current.activeBtw?.status).toBe('pending');
    expect(result.current.activeBtw?.question).toBe('لماذا؟');
    expect(result.current.activeBtw?.answer).toBe('');
  });

  it('يُراكم btw-chunk المتتالية ثم يكتمل عند btw-complete', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'مرح' }, sendMessage }));
    expect(result.current.activeBtw?.answer).toBe('مرح');
    expect(result.current.activeBtw?.status).toBe('streaming');

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'باً' }, sendMessage }));
    expect(result.current.activeBtw?.answer).toBe('مرحباً');

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId }, sendMessage }));
    expect(result.current.activeBtw?.status).toBe('complete');
    expect(result.current.activeBtw?.answer).toBe('مرحباً');
  });

  it('B-270 (أ): btw-complete يحمل نصّاً → يُعتمد إجابةً نهائية (مصدر الحقيقة)', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    // chunk جزئي وصل، ثم complete يحمل النصّ الكامل — يُعتمد الكامل لا الجزئي.
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'جزء' }, sendMessage }));
    act(() =>
      rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'الإجابة الكاملة' }, sendMessage }),
    );
    expect(result.current.activeBtw?.status).toBe('complete');
    expect(result.current.activeBtw?.answer).toBe('الإجابة الكاملة');
  });

  it('B-270 (ب): ضياع كل chunk ووصول btw-complete وحده بنصّ → الإجابة صحيحة (حالة العطل الحيّة)', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('لماذا؟'));
    const btwId = sentBtwId(sendMessage);

    // لا btw-chunk إطلاقاً (دُهست الفتحة المشتركة) — فقط btw-complete يحمل النصّ.
    act(() =>
      rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'النصّ النهائي رغم ضياع الأجزاء' }, sendMessage }),
    );
    expect(result.current.activeBtw?.status).toBe('complete');
    expect(result.current.activeBtw?.answer).toBe('النصّ النهائي رغم ضياع الأجزاء');
  });

  it('B-270 (تراجع): btw-complete بلا نصّ (خادم قديم) يُبقي الأجزاء المتراكمة', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'مترا' }, sendMessage }));
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'كِم' }, sendMessage }));
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId }, sendMessage }));
    expect(result.current.activeBtw?.status).toBe('complete');
    expect(result.current.activeBtw?.answer).toBe('متراكِم');
  });

  it('يترجم btw-error إلى حالة error بكوده', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    act(() =>
      rerender({ sessionId: 's1', latestMessage: { type: 'btw-error', btwId, code: 'busy', message: 'مشغول' }, sendMessage }),
    );
    expect(result.current.activeBtw?.status).toBe('error');
    expect(result.current.activeBtw?.errorCode).toBe('busy');
    expect(result.current.activeBtw?.errorMessage).toBe('مشغول');
  });

  it('fallback: بلا أي ردّ btw-* خلال نافذة السماح → error timeout', () => {
    vi.useFakeTimers();
    const { result } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    expect(result.current.activeBtw?.status).toBe('pending');

    act(() => {
      vi.advanceTimersByTime(BTW_FALLBACK_TIMEOUT_MS);
    });
    expect(result.current.activeBtw?.status).toBe('error');
    expect(result.current.activeBtw?.errorCode).toBe('timeout');
  });

  it('وصول ردّ btw-* يُبطل مؤقّت fallback (لا خطأ timeout لاحقاً)', () => {
    vi.useFakeTimers();
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'x' }, sendMessage }));
    act(() => {
      vi.advanceTimersByTime(BTW_FALLBACK_TIMEOUT_MS * 2);
    });
    // ما زالت streaming — لم يقلبها المؤقّت إلى timeout بعد أن وصل ردّ.
    expect(result.current.activeBtw?.status).toBe('streaming');
    expect(result.current.activeBtw?.errorCode).toBeUndefined();
  });

  it('بلا جلسة → session_not_found فوراً وبلا إرسال', () => {
    const { result, sendMessage } = mountHook({ sessionId: null });
    act(() => result.current.startBtwQuery('hi'));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.activeBtw?.status).toBe('error');
    expect(result.current.activeBtw?.errorCode).toBe('session_not_found');
  });

  it('WS مغلق (ok:false) → disconnected', () => {
    const sendMessage = vi.fn(() => ({ ok: false, reason: 'disconnected' }));
    const { result } = renderHook((p: Props) => useBtwSideChannel(p), {
      initialProps: { sessionId: 's1', latestMessage: null, sendMessage },
    });
    act(() => result.current.startBtwQuery('hi'));

    expect(result.current.activeBtw?.status).toBe('error');
    expect(result.current.activeBtw?.errorCode).toBe('disconnected');
  });

  it('العزل: إطار btw-chunk بـbtwId مختلف يُتجاهَل', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId: 'OTHER', text: 'تسرّب' }, sendMessage }));
    expect(result.current.activeBtw?.answer).toBe('');
    expect(result.current.activeBtw?.status).toBe('pending');
  });

  it('العزل: رسالة دردشة عادية (نوع غير btw-*) لا تمسّ حالة القناة', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    // نوع بث عادي يحمل حتى نفس btwId (لن يحدث فعلياً) — يُتجاهَل لأن النوع ليس btw-*.
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'stream_delta', btwId, text: 'نص محادثة' }, sendMessage }));
    expect(result.current.activeBtw?.answer).toBe('');
    expect(result.current.activeBtw?.status).toBe('pending');
  });

  it('استعلام جديد يستبدل النشط (الأحدث يظهر)', () => {
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('الأول'));
    const firstId = sentBtwId(sendMessage);

    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId: firstId, text: 'ألف' }, sendMessage }));
    expect(result.current.activeBtw?.answer).toBe('ألف');

    act(() => result.current.startBtwQuery('الثاني'));
    expect(result.current.activeBtw?.question).toBe('الثاني');
    expect(result.current.activeBtw?.answer).toBe('');
    expect(result.current.activeBtw?.status).toBe('pending');

    // إطار متأخّر من الاستعلام الأول لم يعد يؤثّر.
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId: firstId, text: 'متأخّر' }, sendMessage }));
    expect(result.current.activeBtw?.answer).toBe('');
  });

  it('closeBtw يمسح الحالة النشطة', () => {
    const { result } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    expect(result.current.activeBtw).not.toBeNull();

    act(() => result.current.closeBtw());
    expect(result.current.activeBtw).toBeNull();
  });

  // --- A-3: معالجة btw-accepted (بند qa-critic) ---

  it('btw-accepted يُبطل مؤقّت fallback: تجاوز 20ث بعد accepted بلا timeout', () => {
    vi.useFakeTimers();
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));
    const btwId = sentBtwId(sendMessage);

    // الخادم يرسل accepted فوراً — يُبطل المؤقّت قبل تجاوز النافذة.
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-accepted', btwId }, sendMessage }));
    expect(result.current.activeBtw?.status).toBe('pending'); // الحالة لم تتغيّر

    // نتجاوز نافذة fallback — يجب ألا يُطلَق خطأ timeout.
    act(() => {
      vi.advanceTimersByTime(BTW_FALLBACK_TIMEOUT_MS * 2);
    });
    expect(result.current.activeBtw?.status).toBe('pending'); // ما زال pending (بلا timeout)
    expect(result.current.activeBtw?.errorCode).toBeUndefined();

    // ثم يصل btw-chunk ويُعرض طبيعياً.
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-chunk', btwId, text: 'ردّ' }, sendMessage }));
    expect(result.current.activeBtw?.status).toBe('streaming');
    expect(result.current.activeBtw?.answer).toBe('ردّ');
  });

  it('btw-accepted بـbtwId خاطئ يُتجاهَل (fallback يبقى نشطاً)', () => {
    vi.useFakeTimers();
    const { result, rerender, sendMessage } = mountHook();
    act(() => result.current.startBtwQuery('hi'));

    // accepted لاستعلام آخر — يُتجاهَل.
    act(() => rerender({ sessionId: 's1', latestMessage: { type: 'btw-accepted', btwId: 'OTHER' }, sendMessage }));

    // fallback لا يزال نشطاً — تجاوز النافذة يعطي timeout.
    act(() => {
      vi.advanceTimersByTime(BTW_FALLBACK_TIMEOUT_MS);
    });
    expect(result.current.activeBtw?.status).toBe('error');
    expect(result.current.activeBtw?.errorCode).toBe('timeout');
  });

  it('غياب btw-accepted تماماً (خادم قديم): timeout كما قبل', () => {
    vi.useFakeTimers();
    const { result } = mountHook();
    act(() => result.current.startBtwQuery('hi'));

    // لا accepted ولا أي ردّ — الخادم لا يعرف btw أصلاً.
    act(() => {
      vi.advanceTimersByTime(BTW_FALLBACK_TIMEOUT_MS);
    });
    expect(result.current.activeBtw?.status).toBe('error');
    expect(result.current.activeBtw?.errorCode).toBe('timeout');
  });

  // ── T-1090: الفرك (btw-fork ← btw-forked | btw-fork-error) ───────────────
  describe('الفرك', () => {
    /** يصل بالهوك إلى سؤال مكتمل بإجابة، وهو الشرط الوحيد لإتاحة الفرك. */
    function mountCompleted(answer = 'الجواب') {
      const view = mountHook();
      act(() => view.result.current.startBtwQuery('س'));
      const btwId = sentBtwId(view.sendMessage);
      act(() =>
        view.rerender({
          sessionId: 's1',
          latestMessage: { type: 'btw-complete', btwId, text: answer },
          sendMessage: view.sendMessage,
        }),
      );
      return { ...view, btwId };
    }

    it('forkBtw يرسل btw-fork بالسؤال والإجابة ونفس btwId، والحالة forking', () => {
      const { result, sendMessage, btwId } = mountCompleted();
      act(() => result.current.forkBtw());

      const frame = sendMessage.mock.calls[1][0] as Record<string, unknown>;
      expect(frame.type).toBe('btw-fork');
      expect(frame.btwId).toBe(btwId);
      expect(frame.sessionId).toBe('s1');
      expect(frame.question).toBe('س');
      expect(frame.answer).toBe('الجواب');
      // الوضع الافتراضي = الفرع الكامل (سلوك الـCLI)
      expect(frame.mode).toBe('full');
      expect(result.current.activeBtw?.forkStatus).toBe('forking');
      expect(result.current.activeBtw?.forkMode).toBe('full');
      // حالة الإجابة نفسها لم تتغيّر
      expect(result.current.activeBtw?.status).toBe('complete');
    });

    it('btw-forked يستدعي onForked بمعرّف الجلسة الجديدة', () => {
      const onForked = vi.fn();
      const sendMessage = vi.fn(() => ({ ok: true }));
      const initialProps: Props = { sessionId: 's1', latestMessage: null, sendMessage, onForked };
      const { result, rerender } = renderHook((p: Props) => useBtwSideChannel(p), { initialProps });
      act(() => result.current.startBtwQuery('س'));
      const btwId = sentBtwId(sendMessage);
      act(() =>
        rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'ج' }, sendMessage, onForked }),
      );
      act(() => result.current.forkBtw());
      act(() =>
        rerender({
          sessionId: 's1',
          latestMessage: { type: 'btw-forked', btwId, forkedSessionId: 'new-session-id' },
          sendMessage,
          onForked,
        }),
      );

      expect(onForked).toHaveBeenCalledTimes(1);
      expect(onForked).toHaveBeenCalledWith('new-session-id');
      expect(result.current.activeBtw?.forkStatus).toBe('idle');
    });

    it('btw-fork-error يضع خطأ الفرك وحده ولا يمسّ الإجابة', () => {
      const { result, rerender, sendMessage, btwId } = mountCompleted();
      act(() => result.current.forkBtw());
      act(() =>
        rerender({
          sessionId: 's1',
          latestMessage: { type: 'btw-fork-error', btwId, code: 'not_writable', message: 'no' },
          sendMessage,
        }),
      );

      expect(result.current.activeBtw?.forkStatus).toBe('error');
      expect(result.current.activeBtw?.forkErrorCode).toBe('not_writable');
      expect(result.current.activeBtw?.forkErrorMessage).toBe('no');
      expect(result.current.activeBtw?.status).toBe('complete');
      expect(result.current.activeBtw?.answer).toBe('الجواب');
    });

    it('btw-forked بلا معرّف جلسة → خطأ ولا انتقال', () => {
      const onForked = vi.fn();
      const sendMessage = vi.fn(() => ({ ok: true }));
      const initialProps: Props = { sessionId: 's1', latestMessage: null, sendMessage, onForked };
      const { result, rerender } = renderHook((p: Props) => useBtwSideChannel(p), { initialProps });
      act(() => result.current.startBtwQuery('س'));
      const btwId = sentBtwId(sendMessage);
      act(() =>
        rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'ج' }, sendMessage, onForked }),
      );
      act(() => result.current.forkBtw());
      act(() =>
        rerender({ sessionId: 's1', latestMessage: { type: 'btw-forked', btwId }, sendMessage, onForked }),
      );

      expect(onForked).not.toHaveBeenCalled();
      expect(result.current.activeBtw?.forkStatus).toBe('error');
      expect(result.current.activeBtw?.forkErrorCode).toBe('fork_failed');
    });

    it('لا فرك قبل الاكتمال ولا على إجابة فارغة ولا مرّتين معاً', () => {
      // (أ) أثناء البثّ
      const streaming = mountHook();
      act(() => streaming.result.current.startBtwQuery('س'));
      act(() => streaming.result.current.forkBtw());
      expect(streaming.sendMessage).toHaveBeenCalledTimes(1); // btw-query وحده
      cleanup();

      // (ب) مكتمل بإجابة فارغة
      const empty = mountCompleted('   ');
      act(() => empty.result.current.forkBtw());
      expect(empty.sendMessage).toHaveBeenCalledTimes(1);
      cleanup();

      // (ج) فرك ثانٍ أثناء فرك جارٍ
      const busy = mountCompleted();
      act(() => busy.result.current.forkBtw());
      act(() => busy.result.current.forkBtw());
      expect(busy.sendMessage).toHaveBeenCalledTimes(2); // query + fork واحد
    });

    it('forkBtw(\'fresh\') يرسل وضع المحادثة الجديدة ويسجّله في الحالة', () => {
      const { result, sendMessage } = mountCompleted();
      act(() => result.current.forkBtw('fresh'));

      const frame = sendMessage.mock.calls[1][0] as Record<string, unknown>;
      expect(frame.type).toBe('btw-fork');
      expect(frame.mode).toBe('fresh');
      // السؤال والإجابة يُرسلان في الوضعين — الفرق في السياق المسحوب لا في الزوج.
      expect(frame.question).toBe('س');
      expect(frame.answer).toBe('الجواب');
      expect(result.current.activeBtw?.forkMode).toBe('fresh');
    });

    it('العزل: btw-forked بـbtwId مختلف يُتجاهَل', () => {
      const onForked = vi.fn();
      const sendMessage = vi.fn(() => ({ ok: true }));
      const initialProps: Props = { sessionId: 's1', latestMessage: null, sendMessage, onForked };
      const { result, rerender } = renderHook((p: Props) => useBtwSideChannel(p), { initialProps });
      act(() => result.current.startBtwQuery('س'));
      const btwId = sentBtwId(sendMessage);
      act(() =>
        rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'ج' }, sendMessage, onForked }),
      );
      act(() => result.current.forkBtw());
      act(() =>
        rerender({
          sessionId: 's1',
          latestMessage: { type: 'btw-forked', btwId: 'other-id', forkedSessionId: 'x' },
          sendMessage,
          onForked,
        }),
      );

      expect(onForked).not.toHaveBeenCalled();
      expect(result.current.activeBtw?.forkStatus).toBe('forking');
    });

    it('WS مغلق (ok:false) → خطأ فرك disconnected بلا مهلة', () => {
      const sendMessage = vi
        .fn()
        .mockReturnValueOnce({ ok: true })
        .mockReturnValueOnce({ ok: false, reason: 'closed' });
      const initialProps: Props = { sessionId: 's1', latestMessage: null, sendMessage };
      const { result, rerender } = renderHook((p: Props) => useBtwSideChannel(p), { initialProps });
      act(() => result.current.startBtwQuery('س'));
      const btwId = sentBtwId(sendMessage);
      act(() =>
        rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'ج' }, sendMessage }),
      );
      act(() => result.current.forkBtw());

      expect(result.current.activeBtw?.forkStatus).toBe('error');
      expect(result.current.activeBtw?.forkErrorCode).toBe('disconnected');
    });

    it('خادم لا يعرف btw-fork: لا ردّ → مهلة الفرك تُنهيها بخطأ timeout', () => {
      vi.useFakeTimers();
      const { result } = mountCompleted();
      act(() => result.current.forkBtw());
      expect(result.current.activeBtw?.forkStatus).toBe('forking');

      act(() => {
        vi.advanceTimersByTime(BTW_FORK_TIMEOUT_MS);
      });
      expect(result.current.activeBtw?.forkStatus).toBe('error');
      expect(result.current.activeBtw?.forkErrorCode).toBe('timeout');
    });

    it('btw-forked يُبطل مهلة الفرك (لا خطأ لاحق)', () => {
      vi.useFakeTimers();
      const onForked = vi.fn();
      const sendMessage = vi.fn(() => ({ ok: true }));
      const initialProps: Props = { sessionId: 's1', latestMessage: null, sendMessage, onForked };
      const { result, rerender } = renderHook((p: Props) => useBtwSideChannel(p), { initialProps });
      act(() => result.current.startBtwQuery('س'));
      const btwId = sentBtwId(sendMessage);
      act(() =>
        rerender({ sessionId: 's1', latestMessage: { type: 'btw-complete', btwId, text: 'ج' }, sendMessage, onForked }),
      );
      act(() => result.current.forkBtw());
      act(() =>
        rerender({
          sessionId: 's1',
          latestMessage: { type: 'btw-forked', btwId, forkedSessionId: 'sid' },
          sendMessage,
          onForked,
        }),
      );

      act(() => {
        vi.advanceTimersByTime(BTW_FORK_TIMEOUT_MS * 2);
      });
      expect(result.current.activeBtw?.forkStatus).toBe('idle');
      expect(onForked).toHaveBeenCalledTimes(1);
    });

    it('استعلام جديد يُصفّر حالة الفرك ومهلته', () => {
      vi.useFakeTimers();
      const { result } = mountCompleted();
      act(() => result.current.forkBtw());
      expect(result.current.activeBtw?.forkStatus).toBe('forking');

      act(() => result.current.startBtwQuery('سؤال آخر'));
      expect(result.current.activeBtw?.forkStatus).toBe('idle');

      // مهلة الفرك القديمة لا تُلوّث السؤال الجديد.
      act(() => {
        vi.advanceTimersByTime(BTW_FORK_TIMEOUT_MS);
      });
      expect(result.current.activeBtw?.forkStatus).toBe('idle');
    });
  });
});
