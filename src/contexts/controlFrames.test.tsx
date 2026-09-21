/**
 * B-208 — الشريحة التراكمية لإطارات التحكّم في WebSocketContext.
 *
 * الجذر المُقاس: `latestMessage` فتحة تخزين **قيمة واحدة**، ومستهلكها
 * (`useChatRealtimeHandlers`) يقارن بالمرجع؛ فأي إطار يُستبدَل قبل تشغيل
 * الـeffect لا يُعالَج أبداً. ترتيب الخادم بعد إعادة الاتصال هو إعادة البثّ ثم
 * mirror ثم `session-status` **أخيراً**، فالبثّ الحيّ يصل في نفس المللي‑ثانية
 * بعد الإطار ويبتلعه ⇒ `isLoading` لا يُرفع ⇒ بطاقة العمليات الجارية لا تظهر
 * حتى يضغط المستخدم زر التحديث.
 *
 * الاختبارات هنا تُشغّل **المزوّد الحقيقي** بمقبس مزيّف وتسلّم عدّة إطارات
 * داخل دفعة render واحدة (`act` واحد)، وهي بالضبط الظرف الذي كان يبتلع الإطار.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

import {
  applyControlFrame,
  MAX_CONTROL_FRAMES,
  useWebSocket,
  WebSocketProvider,
  type ControlFrameMap,
} from './WebSocketContext';
import {
  applyStreamFrame,
  MAX_STREAM_FRAMES,
  pruneProcessedStreamSeqs,
  type StreamFrameMap,
} from './streamFrameLog';

/* ------------------------------------------------------------------ */
/*  مقبس مزيّف                                                          */
/* ------------------------------------------------------------------ */

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readyState = FakeWebSocket.OPEN;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

/** يسلّم إطاراً خاماً كما يصل من الشبكة. */
function deliver(socket: FakeWebSocket, payload: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(payload) });
}

/* ------------------------------------------------------------------ */

let seen: { controlFrames: ControlFrameMap; streamFrames: StreamFrameMap; latestMessage: any; reconnectEpoch?: number } = {
  controlFrames: new Map(),
  streamFrames: new Map(),
  latestMessage: null,
};

function Probe() {
  const { controlFrames, streamFrames, latestMessage, reconnectEpoch } = useWebSocket();
  seen = { controlFrames, streamFrames, latestMessage, reconnectEpoch };
  return null;
}

function mountProvider(): FakeWebSocket {
  render(
    <WebSocketProvider>
      <Probe />
    </WebSocketProvider>,
  );
  const socket = FakeWebSocket.instances.at(-1)!;
  act(() => { socket.onopen?.(); });
  return socket;
}

// `globals: false` ⇒ لا تنظيف تلقائي: بدونه يبقى مزوّد الحالة السابقة مركَّباً
// ويكتب في `seen` فتتلوّث التوكيدات.
afterEach(cleanup);

beforeEach(() => {
  FakeWebSocket.instances = [];
  seen = { controlFrames: new Map(), streamFrames: new Map(), latestMessage: null };
  (globalThis as any).WebSocket = FakeWebSocket;
  localStorage.setItem('auth-token', 'test-token');
});

describe('applyStreamFrame — بثّ لا يفقده batching', () => {
  it('يجمع الأجزاء ثم يحفظ النص عند stream_end', () => {
    let map: StreamFrameMap = new Map();
    map = applyStreamFrame(map, { kind: 'stream_delta', sessionId: 'A', content: 'مرح' }, 1);
    map = applyStreamFrame(map, { kind: 'stream_delta', sessionId: 'A', content: 'باً' }, 2);
    map = applyStreamFrame(map, { kind: 'stream_end', sessionId: 'A' }, 3);
    assert.deepEqual(map.get('A'), {
      seq: 3,
      text: 'مرحباً',
      ended: true,
      frame: { kind: 'stream_end', sessionId: 'A' },
    });
  });

  it('أول جزء بعد نهاية يبدأ جولة جديدة ويُقلّم أقدم الجلسات', () => {
    let map: StreamFrameMap = new Map();
    map = applyStreamFrame(map, { kind: 'stream_delta', sessionId: 'A', content: 'قديم' }, 1);
    map = applyStreamFrame(map, { kind: 'stream_end', sessionId: 'A' }, 2);
    map = applyStreamFrame(map, { kind: 'stream_delta', sessionId: 'A', content: 'جديد' }, 3);
    assert.equal(map.get('A')!.text, 'جديد');
    for (let i = 1; i <= MAX_STREAM_FRAMES + 2; i += 1) {
      map = applyStreamFrame(map, { kind: 'stream_delta', sessionId: `s${i}`, content: 'x' }, i + 3);
    }
    assert.equal(map.size, MAX_STREAM_FRAMES);
    assert.equal(map.has('A'), false);
  });

  it('يحفظ نصّ المساعد النهائي ولا يلتقط نصّ المستخدم', () => {
    let map: StreamFrameMap = new Map();
    map = applyStreamFrame(map, {
      id: 'assistant-a', kind: 'text', role: 'assistant', sessionId: 'A', content: 'جواب Codex',
    }, 1);
    map = applyStreamFrame(map, {
      id: 'user-a', kind: 'text', role: 'user', sessionId: 'A', content: 'السؤال',
    }, 2);
    assert.equal(map.get('A')!.text, 'جواب Codex');
    assert.equal(map.get('A')!.frame.id, 'assistant-a');
  });

  it('يقلّم سجلّ الاستهلاك إلى مفاتيح لقطة البث الحالية', () => {
    const processed = new Map([
      ['stale-a', 1],
      ['current-a', 7],
      ['stale-b', 9],
      ['current-b', 11],
    ]);
    const current: StreamFrameMap = new Map([
      ['current-a', { seq: 7, text: 'a', ended: false, frame: {} }],
      ['current-b', { seq: 11, text: 'b', ended: false, frame: {} }],
    ]);

    pruneProcessedStreamSeqs(processed, current);

    assert.deepEqual([...processed.entries()], [['current-a', 7], ['current-b', 11]]);
  });
});

describe('applyControlFrame — الدالّة الصرفة', () => {
  it('تراكمية: جلستان مختلفتان تتعايشان', () => {
    let map: ControlFrameMap = new Map();
    map = applyControlFrame(map, 'A', { type: 'session-status', sessionId: 'A' }, 1);
    map = applyControlFrame(map, 'B', { type: 'session-status', sessionId: 'B' }, 2);
    assert.equal(map.size, 2);
    assert.equal(map.get('A')!.seq, 1);
    assert.equal(map.get('B')!.seq, 2);
  });

  it('نفس الجلسة: أحدث حالة تفوز (الإطار حالة لا حدث تراكمي)', () => {
    let map: ControlFrameMap = new Map();
    map = applyControlFrame(map, 'A', { isProcessing: true }, 1);
    map = applyControlFrame(map, 'A', { isProcessing: false }, 2);
    assert.equal(map.size, 1);
    assert.equal(map.get('A')!.seq, 2);
    assert.equal(map.get('A')!.frame.isProcessing, false);
  });

  it('لا تُطفر الخريطة بلا حدّ: التقليم يُسقط الأقدم تسلسلاً', () => {
    let map: ControlFrameMap = new Map();
    for (let i = 1; i <= MAX_CONTROL_FRAMES + 5; i++) {
      map = applyControlFrame(map, `s${i}`, { seq: i }, i);
    }
    assert.equal(map.size, MAX_CONTROL_FRAMES);
    assert.equal(map.has('s1'), false, 'الأقدم لم يُقلَّم');
    assert.equal(map.has(`s${MAX_CONTROL_FRAMES + 5}`), true, 'الأحدث سقط');
  });
});

describe('المزوّد الحقيقي — إطارات في دفعة render واحدة', () => {
  it('أجزاء الرد ونهايته في دفعة واحدة تبقى نصاً كاملاً', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'رد ' });
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'مباشر' });
      deliver(socket, { kind: 'stream_end', sessionId: 'A' });
    });

    assert.equal(seen.latestMessage.kind, 'stream_end', 'الفتحة الأحادية لم تعد تمثّل النص');
    assert.equal(seen.streamFrames.get('A')!.text, 'رد مباشر');
    assert.equal(seen.streamFrames.get('A')!.ended, true);
  });

  it('نصّ Codex النهائي ثم complete في دفعة واحدة لا يضيع النص', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, {
        id: 'codex-final', kind: 'text', role: 'assistant', sessionId: 'A', content: 'الرد النهائي',
      });
      deliver(socket, { kind: 'complete', sessionId: 'A' });
    });

    assert.equal(seen.latestMessage.kind, 'complete');
    assert.equal(seen.streamFrames.get('A')!.text, 'الرد النهائي');
    assert.equal(seen.streamFrames.get('A')!.frame.id, 'codex-final');
  });

  it('إطارا تحكّم لجلستين في دفعة واحدة ⇒ كلاهما مُطبَّق', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { type: 'session-status', sessionId: 'A', isProcessing: true });
      deliver(socket, { type: 'session-status', sessionId: 'B', isProcessing: true });
    });

    assert.equal(seen.controlFrames.size, 2, 'دفعة render واحدة ابتلعت إطاراً');
    assert.equal(seen.controlFrames.get('A')!.frame.isProcessing, true);
    assert.equal(seen.controlFrames.get('B')!.frame.isProcessing, true);
  });

  it('الجذر المقيس: بثّ حيّ يلي session-status في نفس الدفعة لا يبتلعه', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { type: 'session-status', sessionId: 'A', isProcessing: true });
      // ترتيب الخادم الفعلي: إعادة البثّ/mirror تصل بعد الإطار مباشرةً.
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'مرحبا' });
      deliver(socket, { kind: 'tool_use', sessionId: 'A', toolName: 'Bash' });
    });

    assert.ok(seen.controlFrames.get('A'), 'إطار التحكّم ابتُلع بالبثّ الحيّ');
    assert.equal(seen.controlFrames.get('A')!.frame.isProcessing, true);
    // البثّ الحيّ يبقى على مساره القديم بلا تغيير.
    assert.equal(seen.latestMessage?.kind, 'tool_use');
  });

  it('التسلسل رتيب عبر الإطارات فيعرف المستهلك ما لم يُعالَج بعد', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { type: 'session-status', sessionId: 'A', isProcessing: true });
    });
    const first = seen.controlFrames.get('A')!.seq;

    act(() => {
      deliver(socket, { type: 'session-status', sessionId: 'A', isProcessing: false });
    });
    const second = seen.controlFrames.get('A')!.seq;

    assert.ok(second > first, 'التسلسل لم يتقدّم — المستهلك سيتخطّى الإطار الجديد');
    assert.equal(seen.controlFrames.get('A')!.frame.isProcessing, false);
  });

  it('إطار تحكّم بلا sessionId يُهمَل ولا يلوّث الشريحة ولا latestMessage', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { type: 'session-status', isProcessing: true });
    });

    assert.equal(seen.controlFrames.size, 0);
    assert.equal(seen.latestMessage, null);
  });
});

describe('reconnect recovery signal', () => {
  it('survives an immediate presence frame in the same React batch', () => {
    vi.useFakeTimers();
    try {
      const socket = mountProvider();
      assert.equal(seen.reconnectEpoch ?? 0, 0);
      act(() => { socket.onclose?.({ code: 1006, reason: '', wasClean: false }); });
      act(() => { vi.advanceTimersByTime(30_000); });
      const reconnected = FakeWebSocket.instances.at(-1)!;
      assert.notEqual(reconnected, socket);
      act(() => {
        reconnected.onopen?.();
        deliver(reconnected, { type: 'presence', runningSessions: [] });
      });
      assert.equal(seen.latestMessage.type, 'presence');
      assert.equal(seen.reconnectEpoch, 1);
    } finally { vi.useRealTimers(); }
  });
});
