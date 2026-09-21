/**
 * useShellConnection.error.test.tsx
 *
 * الحارس ضدّ «اللوح الأسود الصامت»: الخادم يردّ على `init` بإطار
 * `{type:'error'}` (صيانة تحديث، مهلة قفل، …) ثم لا يرسل شيئاً — لا إخراج ولا
 * خروج عملية. كان هذا الـhook يبتلع الإطار كلياً، فيبقى المستخدم أمام لوح أسود
 * بلا رسالة. الفحوص هنا تثبّت العقد الثلاثي:
 *   (١) النصّ يُكتب مرئياً في xterm،
 *   (٢) يُرفع حالةً للمستهلك،
 *   (٣) ولا يُفسَّر خروجَ عملية ولا يُطلق عاصفة إعادة اتصال.
 *
 * Run: npx vitest run src/components/shell/hooks/useShellConnection.error.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import type { ShellErrorInfo } from '../types/types';

import { useShellConnection } from './useShellConnection';

// WebSocket مزيّف: عدد النسخ المُنشأة هو المقياس الصادق الوحيد على «عاصفة
// إعادة الاتصال»، والحالة readyState تثبت بقاء السوكت مفتوحاً بعد الخطأ.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

type HarnessResult = {
  /** كل ما دُفع للمستهلك بالترتيب: خطأ أو `null` (تصفير). */
  errorFeed: (ShellErrorInfo | null)[];
  writes: string[];
  clears: number;
  processCompletions: number[];
  isReconnecting: boolean;
};

/**
 * يركّب الـhook بطرفية مزيّفة. `isPlainShell` هو ما يميّز فعلياً مسار وضع
 * `minimal` (نافذة ربط المزوّد: أمر مباشر على plain shell) من الطرفية العادية،
 * وكلا الوضعين يمرّان على هذا الـhook نفسه.
 */
function Harness({ result, isPlainShell }: { result: HarnessResult; isPlainShell: boolean }) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef({
    write: (data: string) => {
      result.writes.push(data);
    },
  }) as unknown as MutableRefObject<never>;
  const fitAddonRef = useRef({ fit: () => {} }) as unknown as MutableRefObject<never>;
  const selectedProjectRef = useRef({ name: 'p', path: '/p', fullPath: '/p' }) as never;
  const selectedSessionRef = useRef(null) as never;
  const initialCommandRef = useRef<string | null>('claude /login');
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef((code: number) => {
    result.processCompletions.push(code);
  });
  const onShellErrorRef = useRef((error: ShellErrorInfo | null) => {
    result.errorFeed.push(error);
  });

  const connection = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    onShellErrorRef,
    isInitialized: true,
    autoConnect: true,
    closeSocket: () => {},
    clearTerminalScreen: () => {
      result.clears += 1;
    },
    setAuthUrl: () => {},
  });

  useEffect(() => {
    result.isReconnecting = connection.isReconnecting;
  });

  return null;
}

function mount(options: { isPlainShell?: boolean } = {}) {
  const result: HarnessResult = {
    errorFeed: [],
    writes: [],
    clears: 0,
    processCompletions: [],
    isReconnecting: false,
  };
  render(<Harness result={result} isPlainShell={options.isPlainShell ?? true} />);
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error('the hook never opened a socket');
  }
  return { result, socket };
}

/** الأخطاء وحدها من التغذية (بلا التصفيرات). */
const raisedErrors = (result: HarnessResult) =>
  result.errorFeed.filter((entry): entry is ShellErrorInfo => entry !== null);

/** النصّ كما يقرؤه المستخدم: بلا شيفرات الألوان. */
const plainText = (writes: string[]) => writes.join('').replace(/\x1b\[[0-9;]*m/g, '');

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  window.localStorage.setItem('auth-token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useShellConnection — إطار الخطأ الخادمي', () => {
  it('يكتب نصّ الخطأ في الطرفية ويرفعه حالةً للمستهلك', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({
        type: 'error',
        message: 'Update maintenance is active',
        code: 'update_maintenance_active',
      });
    });

    expect(plainText(result.writes)).toContain('Update maintenance is active');
    expect(plainText(result.writes)).toContain('[update_maintenance_active]');
    expect(raisedErrors(result)).toEqual([
      { message: 'Update maintenance is active', code: 'update_maintenance_active' },
    ]);
  });

  it('يلوّن السطر تحذيرياً بدل بلعه صامتاً', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'error', message: 'Shell lock timeout' });
    });

    expect(result.writes.join('')).toContain('\x1b[1;33m');
  });

  it('يتحمّل إطاراً بلا code (خادم أقدم)', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'error', message: 'Shell lock timeout' });
    });

    expect(raisedErrors(result)).toEqual([{ message: 'Shell lock timeout', code: null }]);
    expect(plainText(result.writes)).not.toContain('[');
  });

  it('يعطي نصّاً بديلاً حين يصل الإطار بلا رسالة', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'error', code: 'update_maintenance_active' });
    });

    expect(raisedErrors(result)).toHaveLength(1);
    expect(raisedErrors(result)[0].message.length).toBeGreaterThan(0);
    expect(raisedErrors(result)[0].code).toBe('update_maintenance_active');
    expect(plainText(result.writes).trim().length).toBeGreaterThan(0);
  });

  it('خطأ قبل أي إخراج: لا يُفسَّر خروجَ عملية', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({
        type: 'error',
        message: 'No shell for you',
        code: 'update_maintenance_active',
      });
    });

    expect(result.processCompletions).toEqual([]);
    expect(raisedErrors(result)).toHaveLength(1);
  });

  it('خطأ بعد اتصال قائم: يلحق بالإخراج السابق ولا يمحوه', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'output', data: 'Welcome to the CLI\r\n' });
      socket.emit({ type: 'error', message: 'Session evicted', code: 'update_maintenance_active' });
    });

    const text = plainText(result.writes);
    expect(text.indexOf('Welcome to the CLI')).toBeLessThan(text.indexOf('Session evicted'));
    expect(raisedErrors(result)).toHaveLength(1);
    expect(result.processCompletions).toEqual([]);
  });

  it('خطأ بلا إغلاق سوكت: لا يفتح سوكتاً جديداً ولا يدخل وضع إعادة الاتصال', () => {
    vi.useFakeTimers();
    try {
      const { result, socket } = mount();
      const socketsBefore = FakeWebSocket.instances.length;

      act(() => {
        socket.emit({ type: 'error', message: 'Update maintenance is active' });
      });
      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(FakeWebSocket.instances.length).toBe(socketsBefore);
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
      expect(result.isReconnecting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['وضع minimal (أمر مباشر على plain shell)', true],
    ['الطرفية العادية (جلسة مزوّد)', false],
  ])('%s: يعرض الخطأ نفسه', (_label, isPlainShell) => {
    const { result, socket } = mount({ isPlainShell: isPlainShell as boolean });

    act(() => {
      socket.emit({ type: 'error', message: 'Refused', code: 'update_maintenance_active' });
    });

    expect(plainText(result.writes)).toContain('Refused');
    expect(raisedErrors(result)).toEqual([
      { message: 'Refused', code: 'update_maintenance_active' },
    ]);
    expect(result.processCompletions).toEqual([]);
  });
});

describe('useShellConnection — عمر اللافتة', () => {
  it('أول إخراج بعد الخطأ يصفّر الحالة: البوابة انفتحت والـPTY حيّ', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'error', message: 'Update maintenance is active' });
    });
    expect(raisedErrors(result)).toHaveLength(1);

    act(() => {
      socket.emit({ type: 'output', data: 'welcome back\r\n' });
    });

    expect(result.errorFeed.at(-1)).toBeNull();
  });

  it('لا يصفّر مرّتين بلا خطأ جديد (لا ضجيج على المستهلك)', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'error', message: 'Update maintenance is active' });
      socket.emit({ type: 'output', data: 'a' });
      socket.emit({ type: 'output', data: 'b' });
    });

    expect(result.errorFeed.filter((entry) => entry === null)).toHaveLength(1);
  });

  it('سوكت جديد يفتح بنجاح يصفّر اللافتة', () => {
    const { result, socket } = mount();

    act(() => {
      socket.emit({ type: 'error', message: 'Update maintenance is active' });
    });
    act(() => {
      socket.onopen?.();
    });

    expect(result.errorFeed.at(-1)).toBeNull();
  });

  it.each([
    ['مصادقة', 4401],
    ['صلاحية', 4403],
    ['مشروع غير مرئي', 4404],
  ])(
    'إغلاق %s بعد إطار الخطأ: لا إعادة اتصال ولا مسح للّوح (اللافتة تبقى مقروءة)',
    (_label, closeCode) => {
      vi.useFakeTimers();
      try {
        const { result, socket } = mount();
        const socketsBefore = FakeWebSocket.instances.length;

        act(() => {
          socket.emit({ type: 'error', message: 'Authentication required for terminal session' });
          socket.onclose?.({ code: closeCode as number });
        });
        act(() => {
          vi.advanceTimersByTime(60_000);
        });

        expect(FakeWebSocket.instances.length).toBe(socketsBefore);
        expect(result.clears).toBe(0);
        expect(result.isReconnecting).toBe(false);
        expect(plainText(result.writes)).toContain('Authentication required for terminal session');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('إغلاق شاذّ بلا إطار خطأ سابق: يعيد الاتصال كما كان (لا انحدار)', () => {
    vi.useFakeTimers();
    try {
      const { socket } = mount();
      const socketsBefore = FakeWebSocket.instances.length;

      act(() => {
        socket.onclose?.({ code: 1006 });
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useShellConnection — رفض البوابة قابل للإعادة', () => {
  // المنطقة العمياء: الخادم يترك السوكت مفتوحاً بعد رفض البوابة («أعد المحاولة
  // حين تنتهي الصيانة»)، والصيانة نفسها تُعيد تشغيل الخادم فيهبط 1006. عدّ ذلك
  // نهائياً يعني أن الطرفية لا تعود بعد أي تحديث على أي عقدة.
  it('إطار بوابة ثم إغلاق شاذّ 1006: إعادة الوصل تقع فعلاً', () => {
    vi.useFakeTimers();
    try {
      const { socket } = mount();

      act(() => {
        socket.emit({
          type: 'error',
          message: 'Update maintenance is active',
          code: 'update_maintenance_active',
        });
      });
      const socketsBefore = FakeWebSocket.instances.length;

      act(() => {
        socket.onclose?.({ code: 1006 });
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('اللافتة تصمد عبر إعادة الوصل حتى يُجيب الخادم', () => {
    vi.useFakeTimers();
    try {
      const { result, socket } = mount();

      act(() => {
        socket.emit({ type: 'error', message: 'Update maintenance is active', code: 'update_maintenance_active' });
        socket.onclose?.({ code: 1006 });
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      const reattached = FakeWebSocket.instances.at(-1);
      act(() => {
        reattached?.onopen?.();
      });

      // فتح السوكت وحده لا يثبت أن البوابة انفتحت: لا تصفير بعد.
      expect(result.errorFeed.at(-1)).not.toBeNull();

      act(() => {
        reattached?.emit({ type: 'output', data: 'back online\r\n' });
      });

      expect(result.errorFeed.at(-1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('إطار بوابة ثم إغلاق نظيف 1000: مسار الإغلاق المقصود كما كان (لا backoff)', () => {
    vi.useFakeTimers();
    try {
      const { result, socket } = mount();
      act(() => {
        socket.emit({
          type: 'error',
          message: 'Update maintenance is active',
          code: 'update_maintenance_active',
        });
      });

      act(() => {
        socket.onclose?.({ code: 1000 });
      });

      // الإغلاق النظيف يمسح اللوح ولا يدخل دورة backoff — سلوك سابق لم يُمسّ.
      expect(result.clears).toBe(1);
      expect(result.isReconnecting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
