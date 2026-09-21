/**
 * shellErrorFrameParity.test.tsx
 *
 * حارس تكافؤ بين منطقَين مكرَّرَين انحرف أحدهما فعلاً:
 *   • `shell/hooks/useShellConnection` (سوكت /shell)
 *   • `terminals/hooks/useTerminalConnection` (سوكت /terminal)
 *
 * كلاهما يستقبل إطار `{type:'error'}` من الخادم. المرآة الثانية كانت تعرضه حالةً
 * (بلا `code` وبلا كتابة في اللوح)، والأولى تبتلعه كلياً — وهذا بالضبط ما أنتج
 * «الطرفية السوداء الصامتة». الفحص يمرّر السيناريو **الكامل** على الاثنين:
 * إطار خطأ ثم **إغلاق حقيقي** بالرمز 4403 (وهو ما يفعله الخادم في خمسة من
 * إطاراته الستة)، ويطالب كلاً منهما بثلاثة:
 *   (١) أن يصل نصّ الخطأ إلى المستخدم بسطح ما (كتابةً في اللوح أو حالةً معروضة)،
 *   (٢) ألّا يُعاد فتح السوكت بعد رفضٍ نهائي (فإعادة الفتح تمسح السبب وتُعيد
 *       المستخدم إلى السواد)،
 *   (٣) ألّا يُعامَل الإطار خروجَ عملية.
 *
 * الحارس مقصود أن يفشل إذا أُصلح أحد الموضعين دون مرآته مستقبلاً.
 *
 * Run: npx vitest run src/components/shell/hooks/shellErrorFrameParity.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useRef } from 'react';
import type { MutableRefObject } from 'react';

// ─── مزيّفات xterm: المرآة الثانية تنشئ طرفية حقيقية عند التركيب ───────────

const terminalWrites: string[] = [];

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    write(data: string) {
      terminalWrites.push(data);
    }
    clear() {}
    focus() {}
    dispose() {}
    open() {}
    loadAddon() {}
    getSelection() {
      return '';
    }
    hasSelection() {
      return false;
    }
    attachCustomKeyEventHandler() {}
    registerCharacterJoiner() {
      return 1;
    }
    deregisterCharacterJoiner() {}
    onRender() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

import type { ShellErrorInfo } from '../types/types';
import { useTerminalConnection } from '../../terminals/hooks/useTerminalConnection';

import { useShellConnection } from './useShellConnection';

// ─── WebSocket مزيّف مشترك بين المسارين ────────────────────────────────────

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

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const ERROR_FRAME = {
  type: 'error',
  message: 'Update maintenance is active',
  code: 'update_maintenance_active',
} as const;

const plainText = (chunks: string[]) => chunks.join('').replace(/\x1b\[[0-9;]*m/g, '');

/** رمز إغلاق نهائي يرسله الخادم بعد إطار الخطأ (رفض صلاحية). */
const FINAL_CLOSE_CODE = 4403;
/** أوسع من أي backoff أوّلي: لو كان هناك إعادة اتصال مجدولة لانطلقت خلاله. */
const BEYOND_FIRST_BACKOFF_MS = 30_000;

/** ما يراه المستخدم فعلاً من كل مسار، مصاغاً بمفردات واحدة للطرفين. */
type Surfaced = {
  /** نصّ الخطأ كما بلغ المستخدم (لوحاً أو حالةً). */
  userVisibleText: string;
  /** هل عُومل الإطار خروجَ عملية؟ */
  reportedProcessExit: boolean;
  /** سوكتات فُتحت بعد الإغلاق النهائي: أيّ زيادة = دورة رفض متكرّرة. */
  socketsAfterFinalClose: number;
};

// ─── المسار الأول: /shell ──────────────────────────────────────────────────

function ShellHarness({
  writes,
  errors,
  exits,
}: {
  writes: string[];
  errors: (ShellErrorInfo | null)[];
  exits: number[];
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef({
    write: (data: string) => {
      writes.push(data);
    },
  }) as unknown as MutableRefObject<never>;
  const fitAddonRef = useRef({ fit: () => {} }) as unknown as MutableRefObject<never>;
  const selectedProjectRef = useRef({ name: 'p', path: '/p', fullPath: '/p' }) as never;
  const selectedSessionRef = useRef(null) as never;
  const initialCommandRef = useRef<string | null>('claude /login');
  const isPlainShellRef = useRef(true);
  const onProcessCompleteRef = useRef((code: number) => {
    exits.push(code);
  });
  const onShellErrorRef = useRef((error: ShellErrorInfo | null) => {
    errors.push(error);
  });

  useShellConnection({
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
    clearTerminalScreen: () => {},
    setAuthUrl: () => {},
  });

  return null;
}

/** آخر ما كُتب فعلاً في اللوح من مسار /shell — بخامه، بلا تنظيف الاختبار. */
let lastShellWrites: string[] = [];

function runShellPath(frame: unknown = ERROR_FRAME): Surfaced {
  const writes: string[] = [];
  const errors: (ShellErrorInfo | null)[] = [];
  const exits: number[] = [];
  lastShellWrites = writes;
  render(<ShellHarness writes={writes} errors={errors} exits={exits} />);
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error('the shell hook never opened a socket');
  }
  act(() => {
    socket.emit(frame);
  });
  const socketsBefore = FakeWebSocket.instances.length;
  act(() => {
    socket.onclose?.({ code: FINAL_CLOSE_CODE });
  });
  act(() => {
    vi.advanceTimersByTime(BEYOND_FIRST_BACKOFF_MS);
  });

  return {
    // كلا السطحين مقبول؛ المطلوب ألّا يكون الإطار مبتلعاً.
    userVisibleText: `${plainText(writes)} ${errors
      .filter((entry): entry is ShellErrorInfo => entry !== null)
      .map((entry) => entry.message)
      .join(' ')}`,
    reportedProcessExit: exits.length > 0,
    socketsAfterFinalClose: FakeWebSocket.instances.length - socketsBefore,
  };
}

// ─── المسار الثاني: /terminal (المرآة) ─────────────────────────────────────

function TerminalHarness({ sink }: { sink: { errorMessage: string | null; state: string } }) {
  const { terminalContainerRef, state, errorMessage, exitInfo } = useTerminalConnection({
    terminalId: 't-1',
    initialStatus: 'running',
    isActive: true,
    onRequestListRefresh: () => {},
  });
  sink.errorMessage = errorMessage;
  sink.state = exitInfo ? 'exited' : state;
  return <div ref={terminalContainerRef} />;
}

function runTerminalPath(): Surfaced {
  const sink = { errorMessage: null as string | null, state: '' };
  render(<TerminalHarness sink={sink} />);
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error('the terminal hook never opened a socket');
  }
  act(() => {
    socket.emit(ERROR_FRAME);
  });
  const socketsBefore = FakeWebSocket.instances.length;
  act(() => {
    socket.onclose?.({ code: FINAL_CLOSE_CODE });
  });
  act(() => {
    vi.advanceTimersByTime(BEYOND_FIRST_BACKOFF_MS);
  });

  return {
    userVisibleText: `${plainText(terminalWrites)} ${sink.errorMessage ?? ''}`,
    reportedProcessExit: sink.state === 'exited',
    socketsAfterFinalClose: FakeWebSocket.instances.length - socketsBefore,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  terminalWrites.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.localStorage.setItem('auth-token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('تكافؤ إطار الخطأ بين مسار /shell ومرآته /terminal', () => {
  it('كلا المسارين يُظهر نصّ الخطأ للمستخدم ولا يبتلعه', () => {
    const shell = runShellPath();
    cleanup();
    const terminal = runTerminalPath();

    for (const [label, surfaced] of [
      ['shell', shell],
      ['terminal', terminal],
    ] as const) {
      expect(surfaced.userVisibleText, `المسار ${label} ابتلع إطار الخطأ`).toContain(
        ERROR_FRAME.message,
      );
    }
  });

  it('لا مسار منهما يعيد فتح السوكت بعد إغلاق نهائي تلاه إطار خطأ', () => {
    const shell = runShellPath();
    cleanup();
    const terminal = runTerminalPath();

    expect(shell.socketsAfterFinalClose).toBe(0);
    expect(terminal.socketsAfterFinalClose).toBe(0);
  });

  it('لا مسار منهما يعدّ إطار الخطأ خروجَ عملية', () => {
    const shell = runShellPath();
    cleanup();
    const terminal = runTerminalPath();

    expect(shell.reportedProcessExit).toBe(false);
    expect(terminal.reportedProcessExit).toBe(false);
  });
});

/**
 * B-1253 م-3: مسار /shell كان يكتب `message` و`code` القادمَين من الخادم في
 * xterm مباشرةً. اليوم كل رسائل الخادم الستّ ثوابت، فلا تسرّب فعلي — لكن أول
 * قيمة مُقحَمة تصير حقن OSC/CSI في اللوح. الدالة الآن واحدة في
 * `shared/terminalText.ts` يستوردها الطرفان (الخادم يعيد تصديرها)، وهذه
 * الفحوص تثبّت أن ما يصل اللوح خاملٌ نصّاً.
 */
describe('تعقيم ما يُكتب في اللوح من إطار خطأ معادٍ', () => {
  const ESC = '';
  const BEL = '';
  const CSI_C1 = '';

  /** كل ما كُتب في اللوح، بخامه (بما فيه ألوان الكود نفسه). */
  const rawWrites = () => lastShellWrites.join('');

  it('CRUX: لا تبقى في اللوح إلا محارف اللون التي كتبها الكود نفسه', () => {
    runShellPath({
      type: 'error',
      // OSC 0 (تغيير العنوان)، OSC 52 (كتابة الحافظة)، CSI 2J (مسح اللوح)،
      // ثم مقدّمة C1 مفردة و DEL — الصياغات التي يسقط عندها الفحص النمطي.
      message: `${ESC}]0;pwned${BEL}${ESC}]52;c;cGF3bmVk${BEL}${ESC}[2Jgone${CSI_C1}31mred`,
      code: `${ESC}]0;code${BEL}bad_code`,
    });

    const written = rawWrites();
    // المتبقّي من الإدخال المعادي: نصّ خامل فحسب.
    expect(written).toContain(']0;pwned]52;c;cGF3bmVk[2Jgone31mred');
    expect(written).toContain('[]0;codebad_code]');
    // ولا أثر لأي بايت تحكّم من الإدخال…
    expect(written).not.toContain(BEL);
    expect(written).not.toContain(CSI_C1);
    expect(written).not.toContain('');
    // …والهروبان الوحيدان الباقيان هما اللذان كتبهما السطر نفسه.
    expect(written.match(new RegExp(ESC, 'g'))?.length).toBe(2);
    expect(written.startsWith(`\r\n${ESC}[1;33m`)).toBe(true);
    expect(written.endsWith(`${ESC}[0m\r\n`)).toBe(true);
  });

  it('النصّ العربي والمسافات البيضاء المشروعة تنجو كما هي', () => {
    const arabic = 'تعذّر فتح الطرفية: راجع الإعداد';
    runShellPath({
      type: 'error',
      message: `${arabic}\tمع\r\nسطر ثانٍ${ESC}[31m`,
      code: 'shell_error_unclassified',
    });

    const written = rawWrites();
    expect(written).toContain(arabic);
    // التبويب والسطر الجديد جزء من انضباط اللوح نفسه، لا يُحذفان.
    expect(written).toContain('\tمع\r\nسطر ثانٍ');
    expect(written).toContain('[shell_error_unclassified]');
    expect(written).toContain('[31m');
  });

  it('الخادم والعميل ينظّفان بالدالة نفسها، لا بنسختين', async () => {
    const { sanitizeTerminalText } = await import('../../../../shared/terminalText');
    const serverModule = await import(
      '../../../../server/modules/websocket/services/shell-error-frame'
    );

    // لو عاد أحدهما إلى نسخة خاصّة، انكسر هذا الفحص فوراً.
    expect(serverModule.sanitizeTerminalText).toBe(sanitizeTerminalText);
    for (const hostile of [
      `${ESC}]0;t${BEL}`,
      `${CSI_C1}2J`,
      ' ',
      'نصّ عربي سليم',
      'keeps\ttabs\r\nand newlines',
    ]) {
      expect(serverModule.sanitizeTerminalText(hostile)).toBe(sanitizeTerminalText(hostile));
    }
  });
});
