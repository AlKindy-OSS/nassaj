/**
 * T-1295 — «رسالة تفشل لا تضيع»: صندوق الصادر.
 *
 * المشكلة المقيسة: `sendMessage` في WebSocketContext يُقرّ بالنجاح بمجرّد
 * `socket.send()` — إقرارُ **نقلٍ** لا إقرارُ **قبول**. و`handleSubmit` يمسح
 * المُؤلِّف عند ذلك الإقرار (النصّ، الصور، مسوّدة `draft_input_*`). فكل فشل يقع
 * بعد تلك اللحظة — خطأ من المحرّك، جلسة لم تُولَد، مزوّد مُعطَّل — يجد المُؤلِّف
 * خاوياً، ولا نسخة لكلام المستخدم في أي مكان: لا في سجلّ المحادثة (الخادم لا
 * يخزّن جولةً فشلت قبل أن تبدأ)، ولا في المسوّدة (مُحيت)، ولا في المخزن
 * (الفقاعة المتفائلة تُسحب أو تبقى كذبةً).
 *
 * الصندوق هنا هو النسخة الثالثة: يُكتب **قبل** أن يُمسح المُؤلِّف، ويُحذف عند
 * أوّل دليل قبول، ويُرفع إلى الشاشة عند أوّل دليل فشل.
 *
 * ثلاثة قيود بنيوية، كلٌّ منها ثمنُ حادثةٍ سابقة:
 *
 *  1. **الربط بـ`clientMsgId` لا بالتخمين.** «أحدث إدخال معلّق لهذه الجلسة»
 *     مرفوض: البوابة التي كان يستند إليها (`isLoading`) قراءةُ إغلاق لا قفل،
 *     وهي عالمية لا لكل جلسة، وتُصفَّر بتبديل الجلسة وبإطار `session-status`،
 *     ويتجاوزها `/btw` عمداً. فمعرّفٌ يولّده العميل ويصدى به الخادم هو **شرط
 *     صحّة**: بدونه قد يُطابَق حدثُ تشغيلٍ إدخالَ تشغيلٍ آخر فيُعاد إرسال حمولة
 *     إلى محادثة ليست لها.
 *
 *  2. **الخصوصية.** نسّاج متعدد المستخدمين يُفترض فيه أعضاء لا يثق بعضهم ببعض،
 *     و`localStorage`/IndexedDB مقيَّدان بالأصل (origin) لا بالحساب. فالمفتاح
 *     يحمل `userId`، والصندوق يُمسح عند الخروج وعند تغيّر المستخدم — ولا يُترك
 *     صندوقُ عضوٍ سابق قابعاً في متصفّح عضوٍ لاحق. والمدة بالساعات لا بالأيام.
 *
 *  3. **لا base64 في `localStorage`.** `safeLocalStorage.setItem` عند امتلاء
 *     الحصة يمسح **كل** مفاتيح `draft_input_*` بلا نطاق، فحفظ صورةٍ نصّاً هنا
 *     كان سيجعل ميزةَ «لا تضيع رسالة» تُتلف مسوّدات كل المشاريع. الصور تعيش في
 *     IndexedDB ككائنات `File` أصلية، والبيانات الوصفية وحدها في
 *     `localStorage`، **والتقليم يقع قبل الكتابة لا بعد الامتلاء**.
 *
 *  4. **إخلاء تلقائي عند القبول (B-1034) — v2 وحده.** مخزن v2 كان بلا
 *     تقادم فتراكمت إدخالات `delivered` و`pending` يتيمة حتى يبلغ العدد 20
 *     فيُقفل الإرسال. الآن: `evictV2ForAdmission` تُخلي قبل فحص السعة:
 *     (a) المسلَّم التالف بالعمر، (b) اليتيم المعلَّق التالف، (c) المسلَّم
 *     النصّي الأقدم فالأقدم أولاً ثم الحامل للصور أخيراً — التحوّط بصور
 *     المسلَّم يُضحّى به تحت ضغط السعة فقط. مسار v1 الاحتياطي يبقى
 *     fail-closed عمداً، والتباعد عن دلالة v1 (T-1648/B-894) مقصود.
 *     **لا يُخلى أبداً**: `failed` و`unconfirmed`.
 */

/* ------------------------------------------------------------------ */
/*  الأنواع                                                            */
/* ------------------------------------------------------------------ */

/**
 * حالة الإدخال:
 *  • `pending`      — أُرسل على السلك ولم يصل بعدُ دليلُ قبولٍ ولا فشل. **لا
 *                     يُعرض**: عرضُه يقول «فشلت» عن جولةٍ قد تكون تعمل الآن.
 *  • `failed`       — وصل دليل فشل صريح. يُعرض ببطاقةٍ وأفعالها الثلاثة.
 *  • `unconfirmed`  — أُرسل ثم انقطع الشاهد (أُغلقت الصفحة قبل أن يصل حكمٌ).
 *                     يُعرض، لكن فعلُه الأوّل «تحقّق» لا «أعد الإرسال»: قد تكون
 *                     الجولة نجحت، وإعادةُ الإرسال حينها إرسالٌ مزدوج.
 */
export type OutboxStatus = 'pending' | 'failed' | 'unconfirmed' | 'delivered';

/**
 * نيّة المستخدم لحظة الإرسال، تُحفظ لتُعاد عند إعادة الإرسال.
 *
 * ولا يدخلها `toolsSettings` عمداً: إعادةُ `skipPermissions: true` محفوظةً بعد
 * أن أطفأه المستخدم انحدارُ صلاحيات صامت. تُقرأ حيّةً عند كل إرسال.
 * وكذلك `sessionId`/`resume` — يُعاد حسابهما لحظة الإعادة، فقد وُلدت الجلسة بين
 * المحاولتين.
 */
export type OutboxIntent = {
  provider?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  composerMode?: 'chat' | 'agent';
  coordinationLevel?: 'direct' | 'delegate' | 'delegate_review';
  engineProvider?: string | null;
};

export type OutboxHistoryEligibility = 'text_only' | 'ineligible';

export type OutboxRetryBlockCode = 'attachment_payload_unknown' | 'attachment_files_unavailable'
  | 'attachment_images_missing' | 'attachment_images_incomplete' | 'attachment_images_unreadable'
  | 'attachment_upload_failed' | 'attachment_provider_unsupported' | 'attachment_copy_failed';

export type OutboxEntry = {
  /** يساوي `clientMsgId` المُرسَل مع الأمر — به وحده يُربط الحكم بالإدخال. */
  id: string;
  /** معرّف المشروع (DB projectId) — نطاق العرض. */
  projectId: string;
  /** معرّف الجلسة لحظة الإرسال؛ `null` لمحادثة لم تُولد بعد. */
  sessionId: string | null;
  text: string;
  createdAt: number;
  status: OutboxStatus;
  /** رمز السبب: `transport` أو رمز خطأ الخادم. `null` ما دام `pending`. */
  reasonCode: string | null;
  /** تفصيل الخادم الخام إن وُجد — يُعرض بين قوسين ولا يحلّ محلّ العنوان. */
  reasonDetail: string | null;
  /** Server verdict: only true permits replaying this exact clientMsgId. */
  sameClientMsgIdRetryable?: boolean;
  /** أسماء الصور المحفوظة في IndexedDB بترتيبها. */
  imageNames: string[];
  /** Original non-image attachment inventory; absent legacy values mean unknown. */
  fileNames?: string[];
  fileCount?: number;
  /** Retry failure is independent of the original receipt/session verdict. */
  retryBlockCode?: OutboxRetryBlockCode;
  /** Original payload completeness; missing legacy metadata is never eligible. */
  historyEligibility?: OutboxHistoryEligibility;
  intent: OutboxIntent;
};

type StoredBox = { version: 1; entries: OutboxEntry[] };

/* ------------------------------------------------------------------ */
/*  الحدود                                                             */
/* ------------------------------------------------------------------ */

const KEY_PREFIX = 'nassaj_outbox_v1_u';
/** بالساعات لا بالأيام: صندوقٌ عمرُه أسبوع أرشيفٌ لا شبكة أمان. */
export const OUTBOX_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_OUTBOX_ENTRIES = 20;
/** سقف بايتات الصندوق المُسلسَل — التقليم إليه يقع **قبل** الكتابة. */
export const MAX_OUTBOX_BYTES = 128 * 1024;
/** The original composer permits at most 15 files of 5 MiB.  Two complete
 * batches may be held for recovery; this is an admission limit, never an
 * eviction policy. */
export const MAX_OUTBOX_IMAGE_BYTES = 150 * 1024 * 1024;
export const MAX_OUTBOX_META_BYTES = 32 * 1024;

const V2_DB_NAME = 'nassaj-outbox-v2';
const V2_ENTRIES = 'entries';
const V2_IMAGES = 'images';
const V2_META = 'meta';
/** B ships this false; A is a separately fingerprinted source publication that
 * flips it to true.  A previous compatible B always understands the marker. */
export const MAY_ACTIVATE_OUTBOX_V2 = true;
const activationKey = (account: string) => `activation:${account}`;
type V2Entry = OutboxEntry & { key: string; account: string; generation: string; imageBytes: number };

const utf8Bytes = (value: unknown): number => {
  const text = JSON.stringify(value);
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).byteLength : unescape(encodeURIComponent(text)).length;
};

function v2EntryKey(account: string, id: string, generation: string): string {
  return `${account}\u0000${id}\u0000${generation}`;
}
function v2ImageKey(entry: V2Entry, index: number): string {
  return `${entry.key}\u0000${index}`;
}
function supportsSafeV2Storage(): boolean {
  return typeof indexedDB !== 'undefined' && typeof navigator !== 'undefined'
    && Boolean((navigator as Navigator & { locks?: LockManager }).locks?.request);
}
function openV2Database(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(V2_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(V2_ENTRIES)) db.createObjectStore(V2_ENTRIES, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(V2_IMAGES)) db.createObjectStore(V2_IMAGES);
        if (!db.objectStoreNames.contains(V2_META)) db.createObjectStore(V2_META);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function withV2Transaction<T>(mode: IDBTransactionMode, run: (stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => Promise<T> | T): Promise<T | null> {
  const db = await openV2Database();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      let result: T | null = null;
      let failed = false;
      const tx = db.transaction([V2_ENTRIES, V2_IMAGES, V2_META], mode);
      const stores = {
        [V2_ENTRIES]: tx.objectStore(V2_ENTRIES), [V2_IMAGES]: tx.objectStore(V2_IMAGES), [V2_META]: tx.objectStore(V2_META),
      };
      tx.oncomplete = () => { db.close(); resolve(failed ? null : result); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
      Promise.resolve(run(stores, tx)).then((value) => { result = value; }).catch(() => {
        failed = true;
        try { tx.abort(); } catch { /* transaction was already closed */ }
      });
    });
  } catch { db.close(); return null; }
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function makeOutboxEntry(input: RecordOutboxInput): OutboxEntry {
  const images = input.images ?? [];
  const fileNames = input.fileNames ?? (input.historyEligibility === 'text_only' ? [] : undefined);
  return {
    id: input.id, projectId: input.projectId, sessionId: input.sessionId ?? null, text: input.text,
    createdAt: Date.now(), status: input.status ?? 'pending', reasonCode: input.reasonCode ?? null,
    reasonDetail: input.reasonDetail ?? null, imageNames: images.map((file, index) => file?.name || `image-${index + 1}`),
    ...(fileNames ? { fileNames: [...fileNames], fileCount: fileNames.length } : {}),
    historyEligibility: input.historyEligibility === 'text_only' && images.length === 0 && fileNames?.length === 0 ? 'text_only' : 'ineligible',
    intent: input.intent ?? {},
  };
}

/**
 * Durable v2 admission.  The entry and all original image bytes are committed
 * in one IndexedDB transaction before its caller is allowed to clear/send.
 * It deliberately fails closed when the browser cannot provide origin-wide
 * locking: a local copy is safer than a message which cannot be recovered.
 */
async function recordV2OutboxEntry(input: RecordOutboxInput, activate: boolean): Promise<OutboxEntry | null> {
  const account = activeUserKey;
  const epoch = activeUserEpoch;
  if (!account || !supportsSafeV2Storage()) return null;
  const entry = makeOutboxEntry(input);
  const generation = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const images = input.images ?? [];
  const candidate: V2Entry = { ...entry, account, generation, key: v2EntryKey(account, entry.id, generation), imageBytes: images.reduce((sum, image) => sum + image.size, 0) };
  // Evictions captured inside the transaction for in-memory update after commit.
  let evictedInTx: V2Entry[] = [];
  // B-1042: رصد امتلاء السعة داخل المعاملة لرفع الراية خارجها.
  let v2CapacityExceeded = false;
  const saved = await withV2Transaction<boolean>('readwrite', async (stores) => {
    const all = await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[];
    if (activeUserKey !== account || activeUserEpoch !== epoch) throw new Error('stale_account');
    const owned = all.filter(item => item.account === account);
    // B-1034: أخلِ قبل فحص السعة حتى لا تُقفَل الرسائل الجديدة.
    evictedInTx = evictV2ForAdmission(owned, candidate, stores, Date.now());
    const evictedIds = new Set(evictedInTx.map(e => e.id));
    const ownedAfterEviction = owned.filter(e => !evictedIds.has(e.id));
    const replaced = ownedAfterEviction.filter(item => item.id === entry.id);
    const projected = [...ownedAfterEviction.filter(item => item.id !== entry.id), candidate];
    const metadata = projected.map(({ key: _key, account: _account, generation: _generation, imageBytes: _imageBytes, ...value }) => value);
    const imageBytes = projected.reduce((sum, item) => sum + item.imageBytes, 0);
    if (projected.length > MAX_OUTBOX_ENTRIES || utf8Bytes(metadata) > MAX_OUTBOX_BYTES || imageBytes > MAX_OUTBOX_IMAGE_BYTES) {
      v2CapacityExceeded = true;
      throw new Error('outbox_capacity');
    }
    replaced.forEach(old => {
      stores[V2_ENTRIES].delete(old.key);
      old.imageNames.forEach((_name, index) => stores[V2_IMAGES].delete(v2ImageKey(old, index)));
    });
    stores[V2_ENTRIES].put(candidate);
    images.forEach((image, index) => stores[V2_IMAGES].put(image, v2ImageKey(candidate, index)));
    if (activate) stores[V2_META].put({ activatedAt: Date.now() }, activationKey(account));
    return true;
  });
  if (!saved || activeUserKey !== account || activeUserEpoch !== epoch) {
    // B-1042: رفع الراية فقط إن كانت السعة هي السبب وما زلنا على نفس الحساب.
    if (v2CapacityExceeded && activeUserKey === account && activeUserEpoch === epoch) {
      admissionRefused = true;
      notify();
    }
    return null;
  }
  // القبول نجح — أسقط الراية إن كانت مرفوعة قبل إرسال الإشعار الأخير.
  admissionRefused = false;
  // v2 is isolated from old writers; the in-memory snapshot is only published
  // after the transaction committed.  Update evicted entries first.
  if (evictedInTx.length > 0) {
    const evictedIds = new Set(evictedInTx.map(e => e.id));
    for (const ev of evictedInTx) { v2ManagedIds.delete(ev.id); v2Generations.delete(ev.id); }
    entries = entries.filter(existing => !evictedIds.has(existing.id));
    if (entries.length === 0) entries = EMPTY;
  }
  v2ManagedIds.add(entry.id);
  v2Generations.set(entry.id, generation);
  entryGenerations.set(entry, generation);
  entries = Object.freeze([...entries.filter(existing => existing.id !== entry.id), entry]);
  notify();
  notifyV2Change();
  return entry;
}

async function readV2Activation(account: string): Promise<boolean> {
  const marker = await withV2Transaction<unknown>('readonly', stores => requestValue(stores[V2_META].get(activationKey(account))));
  return Boolean(marker);
}

async function legacyFingerprint(entry: OutboxEntry, images: readonly File[]): Promise<string | null> {
  try {
    const imageParts = await Promise.all(images.map(async (image) => {
      const bytes = new Uint8Array(await image.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { name: image.name, size: image.size, type: image.type, lastModified: image.lastModified,
        digest: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') };
    }));
    const payload = JSON.stringify({ id: entry.id, projectId: entry.projectId, sessionId: entry.sessionId,
      text: entry.text, imageNames: entry.imageNames, images: imageParts, fileNames: entry.fileNames, fileCount: entry.fileCount });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/** Copy v1 payloads only after A is active.  The old source remains untouched:
 * a still-open v1 tab may mutate it, so only an immutable payload fingerprint
 * prevents repeated imports. */
async function importLegacyOutbox(account: string): Promise<void> {
  if (!MAY_ACTIVATE_OUTBOX_V2 || activeUserKey !== account || !supportsSafeV2Storage()) return;
  const epoch = activeUserEpoch;
  const source = readBox(account);
  for (const entry of source) {
    if (activeUserKey !== account || activeUserEpoch !== epoch) return;
    if (!Array.isArray(entry.fileNames) || entry.fileCount !== entry.fileNames.length) continue;
    let images: File[] = [];
    try { images = entry.imageNames.length ? await blobStore.getMany(blobKeysFor(entry)) : []; } catch { continue; }
    if (images.length !== entry.imageNames.length || images.some((image, index) => image.name !== entry.imageNames[index])) continue;
    const fingerprint = await legacyFingerprint(entry, images);
    if (!fingerprint || activeUserKey !== account || activeUserEpoch !== epoch) continue;
    // Re-read after asynchronous blob/hash work; a v1 writer winning meanwhile
    // is never imported under an old marker.
    const fresh = readBox(account).find(candidate => candidate.id === entry.id);
    const freshImages = fresh?.imageNames.join('\u0000');
    if (!fresh || fresh.text !== entry.text || fresh.projectId !== entry.projectId || fresh.sessionId !== entry.sessionId
      || freshImages !== entry.imageNames.join('\u0000') || fresh.intent.provider !== entry.intent.provider
      || fresh.fileCount !== entry.fileCount || fresh.fileNames?.join('\u0000') !== entry.fileNames?.join('\u0000')
      || fresh.historyEligibility !== entry.historyEligibility) continue;
    const generation = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const candidate: V2Entry = { ...fresh, account, generation, key: v2EntryKey(account, fresh.id, generation),
      imageBytes: images.reduce((sum, image) => sum + image.size, 0) };
    const marker = `legacy:${account}:${fingerprint}`;
    const locks = (navigator as Navigator & { locks: LockManager }).locks;
    const imported = await locks.request('nassaj-outbox-v2', { mode: 'exclusive' }, async () => withV2Transaction<boolean>('readwrite', async (stores) => {
      const existingMarker = await requestValue(stores[V2_META].get(marker));
      if (existingMarker) return false;
      const all = await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[];
      if (activeUserKey !== account || activeUserEpoch !== epoch || all.some(item => item.account === account && item.id === entry.id)) return false;
      const owned = all.filter(item => item.account === account);
      const metadata = [...owned, candidate].map(({ key: _key, account: _account, generation: _generation, imageBytes: _imageBytes, ...value }) => value);
      const metaKeys = await requestValue(stores[V2_META].getAllKeys()) as IDBValidKey[];
      const metaValues = await requestValue(stores[V2_META].getAll()) as unknown[];
      const markers = metaKeys.filter(key => typeof key === 'string' && key.startsWith(`legacy:${account}:`));
      if (owned.length >= MAX_OUTBOX_ENTRIES || utf8Bytes(metadata) > MAX_OUTBOX_BYTES
        || owned.reduce((sum, item) => sum + item.imageBytes, candidate.imageBytes) > MAX_OUTBOX_IMAGE_BYTES
        || markers.length >= 100 || utf8Bytes({ keys: [...metaKeys, marker], values: [...metaValues, { source: 'v1' }] }) > MAX_OUTBOX_META_BYTES) throw new Error('legacy_capacity');
      stores[V2_ENTRIES].put(candidate);
      images.forEach((image, index) => stores[V2_IMAGES].put(image, v2ImageKey(candidate, index)));
      stores[V2_META].put({ source: 'v1', id: entry.id }, marker);
      stores[V2_META].put({ activatedAt: Date.now() }, activationKey(account));
      return true;
    }));
    if (imported && activeUserKey === account && activeUserEpoch === epoch) {
      v2ManagedIds.add(entry.id); v2Generations.set(entry.id, generation); entryGenerations.set(entry, generation);
      entries = Object.freeze([...entries.filter(current => current.id !== entry.id), entry]); notify(); notifyV2Change();
    }
  }
}

async function recordLegacyOutboxEntryDurably(input: RecordOutboxInput): Promise<OutboxEntry | null> {
  const entry = recordOutboxEntry(input);
  if (!entry) return null;
  const images = input.images ?? [];
  // Bridge B does not claim v2 atomicity.  It does, however, refuse to clear
  // or dispatch until every original image can be read back from the old store.
  if (!await verifyOutboxImagePersistence(entry, images)) {
    removeOutboxEntry(entry.id);
    return null;
  }
  return entry;
}

/**
 * Admission routing for the B→A compatibility floor.  Every call reads the
 * account marker while holding the origin lock.  B writes legacy only while
 * no marker exists; after A commits activation it transparently adopts v2.
 */
export async function recordOutboxEntryDurably(input: RecordOutboxInput): Promise<OutboxEntry | null> {
  const account = activeUserKey;
  const epoch = activeUserEpoch;
  if (!account || !supportsSafeV2Storage()) return null;
  const locks = (navigator as Navigator & { locks: LockManager }).locks;
  return locks.request('nassaj-outbox-v2', { mode: 'exclusive' }, async () => {
    if (activeUserKey !== account || activeUserEpoch !== epoch) return null;
    const active = await readV2Activation(account);
    if (activeUserKey !== account || activeUserEpoch !== epoch) return null;
    const saved = active || MAY_ACTIVATE_OUTBOX_V2
      ? await recordV2OutboxEntry(input, !active && MAY_ACTIVATE_OUTBOX_V2)
      : await recordLegacyOutboxEntryDurably(input);
    return activeUserKey === account && activeUserEpoch === epoch ? saved : null;
  }).catch(() => null);
}

/* ------------------------------------------------------------------ */
/*  مخزن الصور (IndexedDB) — خلف واجهة تُحقن، فالانحدار رشيق والاختبار ممكن */
/* ------------------------------------------------------------------ */

export interface OutboxBlobStore {
  put(key: string, file: File): Promise<void>;
  getMany(keys: string[]): Promise<File[]>;
  deleteMany(keys: string[]): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'nassaj-outbox';
const DB_STORE = 'images';

/** لا شيء يُحفظ ولا شيء يُقرأ — ومع ذلك لا يسقط حفظ النصّ. */
const nullBlobStore: OutboxBlobStore = {
  put: async () => undefined,
  getMany: async () => [],
  deleteMany: async () => undefined,
  clearAll: async () => undefined,
};

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function createIndexedDbBlobStore(): OutboxBlobStore {
  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, resolve: (value: T) => void) => void,
    fallback: T,
  ): Promise<T> => {
    const db = await openDatabase();
    if (!db) return fallback;
    return new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, mode);
        const store = tx.objectStore(DB_STORE);
        let settled = false;
        const finish = (value: T) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        tx.onerror = () => finish(fallback);
        tx.onabort = () => finish(fallback);
        run(store, finish);
        tx.oncomplete = () => finish(fallback);
      } catch {
        resolve(fallback);
      }
    });
  };

  return {
    put: (key, file) =>
      withStore<void>('readwrite', (store) => { store.put(file, key); }, undefined),
    getMany: async (keys) => {
      if (keys.length === 0) return [];
      return withStore<File[]>(
        'readonly',
        (store, resolve) => {
          const out: (File | undefined)[] = new Array(keys.length);
          let remaining = keys.length;
          keys.forEach((key, index) => {
            const request = store.get(key);
            const done = () => {
              remaining -= 1;
              if (remaining === 0) {
                resolve(out.filter((f): f is File => f instanceof File));
              }
            };
            request.onsuccess = () => { out[index] = request.result as File | undefined; done(); };
            request.onerror = () => { done(); };
          });
        },
        [],
      );
    },
    deleteMany: (keys) =>
      withStore<void>('readwrite', (store) => { keys.forEach((key) => store.delete(key)); }, undefined),
    clearAll: () =>
      withStore<void>('readwrite', (store) => { store.clear(); }, undefined),
  };
}

let blobStore: OutboxBlobStore =
  typeof indexedDB === 'undefined' ? nullBlobStore : createIndexedDbBlobStore();

/** حقن مخزن بديل (اختبارات، أو بيئة بلا IndexedDB). */
export function setOutboxBlobStore(store: OutboxBlobStore | null): void {
  blobStore = store ?? nullBlobStore;
}

const blobKey = (entryId: string, index: number) => `${entryId}#${index}`;
const blobKeysFor = (entry: OutboxEntry) => entry.imageNames.map((_, i) => blobKey(entry.id, i));

/* ------------------------------------------------------------------ */
/*  الحالة الحيّة                                                      */
/* ------------------------------------------------------------------ */

const EMPTY: readonly OutboxEntry[] = Object.freeze([]);
const V2_NOTIFICATION_KEY = 'nassaj_ob2_changed';

let activeUserKey: string | null = null;
let activeUserEpoch = 0;
let entries: readonly OutboxEntry[] = EMPTY;
/**
 * B-1042 — رُفض القبول بسبب امتلاء الصندوق.
 *
 * يُرفع في `recordOutboxEntry`/`recordV2OutboxEntry` حين تتجاوز السعة الحدّ،
 * ويُخفَض عند نجاح قبول لاحق أو عند تنفيذ الإقالة. يُعرض حينها شريط الإقالة.
 */
let admissionRefused = false;
/** IDs loaded/admitted from the isolated store. Old v1 callers never write it. */
const v2ManagedIds = new Set<string>();
const v2Generations = new Map<string, string>();
const entryGenerations = new WeakMap<OutboxEntry, string>();
const listeners = new Set<() => void>();
// Observe existing asynchronous blob writes; weak keys do not retain old entries.
const imageWrites = new WeakMap<OutboxEntry, Promise<boolean>>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[outbox] listener failed:', error);
    }
  }
}

function notifyV2Change(): void {
  try { localStorage.setItem(V2_NOTIFICATION_KEY, `${Date.now()}-${Math.random()}`); } catch { /* notification is advisory */ }
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** لقطة ثابتة المرجع ما لم يتغيّر الصندوق (عقد `useSyncExternalStore`). */
export function getOutboxSnapshot(): readonly OutboxEntry[] {
  return entries;
}

/**
 * B-1042 — هل رُفض آخر طلب قبول بسبب امتلاء الصندوق؟
 * يُستخدَم مع `useSyncExternalStore` + `subscribeOutbox` (نفس القناة).
 */
export function getAdmissionRefusedSnapshot(): boolean {
  return admissionRefused;
}

async function hydrateV2(account: string): Promise<void> {
  const epoch = activeUserEpoch;
  const run = async (): Promise<void> => {
    // فحص الحساب/الجيل بعد انتظار القفل (إن وُجد)
    if (activeUserKey !== account || activeUserEpoch !== epoch) return;
    // B-1034: كنس عند التحميل — احذف المسلَّم واليتيم المعلَّق التالفَيْن بالعمر.
    await withV2Transaction<void>('readwrite', async (stores) => {
      if (activeUserKey !== account || activeUserEpoch !== epoch) return;
      const all = await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[];
      const now = Date.now();
      for (const e of all) {
        if (e.account !== account) continue;
        const expired = (e.status === 'delivered' || (e.status === 'pending' && e.sessionId === null))
          && now - e.createdAt > OUTBOX_TTL_MS;
        if (expired) {
          stores[V2_ENTRIES].delete(e.key);
          e.imageNames.forEach((_n, i) => stores[V2_IMAGES].delete(v2ImageKey(e, i)));
        }
      }
    });
    if (activeUserKey !== account || activeUserEpoch !== epoch) return;
    const loaded = await withV2Transaction<V2Entry[]>('readonly', async (stores) =>
      (await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[]).filter(entry => entry.account === account));
    if (!loaded || activeUserKey !== account || activeUserEpoch !== epoch) return;
    v2ManagedIds.clear();
    v2Generations.clear();
    loaded.forEach(entry => { v2ManagedIds.add(entry.id); v2Generations.set(entry.id, entry.generation); });
    // A v2 record wins over its legacy predecessor by immutable client id.  We
    // intentionally leave the latter on disk until the mixed-version migration
    // can prove that no old writer remains.
    const v2Entries = loaded.map(({ key: _key, account: _account, generation, imageBytes: _imageBytes, ...entry }) => {
      entryGenerations.set(entry, generation);
      return entry;
    });
    const markerValues = await withV2Transaction<unknown[]>('readonly', stores => requestValue(stores[V2_META].getAll()));
    if (activeUserKey !== account || activeUserEpoch !== epoch) return;
    const importedIds = new Set((markerValues ?? []).flatMap(value => {
      const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : null;
      return typeof id === 'string' ? [id] : [];
    }));
    const legacy = readBox(account).filter(entry => !v2ManagedIds.has(entry.id) && !importedIds.has(entry.id));
    entries = [...legacy, ...v2Entries].length === 0 ? EMPTY : Object.freeze([...legacy, ...v2Entries]);
    notify();
    if (MAY_ACTIVATE_OUTBOX_V2) void importLegacyOutbox(account);
  };
  // القفل الحصري يمنع تسابق hydrateV2 المتزامن (أكثر من تبويب)؛ اختياري: بلا locks ينفَّذ مباشرةً.
  if (navigator.locks?.request) {
    await navigator.locks.request('nassaj-outbox-v2', { mode: 'exclusive' }, run);
  } else {
    await run();
  }
}

async function removeV2Entry(id: string, expected?: OutboxEntry): Promise<boolean> {
  const account = activeUserKey;
  const epoch = activeUserEpoch;
  if (!account || !v2ManagedIds.has(id)) return false;
  const removed = await withV2Transaction<boolean>('readwrite', async (stores) => {
    const all = await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[];
    if (activeUserKey !== account || activeUserEpoch !== epoch) throw new Error('stale_account');
    const target = all.find(entry => entry.account === account && entry.id === id);
    // The opaque generation is retained outside the public entry shape.  A
    // timestamp is not an identity and may collide across tabs/reloads.
    if (!target || (expected && target.generation !== entryGenerations.get(expected))) return false;
    stores[V2_ENTRIES].delete(target.key);
    target.imageNames.forEach((_name, index) => stores[V2_IMAGES].delete(v2ImageKey(target, index)));
    return true;
  });
  if (!removed || activeUserKey !== account) return false;
  v2ManagedIds.delete(id);
  v2Generations.delete(id);
  entries = entries.filter(entry => entry.id !== id);
  if (entries.length === 0) entries = EMPTY;
  notify();
  notifyV2Change();
  return true;
}

async function clearV2Account(account: string, onlyWhileInactive = false): Promise<void> {
  const cleared = await withV2Transaction<boolean>('readwrite', async (stores) => {
    const all = await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[];
    // A rapid A→B→A return is a new A generation.  The old switch cleanup
    // must not delete that new private payload after it has rehydrated.
    if (onlyWhileInactive && activeUserKey === account) return false;
    all.filter(entry => entry.account === account).forEach(entry => {
      stores[V2_ENTRIES].delete(entry.key);
      entry.imageNames.forEach((_name, index) => stores[V2_IMAGES].delete(v2ImageKey(entry, index)));
    });
    // Explicit logout is a privacy removal, so its account-specific scheduling
    // metadata goes with the payload. Other accounts remain untouched.
    const keys = await requestValue(stores[V2_META].getAllKeys()) as IDBValidKey[];
    keys.filter(key => typeof key === 'string' && (key.startsWith(`recovery:${account}:`) || key.startsWith(`legacy:${account}:`) || key === activationKey(account)))
      .forEach(key => stores[V2_META].delete(key));
    return true;
  });
  if (cleared) notifyV2Change();
}

async function readV2Images(entry: OutboxEntry): Promise<File[]> {
  const generation = entryGenerations.get(entry);
  if (!generation || !activeUserKey) return [];
  const key = v2EntryKey(activeUserKey, entry.id, generation);
  const files = await withV2Transaction<File[]>('readonly', async (stores) => {
    const result = await Promise.all(entry.imageNames.map((_name, index) => requestValue(stores[V2_IMAGES].get(`${key}\u0000${index}`))));
    return result.filter((file): file is File => file instanceof File);
  });
  return files ?? [];
}

async function patchV2Entry(id: string, patch: (entry: V2Entry) => V2Entry, expectedGeneration = v2Generations.get(id)): Promise<OutboxEntry | null> {
  const account = activeUserKey;
  const epoch = activeUserEpoch;
  if (!account || !v2ManagedIds.has(id) || !expectedGeneration) return null;
  const updated = await withV2Transaction<V2Entry>('readwrite', async (stores) => {
    const all = await requestValue(stores[V2_ENTRIES].getAll()) as V2Entry[];
    if (activeUserKey !== account || activeUserEpoch !== epoch) throw new Error('stale_account');
    const current = all.find(entry => entry.account === account && entry.id === id);
    if (!current || current.generation !== expectedGeneration) throw new Error('stale_generation');
    const next = patch(current);
    stores[V2_ENTRIES].put(next);
    return next;
  });
  if (!updated || activeUserKey !== account || activeUserEpoch !== epoch) return null;
  let committed: OutboxEntry | null = null;
  entries = Object.freeze(entries.map(entry => entry.id === id ? (() => {
    const { key: _key, account: _account, generation, imageBytes: _imageBytes, ...plain } = updated;
    entryGenerations.set(plain, generation);
    committed = plain;
    return plain;
  })() : entry));
  notify();
  notifyV2Change();
  return committed;
}

/* ------------------------------------------------------------------ */
/*  التخزين                                                            */
/* ------------------------------------------------------------------ */

function userKey(userId: string | number | null | undefined): string | null {
  if (userId === null || userId === undefined || userId === '') return null;
  return `${KEY_PREFIX}${String(userId)}`;
}

function readBox(key: string): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredBox;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isWellFormedEntry).map((entry) => ({
      ...entry,
      historyEligibility: entry.historyEligibility === 'text_only' && entry.imageNames.length === 0
        && !(entry.fileCount || entry.fileNames?.length)
        ? 'text_only' : 'ineligible',
    }));
  } catch (error) {
    console.error('[outbox] failed to read the box:', error);
    return [];
  }
}

function isWellFormedEntry(value: unknown): value is OutboxEntry {
  const entry = value as OutboxEntry;
  return Boolean(
    entry
    && typeof entry.id === 'string' && entry.id
    && typeof entry.projectId === 'string'
    && typeof entry.text === 'string'
    && typeof entry.createdAt === 'number'
    && Array.isArray(entry.imageNames),
  );
}

/**
 * B-1034 — التخليص التلقائي قبل فحص السعة في معاملة v2.
 *
 * تُستدعى داخل معاملة readwrite بعد استرداد owned. تُخلي ما يجوز حذفه
 * وتُعيد ما أُخلي للتحديث في الذاكرة بعد الالتزام.
 * لا تمسّ أبداً: `failed` و`unconfirmed`.
 */
function evictV2ForAdmission(
  owned: V2Entry[],
  candidate: V2Entry,
  stores: Record<string, IDBObjectStore>,
  now: number,
): V2Entry[] {
  const evicted: V2Entry[] = [];
  let live = [...owned];

  const doEvict = (entry: V2Entry) => {
    stores[V2_ENTRIES].delete(entry.key);
    entry.imageNames.forEach((_n, i) => stores[V2_IMAGES].delete(v2ImageKey(entry, i)));
    evicted.push(entry);
    live = live.filter(e => e.id !== entry.id);
  };

  // (a) مسلَّم تجاوز TTL
  for (const e of [...owned]) {
    if (e.status === 'delivered' && now - e.createdAt > OUTBOX_TTL_MS) doEvict(e);
  }

  // (b) يتيم معلَّق تجاوز TTL — لا سبيل إلى التحقّق منه (B-553)
  for (const e of [...owned]) {
    if (e.status === 'pending' && e.sessionId === null && now - e.createdAt > OUTBOX_TTL_MS) doEvict(e);
  }

  // (c) إن بقي التجاوز فأخلِ المسلَّم الأقدم حتى يتّسع المخزن
  const projected = () => [...live.filter(e => e.id !== candidate.id), candidate];
  const isOverCapacity = () => {
    const p = projected();
    const meta = p.map(({ key: _k, account: _a, generation: _g, imageBytes: _ib, ...v }) => v);
    return p.length > MAX_OUTBOX_ENTRIES || utf8Bytes(meta) > MAX_OUTBOX_BYTES
      || p.reduce((s, e) => s + e.imageBytes, 0) > MAX_OUTBOX_IMAGE_BYTES;
  };
  if (isOverCapacity()) {
    // نصّي (بلا صور) أولاً — الأقدم فالأقدم، ثم حامل الصور أخيراً (يُضحّى به تحت الضغط فقط)
    for (const e of [...live]
      .filter(e => e.status === 'delivered')
      .sort((a, b) => {
        const aImg = a.imageNames.length > 0 ? 1 : 0;
        const bImg = b.imageNames.length > 0 ? 1 : 0;
        if (aImg !== bImg) return aImg - bImg;
        return a.createdAt - b.createdAt;
      })) {
      if (!isOverCapacity()) break;
      doEvict(e);
    }
  }

  return evicted;
}

/** Preserve every local copy until canonical evidence or an explicit removal. */
function pruneForWrite(candidates: OutboxEntry[]): { kept: OutboxEntry[]; dropped: OutboxEntry[] } {
  return { kept: [...candidates].sort((a, b) => a.createdAt - b.createdAt), dropped: [] };
}

function serializedBytes(list: OutboxEntry[]): number {
  return utf8Bytes({ version: 1, entries: list });
}

function writeBox(key: string, list: OutboxEntry[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, entries: list } satisfies StoredBox));
    return true;
  } catch (error) {
    console.error('[outbox] failed to persist the box:', error);
    return false;
  }
}

function commit(next: OutboxEntry[], requireEntryId?: string): boolean {
  if (!activeUserKey) return false;
  const { kept, dropped } = pruneForWrite(next);
  // The legacy envelope is a migration input only.  A v1 mutation may share
  // an in-memory snapshot with v2 entries, but it must never serialize them
  // back into localStorage (which would create a second mutable payload).
  const legacy = kept.filter(entry => !v2ManagedIds.has(entry.id));
  if (legacy.length > MAX_OUTBOX_ENTRIES || serializedBytes(legacy) > MAX_OUTBOX_BYTES
    || (requireEntryId && !kept.some((entry) => entry.id === requireEntryId))) return false;
  if (!writeBox(activeUserKey, legacy)) return false;
  entries = kept.length === 0 ? EMPTY : Object.freeze([...kept]);
  if (dropped.length > 0) void blobStore.deleteMany(dropped.flatMap(blobKeysFor));
  notify();
  return true;
}

/**
 * ‏B-553/م6 — تبويبات المتصفّح الواحد ترى صندوقاً واحداً.
 *
 * ‏`commit` يكتب القائمة كاملةً من لقطة ذاكرته، ولم يكن ثمّ مستمعُ `storage`.
 * فتبويبان مفتوحان على نفس الأصل — وهو نمطٌ معتاد في نسّاج لا حالة نادرة —
 * أحدهما بائتُ اللقطة: يُحيي إدخالاً حذفه الآخر بعد تأكيده (بطاقةٌ تُبعث على
 * رسالةٍ سُلِّمت)، أو يمحو إدخالاً حيّاً كتبه الآخر (ضياعُ كلام).
 *
 * والمزامنة قراءةٌ لا كتابة: التبويب الذي غيّر الصندوق كتبه بالفعل، وهذا
 * يُحاذي لقطته عليه بلا أن يُعيد كتابة شيء — فلا حلقة بين تبويبين.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!activeUserKey) return;
    if (event.key === V2_NOTIFICATION_KEY) { void hydrateV2(activeUserKey); return; }
    if (event.key !== activeUserKey) return;
    const fresh = readBox(activeUserKey).filter(entry => !v2ManagedIds.has(entry.id));
    const v2Current = entries.filter(entry => v2ManagedIds.has(entry.id));
    entries = [...fresh, ...v2Current].length === 0 ? EMPTY : Object.freeze([...fresh, ...v2Current]);
    notify();
    void hydrateV2(activeUserKey);
  });
}

/* ------------------------------------------------------------------ */
/*  دورة حياة المستخدم                                                 */
/* ------------------------------------------------------------------ */

/** يمسح صناديق كل من سوى `keepKey`، ويُرجع عددَ ما مسحه. */
function purgeForeignBoxes(keepKey: string | null): number {
  try {
    const doomed = Object.keys(localStorage).filter(
      (key) => key.startsWith(KEY_PREFIX) && key !== keepKey,
    );
    doomed.forEach((key) => localStorage.removeItem(key));
    return doomed.length;
  } catch (error) {
    console.error('[outbox] failed to purge foreign boxes:', error);
    return 0;
  }
}

/**
 * يربط الصندوق الحيّ بالمستخدم الحالي.
 *
 * • **تبنّي** مستخدم ⇒ تُمسح صناديق كل من سواه. الأصل واحد والحساب ليس كذلك؛
 *   صندوقٌ متروك في متصفّح مشترك تسريبُ كلامٍ لغير أهله. وإن وُجد صندوق غريب
 *   فعلاً ومُسح، مُسحت **الصور كلها** معه: مخزن الكائنات لا يُعدَّد بمفتاح
 *   مستخدم، ومسحُه حينها أضمن من ترك بقايا حسابٍ آخر. وهذا لا يقع في إعادة
 *   تحميلٍ عادية لنفس المستخدم — لا صندوق غريب هناك — فصورُه تصمد.
 * • **فكّ الارتباط** (`null`) ⇒ إخلاء اللقطة الحيّة **بلا مسحٍ للقرص**. الحالة
 *   الأولى قبل أن يُحسم التوثيق `null` أيضاً، والمسح هناك كان سيُتلف صندوق
 *   صاحبه عند كل إعادة تحميل. المسح فعلُ خروجٍ صريح، و`clearOutbox` وحدها تفعله.
 * • عند التبنّي يُرقّى كل `pending` إلى `unconfirmed`: شاهدُ تلك الجولة انقطع
 *   بإغلاق الصفحة، فلا يجوز وسمُها «فشلت» ولا تركُها خفيّةً إلى الأبد.
 */
export function setOutboxUser(userId: string | number | null | undefined): void {
  const key = userKey(userId);
  if (key === activeUserKey) return;

  const previousAccount = activeUserKey;
  activeUserEpoch += 1;
  activeUserKey = key;
  v2ManagedIds.clear();
  v2Generations.clear();
  if (previousAccount) void clearV2Account(previousAccount, true);

  if (!key) {
    entries = EMPTY;
    notify();
    return;
  }

  // A different authenticated account never reads this key.  Keep foreign v1
  // sources untouched during migration: their unscoped images cannot be
  // cleared safely on a switch without destroying a recoverable payload.

  // B-521: لا تُرقّى `pending` هنا. الترقية عند التبنّي كانت تقلب رسالةً سليمة
  // إلى بطاقة إنذار مع كل إعادة تحميل: التبنّي يقع لحظة التوثيق — قبل أن يصل
  // أي علم عن الجلسات الجارية — فيستحيل تمييز «جولةٌ تعمل الآن» من «شاهدٌ
  // انقطع». وعلى محادثةٍ قائمة لا يصل أي دليل قبول قبل `complete`، فبقاء
  // الإدخال `pending` طوال دقائق التشغيل هو الوضع الطبيعي لا الشاذّ.
  // الحكم صار **مشتقّاً لحظة العرض** (`selectVisibleEntries`) حيث تكون حالة
  // الجلسة معلومة، فلا تُكتب على القرص حالةٌ كاذبة يصعب التراجع عنها.
  const stored = readBox(key);
  entries = stored.length === 0 ? EMPTY : Object.freeze(stored);
  if (!commit(stored)) notify();
  // The old envelope remains read-only migration input.  A v2 snapshot replaces
  // matching client ids only after it has been read from its own database.
  void hydrateV2(key);
}

/** الخروج: لا صندوق ولا صور لأحد على هذا الجهاز. */
export function clearOutbox(): void {
  const account = activeUserKey;
  activeUserEpoch += 1;
  activeUserKey = null;
  v2ManagedIds.clear();
  v2Generations.clear();
  purgeForeignBoxes(null);
  if (account) void clearV2Account(account);
  void blobStore.clearAll();
  entries = EMPTY;
  notify();
}

/* ------------------------------------------------------------------ */
/*  العمليات                                                           */
/* ------------------------------------------------------------------ */

/**
 * ‏B-553/م3 — حكم الحمولة على إدخال الصندوق، **دالّة صرفة**.
 *
 * العلّة المقيسة (مراجعة qa-critic 2026-08-07): الحكم كان يُستهلَك داخل
 * ‏`useChatRealtimeHandlers`، وهو خطّافُ `ChatInterface` — ومكوّنٌ يُفكَّك فعلاً
 * عند تبويب الطرفيات وأثناء التحميل وبلا مشروع مختار. وبوابةُ خطّ الأساس فيه
 * تُسقط كل حدثٍ سبق التركيب عمداً (وهو صواب للمؤشّرات، وكارثيّ للحكم): من
 * أرسل ثم انتقل إلى الطرفيات حتى أقلعت جلسته لا يصله قبولٌ أبداً، فيبقى
 * إدخاله معلَّقاً — وإن كان من محادثة جديدة بقي يتيماً فظهر على كل شاشة
 * محادثة جديدة اثنتي عشرة ساعة.
 *
 * فالحكم صار يُستهلَك في `AppContent` — طبقةٌ لا تُفكَّك خلف بوابة المصادقة —
 * وهذه الدالّة هي كل منطقه، مستخرجةً كي تُختبر بلا تركيب شجرة.
 *
 * ‏`isActiveViewSession` يخصّ حالةً واحدة: رفضُ `session_busy` يُعالَج في
 * الشاشة المعروضة بردّ النصّ إلى المُؤلِّف (B-518)، فبطاقةٌ فوقه نسختان من
 * كلامٍ واحد. أمّا خارجها فلا ردّ يقع، فالبطاقة هي النسخة الأخيرة.
 */
export type OutboxVerdict =
  | { action: 'confirm'; id: string }
  | { action: 'unconfirmed'; id: string }
  | {
    action: 'fail';
    id: string;
    code: string;
    detail: string | null;
    sameClientMsgIdRetryable?: boolean;
  };

export function resolveOutboxVerdict(
  msg: {
    kind?: unknown;
    clientMsgId?: unknown;
    newSessionId?: unknown;
    success?: unknown;
    aborted?: unknown;
    error?: unknown;
    code?: unknown;
    sameClientMsgIdRetryable?: unknown;
    deliveryDisposition?: unknown;
    notStarted?: unknown;
  },
  context: {
    isActiveViewSession: boolean;
    readErrorCode: (m: unknown) => string | null;
    readErrorDetail: (m: unknown) => string | null;
  },
): OutboxVerdict | null {
  const id = typeof msg.clientMsgId === 'string' ? msg.clientMsgId : '';
  if (!id) return null;

  if (msg.kind === 'session_created') {
    // مولدُ جلسةٍ بمعرّف فارغ = فشلُ إقلاعٍ صريح. وبمعرّفٍ صحيح = قبولٌ مؤكَّد:
    // الجولة بدأت والرسالة في سجلّها.
    return msg.newSessionId
      ? { action: 'confirm', id }
      : {
        action: 'fail',
        id,
        code: context.readErrorCode(msg) ?? 'session_create_failed',
        detail: context.readErrorDetail(msg),
        ...(typeof msg.sameClientMsgIdRetryable === 'boolean'
          ? { sameClientMsgIdRetryable: msg.sameClientMsgIdRetryable }
          : {}),
      };
  }

  if (msg.kind === 'complete') {
    // ‏`aborted` قرارُ المستخدم لا فشلُ إرسال: الجولة بدأت والرسالة محفوظة.
    if (msg.success === false && !msg.aborted) {
      return {
        action: 'fail',
        id,
        code: context.readErrorCode(msg) ?? 'run_failed',
        detail: typeof msg.error === 'string' ? msg.error : null,
        ...(typeof msg.sameClientMsgIdRetryable === 'boolean'
          ? { sameClientMsgIdRetryable: msg.sameClientMsgIdRetryable }
          : {}),
      };
    }
    return { action: 'confirm', id };
  }

  if (msg.kind === 'error' && (msg.deliveryDisposition !== undefined
    || msg.code === 'message_dispatch_unconfirmed' || msg.code === 'message_dispatch_not_started')) {
    // A catch is not proof that dispatch never started. Only the explicit
    // pre-dispatch certificate allows replay; all other combinations verify.
    if (msg.deliveryDisposition === 'not_started' && msg.notStarted === true
      && msg.sameClientMsgIdRetryable === true) {
      return { action: 'fail', id, code: 'message_dispatch_not_started', detail: null, sameClientMsgIdRetryable: true };
    }
    return { action: 'unconfirmed', id };
  }

  if (msg.kind === 'error') {
    const code = context.readErrorCode(msg);
    if (code === 'session_busy' && context.isActiveViewSession) {
      return { action: 'confirm', id };
    }
    return {
      action: 'fail',
      id,
      code: code ?? 'unknown',
      detail: context.readErrorDetail(msg),
      ...(typeof msg.sameClientMsgIdRetryable === 'boolean'
        ? { sameClientMsgIdRetryable: msg.sameClientMsgIdRetryable }
        : {}),
    };
  }

  return null;
}

/**
 * Apply an outbox verdict synchronously at WebSocket ingress.
 *
 * This is intentionally upstream of React state and the bounded control-event
 * log: neither a same-batch `latestMessage` overwrite, an AppContent remount,
 * StrictMode, nor `MAX_CONTROL_EVENTS` trimming can lose a delivery verdict.
 * `session_busy` remains a conservative failure here. Only the active chat
 * consumer may remove it, after it actually restores the rejected text.
 */
export function consumeOutboxIngressVerdict(msg: Record<string, unknown>): OutboxVerdict | null {
  const readErrorCode = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Record<string, unknown>;
    const structured = payload.error && typeof payload.error === 'object'
      ? payload.error as Record<string, unknown>
      : null;
    if (typeof structured?.code === 'string' && structured.code) return structured.code;
    return typeof payload.code === 'string' && payload.code ? payload.code : null;
  };
  const readErrorDetail = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Record<string, unknown>;
    const structured = payload.error && typeof payload.error === 'object'
      ? payload.error as Record<string, unknown>
      : null;
    if (typeof structured?.detail === 'string' && structured.detail) return structured.detail;
    return typeof payload.reason === 'string' && payload.reason ? payload.reason : null;
  };
  const verdict = resolveOutboxVerdict(msg, {
    // Ingress has no trustworthy proof that the active composer restored a
    // rejected send. Therefore session_busy must remain recoverable by card.
    isActiveViewSession: false,
    readErrorCode,
    readErrorDetail,
  });
  if (verdict?.action === 'confirm') {
    if (msg.kind === 'session_created' && typeof msg.newSessionId === 'string' && msg.newSessionId) {
      bindOutboxSession(verdict.id, msg.newSessionId);
    }
    confirmOutboxEntry(verdict.id);
  } else if (verdict?.action === 'unconfirmed') {
    markOutboxDispatchUnconfirmed(verdict.id);
  } else if (verdict?.action === 'fail') {
    markOutboxFailed(verdict.id, {
      code: verdict.code,
      detail: verdict.detail,
      sameClientMsgIdRetryable: verdict.sameClientMsgIdRetryable,
    });
  }
  return verdict;
}

export function createClientMsgId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `cmid_${crypto.randomUUID()}`;
    }
  } catch {
    // يسقط إلى البديل أدناه.
  }
  return `cmid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type RecordOutboxInput = {
  id: string;
  projectId: string;
  sessionId: string | null;
  text: string;
  images?: File[];
  fileNames?: string[];
  historyEligibility?: OutboxHistoryEligibility;
  intent?: OutboxIntent;
  status?: OutboxStatus;
  reasonCode?: string | null;
  reasonDetail?: string | null;
};

/**
 * يكتب الإدخال **فوراً** (النصّ والبيانات الوصفية) ويُلحق الصور لاحقاً.
 *
 * الترتيب مقصود: كتابة النصّ لا تنتظر IndexedDB، فتعذُّر حفظ الصور — أو غياب
 * IndexedDB أصلاً — لا يُسقط حفظ النصّ. وأسماء الصور تُسجَّل في الإدخال حتى وإن
 * فشل حفظ كائناتها، فيرى المستخدم أن رسالته كانت تحمل صوراً بدل أن تختفي بصمت.
 */
export function recordOutboxEntry(input: RecordOutboxInput): OutboxEntry | null {
  if (!activeUserKey) return null;

  const images = input.images ?? [];
  const entry = makeOutboxEntry(input);

  if (!commit([...entries.filter((existing) => existing.id !== entry.id), entry], entry.id)) {
    // B-1042: فشل v1 السنكروني — السبب الممكن الوحيد هو امتلاء السعة (commit
    // تُعيد false فقط عند تجاوز MAX_OUTBOX_ENTRIES/MAX_OUTBOX_BYTES).
    admissionRefused = true;
    notify();
    return null;
  }
  // القبول نجح — أسقط الراية بلا إشعار مستقل (commit أرسلته بالفعل).
  admissionRefused = false;

  if (images.length > 0) {
    const writes = Promise.all(images.map(async (file, index) => {
      try {
        await blobStore.put(blobKey(entry.id, index), file);
        return true;
      } catch (error) {
        console.error('[outbox] failed to persist an image:', error);
        return false;
      }
    }));
    imageWrites.set(entry, writes.then(results => results.every(Boolean)));
  }

  return entry;
}

/** A correlated dispatch error preserves payloads and exposes verification, never replay. */
export function markOutboxDispatchUnconfirmed(id: string): boolean {
  if (!activeUserKey || !id) return false;
  const target = entries.find(entry => entry.id === id);
  if (!target || target.status === 'delivered') return false;
  const patch = <T extends OutboxEntry>(entry: T): T => entry.status === 'delivered' ? entry : ({
    ...entry, status: 'unconfirmed', reasonCode: 'message_dispatch_unconfirmed',
    reasonDetail: null, sameClientMsgIdRetryable: false,
  });
  if (v2ManagedIds.has(id)) {
    void patchV2Entry(id, patch);
    return true;
  }
  return commit(entries.map(entry => entry.id === id ? patch(entry) : entry), id);
}

/** ترقية إدخال معلّق إلى «فاشل» — أو تسجيله فاشلاً ابتداءً إن لم يكن موجوداً. */
export function markOutboxFailed(
  id: string,
  reason: { code?: string | null; detail?: string | null; sameClientMsgIdRetryable?: boolean } = {},
): boolean {
  if (!activeUserKey || !id) return false;
  const target = entries.find((entry) => entry.id === id);
  if (!target || target.status === 'delivered') return false;
  if (v2ManagedIds.has(id)) {
    void patchV2Entry(id, entry => entry.status === 'delivered' ? entry : ({ ...entry, status: 'failed', reasonCode: reason.code ?? entry.reasonCode ?? 'unknown',
      reasonDetail: reason.detail ?? null, sameClientMsgIdRetryable: reason.sameClientMsgIdRetryable }));
    return true;
  }
  return commit(
    entries.map((entry) =>
      entry.id === id
        ? {
          ...entry,
          status: 'failed' as const,
          reasonCode: reason.code ?? entry.reasonCode ?? 'unknown',
          reasonDetail: reason.detail ?? null,
          sameClientMsgIdRetryable: reason.sameClientMsgIdRetryable,
        }
        : entry,
    ),
    id,
  );
}

/**
 * إعادة الإرسال جارية ⇒ يعود الإدخال معلَّقاً فتختفي بطاقته حتى يصل حكمُ
 * المحاولة الجديدة. بقاؤها «فاشلاً» أثناء محاولةٍ حيّة يدعو إلى ضغطةٍ ثانية.
 */
export function markOutboxPending(id: string): boolean {
  if (!activeUserKey || !id) return false;
  const target = entries.find((entry) => entry.id === id);
  if (!target || target.status === 'delivered') return false;
  if (v2ManagedIds.has(id)) {
    void patchV2Entry(id, entry => entry.status === 'delivered' ? entry : ({ ...entry, status: 'pending', retryBlockCode: undefined, reasonCode: null,
      reasonDetail: null, sameClientMsgIdRetryable: undefined, createdAt: Date.now() }));
    return true;
  }
  /**
   * ‏B-553/م5 — المحاولة الجديدة تُنعش الختم الزمنيّ.
   *
   * مهلةُ الشكّ تُقاس من `createdAt`، فإدخالٌ عمره أكثر من تسعين ثانية كان
   * يعود «مشكوكاً فيه» في اللحظة نفسها التي أُعيد فيها إلى `pending` — أي أن
   * زرّ «إعادة الإرسال» يبدو بلا أثر، فيضغطه المستخدم ثانيةً، فمحادثتان من
   * رسالة واحدة. والعقد المكتوب فوق هذه الدالّة يَعِد صراحةً بأن البطاقة
   * «تختفي حتى يصل حكم المحاولة الجديدة» — فليكن.
   */
  return commit(
    entries.map((entry) =>
      entry.id === id
        ? {
          ...entry,
          status: 'pending' as const,
          retryBlockCode: undefined,
          reasonCode: null,
          reasonDetail: null,
          sameClientMsgIdRetryable: undefined,
          createdAt: Date.now(),
        }
        : entry,
    ),
    id,
  );
}

/** Awaitable transition for retry callers which must read the replacement only
 * after its v2 transaction committed. */
export async function markOutboxPendingDurably(id: string): Promise<OutboxEntry | null> {
  const target = entries.find(entry => entry.id === id);
  if (!target || target.status === 'delivered') return null;
  if (v2ManagedIds.has(id)) {
    const committed = await patchV2Entry(id, entry => entry.status === 'delivered' ? entry : ({ ...entry, status: 'pending', retryBlockCode: undefined, reasonCode: null,
      reasonDetail: null, sameClientMsgIdRetryable: undefined, createdAt: Date.now() }));
    return committed?.status === 'pending' ? committed : null;
  }
  return markOutboxPending(id) ? (entries.find(entry => entry.id === id) ?? null) : null;
}

/** Atomically restore an unsent retry without overwriting newer delivery evidence. */
export function restorePreparedOutboxRetry(
  expectedPending: OutboxEntry,
  original: OutboxEntry,
  code: OutboxRetryBlockCode,
): boolean {
  if (original.status !== 'failed' || original.id !== expectedPending.id
    || expectedPending.status !== 'pending'
    || entries.find(entry => entry.id === expectedPending.id) !== expectedPending) return false;
  if (v2ManagedIds.has(original.id)) {
    void patchV2Entry(original.id, entry => ({ ...entry, ...original, key: entry.key, account: entry.account,
      generation: entry.generation, imageBytes: entry.imageBytes, retryBlockCode: code }));
    return true;
  }
  return commit(entries.map(entry => entry === expectedPending
    ? { ...original, retryBlockCode: code } : entry), original.id);
}

/** Durable conditional rollback used by retry preparation.  The condition is
 * evaluated inside the v2 transaction so a concurrent delivered verdict wins. */
export async function restorePreparedOutboxRetryDurably(
  expectedPending: OutboxEntry, original: OutboxEntry, code: OutboxRetryBlockCode,
): Promise<OutboxEntry | null> {
  if (original.status !== 'failed' || original.id !== expectedPending.id || expectedPending.status !== 'pending') return null;
  if (!v2ManagedIds.has(original.id)) {
    return restorePreparedOutboxRetry(expectedPending, original, code)
      ? (entries.find(entry => entry.id === original.id) ?? null) : null;
  }
  const committed = await patchV2Entry(original.id, entry => {
    if (entry.status !== 'pending' || entry.createdAt !== expectedPending.createdAt) return entry;
    return { ...entry, ...original, key: entry.key, account: entry.account, generation: entry.generation,
      imageBytes: entry.imageBytes, retryBlockCode: code };
  }, entryGenerations.get(expectedPending));
  return committed?.status === 'failed' && committed.retryBlockCode === code ? committed : null;
}

export type OutboxRetryMode = 'same_id' | 'new_id' | 'verify';

const AMBIGUOUS_RETRY_CODES = new Set([
  'client_msg_id_already_started',
  'client_msg_id_fingerprint_mismatch',
]);

/** Decides whether a card may replay, must mint a new turn, or needs verification. */
export function outboxRetryMode(entry: OutboxEntry): OutboxRetryMode {
  if (entry.status === 'pending' || entry.status === 'unconfirmed' || entry.status === 'delivered') return 'verify';
  if (entry.reasonCode && AMBIGUOUS_RETRY_CODES.has(entry.reasonCode)) return 'verify';
  return entry.sameClientMsgIdRetryable === true ? 'same_id' : 'new_id';
}

/**
 * Receipt proves acceptance, not canonical history visibility. Keep the text and
 * attachments until an exact canonical user identity is loaded or the user removes it.
 */
export function confirmOutboxEntry(id: string): boolean {
  const target = entries.find((entry) => entry.id === id);
  if (!target) return false;
  if (target.status === 'delivered') return true;
  if (v2ManagedIds.has(id)) {
    void patchV2Entry(id, entry => ({ ...entry, status: 'delivered', reasonCode: null, reasonDetail: null, sameClientMsgIdRetryable: false }));
    return true;
  }
  return commit(entries.map((entry) => entry.id === id
    ? { ...entry, status: 'delivered', reasonCode: null, reasonDetail: null, sameClientMsgIdRetryable: false }
    : entry), id);
}

export function removeOutboxEntry(id: string): boolean {
  if (!activeUserKey || !id) return false;
  const target = entries.find((entry) => entry.id === id);
  if (!target) return false;
  if (v2ManagedIds.has(id)) {
    // Do not publish deletion until the entry and every image key committed in
    // the same transaction.  A failed transaction leaves the recovery copy.
    void removeV2Entry(id, target);
    return true;
  }
  if (!commit(entries.filter((entry) => entry.id !== id))) return false;
  void blobStore.deleteMany(blobKeysFor(target));
  return true;
}

/** User-initiated edit/delete and controlled retry rollback may await this
 * boundary.  It is intentionally separate from proof deletion. */
export async function removeOutboxEntryExplicit(id: string): Promise<boolean> {
  const target = entries.find(entry => entry.id === id);
  if (!target) return false;
  if (v2ManagedIds.has(id)) return removeV2Entry(id, target);
  return removeOutboxEntry(id);
}

/** Prepare an explicit dismissal of this account's currently received local copies. */
export function createDeliveredOutboxDismissal(): () => number {
  const owner = activeUserKey;
  const received = entries.filter((entry) => entry.status === 'delivered');
  return () => {
    let removed = 0;
    // B-1042: أسقط الراية قبل الحذف حتى يرى المشتركون الحالة النهائية الصحيحة
    // في أول إشعار يصلهم من removeOutboxEntry. إن لم يُحذف شيء (جميع النسخ
    // أُخليَت بالـTTL مسبقاً) أُرسل إشعار مستقل.
    const wasRefused = admissionRefused;
    admissionRefused = false;
    for (const entry of received) {
      if (activeUserKey !== owner) break;
      // A replacement, retry, or newly received entry was not part of this action.
      if (entries.includes(entry) && entry.status === 'delivered' && removeOutboxEntry(entry.id)) removed += 1;
    }
    if (wasRefused && removed === 0) notify();
    return removed;
  };
}

/** Await and read back replacement blobs before relinquishing the original copy. */
export async function verifyOutboxImagePersistence(entry: OutboxEntry, expected: File[]): Promise<boolean> {
  if (expected.length === 0) return true;
  if (!v2ManagedIds.has(entry.id) && !await imageWrites.get(entry)) return false;
  const saved = await readOutboxRetryPayload(entry);
  return saved.ok && saved.images.length === expected.length && saved.images.every((file, index) =>
    file.name === expected[index].name && file.size === expected[index].size
    && file.type === expected[index].type && file.lastModified === expected[index].lastModified);
}

/** Record a retry obstacle without rewriting the original transport/server verdict. */
export function blockOutboxRetry(id: string, code: OutboxRetryBlockCode): boolean {
  if (v2ManagedIds.has(id)) { void patchV2Entry(id, entry => ({ ...entry, retryBlockCode: code })); return true; }
  return commit(entries.map((entry) => entry.id === id ? { ...entry, retryBlockCode: code } : entry), id);
}

/** Read the complete original retry payload; never infer missing file metadata as zero. */
export async function readOutboxRetryPayload(entry: OutboxEntry): Promise<
  { ok: true; images: File[] } | { ok: false; code: OutboxRetryBlockCode }
> {
  if (!Array.isArray(entry.fileNames) || !entry.fileNames.every(name => typeof name === 'string')
    || !Number.isSafeInteger(entry.fileCount) || entry.fileCount !== entry.fileNames.length) {
    return { ok: false, code: 'attachment_payload_unknown' };
  }
  if (entry.fileNames.length > 0) return { ok: false, code: 'attachment_files_unavailable' };
  if (entry.imageNames.length === 0) return { ok: true, images: [] };
  let images: File[];
  try {
    images = v2ManagedIds.has(entry.id) ? await readV2Images(entry) : await blobStore.getMany(blobKeysFor(entry));
  } catch {
    return { ok: false, code: 'attachment_images_unreadable' };
  }
  if (!Array.isArray(images) || images.length === 0) return { ok: false, code: 'attachment_images_missing' };
  if (images.length !== entry.imageNames.length
    || images.some((file, index) => !(file instanceof File) || file.name !== entry.imageNames[index])) {
    return { ok: false, code: 'attachment_images_incomplete' };
  }
  return { ok: true, images };
}

/** ربطُ إدخالٍ أُرسل قبل مولد الجلسة بمعرّفها بعد ولادته. */
export function bindOutboxSession(id: string, sessionId: string): void {
  if (!activeUserKey || !id || !sessionId) return;
  const target = entries.find((entry) => entry.id === id);
  if (!target || target.sessionId === sessionId) return;
  if (v2ManagedIds.has(id)) { void patchV2Entry(id, entry => ({ ...entry, sessionId })); return; }
  commit(entries.map((entry) => (entry.id === id ? { ...entry, sessionId } : entry)), id);
}

/** كائنات الصور الأصلية لإعادة الرفع أو للمعاينة. قائمة فارغة عند أي تعذُّر. */
export async function readOutboxImages(id: string): Promise<File[]> {
  const target = entries.find((entry) => entry.id === id);
  if (!target || target.imageNames.length === 0) return [];
  try {
    return v2ManagedIds.has(id) ? await readV2Images(target) : await blobStore.getMany(blobKeysFor(target));
  } catch (error) {
    console.error('[outbox] failed to read images:', error);
    return [];
  }
}

/**
 * مهلة الشكّ في إدخال معلَّق (B-521). حاجزٌ ضدّ نافذة الثواني الأولى: بين
 * `send` وبدء العملية لا تكون الجلسة «جارية» بعد، فلولا المهلة لظهرت بطاقة
 * إنذار على رسالةٍ في طريقها. أما الطول فيحمله شرطُ «الجلسة ليست جارية» لا هي.
 */
export const OUTBOX_SUSPECT_AFTER_MS = 90 * 1000;

/**
 * هل يُعرض إدخالٌ معلَّق كـ«لم يصل تأكيد»؟ (B-521 — حكمٌ مشتقّ لا مخزَّن.)
 *
 * `pending` ليست حالة فشل بل «أُرسل ولم يصل حكم». وعلى محادثةٍ قائمة لا يحمل
 * `clientMsgId` إلا `complete` و`error`، فالإدخال يظلّ معلَّقاً طوال دقائق
 * التشغيل — وهذا صحيح. فلا يُشكّ فيه إلا باجتماع شرطين:
 *   • مضت مهلة الشكّ على إنشائه، **و**
 *   • لا جولة تعمل على جلسته الآن.
 * والشرط الثاني هو الحاسم: جولةٌ حيّة تعني أن الرسالة سُلِّمت ونُفِّذت مهما طال
 * زمنها، ووسمُها «لم يصل تأكيد» كذبٌ يدفع المستخدم إلى إرسالٍ مكرّر.
 */
export function isSuspectPending(
  entry: OutboxEntry,
  now: number,
  isSessionLive: (sessionId: string | null) => boolean,
  isSessionStateAuthoritative: (sessionId: string | null) => boolean = () => true,
): boolean {
  if (entry.status !== 'pending') return false;
  /**
   * ‏B-553/م2 — الإدخال اليتيم (`sessionId: null`) **لا يُشكّ فيه أبداً**.
   *
   * وُلد في محادثةٍ لم تُنشأ بعد، فليس له سجلٌّ يُسأل عنه: التحقّق التلقائي
   * يستسلم له بلا سؤال، وزرّ «تحقّق» يحكم عليه بالفشل ظلماً. وحين لا سبيل إلى
   * حكمٍ يبقى العرض ظنّاً محضاً — ظنٌّ ظهر للمالك على **كل** شاشة محادثة
   * جديدة اثنتي عشرة ساعة، ورسالتُه منفَّذةٌ ومحادثتُها تعمل (حادثة 2026-08-07).
   *
   * ولا يضيع كلامه بهذا: فشلُ النقل الصريح يُسجَّل `failed` لا `pending`،
   * والبطاقة الحمراء تظهر كما كانت. المحجوب هو **الإنذار الظنّي** وحده.
   */
  if (!entry.sessionId) return false;
  if (isSessionLive(entry.sessionId)) return false;
  // B-749: انقطاع قناة الحالة لا يعني خمود الجولة. أثناء reconnect لا يستطيع
  // العميل تمييز `idle` من «آخر process_state لم يصل»، لذلك لا يصدر إنذار
  // «لم يصل تأكيد» ظنياً. عند عودة القناة يصبح الحكم نافذاً مجدداً، فيتحقق
  // المؤلف من السجل أو يعرض البطاقة. الفشل الصريح لا يمر بهذا الفرع أصلاً.
  if (!isSessionStateAuthoritative(entry.sessionId)) return false;
  return now - entry.createdAt >= OUTBOX_SUSPECT_AFTER_MS;
}

/**
 * الإدخالات **المعروضة** لجلسةٍ بعينها: ما طابق نطاقها وكان `failed`، أو
 * `unconfirmed` (حالة مخزَّنة من إصدار سابق)، أو معلَّقاً مشكوكاً فيه.
 *
 * ‏`isSessionLive` مُحقَنة لا مستوردة كي تبقى الدالّة صرفة وقابلة للاختبار بلا
 * متجر عالمي؛ وحذفُها يجعل كل معلَّقٍ قديم مشكوكاً فيه (السلوك المحافظ).
 */
export function selectVisibleEntries(
  all: readonly OutboxEntry[],
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  options?: {
    now?: number;
    isSessionLive?: (sessionId: string | null) => boolean;
    isSessionStateAuthoritative?: (sessionId: string | null) => boolean;
  },
): OutboxEntry[] {
  if (!projectId) return [];
  const scopedSessionId = sessionId ?? null;
  const now = options?.now ?? Date.now();
  const isSessionLive = options?.isSessionLive ?? (() => false);
  const isSessionStateAuthoritative = options?.isSessionStateAuthoritative ?? (() => true);
  return all.filter(
    (entry) =>
      entry.projectId === projectId
      && (entry.sessionId ?? null) === scopedSessionId
      // T-1648: receipt-confirmed copies stay protected in storage, not in recovery notices.
      && entry.status !== 'delivered'
      && (entry.status !== 'pending'
        || isSuspectPending(entry, now, isSessionLive, isSessionStateAuthoritative)),
  );
}

/** Text-only receipts cannot prove the presence of an original attachment payload. */
export function canReconcileOutboxHistory(entry: OutboxEntry): boolean {
  const provider = entry.intent.provider;
  if (provider === 'codex') return Array.isArray(entry.fileNames) && entry.fileNames.length === 0;
  return ['claude', 'qwen', 'hermes', 'kimi', 'deepseek', 'glm'].includes(provider ?? '')
    && entry.historyEligibility === 'text_only' && entry.imageNames.length === 0
    && Array.isArray(entry.fileNames) && entry.fileNames.length === 0;
}

type CanonicalHistoryRow = { id: string; sessionId: string; kind: string; role?: string; clientMsgId?: string;
  provider?: string; content?: string; images?: unknown[]; imagesOmitted?: number; deferredPayload?: unknown; files?: unknown[] };

/**
 * Positive proof matrix.  Native client identity is the identity proof;
 * payload fields merely prove that every original submitted part survived the
 * projection.  Equal text by itself is deliberately never a match.
 */
export type OutboxCanonicalProof = Readonly<{ account: string; epoch: number; id: string; generation: string; sessionId: string;
  projectId: string; provider: string; coverage: 'text' | 'text_images' }>;
const AUTOMATIC_RECOVERY_KEY = 'nassaj_ob2_automatic_recovery';
function automaticRecoveryEnabled(): boolean {
  try { return localStorage.getItem(AUTOMATIC_RECOVERY_KEY) !== 'disabled'; } catch { return false; }
}

export function hasCanonicalOutboxProof(entry: OutboxEntry, serverRows: readonly CanonicalHistoryRow[]): OutboxCanonicalProof | null {
  if (!canReconcileOutboxHistory(entry) || !entry.sessionId || !entry.id) return null;
  const matches = serverRows.some((row) => {
    if (row.sessionId !== entry.sessionId || row.kind !== 'text' || row.role !== 'user') return false;
    if (row.clientMsgId !== entry.id) return false;
    if (row.deferredPayload || (row.imagesOmitted ?? 0) > 0 || (row.files?.length ?? 0) > 0) return false;
    if (row.provider !== entry.intent.provider) return false;
    if (row.content !== entry.text) return false;
    if (entry.intent.provider === 'codex') return entry.imageNames.length === 0
      ? (!row.images || (Array.isArray(row.images) && row.images.length === 0))
      : Array.isArray(row.images) && row.images.length === entry.imageNames.length;
    return entry.imageNames.length === 0 && (!row.images || row.images.length === 0);
  });
  const account = activeUserKey;
  const generation = entryGenerations.get(entry);
  return matches && account && generation ? { account, epoch: activeUserEpoch, id: entry.id, generation, sessionId: entry.sessionId,
    projectId: entry.projectId, provider: entry.intent.provider!, coverage: entry.imageNames.length > 0 ? 'text_images' : 'text' } : null;
}

export function getOutboxAccountEpoch(): number { return activeUserEpoch; }

/** Reserve one of the persisted five rolling history reads for an account/session.
 * The caller must reserve before it starts any network request. */
export async function reserveOutboxRecoveryAttempt(scope: string, now = Date.now()): Promise<boolean> {
  const account = activeUserKey;
  if (!account || !scope || !supportsSafeV2Storage()) return false;
  const metaKey = `recovery:${account}:${scope}`;
  const result = await withV2Transaction<boolean>('readwrite', async (stores) => {
    const allMeta = await requestValue(stores[V2_META].getAll()) as unknown[];
    const allKeys = await requestValue(stores[V2_META].getAllKeys()) as IDBValidKey[];
    const owned = allKeys.filter(key => typeof key === 'string' && key.startsWith(`recovery:${account}:`));
    // Budget state is not a permanent ledger.  Expired scopes are removed
    // transactionally, including after their last protected entry disappeared.
    owned.forEach((key) => {
      const position = allKeys.indexOf(key);
      const values = Array.isArray(allMeta[position]) ? allMeta[position] as unknown[] : [];
      if (values.every(value => typeof value === 'number' && now - value >= 24 * 60 * 60 * 1000)) stores[V2_META].delete(key);
    });
    const liveOwned = owned.filter((key) => {
      const position = allKeys.indexOf(key);
      const values = Array.isArray(allMeta[position]) ? allMeta[position] as unknown[] : [];
      return values.some(value => typeof value === 'number' && now - value < 24 * 60 * 60 * 1000);
    });
    const current = await requestValue(stores[V2_META].get(metaKey)) as number[] | undefined;
    const timestamps = (Array.isArray(current) ? current : []).filter(value => Number.isFinite(value) && now - value < 24 * 60 * 60 * 1000);
    if (timestamps.length >= 5 || (!liveOwned.includes(metaKey) && liveOwned.length >= 100)) return false;
    const proposed = [...timestamps, now];
    const prospective = [...liveOwned.filter(key => key !== metaKey).map(key => String(key)), metaKey];
    // Measure the post-prune transaction state, not stale expired arrays which
    // have already been scheduled for deletion above.
    const retainedMeta = allMeta.filter((_value, index) => {
      const key = allKeys[index];
      return !(typeof key === 'string' && key.startsWith(`recovery:${account}:`)) || liveOwned.includes(key);
    });
    if (utf8Bytes({ meta: retainedMeta, scopes: prospective, attempts: proposed }) > MAX_OUTBOX_META_BYTES) return false;
    stores[V2_META].put(proposed, metaKey);
    return true;
  });
  return result === true;
}

/** Deletion accepts only a freshly minted full canonical proof and revalidates
 * account epoch plus opaque generation inside the v2 transaction. */
export async function removeOutboxEntryWithProof(entry: OutboxEntry, proof: OutboxCanonicalProof): Promise<boolean> {
  if (!automaticRecoveryEnabled() || proof.account !== activeUserKey || proof.epoch !== activeUserEpoch || proof.id !== entry.id
    || proof.sessionId !== entry.sessionId || proof.projectId !== entry.projectId || proof.provider !== entry.intent.provider
    || proof.coverage !== (entry.imageNames.length > 0 ? 'text_images' : 'text') || proof.generation !== entryGenerations.get(entry)) return false;
  return removeV2Entry(entry.id, entry);
}

/** Canonical history only: an exact user identity in the same session proves delivery. */
export function hasOutboxDeliveryEvidence(
  serverRows: readonly { id: string; sessionId: string; kind: string; role?: string; clientMsgId?: string }[],
  sessionId: string,
  clientMsgId: string,
): boolean {
  return Boolean(clientMsgId) && serverRows.some((row) =>
    row.sessionId === sessionId && row.kind === 'text' && row.role === 'user'
    && (row.clientMsgId === clientMsgId || row.id === clientMsgId));
}

/** Reconcile newly loaded canonical history without retrying a send or fetching again. */
export function reconcileOutboxDeliveryEvidence(
  sessionId: string,
  serverRows: Parameters<typeof hasOutboxDeliveryEvidence>[0],
): void {
  for (const entry of getOutboxSnapshot()) {
    const proof = entry.sessionId === sessionId ? hasCanonicalOutboxProof(entry, serverRows) : null;
    if (proof) {
      void removeOutboxEntryWithProof(entry, proof);
    }
  }
}

/** Query durable ingress evidence; an old server, malformed response, or outage stays unknown. */
export async function verifyOutboxReceipt(
  sessionId: string, clientMsgId: string, provider: string | undefined,
  fetchReceipt: (url: string, options?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
  signal?: AbortSignal,
): Promise<'accepted' | 'unknown'> {
  if (!provider) return 'unknown';
  try {
    const response = await fetchReceipt(`/api/providers/sessions/${encodeURIComponent(sessionId)}/message-delivery/${encodeURIComponent(clientMsgId)}?provider=${encodeURIComponent(provider)}`, { signal });
    if (!response.ok) return 'unknown';
    const body = await response.json() as Record<string, any>;
    const receipt = body?.receipt;
    const matches = (value: Record<string, unknown> | undefined) => value
      && value.sessionId === sessionId && value.clientMsgId === clientMsgId && value.provider === provider;
    return body?.status === 'accepted' && matches(body) && matches(receipt)
      && receipt.source === 'ingress_receipt' && typeof receipt.content === 'string'
      && typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt)) ? 'accepted' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Bounded, cancellable receipt recovery. Never dispatches or replays a message. */
export function createOutboxReceiptRecovery(
  verify: (entry: OutboxEntry, signal: AbortSignal) => Promise<boolean | 'accepted'>,
  settled: (entry: OutboxEntry, verdict: boolean | 'accepted') => void,
) {
  const jobs = new Map<string, { entry: OutboxEntry; attempts: number; controller?: AbortController; timer?: ReturnType<typeof setTimeout> }>();
  const completed = new Set<string>();
  let disposed = false;
  const delays = [0, 2_000, 5_000, 15_000, 30_000];
  const run = async (job: { entry: OutboxEntry; attempts: number; controller?: AbortController; timer?: ReturnType<typeof setTimeout> }) => {
    job.timer = undefined;
    job.attempts += 1;
    let verdict: boolean | 'accepted' = false;
    const checkedEntry = job.entry;
    job.controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<false>((resolve) => {
      job.controller!.signal.addEventListener('abort', () => resolve(false), { once: true });
      deadline = setTimeout(() => job.controller?.abort(), 10_000);
    });
    try { verdict = await Promise.race([verify(checkedEntry, job.controller.signal), aborted]); }
    catch { /* Unknown remains recoverable. */ }
    finally { clearTimeout(deadline); }
    if (disposed || jobs.get(job.entry.id) !== job) return;
    // A replacement snapshot invalidates the old request, but does not reset
    // its budget or launch a second request while the first is still pending.
    if (checkedEntry !== job.entry) verdict = false;
    else {
      if (verdict !== false) {
        jobs.delete(job.entry.id);
        completed.add(job.entry.id);
      }
      settled(job.entry, verdict);
    }
    if (verdict === false && job.attempts < delays.length && jobs.get(job.entry.id) === job) {
      job.timer = setTimeout(() => { void run(job); }, delays[job.attempts]);
    }
  };
  return {
    reconcile(candidates: readonly OutboxEntry[]) {
      const eligible = candidates.filter((entry) => entry.status !== 'delivered' && entry.status !== 'failed' && entry.sessionId);
      const ids = new Set(eligible.map((entry) => entry.id));
      for (const [id, job] of jobs) {
        if (!ids.has(id)) { clearTimeout(job.timer); jobs.delete(id); job.controller?.abort(); }
      }
      if (disposed) return;
      for (const entry of eligible) {
        if (completed.has(entry.id)) continue;
        const existing = jobs.get(entry.id);
        if (existing) { existing.entry = entry; continue; }
        const job = { entry, attempts: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        jobs.set(entry.id, job);
        job.timer = setTimeout(() => { void run(job); }, 0);
      }
    },
    reset(id: string) {
      completed.delete(id);
      const job = jobs.get(id);
      if (job) { clearTimeout(job.timer); job.controller?.abort(); }
      jobs.delete(id);
    },
    dispose() {
      disposed = true;
      for (const job of jobs.values()) { clearTimeout(job.timer); job.controller?.abort(); }
      jobs.clear();
      completed.clear();
    },
  };
}
