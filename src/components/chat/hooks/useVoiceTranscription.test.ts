/**
 * useVoiceTranscription.test.ts — ADR-103 / T-1248
 *
 * الوضع «الدقيق» يجمع ثلاث واجهات متصفّح لا تُحاكى بسهولة (getUserMedia،
 * MediaRecorder، رفع شبكي) في دورة واحدة، فالمُثبَّت هنا هو ما ينكسر بصمت لا
 * «المسار السعيد» وحده:
 *
 *  1. الإيقاف يُنهي **مسارات الـstream** لا المسجّل فقط — وإلا بقي مؤشّر
 *     الميكروفون مضاءً بعد ما تراه الواجهة توقّفاً.
 *  2. الرفع الناجح يُدرج النصّ **مرّة واحدة** بمسار الإدراج نفسه.
 *  3. كل رمز خطأ من الخادم يصل الواجهة كما هو (لا «فشل» عامّ يبتلعها).
 *  4. الإلغاء (تبديل الجلسة) يُجهض الطلب ويمنع أي إدراج متأخّر — التسرّب هنا
 *     يكتب كلام محادثةٍ في مسودّة أخرى بعد ثانيتين.
 *  5. الحمولة المحكوم عليها بالفشل تُوقَف قبل الرفع (سقف `maxMb`)، والفارغة كذلك.
 *  6. نوع MIME يُجرَّد من معامل الترميز قبل بناء الملف (الخادم يطابق حرفياً).
 *  7. فشل الإذن يُترجَم إلى سبب مفهوم لا إلى عطل عامّ.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useVoiceTranscription.test.ts
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseMimeType,
  useVoiceMode,
  useVoiceTranscription,
  voiceAccurateConsentStorageKey,
  voiceModeStorageKey,
  VOICE_RECORDING_MAX_MS,
} from './useVoiceTranscription';

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

// ─── مزيّفات واجهات المتصفّح ────────────────────────────────────────────────

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  /** الأنواع التي «يدعمها» هذا المتصفّح المزيّف. */
  static supported = new Set<string>(['audio/webm;codecs=opus', 'audio/webm']);
  static constructorThrows = false;

  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.has(type);
  }

  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  stream: FakeStream;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(stream: FakeStream, options?: { mimeType?: string }) {
    if (FakeMediaRecorder.constructorThrows) throw new Error('unsupported');
    this.stream = stream;
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }

  /** المتصفّح يسلّم الأجزاء قبل `onstop`؛ الاختبار يفعل ذلك يدوياً. */
  emitData(text: string) {
    this.ondataavailable?.({ data: new Blob([text], { type: 'audio/webm' }) });
  }
}

const lastRecorder = () => {
  const rec = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
  if (!rec) throw new Error('لم يُنشأ أي MediaRecorder');
  return rec;
};

let currentStream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn>;

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

/** يبني تسجيلاً كاملاً حتى لحظة ما قبل حسم الرفع. */
async function record(hook: { current: ReturnType<typeof useVoiceTranscription> }, text = 'صوت') {
  act(() => hook.current.start());
  await waitFor(() => expect(FakeMediaRecorder.instances.length).toBeGreaterThan(0));
  act(() => lastRecorder().emitData(text));
  act(() => hook.current.stop());
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.constructorThrows = false;
  FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
  currentStream = new FakeStream();
  getUserMedia = vi.fn(async () => currentStream);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue(jsonResponse(true, { text: 'النصّ المفرَّغ' }));
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// ─── 1. الدعم والتدهور اللطيف ───────────────────────────────────────────────

describe('اكتشاف الدعم', () => {
  it('غير مدعوم بلا MediaRecorder', () => {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    expect(result.current.isSupported).toBe(false);
  });

  it('غير مدعوم خارج السياق الآمن رغم وجود الواجهات', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    expect(result.current.isSupported).toBe(false);
  });

  it('البدء بلا دعم يُنتج خطأً ظاهراً لا فشلاً صامتاً', () => {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    expect(result.current.error).toBe('unsupported');
    expect(result.current.state).toBe('error');
  });
});

// ─── 2. دورة التسجيل والرفع ─────────────────────────────────────────────────

describe('دورة التسجيل والرفع', () => {
  it('الرفع الناجح يُدرج النصّ مرّة واحدة ويعود إلى idle', async () => {
    const insert = vi.fn();
    const { result } = renderHook(() => useVoiceTranscription(insert));

    await record(result, 'مرحباً');
    await waitFor(() => expect(result.current.state).toBe('idle'));

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith('النصّ المفرَّغ');
    expect(result.current.error).toBeNull();
  });

  it('يمرّ بحالة uploading بين التسجيل والإدراج', async () => {
    let resolveUpload: (value: unknown) => void = () => {};
    authenticatedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));
    act(() => lastRecorder().emitData('صوت'));
    act(() => result.current.stop());

    await waitFor(() => expect(result.current.state).toBe('uploading'));
    expect(result.current.isUploading).toBe(true);

    await act(async () => {
      resolveUpload(jsonResponse(true, { text: 'تمّ' }));
    });
    await waitFor(() => expect(result.current.state).toBe('idle'));
  });

  it('يُنهي كل مسارات الـstream عند الإيقاف (لا مؤشّر ميكروفون عالق)', async () => {
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    await record(result);
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(currentStream.tracks.every((track) => track.stopped)).toBe(true);
  });

  it('يختار أوّل نوع مدعوم من قائمة التفضيل', async () => {
    FakeMediaRecorder.supported = new Set(['audio/webm']);
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(FakeMediaRecorder.instances.length).toBe(1));
    expect(lastRecorder().mimeType).toBe('audio/webm');
  });

  it('يسقط لطيفاً حين لا نوع مدعوم بدل أن يمتنع عن التسجيل', async () => {
    FakeMediaRecorder.supported = new Set();
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));
  });

  it('يرسل حقل audio وبلا حقل language (الكشف تلقائي هو المطلوب)', async () => {
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    await record(result);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());

    const [url, init] = authenticatedFetch.mock.calls[0] as [string, { body: FormData }];
    expect(url).toBe('/api/voice/transcription');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('language')).toBeNull();
    const file = init.body.get('audio') as File;
    // مصيدة §5: معامل الترميز مجرَّد — الخادم يطابق قائمة الأنواع حرفياً.
    expect(file.type).toBe('audio/webm');
  });

  it('لا يضبط Content-Type بنفسه (حدّ الـmultipart يولّده المتصفّح)', async () => {
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    await record(result);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    const [, init] = authenticatedFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(init.headers).toBeUndefined();
  });

  it('baseMimeType يجرّد المعاملات', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('AUDIO/MP4')).toBe('audio/mp4');
  });
});

// ─── 3. رموز الخطأ ──────────────────────────────────────────────────────────

describe('رموز الخطأ', () => {
  const serverCodes = [
    ['NO_TRANSCRIPTION_KEY', 409],
    ['INVALID_TRANSCRIPTION_KEY', 502],
    ['TRANSCRIPTION_RATE_LIMITED', 429],
    ['TRANSCRIPTION_TIMEOUT', 504],
    ['TRANSCRIPTION_UNREACHABLE', 502],
    ['TRANSCRIPTION_FAILED', 502],
    ['AUDIO_TOO_LARGE', 413],
    ['UNSUPPORTED_AUDIO_TYPE', 415],
    ['EMPTY_AUDIO', 400],
  ] as const;

  it.each(serverCodes)('يمرّر رمز %s كما هو بلا ابتلاعه في «فشل» عامّ', async (code, status) => {
    authenticatedFetch.mockResolvedValue(jsonResponse(false, { code, error: 'x' }, status));
    const insert = vi.fn();
    const { result } = renderHook(() => useVoiceTranscription(insert));

    await record(result);
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toBe(code);
    expect(insert).not.toHaveBeenCalled();
  });

  it('جواب خطأ بلا رمز يسقط على upload-failed', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(false, {}, 500));
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    await record(result);
    await waitFor(() => expect(result.current.error).toBe('upload-failed'));
  });

  it('عطل الشبكة يُنتج upload-failed لا استثناءً غير ملتقط', async () => {
    authenticatedFetch.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    await record(result);
    await waitFor(() => expect(result.current.error).toBe('upload-failed'));
  });

  it('نصّ فارغ من الخادم = EMPTY_AUDIO لا إدراج فراغ', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(true, { text: '   ' }));
    const insert = vi.fn();
    const { result } = renderHook(() => useVoiceTranscription(insert));
    await record(result);
    await waitFor(() => expect(result.current.error).toBe('EMPTY_AUDIO'));
    expect(insert).not.toHaveBeenCalled();
  });

  it('رفض إذن الميكروفون يُترجَم إلى mic-denied', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    getUserMedia.mockRejectedValue(denied);
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.error).toBe('mic-denied'));
    expect(result.current.state).toBe('error');
  });

  it('غياب المايكروفون يُترجَم إلى no-mic', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('none'), { name: 'NotFoundError' }));
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.error).toBe('no-mic'));
  });

  it('فشل بناء المسجّل يُحرّر المسارات ولا يترك الميكروفون مفتوحاً', async () => {
    FakeMediaRecorder.constructorThrows = true;
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.error).toBe('recorder-failed'));
    expect(currentStream.tracks.every((track) => track.stopped)).toBe(true);
  });
});

// ─── 4. حرّاس الحمولة ───────────────────────────────────────────────────────

describe('حرّاس الحمولة', () => {
  it('تسجيل بلا صوت لا يُرفع أصلاً', async () => {
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));
    act(() => result.current.stop());

    await waitFor(() => expect(result.current.error).toBe('EMPTY_AUDIO'));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('تجاوز سقف maxMb يُوقف قبل الرفع لا بعده', async () => {
    // سقف صفريّ بالمعنى العملي: أصغر تسجيل يتجاوزه.
    const { result } = renderHook(() => useVoiceTranscription(vi.fn(), { maxMb: 0.000001 }));
    await record(result, 'حمولة');
    await waitFor(() => expect(result.current.error).toBe('AUDIO_TOO_LARGE'));
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(result.current.maxMb).toBe(0.000001);
  });

  it('غياب maxMb يُبقي حدّاً احتياطياً لا حدّاً مفتوحاً', () => {
    const { result } = renderHook(() => useVoiceTranscription(vi.fn(), { maxMb: null }));
    expect(result.current.maxMb).toBe(10);
  });

  it('سقف المدّة يوقف تلقائياً ويُبلّغ — ويُفرّغ ما سُجّل بدل رميه', async () => {
    // shouldAdvanceTime: الخطّاف ينتظر getUserMedia قبل ضبط المؤقّت، فساعة
    // مجمَّدة تماماً تمنع حسم ذلك الوعد أصلاً.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const insert = vi.fn();
      const { result } = renderHook(() => useVoiceTranscription(insert));

      act(() => result.current.start());
      await vi.waitFor(() => expect(result.current.state).toBe('recording'));
      act(() => lastRecorder().emitData('كلام طويل'));

      await act(async () => {
        vi.advanceTimersByTime(VOICE_RECORDING_MAX_MS);
      });

      expect(result.current.reachedMaxDuration).toBe(true);
      await vi.waitFor(() => expect(insert).toHaveBeenCalledWith('النصّ المفرَّغ'));
      expect(currentStream.tracks.every((track) => track.stopped)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 5. الإلغاء وفكّ التركيب ────────────────────────────────────────────────

describe('الإلغاء (تبديل الجلسة) وفكّ التركيب', () => {
  it('الإلغاء أثناء الرفع يمنع الإدراج المتأخّر ويُجهض الطلب', async () => {
    let resolveUpload: (value: unknown) => void = () => {};
    const signals: AbortSignal[] = [];
    authenticatedFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    });
    const insert = vi.fn();
    const { result } = renderHook(() => useVoiceTranscription(insert));

    await record(result);
    await waitFor(() => expect(result.current.state).toBe('uploading'));

    act(() => result.current.cancel());
    expect(result.current.state).toBe('idle');
    expect(signals[0].aborted).toBe(true);

    // حتى لو وصل الجواب بعد الإلغاء (السباق الحقيقي): لا إدراج.
    await act(async () => {
      resolveUpload(jsonResponse(true, { text: 'متأخّر' }));
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('الإلغاء أثناء التسجيل يُنهي المسارات ولا يرفع شيئاً', async () => {
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));

    act(() => result.current.cancel());

    expect(result.current.state).toBe('idle');
    expect(currentStream.tracks.every((track) => track.stopped)).toBe(true);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('فكّ التركيب أثناء التسجيل يُحرّر المايكروفون', async () => {
    const { result, unmount } = renderHook(() => useVoiceTranscription(vi.fn()));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));

    unmount();

    expect(currentStream.tracks.every((track) => track.stopped)).toBe(true);
  });

  it('الإلغاء أثناء انتظار إذن الميكروفون يُغلق المسارات فور وصولها', async () => {
    let releaseStream: (value: FakeStream) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise<FakeStream>((resolve) => {
        releaseStream = resolve;
      }),
    );
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));

    act(() => result.current.start());
    act(() => result.current.cancel());

    await act(async () => {
      releaseStream(currentStream);
    });

    expect(currentStream.tracks.every((track) => track.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('toggle لا يبدأ تسجيلاً ثانياً أثناء الرفع', async () => {
    authenticatedFetch.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useVoiceTranscription(vi.fn()));
    await record(result);
    await waitFor(() => expect(result.current.state).toBe('uploading'));

    act(() => result.current.toggle());

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(result.current.state).toBe('uploading');
  });
});

// ─── 6. تفضيل الوضع ─────────────────────────────────────────────────────────

describe('useVoiceMode', () => {
  // الافتراضي «مستمرّ» لا «سريع»: الوضع السريع يتقطّع بنيوياً على أندرويد
  // (نطق واحد + نغمة نظام عند كل إعادة فتح)، والمُؤلِّف يهبط إليه تلقائياً حين
  // لا يكون المستمرّ متاحاً — فالتفضيل هنا نيّة لا فرض.
  it('الافتراضي مستمرّ، والاختيار يُحفظ في مفتاح مُنطَّق', () => {
    const { result } = renderHook(() => useVoiceMode('7'));
    expect(result.current[0]).toBe('accurate');

    act(() => result.current[1]('fast'));
    expect(result.current[0]).toBe('fast');
    expect(window.localStorage.getItem(voiceModeStorageKey('7'))).toBe('fast');

    act(() => result.current[1]('accurate'));

    expect(result.current[0]).toBe('accurate');
    expect(window.localStorage.getItem(voiceModeStorageKey('7'))).toBe('accurate');
    // ولا يتسرّب إلى المفتاح غير المُنطَّق (جهاز واحد قد يحمل أكثر من حساب).
    expect(window.localStorage.getItem(voiceModeStorageKey())).toBeNull();
  });

  it('يقرأ التفضيل المحفوظ عند التركيب ويثبت عليه', () => {
    window.localStorage.setItem(voiceModeStorageKey('7'), 'accurate');
    const { result, rerender } = renderHook(() => useVoiceMode('7'));
    expect(result.current[0]).toBe('accurate');
    rerender();
    expect(result.current[0]).toBe('accurate');
  });

  it('يعيد القراءة حين يصل النطاق متأخّراً (هوية المستخدم بعد التركيب)', () => {
    window.localStorage.setItem(voiceModeStorageKey('7'), 'accurate');
    const { result, rerender } = renderHook(({ scope }) => useVoiceMode(scope), {
      initialProps: { scope: null as string | null },
    });
    expect(result.current[0]).toBe('accurate');

    rerender({ scope: '7' });

    expect(result.current[0]).toBe('accurate');
  });

  it('قيمة مخزَّنة فاسدة لا تُنتج وضعاً ثالثاً', () => {
    window.localStorage.setItem(voiceModeStorageKey('7'), 'whisper-x');
    const { result } = renderHook(() => useVoiceMode('7'));
    expect(result.current[0]).toBe('accurate');
  });

  it('مفتاح موافقة الوضع الدقيق مستقلّ عن موافقة الوضع السريع', () => {
    expect(voiceAccurateConsentStorageKey('7')).toBe('nassaj:voice:accurate-consent:v1:7');
    expect(voiceAccurateConsentStorageKey('7')).not.toBe('nassaj:voice:consent:v1:7');
  });
});
