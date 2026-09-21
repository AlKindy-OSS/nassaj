import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import {
  beginSessionProcessConnectionEpoch,
  invalidateSessionProcessAuthority,
  reconcilePresenceProcessStates,
  resetSessionProcessStates,
  setSessionProcessState,
  type SessionProcessState,
} from '../stores/sessionProcessStateStore';
import { applyOutcomeDelta, type OutcomeState } from '../stores/sessionCompletionStore';
import { consumeOutboxIngressVerdict } from '../components/chat/utils/messageOutbox';
import { rememberSessionWorkspaceGeneration } from '../utils/sessionWorkspaceBinding';

import { applyStreamFrame, type StreamFrameMap } from './streamFrameLog';

export type WsConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export type SendMessageResult = { ok: true } | { ok: false; reason: string };

/**
 * إطار تحكّم مُخزَّن في الشريحة التراكمية: الحمولة الخام + رقم تسلسلي رتيب
 * على مستوى الاتصال، ليتمكّن المستهلك من معرفة ما لم يُعالج بعد بلا مقارنة
 * مرجعية (التي كانت سبب الفقد أصلاً).
 */
export type ControlFrame = { seq: number; frame: any };

/** خريطة إطارات التحكّم الحيّة: مفتاحها `sessionId`. */
export type ControlFrameMap = ReadonlyMap<string, ControlFrame>;

/** حدث تحكّم في السجلّ الملحَق: الحمولة الخام ورقمها التسلسلي. */
export type ControlEvent = { seq: number; frame: any };

/**
 * سجلّ أحداث التحكّم: **ملحَق (append-only) مرتّب بـ`seq`، بلا مفتاح**.
 *
 * `droppedBeforeSeq` = أعلى `seq` أُسقط بالتقليم (0 حين لم يُسقط شيء). وجودُه هو
 * ما يجعل الفقد **غير صامت**: مستهلكٌ عولج عنده حتى `n` يعرف أنه فقد أحداثاً متى
 * كان `n < droppedBeforeSeq`، فيتعافى بلقطة حتمية بدل أن يمضي على حالة ناقصة.
 */
export type ControlEventLog = {
  events: readonly ControlEvent[];
  droppedBeforeSeq: number;
};

/**
 * لقطة بثّ تراكمية لكل جلسة. التجميع يحدث داخل مستقبِل WebSocket نفسه، قبل
 * جدولة React، لذلك لا تبتلع دفعة render واحدة أجزاء الرد أو `stream_end`.
 */
type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => SendMessageResult;
  latestMessage: any | null;
  /**
   * شريحة **تراكمية** لإطارات التحكّم لمرّة-واحدة (اليوم: `session-status`).
   *
   * لماذا شريحة مستقلة (B-208): `latestMessage` فتحة تخزين قيمة واحدة، ومستهلكها
   * يقارن بالمرجع؛ فأي إطار يُستبدَل قبل تشغيل الـeffect لا يُعالَج أبداً. ترتيب
   * الخادم بعد إعادة الاتصال هو إعادة البثّ ثم mirror ثم `session-status`
   * أخيراً — فالبثّ الحيّ يصل في نفس المللي‑ثانية **بعد** الإطار ويبتلعه.
   * إطارات التحكّم هنا تُكتب بـupdater دالّي تراكمي في Map بمفتاح الجلسة، فلا
   * تبتلع دفعةُ render واحدة إطاراً يخصّ جلسة أخرى، ولا يبتلعه إطار من نوع آخر.
   *
   * (نفس أسلوب `open_sessions_count` أدناه: شريحة خاصة بدل المرور على
   * `latestMessage`. النطاق مقصور على إطارات التحكّم — إعادة هندسة القناة كلها
   * دَين مؤجَّل بـADR.)
   */
  controlFrames: ControlFrameMap;
  /**
   * شريحة **أحداث** التحكّم (`complete`, `error`, `session_created`,
   * `permission_request`, `permission_cancelled`) — سجلّ ملحَق لا خريطة حالات.
   *
   * لماذا شريحة ثانية لا توسعة للأولى (T-1293): `controlFrames` خريطةٌ مفتاحها
   * الجلسة و«أحدث حالة تفوز» — وهو ترميز صحيح لـ`session-status` لأنه **حالة**.
   * أمّا `complete` فحدثٌ لمرّة واحدة: مفتاحٌ مبني على الجلسة يجمع أحداث تشغيلات
   * مختلفة في خانة واحدة فيبتلع أحدُها الآخر، والأسوأ أن هذه الحمولات قد تحمل
   * `sessionId: ''` (‏`createNormalizedMessage` يحوّل null إلى '') فتتكدّس كلها
   * في خانة الفراغ. السجلّ الملحَق لا يفقد شيئاً ما دام تحت السقف، وما فوقه
   * يُعلَن بـ`droppedBeforeSeq`.
   *
   * والعدّاد `seq` **واحد يخدم الشريحتين**، فترتيب حدثٍ بالنسبة لحالةٍ يبقى
   * قابلاً للاستنتاج عند المستهلك.
   */
  controlEvents: ControlEventLog;
  streamFrames: StreamFrameMap;
  /** Durable reconnect signal; unrelated incoming frames cannot overwrite it. */
  reconnectEpoch: number;
  isConnected: boolean;
  wsStatus: WsConnectionStatus;
  /**
   * Number of open sessions on the server right now (global activity counter,
   * not scoped to the current session's viewers). Updated via the
   * `open_sessions_count` WS message. `null` until the first message arrives.
   */
  openSessionsCount: number | null;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

// localStorage key holding the JWT. Kept in sync with AUTH_TOKEN_STORAGE_KEY
// (src/components/auth/constants.ts) and the writer in utils/api.js.
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

/**
 * Resolve the WS URL from the FRESHEST persisted token, exactly like
 * shell/utils/socket.ts. This is the B-131 fix: the server rotates the JWT
 * mid-session via `X-Refreshed-Token` and the client persists it to
 * localStorage, but a backoff reconnect scheduled by `onclose` does NOT re-run
 * the [token] effect — so reading React state there would keep dialing with the
 * pre-rotation token until it expired (day 7), an endless `expired` reconnect
 * loop. Reading localStorage on every (re)connect guarantees the newest token.
 *
 * Exported so the reconnect-token behaviour is unit-testable against the exact
 * code path `connect()` uses (no drift between test and production).
 */
export const resolveWebSocketUrl = (): string | null =>
  buildWebSocketUrl(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY));

/**
 * Reduce a JWT to the identity it authenticates, ignoring its lifetime.
 *
 * The socket used to be keyed on the raw token string, so EVERY rotation tore a
 * healthy connection down and dialled a new one. The server rotates proactively
 * (past half-life, `X-Refreshed-Token`), which in practice means a rotation lands
 * while the user is actively working — and the owner sees the "Reconnecting…"
 * badge flash on ordinary messages, with the stream interrupted for as long as
 * the round-trip takes. Nothing required that: `connect()` always reads the
 * FRESHEST token from localStorage, so a socket opened before a rotation is not
 * stale, and a later reconnect naturally picks the new one up.
 *
 * What MUST still force a reconnect is a change of who/what the socket is
 * authenticated as:
 *   • `sub`/`userId` — a different account (login, logout, account switch);
 *   • `pwd_iat`      — a password change, after which the server rejects the old
 *                      credential and the live socket has to be re-established.
 * `exp`/`iat` alone are deliberately excluded: that is the routine rotation.
 *
 * Falls back to the raw token when the payload cannot be read, preserving the
 * previous (reconnect-on-any-change) behaviour rather than risking a socket
 * authenticated as the wrong identity.
 */
export const identityKeyFromToken = (token: string | null | undefined): string | null => {
  if (!token) return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return token;
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const subject = claims?.sub ?? claims?.userId ?? claims?.id;
    if (subject === undefined || subject === null) return token;
    return `${String(subject)}:${String(claims?.pwd_iat ?? '')}`;
  } catch {
    return token;
  }
};

// Exponential backoff constants (milliseconds).
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_MS = 500;

/** Compute next reconnect delay with full-jitter exponential backoff. */
export function calcReconnectDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  return exp + Math.random() * RECONNECT_JITTER_MS;
}

/** WS message type for the server-wide open-sessions counter. */
const OPEN_SESSIONS_MESSAGE_TYPE = 'open_sessions_count';

/**
 * أنواع إطارات **التحكّم**: إطارات لمرّة-واحدة، غير مُعادة، تحمل `sessionId`،
 * وفقدها يترك الواجهة في حالة خاطئة صامتة. تُوجَّه إلى الشريحة التراكمية
 * `controlFrames` بدل فتحة `latestMessage` ذات القيمة الواحدة.
 *
 * التوسعة لاحقاً = إضافة نوع هنا فقط (المستهلك يفرز بالنوع).
 *
 * **فخّ مقصود التوثيق (T-1293):** المطابقة أدناه على `data.type`. وحمولات
 * `NormalizedMessage` (‏`complete`, `error`, `session_created`, `permission_*`)
 * تحمل `kind` **بلا `type` إطلاقاً**، فإضافة أيٍّ منها إلى هذه المجموعة
 * **لا-عملية صامتة**. مكانها `CONTROL_EVENT_KINDS` أدناه.
 */
export const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set(['session-status']);

/**
 * أنواع **أحداث** التحكّم، مفروزة بـ`data.kind` لا `data.type`.
 *
 * الفارق عن `CONTROL_MESSAGE_TYPES` دلالي لا شكلي: تلك **حالات** لكل جلسة
 * (أحدثها يفوز)، وهذه **أحداث** لمرّة واحدة يجب ألّا يبتلع أحدها الآخر.
 */
export const CONTROL_EVENT_KINDS: ReadonlySet<string> = new Set([
  'session_created',
  'complete',
  'error',
  'permission_request',
  'permission_cancelled',
]);

/**
 * سقف حجم خريطة إطارات التحكّم. الخريطة تحمل إدخالاً واحداً لكل جلسة شوهدت،
 * فتنمو مع طول الجلسة؛ التقليم يُسقط الأقدم تسلسلاً (الأبعد عهداً) ويُبقي
 * أحدث الحالات — وهي الوحيدة ذات المعنى.
 */
export const MAX_CONTROL_FRAMES = 64;

/**
 * تطبيق إطار تحكّم على الخريطة السابقة — دالّة صرفة ليكون السلوك قابلاً
 * للاختبار خارج React ولئلّا يتفرّع المنطق بين الإنتاج والاختبار.
 *
 * «أحدث حالة لكل جلسة تفوز» صحيح دلالياً: الإطار **حالة** لا حدثاً تراكمياً،
 * والتراكم المطلوب هو ألّا تُسقط جلسةٌ إطارَ جلسةٍ أخرى في نفس دفعة الـrender.
 */
export function applyControlFrame(
  previous: ControlFrameMap,
  sessionId: string,
  frame: any,
  seq: number,
): ControlFrameMap {
  const next = new Map(previous);
  next.set(sessionId, { seq, frame });
  if (next.size > MAX_CONTROL_FRAMES) {
    const bySeqAsc = [...next.entries()].sort((a, b) => a[1].seq - b[1].seq);
    for (const [key] of bySeqAsc.slice(0, next.size - MAX_CONTROL_FRAMES)) {
      next.delete(key);
    }
  }
  return next;
}

/** خريطة فارغة ثابتة المرجع: تمنع re-render وهمياً قبل وصول أول إطار تحكّم. */
const EMPTY_CONTROL_FRAMES: ControlFrameMap = new Map();
const EMPTY_STREAM_FRAMES: StreamFrameMap = new Map();

/**
 * سقف سجلّ الأحداث. أوسع من سقف الخريطة لأن السجلّ ينمو بعدد **الأحداث** لا
 * بعدد الجلسات: جولةٌ واحدة كثيرة الأذونات تُنتج عشرات المدخلات.
 */
export const MAX_CONTROL_EVENTS = 256;

/**
 * إلحاق حدث بالسجلّ — دالّة صرفة (قابلة للاختبار خارج React).
 *
 * التقليم يُسقط الأقدم ويرفع `droppedBeforeSeq` إلى أعلى `seq` أُسقط، فيبقى
 * الفقد معلوماً للمستهلك بدل أن يمرّ صامتاً.
 */
export function appendControlEvent(
  previous: ControlEventLog,
  frame: any,
  seq: number,
): ControlEventLog {
  const events = [...previous.events, { seq, frame }];
  if (events.length <= MAX_CONTROL_EVENTS) {
    return { events, droppedBeforeSeq: previous.droppedBeforeSeq };
  }
  const dropped = events.splice(0, events.length - MAX_CONTROL_EVENTS);
  const highestDropped = dropped[dropped.length - 1]!.seq;
  return {
    events,
    droppedBeforeSeq: Math.max(previous.droppedBeforeSeq, highestDropped),
  };
}

/** سجلّ فارغ ثابت المرجع (نفس دور `EMPTY_CONTROL_FRAMES`). */
const EMPTY_CONTROL_EVENTS: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

/** Safely narrows one presence snapshot's process list without importing UI code. */
function parsePresenceProcessStates(raw: unknown): Array<{
  sessionId: string;
  state: SessionProcessState;
}> {
  if (!Array.isArray(raw)) return [];
  const parsed: Array<{ sessionId: string; state: SessionProcessState }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) continue;
    if (entry.state !== 'running' && entry.state !== 'frozen') continue;
    parsed.push({ sessionId: entry.sessionId, state: entry.state });
  }
  return parsed;
}

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const reconnectAttemptRef = useRef(0); // Counts consecutive failures for backoff
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [controlFrames, setControlFrames] = useState<ControlFrameMap>(EMPTY_CONTROL_FRAMES);
  const [controlEvents, setControlEvents] = useState<ControlEventLog>(EMPTY_CONTROL_EVENTS);
  const [streamFrames, setStreamFrames] = useState<StreamFrameMap>(EMPTY_STREAM_FRAMES);
  // عدّاد رتيب لإطارات التحكّم عبر كل الاتصالات: المستهلك يعرف به ما لم يُعالج.
  // **واحد للشريحتين** عمداً: به وحده يبقى ترتيب حدثٍ بالنسبة لحالةٍ معلوماً.
  const controlSeqRef = useRef(0);
  const streamSeqRef = useRef(0);
  const [isConnected, setIsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [openSessionsCount, setOpenSessionsCount] = useState<number | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();
  // The effect below is keyed on the token's IDENTITY, not on the token string:
  // login/logout, an account switch or a password change reconnect, while the
  // server's routine mid-session rotation does not. The socket URL is always
  // built from the freshest localStorage value inside connect()
  // (see resolveWebSocketUrl), so a socket that outlives a rotation is not stale
  // and any later reconnect still dials with the newest token.
  const identityKey = identityKeyFromToken(token);
  // Monotonic connection epoch. Each connect() bumps it; a socket captures its
  // epoch and ignores its own onopen/onclose once a newer connection exists.
  // This is what stops a token rotation's old-socket close from spawning a
  // duplicate reconnect alongside the fresh socket.
  const connEpochRef = useRef(0);

  useEffect(() => {
    // A process-state snapshot belongs to one authenticated identity. Clear it
    // on account/password identity changes, but preserve it across ordinary
    // network reconnects where this effect does not re-run.
    resetSessionProcessStates();
    // (Re)establishing the connection for a real token change: clear the
    // unmounted flag so the cleanup of the PREVIOUS run (which set it true)
    // does not permanently block this fresh connection. A genuine React unmount
    // still leaves the flag true because no effect re-run follows it.
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [identityKey]); // reconnect on identity change only — never on a routine rotation

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    // Cancel any pending reconnect: a fresh connect (e.g. token rotation closing
    // the old socket, which schedules an onclose reconnect) must not later spawn
    // a duplicate socket. Prevents reconnect storms on rapid token changes.
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    // This attempt supersedes any previous socket.
    const myEpoch = connEpochRef.current + 1;
    connEpochRef.current = myEpoch;
    // Separate globally monotonic epoch for process-state authority. `onopen`
    // does not grant authority; only a direct per-session frame below can.
    const processStateEpoch = beginSessionProcessConnectionEpoch();
    try {
      // Build from the freshest localStorage token (see resolveWebSocketUrl):
      // survives a mid-session `X-Refreshed-Token` rotation even on backoff
      // reconnects that do not re-run the [token] effect.
      const wsUrl = resolveWebSocketUrl();

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        if (myEpoch !== connEpochRef.current) return; // superseded by a newer connect
        setIsConnected(true);
        setWsStatus('connected');
        reconnectAttemptRef.current = 0; // Reset backoff counter on successful connection
        wsRef.current = websocket;
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          setReconnectEpoch(epoch => epoch + 1);
          setLatestMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (myEpoch !== connEpochRef.current) return; // ignore stale socket
        try {
          const data = JSON.parse(event.data);
          // The open_sessions_count message is a background counter update.
          // It updates its own slice of state without touching latestMessage so
          // that hooks watching latestMessage (e.g. useSessionParticipants) do
          // not trigger unnecessary re-fetches on every counter broadcast.
          if (data && data.type === OPEN_SESSIONS_MESSAGE_TYPE) {
            if (typeof data.count === 'number') {
              setOpenSessionsCount(data.count);
            }
            return;
          }
          // B-829: `latestMessage` فتحة واحدة، لذا stream_delta ثم stream_end
          // في دفعة React واحدة كانا يختزلان إلى النهاية ويضيع النص كله حتى
          // الجلب اليدوي. اجمع النص تزامنياً هنا قبل المرور بالقناة التوافقية.
          if (
            data?.kind === 'stream_delta'
            || data?.kind === 'stream_end'
            || (data?.kind === 'text' && data?.role === 'assistant')
          ) {
            streamSeqRef.current += 1;
            const seq = streamSeqRef.current;
            setStreamFrames((previous) => applyStreamFrame(previous, data, seq));
          }
          // إطار تحكّم (session-status …): إلى الشريحة التراكمية عبر updater
          // دالّي — إطاران في نفس دفعة الـrender يُطبَّقان كلاهما بدل أن يبتلع
          // آخرُهما أولَهما. الإطار بلا `sessionId` يُهمَل (المستهلك يهمله أصلاً).
          if (data && typeof data.type === 'string' && CONTROL_MESSAGE_TYPES.has(data.type)) {
            const controlSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
            if (!controlSessionId) return;
            if (data.type === 'session-status' && typeof data.isProcessing === 'boolean') {
              setSessionProcessState(
                controlSessionId,
                data.isProcessing ? 'running' : 'idle',
                { epoch: processStateEpoch, authoritative: true },
              );
            }
            controlSeqRef.current += 1;
            const seq = controlSeqRef.current;
            setControlFrames((previous) => applyControlFrame(previous, controlSessionId, data, seq));
            return;
          }
          // حدث تحكّم (complete, error, session_created, permission_*): يُلحَق
          // بالسجلّ **ويُكمل طريقه** إلى `latestMessage` — تفرّعٌ لا تحويل.
          //
          // لا `return` هنا عمداً: ستة عشر ملفاً تقرأ `latestMessage`، ومنها
          // مستهلكون حقيقيون لهذه الأنواع بالذات (‏`AppContent` يُنزل حالة
          // الجلسة إلى `idle` ويُجدول تحديث الورشات ويضع علامة «انتهت ولم
          // تُفتح»، و`useBtwSideChannel`). تحويلُها كان سيُطفئ ذلك كلّه صامتاً.
          // ومنعُ المعالجة المزدوجة مسؤولية المستهلك وحده (حُذفت هذه الحالات
          // من مُبدِّل `latestMessage` في `useChatRealtimeHandlers`).
          //
          // ولا فلترة على `sessionId` هنا: الحمولة قد تصل بـ`''` (‏null يُحوَّل
          // إلى `''` في `createNormalizedMessage`، ومسار الخطأ في claude-sdk
          // يبعثه لجلسة جديدة فشلت قبل التقاط معرّفها) — وإسقاطُها يعني ضياع
          // نبأ الفشل كلّه.
          if (data && typeof data.kind === 'string' && CONTROL_EVENT_KINDS.has(data.kind)) {
            if (data.kind === 'session_created') {
              rememberSessionWorkspaceGeneration(
                data.newSessionId || data.sessionId,
                data.workspaceGeneration,
              );
            }
            // B-721: delivery authority is consumed synchronously, before the
            // bounded React log can batch, remount, or trim the terminal event.
            consumeOutboxIngressVerdict(data);
            controlSeqRef.current += 1;
            const seq = controlSeqRef.current;
            setControlEvents((previous) => appendControlEvent(previous, data, seq));
          }
          // Update the external process-state store synchronously in the WS
          // callback. `latestMessage` remains a compatibility channel, but a
          // following stream_delta can no longer replace state before an effect
          // sees it because no React effect is involved in this path.
          const isProcessState =
            data?.kind === 'status'
            && data?.text === 'process_state'
            && typeof data?.sessionId === 'string'
            && data.sessionId.length > 0;
          const isTerminalProcessState =
            (data?.kind === 'complete' || data?.kind === 'error')
            && typeof data?.sessionId === 'string'
            && data.sessionId.length > 0;
          if (isProcessState) {
            setSessionProcessState(data.sessionId, data.processState, {
              epoch: processStateEpoch,
              authoritative: true,
            });
          } else if (data?.type === 'presence' && Array.isArray(data?.runningSessions)) {
            reconcilePresenceProcessStates(parsePresenceProcessStates(data.runningSessions));
          } else if (isTerminalProcessState) {
            setSessionProcessState(data.sessionId, 'idle', {
              epoch: processStateEpoch,
              authoritative: true,
            });
          }
          // `session_outcome` is a shared sidebar state, not a chat-only event.
          // Applying it here keeps a following stream frame from overwriting the
          // legacy `latestMessage` slot before AppContent can observe the delta.
          // That is especially visible on mobile, where the sidebar can stay
          // open while the completed conversation itself was never opened.
          if (
            data?.type === 'session_outcome'
            && typeof data.sessionId === 'string'
            && data.sessionId.length > 0
            && (data.outcomeState === 'visible' || data.outcomeState === 'seen' || data.outcomeState === 'absent')
          ) {
            applyOutcomeDelta(
              data.sessionId,
              (data.outcome ?? null) as Parameters<typeof applyOutcomeDelta>[1],
              typeof data.outcomeAt === 'string' ? data.outcomeAt : null,
              data.outcomeState as OutcomeState,
            );
          }
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = (event) => {
        // [WS-DIAG] (point #5) Client-side close forensics. The server-side close
        // code (1006 abnormal/no-frame, 1001 going-away/reload, 1000 normal) lets us
        // correlate the browser's view with the server log. `wasClean=false` + code
        // 1006 = network/proxy/keepalive drop (the active-stream freeze case);
        // 1001 = reload/navigation. A reconnect is scheduled below in either case,
        // but the active session's stream is only re-bound if a component re-issues
        // check-session-status AND the run is idle (active runs are vetoed server-side).
        // eslint-disable-next-line no-console
        console.log(
          `[WS-DIAG] client-onclose code=${event.code} `
          + `reason=${JSON.stringify(event.reason || '')} wasClean=${event.wasClean} `
          + `superseded=${myEpoch !== connEpochRef.current} `
          + `hadConnected=${hasConnectedRef.current}`
        );
        // A superseded socket (token rotated, newer connect already running)
        // must not touch shared state or schedule a reconnect — that newer
        // connection owns the lifecycle now.
        if (myEpoch !== connEpochRef.current) return;
        invalidateSessionProcessAuthority(processStateEpoch);
        setIsConnected(false);
        wsRef.current = null;

        // Only show "reconnecting" if we've successfully connected before;
        // on the very first attempt a failure shows as "disconnected".
        if (hasConnectedRef.current) {
          setWsStatus('reconnecting');
        } else {
          setWsStatus('disconnected');
        }

        // Exponential backoff reconnect (avoids reconnect storm).
        const delay = calcReconnectDelay(reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, delay);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, []); // stable: reads the live token from localStorage on every connect, so
  //          the onclose reconnect timer never closes over a stale token/closure.

  const sendMessage = useCallback((message: any): SendMessageResult => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return { ok: true };
    }
    return { ok: false, reason: 'disconnected' };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    controlFrames,
    controlEvents,
    streamFrames,
    reconnectEpoch,
    isConnected,
    wsStatus,
    openSessionsCount,
  }), [
    sendMessage,
    latestMessage,
    controlFrames,
    controlEvents,
    streamFrames,
    reconnectEpoch,
    isConnected,
    wsStatus,
    openSessionsCount,
  ]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
