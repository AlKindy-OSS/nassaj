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

let seen: { controlFrames: ControlFrameMap; latestMessage: any } = {
  controlFrames: new Map(),
  latestMessage: null,
};

function Probe() {
  const { controlFrames, latestMessage } = useWebSocket();
  seen = { controlFrames, latestMessage };
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
  seen = { controlFrames: new Map(), latestMessage: null };
  (globalThis as any).WebSocket = FakeWebSocket;
  localStorage.setItem('auth-token', 'test-token');
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
