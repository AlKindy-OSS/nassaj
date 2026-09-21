import { useSyncExternalStore } from 'react';

/**
 * useMediaQuery — يشترك في استعلام وسائط ويعيد **بوليان**.
 *
 * لماذا `useSyncExternalStore` ولماذا بوليان تحديداً؟ لأن React 18 يقارن لقطات
 * المخزن بالهوية: لقطةٌ تبني كائناً جديداً كلّ نداء تعني «تغيّرت» في كل تصيير،
 * فتُنتج تحذير `The result of getSnapshot should be cached` وحلقة تصيير غير
 * محدودة. البدائية ثابتة الهوية بالقيمة فتسقط المشكلة من أصلها — ولهذا **لا
 * يُعاد كائن من هنا أبداً**، ومن أراد قيمتين اشترك مرّتين.
 *
 * ولماذا الاشتراك لا القراءة مرّة؟ لأن البيئة تتغيّر تحت المستخدم فعلاً:
 * تدوير الجهاز، وصل لوحة مفاتيح بلوحة لمس إلى جهاز لوحي، تصغير نافذة. القراءة
 * المجمَّدة تجعل أي قيمة مشتقّة منها تكذب حتى إعادة التحميل.
 *
 * المخازن مُشتركة لكل استعلام (خريطة على مستوى الوحدة)، فعشرة مستهلكين
 * لاستعلام واحد = مستمع `change` واحد لا عشرة.
 */

type QueryStore = {
  matches: boolean;
  listeners: Set<() => void>;
  mql: MediaQueryList | null;
  detach: (() => void) | null;
};

const stores = new Map<string, QueryStore>();

/**
 * ‏`matchMedia` غير موجودة في jsdom ولا في بيئة الاختبار العقدية ولا أثناء
 * التصيير على الخادم. الغياب **لا يرمي** — يعود بـ`false` كي لا تُسقط ميزةُ
 * عرضٍ عشراتِ الاختبارات التي تركّب مستهلكاً للتفضيلات.
 */
const hasMatchMedia = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

const getStore = (query: string): QueryStore => {
  const existing = stores.get(query);
  if (existing) {
    return existing;
  }

  const mql = hasMatchMedia() ? window.matchMedia(query) : null;
  const store: QueryStore = {
    matches: mql?.matches ?? false,
    listeners: new Set(),
    mql,
    detach: null,
  };

  stores.set(query, store);
  return store;
};

const subscribe = (query: string) => (listener: () => void) => {
  const store = getStore(query);
  store.listeners.add(listener);

  if (store.mql && !store.detach) {
    const onChange = (event: MediaQueryListEvent) => {
      if (store.matches === event.matches) {
        return;
      }
      store.matches = event.matches;
      for (const l of store.listeners) l();
    };
    // Safari <14 لا يعرف addEventListener على MediaQueryList؛ الارتداد إلى
    // addListener المهجورة يُبقي الميزة عاملة هناك بدل أن تتجمّد صامتة.
    if (typeof store.mql.addEventListener === 'function') {
      store.mql.addEventListener('change', onChange);
      store.detach = () => store.mql?.removeEventListener('change', onChange);
    } else if (typeof store.mql.addListener === 'function') {
      store.mql.addListener(onChange);
      store.detach = () => store.mql?.removeListener(onChange);
    }
  }

  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.detach?.();
      store.detach = null;
    }
  };
};

/** لقطة الخادم ثابتة ولا تلمس `window` إطلاقاً (تفادي عدم تطابق الترطيب). */
const getServerSnapshot = (): boolean => false;

export function useMediaQuery(query: string): boolean {
  const store = getStore(query);
  return useSyncExternalStore(
    subscribe(query),
    () => store.matches,
    getServerSnapshot,
  );
}

/** اختبارات فقط: يُسقط المخازن المشتركة ليبدأ الاختبار التالي نظيفاً. */
export function __resetMediaQueryStoresForTests(): void {
  for (const store of stores.values()) {
    store.detach?.();
  }
  stores.clear();
}
