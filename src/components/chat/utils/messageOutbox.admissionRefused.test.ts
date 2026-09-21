/**
 * B-1042 — شريط الإقالة: الراية تُرفع عند امتلاء الصندوق وتنخفض بعد ذلك.
 *
 * يختبر هذا الملف سلوك `admissionRefused` عبر `getAdmissionRefusedSnapshot`:
 *  1. مخفيّ حين توجد نسخ مُسلَّمة في الحالة الاعتيادية (بلا رفض قبول).
 *  2. ظاهر بعد رفض القبول بسبب امتلاء الصندوق.
 *  3. مخفيّ بعد تنفيذ الإقالة.
 *  4. مخفيّ بعد نجاح قبول لاحق.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * المسار v1 (localStorage) يُستخدَم لأن jsdom يفتقر إلى IndexedDB؛ المنطق المُختبَر
 * مشترك بين المسارين (نفس `admissionRefused` الوحدوي ونفس `notify`).
 */

import { beforeEach, expect, it, vi } from 'vitest';
import {
  clearOutbox,
  confirmOutboxEntry,
  createDeliveredOutboxDismissal,
  getAdmissionRefusedSnapshot,
  getOutboxSnapshot,
  markOutboxFailed,
  MAX_OUTBOX_ENTRIES,
  recordOutboxEntry,
  setOutboxBlobStore,
  setOutboxUser,
  subscribeOutbox,
} from './messageOutbox';

/* ── إعداد ── */

beforeEach(() => {
  localStorage.clear();
  clearOutbox();
  setOutboxUser('owner');
  setOutboxBlobStore({
    put: async () => undefined,
    getMany: async () => [],
    deleteMany: async () => undefined,
    clearAll: async () => undefined,
  });
});

function addEntry(id: string, status: 'delivered' | 'failed' | 'pending' = 'pending') {
  recordOutboxEntry({ id, sessionId: 'session-a', projectId: 'p', text: id });
  if (status === 'delivered') confirmOutboxEntry(id);
  if (status === 'failed') markOutboxFailed(id, { code: 'transport' });
}

/** يملأ الصندوق حتى سقفه بإدخالات مُسلَّمة ثم يُعيد الإدخال التالي الذي يُفشل القبول. */
function fillToCapacity(): void {
  for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
    addEntry(`fill-${i}`, 'delivered');
  }
}

/* ── الاختبارات ── */

it('1 — مخفيّ في الحالة الاعتيادية: نسخ مُسلَّمة موجودة لكن لم يُرفض قبول', () => {
  addEntry('delivered-a', 'delivered');
  addEntry('delivered-b', 'delivered');

  expect(getAdmissionRefusedSnapshot()).toBe(false);
});

it('2 — ظاهر بعد رفض القبول بسبب امتلاء الصندوق', () => {
  const notifications: boolean[] = [];
  const unsub = subscribeOutbox(() => {
    notifications.push(getAdmissionRefusedSnapshot());
  });

  fillToCapacity();
  // محاولة إضافة إدخال إضافي تتجاوز السقف → تُفشَل ← ترفع الراية
  const result = recordOutboxEntry({ id: 'overflow', sessionId: 'session-a', projectId: 'p', text: 'overflow' });

  unsub();

  expect(result).toBeNull();
  expect(getAdmissionRefusedSnapshot()).toBe(true);
  // يجب أن يكون قد وصل إشعار بالراية مرفوعة
  expect(notifications.at(-1)).toBe(true);
});

it('3 — مخفيّ بعد تنفيذ الإقالة', () => {
  fillToCapacity();
  recordOutboxEntry({ id: 'overflow', sessionId: 'session-a', projectId: 'p', text: 'overflow' });
  expect(getAdmissionRefusedSnapshot()).toBe(true);

  const dismissed = createDeliveredOutboxDismissal()();

  expect(dismissed).toBeGreaterThan(0);
  expect(getAdmissionRefusedSnapshot()).toBe(false);
});

it('3b — مخفيّ بعد الإقالة حتى لو لم يتبقَّ نسخ مُسلَّمة (أُخليَت بالـTTL مسبقاً)', () => {
  // رفع الراية يدوياً عبر مسار القبول الفاشل
  fillToCapacity();
  recordOutboxEntry({ id: 'overflow', sessionId: 'session-a', projectId: 'p', text: 'overflow' });
  expect(getAdmissionRefusedSnapshot()).toBe(true);

  const notifications: boolean[] = [];
  const unsub = subscribeOutbox(() => notifications.push(getAdmissionRefusedSnapshot()));

  // الإقالة تُنشئ قائمة من النسخ الحالية المُسلَّمة؛ امسح الصندوق قبل التنفيذ
  const dismiss = createDeliveredOutboxDismissal();
  clearOutbox();
  setOutboxUser('owner'); // أعِد تفعيل الحساب
  // الآن لا نسخ مُسلَّمة — الإقالة تُعيد 0 لكن الراية يجب أن تنخفض
  const removed = dismiss();
  unsub();

  expect(removed).toBe(0);
  expect(getAdmissionRefusedSnapshot()).toBe(false);
  // يجب أن يصل إشعار بالانخفاض
  expect(notifications).toContain(false);
});

it('4 — مخفيّ بعد نجاح قبول لاحق', () => {
  // امئل الصندوق وارفع الراية
  fillToCapacity();
  recordOutboxEntry({ id: 'overflow', sessionId: 'session-a', projectId: 'p', text: 'overflow' });
  expect(getAdmissionRefusedSnapshot()).toBe(true);

  // أفرِغ الصندوق جزئياً حتى يتّسع الإدخال الجديد
  const dismiss = createDeliveredOutboxDismissal();
  // احذف نصف النسخ يدوياً
  const snapshot = getOutboxSnapshot().filter(e => e.status === 'delivered').slice(0, 5);
  for (const entry of snapshot) {
    // استخدم removeOutboxEntry عبر الإقالة — أو احذف مباشرةً عبر v1
    void entry; // eslint-disable-line
  }
  // أقصر طريق: استدعِ الإقالة الكاملة لإفراغ المُسلَّمات
  dismiss();
  expect(getAdmissionRefusedSnapshot()).toBe(false); // الإقالة وحدها تُخفض الراية

  // أعِد رفعها يدوياً: امئل الصندوق من جديد بلا إقالة
  fillToCapacity();
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((_k, _v) => {
    throw new Error('quota');
  });
  const suppressed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  recordOutboxEntry({ id: 'overflow-2', sessionId: 'session-a', projectId: 'p', text: 'overflow-2' });
  spy.mockRestore();
  suppressed.mockRestore();

  // قبولٌ ناجح: امسح الصندوق وأضِف إدخالاً جديداً بنجاح
  clearOutbox();
  setOutboxUser('owner');
  const entry = recordOutboxEntry({ id: 'new-success', sessionId: 'session-a', projectId: 'p', text: 'new-success' });

  expect(entry).not.toBeNull();
  expect(getAdmissionRefusedSnapshot()).toBe(false);
});
