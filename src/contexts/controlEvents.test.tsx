/**
 * T-1293 — سجلّ **أحداث** التحكّم في WebSocketContext (شريحة ثانية لا توسعة).
 *
 * الجذر المُقاس: `CONTROL_MESSAGE_TYPES` تُطابِق على `data.type`، وحمولات
 * `NormalizedMessage` (‏`complete`, `error`, `session_created`, `permission_*`)
 * تحمل `kind` **بلا `type` إطلاقاً** — فإضافتها إلى تلك المجموعة كانت ستكون
 * لا-عملية صامتة، و`session-status` وحده يعمل لأنه الوحيد المُصدَر بـ`type`.
 *
 * ولم تصلح خريطةُ الحالات لها: `complete` **حدث** لا حالة، ومفتاحٌ بالجلسة يجمع
 * أحداث تشغيلات مختلفة في خانة واحدة — وفي خانة `''` حين تصل الحمولة بلا معرّف
 * (‏`createNormalizedMessage` يحوّل null إلى `''`).
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
  clearOutbox,
  getOutboxSnapshot,
  markOutboxPending,
  recordOutboxEntry,
  setOutboxUser,
} from '../components/chat/utils/messageOutbox';
import { readSessionWorkspaceGeneration } from '../utils/sessionWorkspaceBinding';

import {
  appendControlEvent,
  MAX_CONTROL_EVENTS,
  useWebSocket,
  WebSocketProvider,
  type ControlEventLog,
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

function deliver(socket: FakeWebSocket, payload: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(payload) });
}

/* ------------------------------------------------------------------ */

let seen: {
  controlEvents: ControlEventLog;
  controlFrames: ControlFrameMap;
  latestMessage: any;
} = {
  controlEvents: { events: [], droppedBeforeSeq: 0 },
  controlFrames: new Map(),
  latestMessage: null,
};

function Probe() {
  const { controlEvents, controlFrames, latestMessage } = useWebSocket();
  seen = { controlEvents, controlFrames, latestMessage };
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

afterEach(() => {
  cleanup();
  clearOutbox();
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  sessionStorage.clear();
  seen = {
    controlEvents: { events: [], droppedBeforeSeq: 0 },
    controlFrames: new Map(),
    latestMessage: null,
  };
  (globalThis as any).WebSocket = FakeWebSocket;
  localStorage.setItem('auth-token', 'test-token');
  setOutboxUser('ws-ingress-test');
});

describe('session workspace binding ingress', () => {
  it('preserves workspaceGeneration under newSessionId when the provider emits it', () => {
    const socket = mountProvider();
    act(() => {
      deliver(socket, {
        kind: 'session_created',
        sessionId: 'parent-session',
        newSessionId: 'session-bound',
        workspaceGeneration: 'generation-bound',
      });
    });

    assert.equal(readSessionWorkspaceGeneration('session-bound'), 'generation-bound');
    assert.equal(readSessionWorkspaceGeneration('parent-session'), null);
  });

  it('falls back to sessionId for the server session_created shape without newSessionId', () => {
    const socket = mountProvider();
    act(() => {
      deliver(socket, {
        kind: 'session_created',
        sessionId: 'session-fallback',
        workspaceGeneration: 'generation-fallback',
      });
    });

    assert.equal(readSessionWorkspaceGeneration('session-fallback'), 'generation-fallback');
  });
});

describe('appendControlEvent — الدالّة الصرفة', () => {
  it('ملحَق لا خريطة: حدثان لنفس الجلسة يتعايشان', () => {
    let log: ControlEventLog = { events: [], droppedBeforeSeq: 0 };
    log = appendControlEvent(log, { kind: 'complete', sessionId: 'A' }, 1);
    log = appendControlEvent(log, { kind: 'complete', sessionId: 'A' }, 2);

    assert.equal(log.events.length, 2, 'الثاني ابتلع الأول — هذا سلوك خريطة لا سجلّ');
    assert.deepEqual(log.events.map((e) => e.seq), [1, 2]);
  });

  it('حدثان بلا معرّف جلسة لا يتكدّسان في خانة واحدة', () => {
    let log: ControlEventLog = { events: [], droppedBeforeSeq: 0 };
    log = appendControlEvent(log, { kind: 'error', sessionId: '', error: 'أول' }, 1);
    log = appendControlEvent(log, { kind: 'error', sessionId: '', error: 'ثانٍ' }, 2);

    assert.equal(log.events.length, 2);
    assert.equal(log.events[0].frame.error, 'أول');
  });

  it('تحت السقف: لا فقد ولا ادّعاء فقد', () => {
    let log: ControlEventLog = { events: [], droppedBeforeSeq: 0 };
    for (let i = 1; i <= MAX_CONTROL_EVENTS; i++) {
      log = appendControlEvent(log, { kind: 'complete', seq: i }, i);
    }
    assert.equal(log.events.length, MAX_CONTROL_EVENTS);
    assert.equal(log.droppedBeforeSeq, 0);
  });

  it('تجاوز السقف يُقلّم الأقدم ويرفع droppedBeforeSeq (فقدٌ مُعلَن)', () => {
    let log: ControlEventLog = { events: [], droppedBeforeSeq: 0 };
    for (let i = 1; i <= MAX_CONTROL_EVENTS + 3; i++) {
      log = appendControlEvent(log, { kind: 'complete', seq: i }, i);
    }

    assert.equal(log.events.length, MAX_CONTROL_EVENTS);
    assert.equal(log.droppedBeforeSeq, 3, 'الفقد مرّ صامتاً — المستهلك لا يمكنه اكتشافه');
    assert.equal(log.events[0].seq, 4, 'المُقلَّم ليس الأقدم');
    assert.equal(log.events.at(-1)!.seq, MAX_CONTROL_EVENTS + 3);
  });

  it('droppedBeforeSeq لا يتراجع أبداً', () => {
    const log: ControlEventLog = { events: [], droppedBeforeSeq: 99 };
    const next = appendControlEvent(log, { kind: 'complete' }, 100);
    assert.equal(next.droppedBeforeSeq, 99);
  });
});

describe('المزوّد الحقيقي — أحداث في دفعة render واحدة', () => {
  it('يحسم complete قبل أن تستبدله حمولة تالية في latestMessage (B-721)', () => {
    recordOutboxEntry({
      id: 'cmid-b721', projectId: 'p1', sessionId: 'A', text: 'رسالة المالك',
    });
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'complete', sessionId: 'A', clientMsgId: 'cmid-b721' });
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'tail' });
    });

    assert.equal(seen.latestMessage?.kind, 'stream_delta', 'الاختبار لم يُنشئ overwrite فعلياً');
    assert.equal(getOutboxSnapshot().length, 1, 'يجب حفظ النسخة حتى ظهورها في السجل');
    assert.equal(getOutboxSnapshot()[0].status, 'delivered', 'ضاعت شهادة complete داخل دفعة React');
    assert.equal(getOutboxSnapshot()[0].id, 'cmid-b721');
    assert.equal(getOutboxSnapshot()[0].text, 'رسالة المالك');
  });

  it('التقليم بعد complete يحفظ حكم التسليم والنسخة المحلية حتى ظهور السجل', () => {
    recordOutboxEntry({
      id: 'cmid-trim', projectId: 'p1', sessionId: 'A', text: 'رسالة طويلة التشغيل',
    });
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'complete', sessionId: 'A', clientMsgId: 'cmid-trim' });
      for (let i = 0; i < MAX_CONTROL_EVENTS + 2; i++) {
        deliver(socket, { kind: 'permission_request', sessionId: 'A', requestId: `trim-${i}` });
      }
    });

    assert.ok(seen.controlEvents.droppedBeforeSeq > 0, 'الاختبار لم يتجاوز سقف السجل');
    assert.equal(getOutboxSnapshot().length, 1, 'التقليم لا يحذف النسخة المحلية قبل ظهور السجل');
    assert.equal(getOutboxSnapshot()[0].status, 'delivered', 'تقليم complete أبقى الإدخال pending');
    assert.equal(getOutboxSnapshot()[0].id, 'cmid-trim');
    assert.equal(getOutboxSnapshot()[0].text, 'رسالة طويلة التشغيل');
  });

  it('session_busy يبقى recoverable ولا يعاد استهلاكه عند remount', () => {
    recordOutboxEntry({
      id: 'cmid-busy', projectId: 'p1', sessionId: 'A', text: 'لا تفقدني',
    });
    const first = mountProvider();

    act(() => {
      deliver(first, {
        kind: 'error', sessionId: 'A', clientMsgId: 'cmid-busy', code: 'session_busy',
      });
    });
    assert.equal(getOutboxSnapshot()[0]?.status, 'failed');

    // Simulate an accepted retry before a route subtree remount. No old event
    // is replayed because verdict application belongs to socket ingress, not UI.
    markOutboxPending('cmid-busy');
    cleanup();
    mountProvider();
    assert.equal(getOutboxSnapshot()[0]?.status, 'pending', 'remount أعاد session_busy القديم');
  });

  it('حدثان في نفس الدفعة ⇒ كلاهما محفوظ (الجذر المقيس)', () => {
    const socket = mountProvider();

    act(() => {
      // نهاية جولة ثم خطأ جولة تالية في نفس المللي‑ثانية: فتحة `latestMessage`
      // تحتفظ بالأخير وحده، فكانت نهاية التشغيل الأولى تضيع كلياً.
      deliver(socket, { kind: 'complete', sessionId: 'A' });
      deliver(socket, { kind: 'error', sessionId: 'A', error: 'boom' });
    });

    assert.equal(seen.controlEvents.events.length, 2, 'دفعة render واحدة ابتلعت حدثاً');
    assert.deepEqual(seen.controlEvents.events.map((e) => e.frame.kind), ['complete', 'error']);
  });

  it("حدث بـsessionId='' لا يُسقَط (جلسة فشلت قبل التقاط معرّفها)", () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'error', sessionId: '', error: 'spawn failed' });
    });

    assert.equal(
      seen.controlEvents.events.length,
      1,
      'أُسقط نبأ الفشل كلّه لأن الحمولة بلا معرّف جلسة',
    );
  });

  it('تفرّع لا تحويل: الحدث يصل latestMessage أيضاً (مستهلكوه الآخرون)', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'complete', sessionId: 'A' });
    });

    assert.equal(
      seen.latestMessage?.kind,
      'complete',
      'تحويلُ الحمولة يُطفئ AppContent (حالة الجلسة، تحديث الورشات، «انتهت ولم تُفتح»)',
    );
    assert.equal(seen.controlEvents.events.length, 1);
  });

  it('عدّاد واحد للشريحتين: session-status وcomplete مرتّبان بـseq', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { type: 'session-status', sessionId: 'A', isProcessing: true });
      deliver(socket, { kind: 'complete', sessionId: 'A' });
    });

    const frameSeq = seen.controlFrames.get('A')!.seq;
    const eventSeq = seen.controlEvents.events[0].seq;
    assert.ok(
      frameSeq < eventSeq,
      `الترتيب بين الشريحتين غير قابل للاستنتاج: حالة=${frameSeq} حدث=${eventSeq}`,
    );
  });

  it('حدثٌ لا يلوّث خريطة الحالات ولا العكس', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'complete', sessionId: 'A' });
    });

    assert.equal(seen.controlFrames.size, 0, 'حدثٌ كُتب في خريطة الحالات');
  });

  it('البثّ الحيّ يبقى على مساره ولا يدخل السجلّ', () => {
    const socket = mountProvider();

    act(() => {
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'مرحبا' });
      deliver(socket, { kind: 'tool_use', sessionId: 'A', toolName: 'Bash' });
    });

    assert.equal(seen.controlEvents.events.length, 0);
    assert.equal(seen.latestMessage?.kind, 'tool_use');
  });

  it('تجاوز السقف على المزوّد نفسه يُعلن الفقد', () => {
    const socket = mountProvider();

    act(() => {
      for (let i = 0; i < MAX_CONTROL_EVENTS + 2; i++) {
        deliver(socket, { kind: 'permission_request', sessionId: 'A', requestId: `r${i}` });
      }
    });

    assert.equal(seen.controlEvents.events.length, MAX_CONTROL_EVENTS);
    assert.ok(seen.controlEvents.droppedBeforeSeq > 0, 'الفقد صامت على مسار المزوّد');
  });
});
