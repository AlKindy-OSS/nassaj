/**
 * T-1295 — صندوق الصادر: التخزين والخصوصية والتقليم.
 *
 * ما يحرسه هذا الملف:
 *  ١. الإدخال يُحفَظ بنصّه وصوره، ويُقرأ بعد إعادة التحميل.
 *  ٢. الحكم يُصيب الإدخال الصحيح **بـ`clientMsgId`** ولو كان هناك إدخالان
 *     معلَّقان — لا «أحدث معلَّق» ولا تخمين.
 *  ٣. الخصوصية: المفتاح يحمل `userId`، وتغيّرُ المستخدم يمسح صندوق من سبقه،
 *     والخروج يمسح كل شيء. مستخدمٌ لا يقرأ صندوق غيره.
 *  ٤. الصور خارج `localStorage` (مخزن كائنات مستقلّ)، وتعذُّرُ حفظها لا يُسقط
 *     حفظ النصّ.
 *  ٥. التقليم **قبل** الكتابة: بالعمر وبالعدد — فلا تُبلَغ حصةُ التخزين أصلاً،
 *     وهي المسار الذي كان يمسح كل مسوّدات المشاريع.
 *  ٦. ‏`pending` لا يُعرض، ويُرقّى إلى `unconfirmed` عند إعادة التحميل.
 *
 * RUNNER: vitest (`npm run test:src`) — jsdom.
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOutboxReceiptRecovery,
  MAX_OUTBOX_ENTRIES,
  MAX_OUTBOX_BYTES,
  bindOutboxSession,
  OUTBOX_SUSPECT_AFTER_MS,
  OUTBOX_TTL_MS,
  clearOutbox,
  hasCanonicalOutboxProof,
  hasOutboxDeliveryEvidence,
  verifyOutboxReceipt,
  consumeOutboxIngressVerdict,
  reconcileOutboxDeliveryEvidence,
  confirmOutboxEntry,
  createClientMsgId,
  getOutboxSnapshot,
  isSuspectPending,
  markOutboxFailed,
  markOutboxPending,
  readOutboxImages,
  readOutboxRetryPayload,
  recordOutboxEntry,
  recordOutboxEntryDurably,
  removeOutboxEntry,
  restorePreparedOutboxRetry,
  selectVisibleEntries,
  setOutboxBlobStore,
  setOutboxUser,
  subscribeOutbox,
  type OutboxBlobStore,
} from './messageOutbox';

/** مخزن كائنات في الذاكرة: يقوم مقام IndexedDB الغائب في jsdom. */
function memoryBlobStore() {
  const map = new Map<string, File>();
  const store: OutboxBlobStore = {
    put: async (key, file) => { map.set(key, file); },
    getMany: async (keys) => keys.map((k) => map.get(k)).filter((f): f is File => Boolean(f)),
    deleteMany: async (keys) => { keys.forEach((k) => map.delete(k)); },
    clearAll: async () => { map.clear(); },
  };
  return { store, map };
}

const PROJECT = 'proj-1';
const SESSION = 'sess-1';

function makeFile(name = 'shot.png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

function record(id: string, overrides: Record<string, unknown> = {}) {
  return recordOutboxEntry({
    id,
    projectId: PROJECT,
    sessionId: SESSION,
    text: `نصّ ${id}`,
    ...overrides,
  } as Parameters<typeof recordOutboxEntry>[0]);
}

let blobs: ReturnType<typeof memoryBlobStore>;

beforeEach(() => {
  localStorage.clear();
  blobs = memoryBlobStore();
  setOutboxBlobStore(blobs.store);
  clearOutbox();
  setOutboxUser(2);
});

describe('الحفظ والاسترجاع', () => {
  it('يحفظ النصّ والصور، ويُرجع الصور ككائنات أصلية', async () => {
    const file = makeFile();
    record('m1', { images: [file] });

    const [entry] = getOutboxSnapshot();
    expect(entry.text).toBe('نصّ m1');
    expect(entry.imageNames).toEqual(['shot.png']);
    // النصّ في localStorage، والصورة **ليست** فيه.
    const raw = localStorage.getItem('nassaj_outbox_v1_u2') ?? '';
    expect(raw).toContain('نصّ m1');
    expect(raw).not.toContain('data:image');

    await Promise.resolve();
    const restored = await readOutboxImages('m1');
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe('shot.png');
  });

  it('تعذُّر حفظ الصور لا يُسقط حفظ النصّ (انحدار رشيق)', () => {
    setOutboxBlobStore({
      put: async () => { throw new Error('no indexeddb'); },
      getMany: async () => [],
      deleteMany: async () => undefined,
      clearAll: async () => undefined,
    });

    record('m1', { images: [makeFile()] });

    const [entry] = getOutboxSnapshot();
    expect(entry.text).toBe('نصّ m1');
    expect(entry.imageNames).toEqual(['shot.png']);
  });

  // B-521: كان يُرقّى هنا إلى `unconfirmed`. صار الحكم مشتقّاً لحظة العرض،
  // لأن التبنّي يقع قبل أن يُعرف أي شيء عن الجولات الجارية — فترقيتُه تقلب
  // رسالةً سليمة إلى بطاقة إنذار مع كل إعادة تحميل أثناء تشغيل حيّ.
  it('يعيش عبر إعادة التحميل بحالته كما هي — لا ترقية عند التبنّي', () => {
    record('m1', { status: 'pending' });
    record('m2', { status: 'failed', reasonCode: 'transport' });

    // إعادة تحميل = مستهلك جديد يقرأ المفتاح نفسه.
    setOutboxUser(null);
    setOutboxUser(2);

    const byId = new Map(getOutboxSnapshot().map((e) => [e.id, e]));
    expect(byId.get('m1')?.status).toBe('pending');
    expect(byId.get('m2')?.status).toBe('failed');
  });
});

describe('الربط بـclientMsgId', () => {
  it('يُصيب الإدخال الصحيح مع إدخالين معلَّقين', () => {
    record('m1');
    record('m2');

    markOutboxFailed('m2', { code: 'spawn_failed' });

    const byId = new Map(getOutboxSnapshot().map((e) => [e.id, e]));
    expect(byId.get('m1')?.status).toBe('pending');
    expect(byId.get('m2')?.status).toBe('failed');
    expect(byId.get('m2')?.reasonCode).toBe('spawn_failed');
  });

  it('معرّف مجهول لا يُغيّر شيئاً (لا يقع الحكم على جارٍ بريء)', () => {
    record('m1');
    expect(markOutboxFailed('ghost', { code: 'x' })).toBe(false);
    expect(getOutboxSnapshot()[0].status).toBe('pending');
  });

  it('القبول في مخزن v1 يحتفظ بالإدخال وصورته حتى يصبح النقل إلى v2 ممكناً', async () => {
    record('m1', { images: [makeFile()] });
    await Promise.resolve();
    expect(blobs.map.size).toBe(1);

    confirmOutboxEntry('m1');
    await Promise.resolve();

    expect(getOutboxSnapshot()[0].status).toBe('delivered');
    expect(blobs.map.size).toBe(1);
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).toContain('نصّ m1');
    // دليل الهوية القديم وحده ليس تفويض حذف: لا جيل v2 ولا اكتمال أجزاء.
    reconcileOutboxDeliveryEvidence(SESSION, [{ id: 'm1', sessionId: SESSION, kind: 'text', role: 'user' }]);
    expect(getOutboxSnapshot()).toHaveLength(1);
  });

  it('إعادة الإرسال تُعيد الإدخال معلَّقاً فتختفي بطاقته', () => {
    record('m1', { status: 'failed', reasonCode: 'transport' });
    markOutboxPending('m1');
    const [entry] = getOutboxSnapshot();
    expect(entry.status).toBe('pending');
    expect(entry.reasonCode).toBeNull();
    expect(selectVisibleEntries(getOutboxSnapshot(), PROJECT, SESSION)).toHaveLength(0);
  });
});

describe('الخصوصية', () => {
  it('المفتاح يحمل userId، وتغيّر المستخدم لا يقرأ مصدر v1 من سبقه أثناء الهجرة', () => {
    record('m1');
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).toBeTruthy();

    setOutboxUser(3);

    expect(getOutboxSnapshot()).toHaveLength(0);
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).toContain('نصّ m1');
  });

  it('مفتاح مستخدم آخر لا يُقرأ ولو زُرع يدوياً، ويبقى مصدراً معزولاً للهجرة', () => {
    localStorage.setItem(
      'nassaj_outbox_v1_u9',
      JSON.stringify({
        version: 1,
        entries: [{
          id: 'foreign', projectId: PROJECT, sessionId: SESSION, text: 'سرّ الآخر',
          createdAt: Date.now(), status: 'failed', reasonCode: null, reasonDetail: null,
          imageNames: [], intent: {},
        }],
      }),
    );

    // مستخدم آخر يفتح التطبيق على المتصفّح نفسه.
    setOutboxUser(null);
    setOutboxUser(7);

    expect(getOutboxSnapshot()).toHaveLength(0);
    expect(localStorage.getItem('nassaj_outbox_v1_u9')).toContain('سرّ الآخر');
  });

  it('الخروج يمسح الصندوق والصور', async () => {
    record('m1', { images: [makeFile()] });
    await Promise.resolve();

    clearOutbox();
    await Promise.resolve();

    expect(getOutboxSnapshot()).toHaveLength(0);
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).toBeNull();
    expect(blobs.map.size).toBe(0);
    // وبلا مستخدم لا يُكتب شيء أصلاً.
    expect(record('m2')).toBeNull();
  });
});

describe('التقليم قبل الكتابة', () => {
  it('لا يمسّ مفاتيح المسوّدات إطلاقاً', () => {
    localStorage.setItem('draft_input_other-project', 'مسوّدة مشروع آخر');
    for (let i = 0; i < MAX_OUTBOX_ENTRIES + 6; i += 1) {
      record(`m${i}`, { text: 'ح'.repeat(2000) });
    }
    expect(localStorage.getItem('draft_input_other-project')).toBe('مسوّدة مشروع آخر');
  });

  it('يرفض الجديد عند تجاوز السعة ويحفظ الأقدم', () => {
    for (let i = 0; i < MAX_OUTBOX_ENTRIES + 3; i += 1) {
      record(`m${i}`);
    }
    const ids = getOutboxSnapshot().map((e) => e.id);
    expect(ids).toHaveLength(MAX_OUTBOX_ENTRIES);
    expect(ids).toContain('m0');
    expect(ids).not.toContain(`m${MAX_OUTBOX_ENTRIES + 2}`);
  });

  it('يحفظ الرسالة القديمة دون تأكيد', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - OUTBOX_TTL_MS - 1000);
    record('old');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    record('fresh');

    const ids = getOutboxSnapshot().map((e) => e.id);
    expect(ids).toEqual(['old', 'fresh']);
    vi.restoreAllMocks();
  });
});

describe('العرض', () => {
  it('لا يُعرض المعلَّق، ويُعرض الفاشل لجلسته ومشروعه وحدهما', () => {
    record('pending-one', { status: 'pending' });
    record('failed-here', { status: 'failed' });
    record('failed-other-session', { status: 'failed', sessionId: 'sess-2' });
    record('failed-other-project', { status: 'failed', projectId: 'proj-2' });

    const visible = selectVisibleEntries(getOutboxSnapshot(), PROJECT, SESSION).map((e) => e.id);
    expect(visible).toEqual(['failed-here']);
  });

  it('محادثة لم تُولد بعد: الفشلُ الصريح بلا معرّف جلسة يُعرض لها', () => {
    record('draft-fail', { status: 'failed', sessionId: null });
    const visible = selectVisibleEntries(getOutboxSnapshot(), PROJECT, null).map((e) => e.id);
    expect(visible).toEqual(['draft-fail']);
  });

  /**
   * ‏B-553/م2 — اليتيم المعلَّق **لا يُشكّ فيه أبداً**، مهما طال عمره.
   *
   * حادثة المالك 2026-08-07: رسالةٌ أُرسلت من محادثة جديدة نُفِّذت فعلاً
   * ومحادثتُها تعمل، وبطاقتها الصفراء ظاهرة على **كل** شاشة محادثة جديدة. لأن
   * الإدخال بقي بلا معرّف جلسة (`bindOutboxSession` بلا مستدعٍ، والحكم لم يصل
   * لغياب الصدى) — ولا سبيل إلى التحقّق منه: لا سجلَّ يُسأل، فالعرض ظنٌّ محض.
   * والفشلُ الصريح يبقى معروضاً (الاختبار أعلاه): المحجوب هو الإنذار الظنّي.
   */
  it('اليتيم المعلَّق لا يُعرض ولو تجاوز مهلة الشكّ — B-553', () => {
    const old = Date.now() - (OUTBOX_SUSPECT_AFTER_MS + 60_000);
    expect(
      isSuspectPending(
        { ...(record('orphan', { status: 'pending', sessionId: null }) as any), createdAt: old },
        Date.now(),
        () => false,
      ),
    ).toBe(false);

    // وذو الجلسة يُشكّ فيه كما كان — القاعدة لم تتّسع إلى غير اليتيم.
    expect(
      isSuspectPending(
        { ...(record('owned', { status: 'pending', sessionId: 'sess-1' }) as any), createdAt: old },
        Date.now(),
        () => false,
      ),
    ).toBe(true);
  });

  it('يُخطر المشتركين عند كل تغيير', () => {
    let hits = 0;
    const unsubscribe = subscribeOutbox(() => { hits += 1; });
    record('m1');
    markOutboxFailed('m1', { code: 'transport' });
    removeOutboxEntry('m1');
    unsubscribe();
    expect(hits).toBe(3);
  });
});

describe('createClientMsgId', () => {
  it('يولّد معرّفات فريدة', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createClientMsgId()));
    expect(ids.size).toBe(200);
  });
});

/**
 * B-521 — بطاقة «لم يصل تأكيد» كانت تظهر كذباً على رسالة سُلِّمت وجولتها تعمل.
 *
 * ثلاث حلقات تضافرت: الخادم لا يصدّي `clientMsgId` إلا على `session_created`
 * و`complete` و`error`؛ و`session_created` لا يُبعث إلا لمحادثة جديدة — فعلى
 * محادثة قائمة لا دليل قبول حتى تنتهي الجولة؛ و`setOutboxUser` كان يرقّي كل
 * `pending` إلى `unconfirmed` عند كل تبنٍّ، أي عند كل إعادة تحميل.
 */
describe('B-521 — الشكّ في المعلَّق مشتقٌّ لا مخزَّن', () => {
  const NOW = 1_800_000_000_000;
  const base = {
    projectId: 'p1',
    sessionId: 's1',
    text: 'مرحباً',
    reasonCode: null,
    reasonDetail: null,
    imageNames: [] as string[],
    intent: {},
  };
  const pending = (createdAt: number, id = 'e1') =>
    ({ ...base, id, createdAt, status: 'pending' as const });

  const live = () => true;
  const idle = () => false;

  it('جولة تعمل ⇒ لا بطاقة مهما طال الزمن — الانحدار المستهدف', () => {
    const entry = pending(NOW - 40 * 60 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', { now: NOW, isSessionLive: live });

    assert.equal(visible.length, 0, 'بطاقة إنذار على رسالة سُلِّمت وجولتها تعمل');
  });

  it('جلسة ساكنة ومضت المهلة ⇒ تظهر', () => {
    const entry = pending(NOW - 5 * 60 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', { now: NOW, isSessionLive: idle });

    assert.equal(visible.length, 1);
  });

  it('انقطع الاتصال أثناء المعالجة ⇒ لا يُحوَّل غياب الحالة إلى idle ظني', () => {
    const entry = pending(NOW - 6 * 60 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', {
      now: NOW,
      // لقطة الانحدار: مؤشر Processing ما زال قائماً لكن قناة process_state
      // غير متاحة، فلا توجد سلطة للحكم إن كانت الجولة ساكنة أم حيّة.
      isSessionLive: idle,
      isSessionStateAuthoritative: () => false,
    });

    assert.equal(visible.length, 0, 'ظهر إنذار تسليم أثناء reconnect غير الحاسم');
  });

  it('بعد إعادة الاتصال: الجولة الحيّة تبقى بلا بطاقة', () => {
    const entry = pending(NOW - 6 * 60 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', {
      now: NOW,
      isSessionLive: live,
      isSessionStateAuthoritative: () => true,
    });

    assert.equal(visible.length, 0);
  });

  it('frozen دليل أن الجولة بدأت ⇒ لا بطاقة', () => {
    const entry = pending(NOW - 6 * 60 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', {
      now: NOW,
      isSessionLive: () => true,
      isSessionStateAuthoritative: () => true,
    });

    assert.equal(visible.length, 0);
  });

  it('بعد إعادة الاتصال: رسالة لم تبدأ فعلاً تظهر حين تثبت سكون الجلسة', () => {
    const entry = pending(NOW - 6 * 60 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', {
      now: NOW,
      isSessionLive: idle,
      isSessionStateAuthoritative: () => true,
    });

    assert.equal(visible.length, 1, 'أُخفيت رسالة لم تبدأ بعد استعادة سلطة الحالة');
  });

  it('نافذة الثواني الأولى محميّة: ساكنة لكن المهلة لم تمضِ ⇒ لا بطاقة', () => {
    const entry = pending(NOW - 5 * 1000);

    const visible = selectVisibleEntries([entry], 'p1', 's1', { now: NOW, isSessionLive: idle });

    assert.equal(visible.length, 0, 'بطاقة ظهرت على رسالة ما زالت في طريقها');
  });

  it('`failed` يظهر دائماً بلا شرط زمن ولا حالة جلسة', () => {
    const entry = { ...pending(NOW), status: 'failed' as const, reasonCode: 'transport' };

    const visible = selectVisibleEntries([entry], 'p1', 's1', { now: NOW, isSessionLive: live });

    assert.equal(visible.length, 1);
  });

  it('فشل النقل الصريح يظهر حتى أثناء انقطاع الاتصال', () => {
    const entry = { ...pending(NOW), status: 'failed' as const, reasonCode: 'transport' };

    const visible = selectVisibleEntries([entry], 'p1', 's1', {
      now: NOW,
      isSessionLive: idle,
      isSessionStateAuthoritative: () => false,
    });

    assert.equal(visible.length, 1);
  });

  it('تبنّي المستخدم لا يكتب `unconfirmed` على القرص', () => {
    const key = 'nassaj_outbox_v1_u7';
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, entries: [pending(NOW)] }),
    );

    setOutboxUser(7);

    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    assert.equal(
      stored.entries?.[0]?.status,
      'pending',
      'التبنّي رقّى الحالة على القرص — حكمٌ كاذب يصعب التراجع عنه',
    );
  });
});

describe('B-894 canonical delivery evidence', () => {
  const row = { id: 'server-1', sessionId: 's1', kind: 'text', role: 'user', clientMsgId: 'cmid_1', content: 'موافق' };
  it('accepts only the exact canonical user identity and session', () => {
    expect(hasOutboxDeliveryEvidence([row], 's1', 'cmid_1')).toBe(true);
    expect(hasOutboxDeliveryEvidence([{ ...row, id: 'cmid_1', clientMsgId: undefined }], 's1', 'cmid_1')).toBe(true);
    expect(hasOutboxDeliveryEvidence([row], 's2', 'cmid_1')).toBe(false);
    expect(hasOutboxDeliveryEvidence([row], 's1', 'cmid_2')).toBe(false);
  });
  it('does not accept repeated text, assistant response, or old history without identity', () => {
    expect(hasOutboxDeliveryEvidence([{ ...row, clientMsgId: undefined }], 's1', 'cmid_1')).toBe(false);
    expect(hasOutboxDeliveryEvidence([{ ...row, role: 'assistant' }], 's1', 'cmid_1')).toBe(false);
    expect(hasOutboxDeliveryEvidence([{ ...row, kind: 'complete' }], 's1', 'cmid_1')).toBe(false);
    expect(hasOutboxDeliveryEvidence([row], 's1', '')).toBe(false);
  });
});

it('B-894 legacy history identity never disposes the matching v1 copy', () => {
  setOutboxUser('late-history');
  recordOutboxEntry({ id: 'cmid_first', projectId: 'p', sessionId: 's1', text: 'موافق' });
  recordOutboxEntry({ id: 'cmid_second', projectId: 'p', sessionId: 's1', text: 'موافق' });
  reconcileOutboxDeliveryEvidence('s1', []);
  expect(getOutboxSnapshot()).toHaveLength(2);
  reconcileOutboxDeliveryEvidence('s1', [{ id: 'saved', sessionId: 's1', kind: 'text', role: 'user', clientMsgId: 'cmid_first' }]);
  expect(getOutboxSnapshot().map((entry) => entry.id)).toEqual(['cmid_first', 'cmid_second']);
});

describe('B-894 receipt and retained-copy boundaries', () => {
  const identity = { sessionId: SESSION, clientMsgId: 'cmid_x', provider: 'codex' };
  const accepted = { ...identity, status: 'accepted', receipt: { ...identity, source: 'ingress_receipt', content: 'موافق', createdAt: '2026-09-05T00:00:00Z' } };
  it('requires exact authenticated receipt identity and handles old server/offline', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => accepted }));
    expect(await verifyOutboxReceipt(SESSION, 'cmid_x', 'codex', fetch)).toBe('accepted');
    for (const body of [
      { ...accepted, clientMsgId: 'other' },
      { ...accepted, receipt: { ...accepted.receipt, sessionId: 'other' } },
      { ...accepted, receipt: { ...accepted.receipt, provider: 'claude' } },
      { ...accepted, receipt: { ...accepted.receipt, source: 'history' } },
      { ...accepted, status: 'unknown' },
    ]) expect(await verifyOutboxReceipt(SESSION, 'cmid_x', 'codex', async () => ({ ok: true, json: async () => body }))).toBe('unknown');
    expect(await verifyOutboxReceipt(SESSION, 'cmid_x', 'codex', async () => ({ ok: false, json: async () => accepted }))).toBe('unknown');
    expect(await verifyOutboxReceipt(SESSION, 'cmid_x', 'codex', async () => { throw new Error('offline'); })).toBe('unknown');
  });
  it('retains delivered copies beyond TTL and refuses overflow instead of pruning them', () => {
    vi.useFakeTimers();
    try {
      for (let n = 0; n < MAX_OUTBOX_ENTRIES; n++) { record(`saved-${n}`); confirmOutboxEntry(`saved-${n}`); }
      vi.advanceTimersByTime(OUTBOX_TTL_MS + 1);
      setOutboxUser(null); setOutboxUser(2);
      expect(getOutboxSnapshot()).toHaveLength(MAX_OUTBOX_ENTRIES);
      expect(record('overflow')).toBeNull();
      expect(getOutboxSnapshot().every((entry) => entry.status === 'delivered')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('quota failure never rewrites a smaller box or loses retained content', () => {
    record('saved'); confirmOutboxEntry('saved');
    const before = localStorage.getItem('nassaj_outbox_v1_u2');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      expect(record('new')).toBeNull();
      expect(getOutboxSnapshot().map((entry) => entry.id)).toEqual(['saved']);
      expect(localStorage.getItem('nassaj_outbox_v1_u2')).toBe(before);
      expect(setItem).toHaveBeenCalledTimes(1);
    } finally { setItem.mockRestore(); }
  });
});

it('B-894 session-created receipt binds the retained local copy to its actual session', () => {
  record('cmid_new', { sessionId: null });
  consumeOutboxIngressVerdict({ kind: 'session_created', clientMsgId: 'cmid_new', newSessionId: 'born' });
  expect(getOutboxSnapshot()[0]).toMatchObject({ sessionId: 'born', status: 'delivered' });
  markOutboxFailed('cmid_new', { code: 'late_error' });
  expect(getOutboxSnapshot()[0].status).toBe('delivered');
});

it('B-894 binding a session near the byte cap never prunes the target copy', () => {
  record('protected', { text: 'x'.repeat(MAX_OUTBOX_BYTES - 1000) });
  confirmOutboxEntry('protected');
  record('pending', { sessionId: null, text: '' });
  const remaining = MAX_OUTBOX_BYTES - localStorage.getItem('nassaj_outbox_v1_u2')!.length - 5;
  expect(remaining).toBeGreaterThan(0);
  record('pending', { sessionId: null, text: 'y'.repeat(remaining) });
  const before = getOutboxSnapshot();
  const persisted = localStorage.getItem('nassaj_outbox_v1_u2');
  bindOutboxSession('pending', 'session-with-an-identity-longer-than-the-remaining-space');
  expect(getOutboxSnapshot()).toBe(before);
  expect(localStorage.getItem('nassaj_outbox_v1_u2')).toBe(persisted);
  expect(markOutboxFailed('pending', { detail: 'z'.repeat(1000) })).toBe(false);
  expect(getOutboxSnapshot()).toBe(before);
});


describe('B-894 bounded receipt recovery', () => {
  it('recovers a late receipt without an idle transition and stops after acceptance', async () => {
    vi.useFakeTimers();
    const verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValue('accepted');
    const settled = vi.fn();
    const recovery = createOutboxReceiptRecovery(verify, settled);
    try {
      const entry = record('late')!;
      recovery.reconcile([entry]);
      await vi.advanceTimersByTimeAsync(0);
      recovery.reconcile([entry]);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(settled).toHaveBeenLastCalledWith(entry, 'accepted');
    } finally { recovery.dispose(); vi.useRealTimers(); }
  });
  it('bounds unknown results and cancels obsolete in-flight results', async () => {
    vi.useFakeTimers();
    const verify = vi.fn().mockResolvedValue(false);
    const settled = vi.fn();
    const recovery = createOutboxReceiptRecovery(verify, settled);
    try {
      const entry = record('unknown')!;
      recovery.reconcile([entry]);
      await vi.advanceTimersByTimeAsync(500_000);
      recovery.reconcile([entry]);
      await vi.advanceTimersByTimeAsync(500_000);
      expect(verify).toHaveBeenCalledTimes(5);
      recovery.dispose();
      let finish!: (value: 'accepted') => void;
      const pending = createOutboxReceiptRecovery(() => new Promise((resolve) => { finish = resolve; }), settled);
      pending.reconcile([entry]);
      await vi.advanceTimersByTimeAsync(0);
      const count = settled.mock.calls.length;
      pending.dispose();
      finish('accepted');
      await Promise.resolve();
      expect(settled).toHaveBeenCalledTimes(count);
    } finally { recovery.dispose(); vi.useRealTimers(); }
  });
});


it.each(['pending', 'unconfirmed', 'failed', 'delivered'] as const)('B-894 retains %s copies and their attachments across TTL and overflow', async (status) => {
  vi.useFakeTimers();
  try {
    record('protected-copy', { status, images: [makeFile()] });
    await Promise.resolve();
    vi.advanceTimersByTime(OUTBOX_TTL_MS + 1);
    for (let n = 1; n < MAX_OUTBOX_ENTRIES; n++) record(`next-${n}`);
    expect(record('overflow')).toBeNull();
    expect(getOutboxSnapshot().some((entry) => entry.id === 'protected-copy')).toBe(true);
    expect(await readOutboxImages('protected-copy')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});


it('B-894 keeps one verification in flight despite rerenders and removes cancelled jobs', async () => {
  vi.useFakeTimers();
  let finish!: (value: boolean) => void;
  const verify = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const settled = vi.fn();
  const recovery = createOutboxReceiptRecovery(verify, settled);
  try {
    const entry = record('single-flight')!;
    recovery.reconcile([entry]);
    await vi.advanceTimersByTimeAsync(0);
    recovery.reconcile([entry]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(verify).toHaveBeenCalledTimes(1);
    recovery.reconcile([]);
    finish(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  } finally { recovery.dispose(); vi.useRealTimers(); }
});


it.each(['accepted', true] as const)('B-894 replaces a snapshot during fetch and recovers %s without overlapping requests', async (verdict) => {
  vi.useFakeTimers();
  let finish!: (value: boolean | 'accepted') => void;
  const verify = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(verdict);
  const settled = vi.fn();
  const recovery = createOutboxReceiptRecovery(verify, settled);
  try {
    const entry = record('replaced')!;
    recovery.reconcile([entry]);
    await vi.advanceTimersByTimeAsync(0);
    const replacement = { ...entry };
    recovery.reconcile([replacement]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(verify).toHaveBeenCalledTimes(1);
    finish(verdict);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(verify).toHaveBeenLastCalledWith(replacement, expect.any(AbortSignal));
    expect(settled).toHaveBeenCalledExactlyOnceWith(replacement, verdict);
    recovery.reconcile([replacement]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(verify).toHaveBeenCalledTimes(2);
  } finally { recovery.dispose(); vi.useRealTimers(); }
});

it('B-894 replacement snapshots never reset the five-attempt budget', async () => {
  vi.useFakeTimers();
  const verify = vi.fn().mockResolvedValue(false);
  const recovery = createOutboxReceiptRecovery(verify, vi.fn());
  try {
    const entry = record('bounded-clones')!;
    for (let n = 0; n < 12; n++) {
      recovery.reconcile([{ ...entry }]);
      await vi.advanceTimersByTimeAsync(100_000);
    }
    expect(verify).toHaveBeenCalledTimes(5);
  } finally { recovery.dispose(); vi.useRealTimers(); }
});


it('B-894 aborts hung requests at the deadline and exhausts a bounded budget', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const verify = vi.fn((_entry, signal: AbortSignal) => { signals.push(signal); return new Promise<boolean>(() => {}); });
  const recovery = createOutboxReceiptRecovery(verify, vi.fn());
  try {
    recovery.reconcile([record('hung')!]);
    await vi.advanceTimersByTimeAsync(500_000);
    expect(verify).toHaveBeenCalledTimes(5);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(500_000);
    expect(verify).toHaveBeenCalledTimes(5);
  } finally { recovery.dispose(); vi.useRealTimers(); }
});


describe('B-894 sticky history eligibility', () => {
  it('normalizes missing legacy eligibility without inferring from empty image names', () => {
    const entry = record('legacy')!;
    const { historyEligibility: _ignored, ...legacy } = entry;
    localStorage.setItem('nassaj_outbox_v1_u7', JSON.stringify({ version: 1, entries: [legacy] }));
    setOutboxUser(7);
    expect(getOutboxSnapshot()[0].historyEligibility).toBe('ineligible');
  });

  it('rejects a text-only claim with image bytes', () => {
    expect(record('image', { historyEligibility: 'text_only', images: [makeFile()] })?.historyEligibility).toBe('ineligible');
  });

  it.each(['claude', 'qwen', 'hermes', 'kimi', 'deepseek', 'glm'])('%s keeps v1 copies despite an exact native identity', (provider) => {
    record('text', { text: 'identical', historyEligibility: 'text_only', intent: { provider } });
    record('file', { text: 'identical', fileNames: ['source.pdf'], historyEligibility: 'ineligible', intent: { provider } });
    record('image', { text: 'identical', images: [makeFile()], historyEligibility: 'ineligible', intent: { provider } });
    record('legacy', { text: 'identical', intent: { provider } });
    reconcileOutboxDeliveryEvidence(SESSION, ['text', 'file', 'image', 'legacy'].map(id => ({
      id: 'native-' + id, sessionId: SESSION, clientMsgId: id, kind: 'text', role: 'user',
    })));
    expect(getOutboxSnapshot().map(entry => entry.id)).toEqual(['text', 'file', 'image', 'legacy']);
  });

  it.each(['codex', 'cursor', 'opencode', 'antigravity'])('%s does not let a v1 identity row dispose a copy', (provider) => {
    record('native', { intent: { provider } });
    reconcileOutboxDeliveryEvidence(SESSION, [{ id: 'native', sessionId: SESSION, kind: 'text', role: 'user' }]);
    expect(getOutboxSnapshot()).toHaveLength(1);
  });
});


describe('B-894 retry inventory persistence', () => {
  it('retains the original file inventory after reload and blocks unsupported restoration', async () => {
    record('files', { fileNames: ['source.pdf', 'source.txt'], historyEligibility: 'ineligible' });
    setOutboxUser(null);
    setOutboxUser(2);
    expect(getOutboxSnapshot()[0]).toMatchObject({ fileNames: ['source.pdf', 'source.txt'], fileCount: 2 });
    expect(await readOutboxRetryPayload(getOutboxSnapshot()[0])).toEqual({ ok: false, code: 'attachment_files_unavailable' });
  });

  it('does not upgrade legacy text-only claims with missing inventory during reload', async () => {
    record('legacy', { historyEligibility: 'text_only' });
    const { fileNames: _names, fileCount: _count, ...legacy } = getOutboxSnapshot()[0];
    localStorage.setItem('nassaj_outbox_v1_u2', JSON.stringify({ version: 1, entries: [legacy] }));
    setOutboxUser(null);
    setOutboxUser(2);
    expect(await readOutboxRetryPayload(getOutboxSnapshot()[0])).toEqual({ ok: false, code: 'attachment_payload_unknown' });
    expect(getOutboxSnapshot()[0].fileNames).toBeUndefined();
  });

  it.each([{ fileNames: [], fileCount: 1 }, { fileNames: ['file'], fileCount: 0 }, { fileNames: null, fileCount: 0 }])(
    'refuses inconsistent metadata %j', async (inventory) => {
      const entry = record('invalid', { historyEligibility: 'text_only' })!;
      expect(await readOutboxRetryPayload({ ...entry, ...inventory } as typeof entry)).toEqual({ ok: false, code: 'attachment_payload_unknown' });
    });

  it('rejects a text-only declaration when original files exist', () => {
    expect(record('file-claim', { fileNames: ['a.pdf'], historyEligibility: 'text_only' })?.historyEligibility).toBe('ineligible');
  });

  it('refuses substituted image names even when the count matches', async () => {
    const entry = record('image-name', { images: [makeFile('original.png')], fileNames: [] })!;
    blobs.map.set('image-name#0', makeFile('different.png'));
    expect(await readOutboxRetryPayload(entry)).toEqual({ ok: false, code: 'attachment_images_incomplete' });
  });
});

describe('B-969 restore a failed retry without losing its original evidence', () => {
  function prepareRetry() {
    record('restore-retry', { fileNames: [], images: [makeFile()],
      intent: { provider: 'claude', coordinationLevel: 'delegate_review' } });
    markOutboxFailed('restore-retry', { code: 'not_started', detail: 'retained reason', sameClientMsgIdRetryable: true });
    const original = getOutboxSnapshot()[0];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(original.createdAt + 1_000);
    try { expect(markOutboxPending(original.id)).toBe(true); } finally { clock.mockRestore(); }
    return { original, prepared: getOutboxSnapshot()[0] };
  }

  it('restores the original timestamp, reason, intent and attachments and persists them', async () => {
    const { original, prepared } = prepareRetry();
    expect(prepared.createdAt).not.toBe(original.createdAt);
    expect(restorePreparedOutboxRetry(prepared, original, 'attachment_upload_failed')).toBe(true);
    const expected = { ...original, retryBlockCode: 'attachment_upload_failed' };
    expect(getOutboxSnapshot()).toEqual([expected]);
    expect(JSON.parse(localStorage.getItem('nassaj_outbox_v1_u2')!).entries).toEqual([expected]);
    expect((await readOutboxImages(original.id)).map(file => file.name)).toEqual(original.imageNames);
  });

  it.each(['different-id', 'nonfailed-original', 'nonpending-attempt', 'stale-reference', 'delivered', 'account'] as const)(
    'refuses to restore over unrelated or newer state (%s)', (change) => {
      let { original, prepared } = prepareRetry();
      if (change === 'different-id') original = { ...original, id: 'another-id' };
      if (change === 'nonfailed-original') original = { ...original, status: 'delivered' };
      if (change === 'nonpending-attempt') prepared = { ...prepared, status: 'failed' };
      if (change === 'stale-reference') {
        markOutboxFailed(original.id, { code: 'newer-error' });
        markOutboxPending(original.id);
      }
      if (change === 'delivered') confirmOutboxEntry(original.id);
      if (change === 'account') {
        setOutboxUser(3);
        record(original.id, { text: 'belongs to another account' });
      }
      const key = `nassaj_outbox_v1_u${change === 'account' ? 3 : 2}`;
      const before = getOutboxSnapshot();
      const persisted = localStorage.getItem(key);
      expect(restorePreparedOutboxRetry(prepared, original, 'attachment_upload_failed')).toBe(false);
      expect(getOutboxSnapshot()).toBe(before);
      expect(localStorage.getItem(key)).toBe(persisted);
    });

  it('keeps memory and persisted pending state unchanged when restoring exceeds storage quota', () => {
    const { original, prepared } = prepareRetry();
    const before = getOutboxSnapshot();
    const persisted = localStorage.getItem('nassaj_outbox_v1_u2');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      expect(restorePreparedOutboxRetry(prepared, original, 'attachment_upload_failed')).toBe(false);
      expect(getOutboxSnapshot()).toBe(before);
      expect(localStorage.getItem('nassaj_outbox_v1_u2')).toBe(persisted);
    } finally { setItem.mockRestore(); }
  });
});

describe('T-1648 received-copy notice lifecycle', () => {
  const visibleIds = () => selectVisibleEntries(getOutboxSnapshot(), PROJECT, SESSION).map(entry => entry.id);
  const canonical = (id: string) => [{ id: `server-${id}`, clientMsgId: id, sessionId: SESSION, kind: 'text', role: 'user' }];

  it('hides receipt-confirmed notices immediately, retaining text and images across reload', async () => {
    record('received', { status: 'unconfirmed', images: [makeFile()], intent: { provider: 'codex' } });
    record('failed', { status: 'failed' });
    record('unknown', { status: 'unconfirmed' });
    expect(visibleIds()).toEqual(['received', 'failed', 'unknown']);
    confirmOutboxEntry('received');
    expect(visibleIds()).toEqual(['failed', 'unknown']);
    setOutboxUser(null);
    setOutboxUser(2);
    expect(visibleIds()).toEqual(['failed', 'unknown']);
    expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'received', status: 'delivered', text: 'نصّ received' });
    expect(await readOutboxImages('received')).toHaveLength(1);
  });

  it('keeps a received copy silent when history is unavailable or has a different identity', async () => {
    record('received', { images: [makeFile()], intent: { provider: 'codex' } });
    confirmOutboxEntry('received');
    expect(await verifyOutboxReceipt(SESSION, 'received', 'codex', async () => { throw new Error('offline'); })).toBe('unknown');
    reconcileOutboxDeliveryEvidence(SESSION, []);
    reconcileOutboxDeliveryEvidence(SESSION, canonical('other'));
    expect(visibleIds()).toEqual([]);
    expect(getOutboxSnapshot()).toHaveLength(1);
    expect(await readOutboxImages('received')).toHaveLength(1);
    reconcileOutboxDeliveryEvidence(SESSION, canonical('received'));
    expect(getOutboxSnapshot()).toHaveLength(1);
    expect(await readOutboxImages('received')).toHaveLength(1);
  });

  it.each(['receipt-first', 'history-first'] as const)('preserves a v1 copy during %s event ordering', (order) => {
    record('received', { status: 'unconfirmed' });
    if (order === 'receipt-first') confirmOutboxEntry('received');
    reconcileOutboxDeliveryEvidence(SESSION, canonical('received'));
    confirmOutboxEntry('received');
    markOutboxFailed('received', { code: 'late-error' });
    expect(getOutboxSnapshot()).toHaveLength(1);
    expect(visibleIds()).toEqual([]);
  });

  it('ignores late failure and pending transitions after confirmed receipt', () => {
    record('received', { status: 'unconfirmed' });
    confirmOutboxEntry('received');
    expect(markOutboxFailed('received', { code: 'late-error' })).toBe(false);
    expect(markOutboxPending('received')).toBe(false);
    expect(getOutboxSnapshot()[0].status).toBe('delivered');
    expect(visibleIds()).toEqual([]);
  });

  it('does not expose the previous account copy after switching accounts', () => {
    record('received');
    confirmOutboxEntry('received');
    setOutboxUser(3);
    expect(getOutboxSnapshot()).toHaveLength(0);
    record('other-unknown', { status: 'unconfirmed' });
    expect(visibleIds()).toEqual(['other-unknown']);
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).toContain('نصّ received');
  });
});

// B-1007: a caught dispatch exception is not evidence of non-delivery.
describe('correlated dispatch uncertainty', () => {
  it('exposes only the exact message for verification and preserves its images', async () => {
    record('dispatch-a', { images: [makeFile()] });
    record('dispatch-b');
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-a', deliveryDisposition: 'unknown' });
    const entry = getOutboxSnapshot().find(entry => entry.id === 'dispatch-a')!;
    expect(entry.status).toBe('unconfirmed');
    expect(entry.sameClientMsgIdRetryable).toBe(false);
    expect(selectVisibleEntries(getOutboxSnapshot(), PROJECT, SESSION, {
      isSessionLive: () => true, isSessionStateAuthoritative: () => false,
    }).map(entry => entry.id)).toEqual(['dispatch-a']);
    expect(await readOutboxImages('dispatch-a')).toHaveLength(1);
    expect(getOutboxSnapshot().find(entry => entry.id === 'dispatch-b')?.status).toBe('pending');
    expect(await verifyOutboxReceipt(SESSION, entry.id, 'codex', async () => ({ ok: false, json: async () => ({}) }))).toBe('unknown');
    expect(getOutboxSnapshot().find(candidate => candidate.id === entry.id)?.status).toBe('unconfirmed');
  });

  it('requires the complete not-started certificate before enabling retry', () => {
    record('dispatch-a');
    for (const certificate of [
      { deliveryDisposition: 'unknown' },
      { deliveryDisposition: 'not_started', notStarted: true },
      { deliveryDisposition: 'not_started', sameClientMsgIdRetryable: true },
    ]) {
      consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-a', ...certificate });
      expect(getOutboxSnapshot()[0].status).toBe('unconfirmed');
    }
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-a', deliveryDisposition: 'not_started', notStarted: true, sameClientMsgIdRetryable: true });
    expect(getOutboxSnapshot()[0]).toMatchObject({ status: 'failed', sameClientMsgIdRetryable: true });
  });

  it('never guesses an identity or downgrades confirmed delivery', () => {
    record('dispatch-a');
    expect(consumeOutboxIngressVerdict({ kind: 'error', deliveryDisposition: 'unknown' })).toBeNull();
    expect(getOutboxSnapshot()[0].status).toBe('pending');
    confirmOutboxEntry('dispatch-a');
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-a', deliveryDisposition: 'unknown' });
    expect(getOutboxSnapshot()[0].status).toBe('delivered');
    setOutboxUser(3);
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-a', deliveryDisposition: 'unknown' });
    expect(getOutboxSnapshot()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  B-1034 — إخلاء تلقائي عند القبول (مسار v2 / IndexedDB)           */
/* ------------------------------------------------------------------ */

/**
 * محاكاة IndexedDB في الذاكرة تقوم مقام البيئة الغائبة في jsdom.
 * تتبع نمط memoryBlobStore: خريطة بسيطة + طلبات تُحلّ عبر microtask.
 * المعاملات تُلتزم في setTimeout(0) بعد انتهاء الـrun callback.
 */
function makeMemoryIDB() {
  // خريطة اسم قاعدة البيانات → اسم المخزن → Map<key, value>
  const dbs = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();

  function getDB(name: string): Map<string, Map<IDBValidKey, unknown>> {
    if (!dbs.has(name)) {
      dbs.set(name, new Map([
        ['entries', new Map()], ['images', new Map()], ['meta', new Map()],
      ]));
    }
    return dbs.get(name)!;
  }

  function fakeRequest<T>(val: T): IDBRequest<T> {
    const req: any = { result: val, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => { if (req.onsuccess) req.onsuccess.call(req); });
    return req as IDBRequest<T>;
  }

  function fakeStore(storeMap: Map<IDBValidKey, unknown>, pendingOps: Array<() => void>): IDBObjectStore {
    return {
      getAll: () => fakeRequest([...storeMap.values()]),
      get: (key: IDBValidKey) => fakeRequest(storeMap.get(key)),
      getAllKeys: () => fakeRequest([...storeMap.keys()]),
      put: (value: unknown, key?: IDBValidKey) => {
        const k = key ?? (value as any)?.key;
        pendingOps.push(() => storeMap.set(k, value));
        return fakeRequest(k as IDBValidKey);
      },
      delete: (key: IDBValidKey) => {
        pendingOps.push(() => storeMap.delete(key));
        return fakeRequest(undefined as unknown as IDBValidKey);
      },
    } as unknown as IDBObjectStore;
  }

  const factory = {
    open: (name: string, _version?: number) => {
      const storesByName = getDB(name);
      const req: any = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.result = {
          transaction: (storeNames: string[], _mode: string) => {
            const pendingOps: Array<() => void> = [];
            const txStores: Record<string, IDBObjectStore> = {};
            for (const sn of storeNames) txStores[sn] = fakeStore(storesByName.get(sn)!, pendingOps);
            const tx: any = { oncomplete: null, onerror: null, onabort: null };
            tx.objectStore = (sn: string) => txStores[sn];
            tx.abort = () => { pendingOps.length = 0; queueMicrotask(() => { if (tx.onabort) tx.onabort.call(tx); }); };
            // commit ops and fire oncomplete after all microtasks from run() settle
            setTimeout(() => { pendingOps.forEach(op => op()); if (tx.oncomplete) tx.oncomplete.call(tx); }, 0);
            return tx as IDBTransaction;
          },
          close: () => {},
          objectStoreNames: { contains: () => true },
        };
        if (req.onupgradeneeded) req.onupgradeneeded.call(req);
        if (req.onsuccess) req.onsuccess.call(req);
      });
      return req as IDBOpenDBRequest;
    },
  };

  return {
    factory,
    clear: () => dbs.clear(),
    getStoreMap: (dbName: string, storeName: string): Map<IDBValidKey, unknown> =>
      getDB(dbName).get(storeName) ?? new Map<IDBValidKey, unknown>(),
  };
}

/** انتظر التزام جميع معاملات IDB المعلَّقة. */
async function flushIDB() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('B-1034 — إخلاء تلقائي في مسار v2', () => {
  let fakeIDB: ReturnType<typeof makeMemoryIDB>;

  beforeEach(async () => {
    fakeIDB = makeMemoryIDB();
    Object.defineProperty(window, 'indexedDB', { value: fakeIDB.factory, writable: true, configurable: true });
    Object.defineProperty(navigator, 'locks', {
      value: { request: async (_n: string, _o: unknown, cb: () => Promise<unknown>) => cb() },
      writable: true, configurable: true,
    });
    localStorage.clear();
    blobs = memoryBlobStore();
    setOutboxBlobStore(blobs.store);
    clearOutbox();
    setOutboxUser(99);
    await flushIDB(); // انتظر hydrateV2 الأولى
  });

  afterEach(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, writable: true, configurable: true });
    Object.defineProperty(navigator, 'locks', { value: undefined, writable: true, configurable: true });
    fakeIDB.clear();
  });

  it('انحدار B-1034: 20 مسلَّماً بـsessionId:null ثم الحادي والعشرون ينجح ويُخلي الأقدم', async () => {
    const oldTs = Date.now() - OUTBOX_TTL_MS - 1000;

    // سجّل 20 إدخالاً قديماً ثم أكّدها كـdelivered
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(oldTs);
      await recordOutboxEntryDurably({ id: `old${i}`, projectId: PROJECT, sessionId: null, text: `t${i}` });
      await flushIDB();
      vi.restoreAllMocks();
      confirmOutboxEntry(`old${i}`);
      await flushIDB();
    }
    expect(getOutboxSnapshot()).toHaveLength(MAX_OUTBOX_ENTRIES);

    // الإرسال الحادي والعشرون — يجب أن ينجح لأن القديمة تجاوزت TTL
    const result = await recordOutboxEntryDurably({ id: 'new1', projectId: PROJECT, sessionId: SESSION, text: 'رسالة جديدة' });
    await flushIDB();

    expect(result).not.toBeNull();
    const snap = getOutboxSnapshot();
    // كل الإدخالات القديمة تجاوزت TTL فأُخليَت جميعها في (a) — يبقى الجديد وحده
    expect(snap).toHaveLength(1);
    expect(snap.map(e => e.id)).toEqual(['new1']);
  });

  it('B-1034: المسلَّم الأقدم من TTL يُحذف عند hydrateV2 مع بلوباته', async () => {
    const oldTs = Date.now() - OUTBOX_TTL_MS - 1000;
    const img = makeFile('old.png');

    vi.spyOn(Date, 'now').mockReturnValue(oldTs);
    await recordOutboxEntryDurably({ id: 'stale', projectId: PROJECT, sessionId: SESSION, text: 'قديم', images: [img] });
    await flushIDB();
    vi.restoreAllMocks();
    confirmOutboxEntry('stale');
    await flushIDB();

    expect(getOutboxSnapshot().find(e => e.id === 'stale')).toBeTruthy();

    // إعادة التحميل — setOutboxUser تستدعي hydrateV2
    setOutboxUser(null);
    setOutboxUser(99);
    await flushIDB();

    expect(getOutboxSnapshot().find(e => e.id === 'stale')).toBeUndefined();
    // تحقّق من حذف بلوب الصورة فعلاً من مخزن الصور في IDB
    const imagesStore = fakeIDB.getStoreMap('nassaj-outbox-v2', 'images');
    expect(imagesStore.size).toBe(0);
  });

  it('B-1034: 20 إدخالاً failed ثم إرسال جديد يبقى مرفوضاً (outbox_capacity)', async () => {
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
      await recordOutboxEntryDurably({ id: `f${i}`, projectId: PROJECT, sessionId: SESSION, text: `fail ${i}` });
      await flushIDB();
      // قلّبها إلى failed في الذاكرة (بلا v2 patch لتبقى لا تُخلى)
      const target = getOutboxSnapshot().find(e => e.id === `f${i}`);
      if (target) markOutboxFailed(`f${i}`, { code: 'transport' });
      await flushIDB();
    }
    expect(getOutboxSnapshot()).toHaveLength(MAX_OUTBOX_ENTRIES);

    const result = await recordOutboxEntryDurably({ id: 'blocked', projectId: PROJECT, sessionId: SESSION, text: 'محجوب' });
    await flushIDB();

    expect(result).toBeNull();
  });

  it('B-1034: unconfirmed لا يُخلى لصالح السعة', async () => {
    const oldTs = Date.now() - OUTBOX_TTL_MS - 1000;

    // سجّل 20 إدخالاً قديماً unconfirmed
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(oldTs);
      await recordOutboxEntryDurably({ id: `uc${i}`, projectId: PROJECT, sessionId: SESSION, text: `u${i}` });
      await flushIDB();
      vi.restoreAllMocks();
      // اجعلها unconfirmed: نستخدم markOutboxDispatchUnconfirmed عبر consumeOutboxIngressVerdict
      consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: `uc${i}`, deliveryDisposition: 'unknown' });
      await flushIDB();
    }
    expect(getOutboxSnapshot().every(e => e.status === 'unconfirmed')).toBe(true);

    const result = await recordOutboxEntryDurably({ id: 'extra', projectId: PROJECT, sessionId: SESSION, text: 'لا مكان' });
    await flushIDB();

    // unconfirmed لا يُخلى — الإضافة يجب أن تُرفض
    expect(result).toBeNull();
  });

  it('B-1034 (ج-أ): 20 مسلَّماً حديثاً ثم الحادي والعشرون يُخلي الأقدم وحده والبقية سليمة', async () => {
    const baseTs = Date.now();

    // سجّل 20 مسلَّماً بـcreatedAt متصاعد (جميعها داخل TTL)
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(baseTs + i);
      await recordOutboxEntryDurably({ id: `recent${i}`, projectId: PROJECT, sessionId: SESSION, text: `r${i}` });
      await flushIDB();
      vi.restoreAllMocks();
      confirmOutboxEntry(`recent${i}`);
      await flushIDB();
    }
    expect(getOutboxSnapshot()).toHaveLength(MAX_OUTBOX_ENTRIES);

    // الحادي والعشرون يضغط السعة — يُخلي recent0 (الأقدم) فقط
    const result = await recordOutboxEntryDurably({ id: 'extra', projectId: PROJECT, sessionId: SESSION, text: 'إضافي' });
    await flushIDB();

    expect(result).not.toBeNull();
    const snap = getOutboxSnapshot();
    const ids = snap.map(e => e.id);
    expect(snap).toHaveLength(MAX_OUTBOX_ENTRIES); // 19 ناجٍ + extra
    expect(ids).toContain('extra');
    expect(ids).not.toContain('recent0'); // الأقدم يُخلى وحده
    for (let i = 1; i < MAX_OUTBOX_ENTRIES; i++) expect(ids).toContain(`recent${i}`);
  });

  it('B-1034 (ج-ب): يتيم معلَّق قديم يُخلى عند القبول التالي، وحديث يبقى', async () => {
    const oldTs = Date.now() - OUTBOX_TTL_MS - 1000;

    // إدخال قديم sessionId=null (يتيم قديم — تجاوز TTL)
    vi.spyOn(Date, 'now').mockReturnValue(oldTs);
    await recordOutboxEntryDurably({ id: 'oldOrphan', projectId: PROJECT, sessionId: null, text: 'يتيم قديم' });
    await flushIDB();
    vi.restoreAllMocks();
    // بعد التسجيل يكون موجوداً
    expect(getOutboxSnapshot().map(e => e.id)).toContain('oldOrphan');

    // إدخال حديث sessionId=null — قبوله يُشغّل الخطوة (b) فيُخلي oldOrphan
    const result = await recordOutboxEntryDurably({ id: 'freshOrphan', projectId: PROJECT, sessionId: null, text: 'يتيم حديث' });
    await flushIDB();

    expect(result).not.toBeNull();
    const ids = getOutboxSnapshot().map(e => e.id);
    expect(ids).not.toContain('oldOrphan');  // القديم يُخلى بالخطوة (b)
    expect(ids).toContain('freshOrphan');    // الحديث (داخل TTL) يبقى
  });

  it('B-1034 (ج-ج): المسلَّم النصّي يُخلى قبل الحامل للصور تحت ضغط السعة', async () => {
    const baseTs = Date.now();

    // 19 مسلَّماً نصّياً بـcreatedAt متصاعد
    for (let i = 0; i < MAX_OUTBOX_ENTRIES - 1; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(baseTs + i);
      await recordOutboxEntryDurably({ id: `txt${i}`, projectId: PROJECT, sessionId: SESSION, text: `نص${i}` });
      await flushIDB();
      vi.restoreAllMocks();
      confirmOutboxEntry(`txt${i}`);
      await flushIDB();
    }
    // مسلَّم واحد حامل للصور (أحدث من جميع النصّيين)
    const img = makeFile('img.png');
    vi.spyOn(Date, 'now').mockReturnValue(baseTs + MAX_OUTBOX_ENTRIES);
    await recordOutboxEntryDurably({ id: 'imgEntry', projectId: PROJECT, sessionId: SESSION, text: 'بصور', images: [img] });
    await flushIDB();
    vi.restoreAllMocks();
    confirmOutboxEntry('imgEntry');
    await flushIDB();

    expect(getOutboxSnapshot()).toHaveLength(MAX_OUTBOX_ENTRIES);

    // إضافة واحدة تحت الضغط — يُخلى txt0 (أقدم نصّي) لا imgEntry (حامل صور)
    const result = await recordOutboxEntryDurably({ id: 'pressure', projectId: PROJECT, sessionId: SESSION, text: 'ضغط' });
    await flushIDB();

    expect(result).not.toBeNull();
    const ids = getOutboxSnapshot().map(e => e.id);
    expect(ids).not.toContain('txt0');     // أقدم نصّي يُخلى
    expect(ids).toContain('imgEntry');     // حامل الصور يبقى رغم أنه الأحدث
    expect(ids).toContain('pressure');
    expect(getOutboxSnapshot()).toHaveLength(MAX_OUTBOX_ENTRIES);
  });
});

/*
 * B-1078 — `displayClientMsgId` pairs a history row with its bubble for display
 * only. It is set whatever the turn state (running, error), so it must never be
 * outbox deletion proof: only `clientMsgId` (terminal success) may retire a copy.
 */
describe('B-1078 outbox proof ignores displayClientMsgId', () => {
  let fakeIDB: ReturnType<typeof makeMemoryIDB>;
  const TEXT = 'سوي تجربة أبغا اشوف ';
  const row = (identity: { clientMsgId?: string; displayClientMsgId?: string }) => ({
    id: 'uuid-transcript', sessionId: SESSION, kind: 'text', role: 'user', provider: 'claude', content: TEXT, ...identity,
  });

  beforeEach(async () => {
    fakeIDB = makeMemoryIDB();
    Object.defineProperty(window, 'indexedDB', { value: fakeIDB.factory, writable: true, configurable: true });
    Object.defineProperty(navigator, 'locks', {
      value: { request: async (_n: string, _o: unknown, cb: () => Promise<unknown>) => cb() },
      writable: true, configurable: true,
    });
    localStorage.clear();
    clearOutbox();
    setOutboxUser(1078);
    await flushIDB();
  });

  afterEach(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, writable: true, configurable: true });
    Object.defineProperty(navigator, 'locks', { value: undefined, writable: true, configurable: true });
    fakeIDB.clear();
  });

  async function durable(id: string) {
    const entry = await recordOutboxEntryDurably({
      id, projectId: PROJECT, sessionId: SESSION, text: TEXT, historyEligibility: 'text_only', intent: { provider: 'claude' },
    });
    await flushIDB();
    expect(entry).not.toBeNull();
    return getOutboxSnapshot().find(candidate => candidate.id === id)!;
  }

  it('hasCanonicalOutboxProof: clientMsgId mints proof, displayClientMsgId alone does not', async () => {
    const entry = await durable('cmid_b1078_proof');
    expect(hasCanonicalOutboxProof(entry, [row({ clientMsgId: entry.id })])).not.toBeNull();
    expect(hasCanonicalOutboxProof(entry, [row({ displayClientMsgId: entry.id })])).toBeNull();
  });

  it('hasOutboxDeliveryEvidence does not accept a display-only identity', () => {
    expect(hasOutboxDeliveryEvidence([row({ displayClientMsgId: 'cmid_x' })], SESSION, 'cmid_x')).toBe(false);
    expect(hasOutboxDeliveryEvidence([row({ clientMsgId: 'cmid_x' })], SESSION, 'cmid_x')).toBe(true);
  });

  it('reconcile keeps an error-turn entry whose history row carries only the display id', async () => {
    const entry = await durable('cmid_b1078_error_turn');
    markOutboxFailed(entry.id, { code: 'provider_error' });
    await flushIDB();
    reconcileOutboxDeliveryEvidence(SESSION, [row({ displayClientMsgId: entry.id })]);
    await flushIDB();
    expect(getOutboxSnapshot().map(candidate => [candidate.id, candidate.status])).toEqual([[entry.id, 'failed']]);
  });

  it('reconcile still retires the copy on the terminal clientMsgId proof (positive control)', async () => {
    const entry = await durable('cmid_b1078_success');
    reconcileOutboxDeliveryEvidence(SESSION, [row({ clientMsgId: entry.id, displayClientMsgId: entry.id })]);
    await flushIDB();
    expect(getOutboxSnapshot()).toHaveLength(0);
  });
});
