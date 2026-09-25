import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Unit coverage for the account-scoped preference sync layer.
 *
 * `preferencesSync` imports `../utils/api`; we mock it so each test controls the
 * GET/PUT responses, then stub the browser globals (window/localStorage) the
 * module reads. `mock.module` requires `--experimental-test-module-mocks` (the
 * project `test` script already passes it).
 */

type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

// Mutable handles the mocked api closes over so each test can swap behaviour.
let getResponse: () => Promise<FetchResponse>;
let putResponse: (body: unknown) => Promise<FetchResponse>;
let lastPutBody: unknown;

mock.module('../utils/api', {
  namedExports: {
    authenticatedFetch: (endpoint: string, options: unknown) =>
      (globalThis.fetch as (url: string, init: unknown) => Promise<FetchResponse>)(endpoint, options),
    hasAuthenticatedSession: () => Boolean(globalThis.localStorage?.getItem('auth-token')),
    api: {
      get: (_endpoint: string) => getResponse(),
      put: (_endpoint: string, body: unknown) => {
        lastPutBody = body;
        return putResponse(body);
      },
    },
  },
});

const ok = (value: unknown): Promise<FetchResponse> =>
  Promise.resolve({ ok: true, status: 200, json: async () => value });
const notFound = (): Promise<FetchResponse> =>
  Promise.resolve({ ok: false, status: 404, json: async () => ({}) });

// Minimal localStorage + window stubs.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

let dispatched: Array<{ type: string; detail?: unknown }> = [];

const installGlobals = () => {
  const storage = new MemoryStorage();
  (globalThis as Record<string, unknown>).localStorage = storage;
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      dispatched.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  // CustomEvent/Event shims for the module's dispatch calls.
  (globalThis as Record<string, unknown>).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  (globalThis as Record<string, unknown>).Event = class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
  return storage;
};

let sync: typeof import('./preferencesSync');

beforeEach(async () => {
  installGlobals();
  dispatched = [];
  lastPutBody = undefined;
  getResponse = () => ok({ preferences: {} });
  putResponse = () => ok({ preferences: {} });
  sync = await import('./preferencesSync');
  sync.__resetPreferenceSyncForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe('synced key registry', () => {
  it('includes every owner key the decision list requires and excludes device-local keys', () => {
    const keys = new Set(sync.getSyncedStorageKeys());
    for (const expected of [
      'theme',
      'nassaj-theme-preset',
      'userLanguage',
      'uiPreferences',
      'notificationSoundEnabled',
      'codeEditorTheme',
      'codeEditorFontSize',
      'claude-settings',
      'cursor-tools-settings',
      'codex-settings',
      'selected-provider',
      'claude-model',
      'antigravity-model',
    ]) {
      assert.ok(keys.has(expected), `expected synced key: ${expected}`);
    }
    for (const local of [
      'activeTab',
      'auth-token',
      'permissionMode-abc',
    ]) {
      assert.ok(!keys.has(local), `device-local key must not sync: ${local}`);
    }
  });
});

describe('collectLocalPreferences', () => {
  it('decodes JSON-shaped values and keeps plain strings, skipping unset keys', () => {
    localStorage.setItem('theme', 'dark'); // plain string
    localStorage.setItem('uiPreferences', JSON.stringify({ sidebarVisible: false }));
    const out = sync.collectLocalPreferences();
    assert.equal(out.theme, 'dark');
    assert.deepEqual(out.uiPreferences, { sidebarVisible: false });
    assert.ok(!('userLanguage' in out), 'unset key must be omitted');
    assert.ok(!('rtlLayout' in out), 'rtlLayout is no longer synced (derived from userLanguage)');
  });
});

describe('applyServerPreferences', () => {
  it('writes values to localStorage and dispatches a live-apply event per key', () => {
    sync.applyServerPreferences({ theme: 'dark', userLanguage: 'en' });
    assert.equal(localStorage.getItem('theme'), 'dark');
    assert.equal(localStorage.getItem('userLanguage'), 'en');
    const applyEvents = dispatched.filter((e) => e.type === 'preferences:apply');
    assert.equal(applyEvents.length, 2);
  });

  it('ignores rtlLayout from server (no longer a synced preference)', () => {
    sync.applyServerPreferences({ rtlLayout: true } as Record<string, unknown>);
    assert.equal(localStorage.getItem('rtlLayout'), null, 'rtlLayout must not be written');
  });

  it('ignores unknown forward-compat keys', () => {
    sync.applyServerPreferences({ someFutureKey: 'x' } as Record<string, unknown>);
    assert.equal(localStorage.getItem('someFutureKey'), null);
  });
});

describe('write mirror', () => {
  /** Installs the mirror over the current stubs and captures keepalive flushes. */
  const armMirror = () => {
    const sent: unknown[] = [];
    (globalThis as Record<string, unknown>).fetch = (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200 });
    };
    localStorage.setItem('auth-token', 't');
    sync.installPreferenceWriteMirror();
    return sent;
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).fetch;
  });

  it('mirrors a real change but never a rewrite of the identical value', () => {
    const sent = armMirror();

    localStorage.setItem('theme', 'light'); // genuine change
    sync.flushPendingWritesNow();
    assert.deepEqual(sent, [{ theme: 'light' }]);

    // ThemeContext re-persisting its boot value / a value it just adopted from
    // the account. Republishing it would let a stale client overwrite the
    // choice another client just made (theme snapping back to dark).
    localStorage.setItem('theme', 'light');
    sync.flushPendingWritesNow();
    assert.equal(sent.length, 1, 'identical rewrite must not reach the account');

    localStorage.setItem('theme', 'dark');
    sync.flushPendingWritesNow();
    assert.deepEqual(sent[1], { theme: 'dark' });
  });

  it('flushes a pending change immediately so a fast reload cannot lose it', () => {
    const sent = armMirror();
    localStorage.setItem('theme', 'light'); // still inside the 500ms debounce
    sync.flushPendingWritesNow();
    assert.deepEqual(sent, [{ theme: 'light' }], 'debounced write must survive teardown');
  });

  /* B-567 — كتابة التطبيع لا تُصفّر تفضيلات الحساب.
   *
   * مخزن التفضيلات يكتب مرّةً عند أوّل اشتراك ليُثبّت شكل القيمة المخزَّنة
   * (ترحيل مفاتيح مفردة قديمة، ختم `__v`). تلك كتابةُ آلةٍ لا قرارُ مستخدم،
   * وكانت تدخل الطابور فتُرى `hasUnsyncedWrite('uiPreferences')`، فيتخطّى
   * الترطيبُ مفتاحَ التفضيلات كلَّه ثم يُفرَغ الطابور فتُدفع القيم المحلية
   * فوق الحساب. أي أنّ الدخول من متصفّح جديد كان قد يمحو تفضيلات الحساب —
   * وهو بعينه عَرَض «إعدادي رجع». */
  it('a suppressed normalisation write neither reaches the account nor blocks hydration', async () => {
    const sent = armMirror();
    const accountValue = JSON.stringify({ showThinking: false, sendByCtrlEnter: true, __v: 9 });
    getResponse = () => ok({ preferences: { uiPreferences: accountValue } });

    // المخزن يُثبّت شكله محلياً قبل أن يعود GET — مكتوماً عن المرآة.
    sync.withMirrorSuppressed(() => {
      localStorage.setItem('uiPreferences', JSON.stringify({ showThinking: true, __v: 1 }));
    });

    const result = await sync.hydratePreferencesFromServer();
    sync.flushPendingWritesNow();

    assert.equal(result.status, 'applied');
    assert.equal(
      localStorage.getItem('uiPreferences'),
      accountValue,
      'قيمة الحساب مرجع: التطبيع المكتوم لا يحجبها',
    );
    assert.deepEqual(sent, [], 'التطبيع لا يُرسَل إلى الحساب إطلاقاً');
  });

  /* الوجه المقابل، يُثبت أنّ الحارس هو الفارق لا مصادفةً في الترتيب: نفس
   * التسلسل بلا كتم يُنتج السلوك المعطوب — الترطيب يتخطّى المفتاح. */
  it('the same write WITHOUT suppression is what blocks hydration (B-567 mechanism)', async () => {
    armMirror();
    getResponse = () =>
      ok({ preferences: { uiPreferences: JSON.stringify({ showThinking: false, __v: 9 }) } });

    const local = JSON.stringify({ showThinking: true, __v: 1 });
    localStorage.setItem('uiPreferences', local); // بلا كتم → يدخل الطابور

    await sync.hydratePreferencesFromServer();

    assert.equal(
      localStorage.getItem('uiPreferences'),
      local,
      'الكتابة غير المكتومة تحجب قيمة الحساب — وهذا ما يمنعه الحارس',
    );
  });

  it('restores the previous suppression state (nested calls stay safe)', () => {
    const sent = armMirror();

    sync.withMirrorSuppressed(() => {
      sync.withMirrorSuppressed(() => {
        localStorage.setItem('theme', 'dark');
      });
      // العودة من الداخلي يجب ألّا تُعيد تسليح المرآة داخل الخارجي.
      localStorage.setItem('userLanguage', 'ar');
    });
    sync.flushPendingWritesNow();
    assert.deepEqual(sent, [], 'لا شيء يُرسَل من داخل الكتم المتداخل');

    // وبعد الخروج تعود المرآة إلى عملها الطبيعي.
    localStorage.setItem('theme', 'light');
    sync.flushPendingWritesNow();
    assert.deepEqual(sent, [{ theme: 'light' }], 'المرآة تُستأنف بعد الكتم');
  });

  it('does not let a server payload overwrite a change still queued locally', async () => {
    armMirror();
    localStorage.setItem('theme', 'light'); // user just chose light
    getResponse = () => ok({ preferences: { theme: 'dark', userLanguage: 'ar' } });

    const result = await sync.hydratePreferencesFromServer();

    assert.equal(result.status, 'applied');
    assert.equal(localStorage.getItem('theme'), 'light', 'queued local choice wins');
    assert.equal(localStorage.getItem('userLanguage'), 'ar', 'other keys still hydrate');
  });

  /* B-444 — الاختيار لا يُبتلع عند فشل الإرسال.
   * كانت الدفعة تُمسح قبل انتظار الردّ، فأي انقطاع (إعادة تشغيل الخادم، 4G
   * متذبذب) يفقد التغيير صامتاً ثم يعيده الترطيب التالي إلى قيمة الحساب. */
  it('keeps a failed batch queued instead of dropping it', async () => {
    const sent: unknown[] = [];
    let failNext = true;
    (globalThis as Record<string, unknown>).fetch = (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      if (failNext) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve({ ok: true, status: 200 });
    };
    localStorage.setItem('auth-token', 't');
    sync.installPreferenceWriteMirror();

    localStorage.setItem('theme', 'light');
    sync.flushPendingWritesNow();

    await new Promise((resolve) => setImmediate(resolve)); // ريثما يعود الرفض

    failNext = false;
    sync.flushPendingWritesNow(); // العودة من الخلفية / اتصال عاد
    assert.deepEqual(sent, [{ theme: 'light' }, { theme: 'light' }], 'الدفعة الفاشلة تُعاد');
    sync.__resetPreferenceSyncForTests();
  });

  it('protects a failed (still unsent) change from a later server payload', async () => {
    (globalThis as Record<string, unknown>).fetch = () => Promise.reject(new Error('offline'));
    localStorage.setItem('auth-token', 't');
    sync.installPreferenceWriteMirror();

    localStorage.setItem('theme', 'light');
    sync.flushPendingWritesNow();
    await new Promise((resolve) => setImmediate(resolve));

    getResponse = () => ok({ preferences: { theme: 'dark' } });
    await sync.hydratePreferencesFromServer();

    assert.equal(localStorage.getItem('theme'), 'light', 'اختيار لم يصل الحساب بعد لا يُطمس');
    sync.__resetPreferenceSyncForTests();
  });

  it('does not requeue a late account A write after account B becomes active', async () => {
    let rejectA!: (reason?: unknown) => void;
    const sent: unknown[] = [];
    (globalThis as Record<string, unknown>).fetch = (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      if (sent.length === 1) return new Promise((_resolve, reject) => { rejectA = reject; });
      return Promise.resolve({ ok: true, status: 200 });
    };
    sync.setPreferenceIdentityAuthenticated(true);
    sync.installPreferenceWriteMirror();

    localStorage.setItem('theme', 'dark');
    sync.flushPendingWritesNow();
    sync.setPreferenceIdentityAuthenticated(false);
    sync.setPreferenceIdentityAuthenticated(true);
    getResponse = () => ok({ preferences: {} });
    await sync.hydratePreferencesFromServer();
    rejectA(new Error('late A failure'));
    await new Promise((resolve) => setImmediate(resolve));

    localStorage.setItem('theme', 'light');
    sync.flushPendingWritesNow();
    assert.deepEqual(sent, [{ theme: 'dark' }, { theme: 'light' }]);
  });

  it('a transient GET failure does not disable the write mirror for the session', async () => {
    const sent = armMirror();
    getResponse = () => Promise.reject(new Error('server restarting'));

    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'unavailable');

    localStorage.setItem('theme', 'light');
    sync.flushPendingWritesNow();
    assert.deepEqual(sent, [{ theme: 'light' }], 'المرآة تبقى حيّة بعد عطل عابر');
  });
});

describe('hydratePreferencesFromServer', () => {
  it('removes account A values before delayed account B hydration can paint', async () => {
    localStorage.setItem('theme', 'dark');
    sync.setPreferenceIdentityAuthenticated(true);
    let releaseB!: (value: FetchResponse) => void;
    getResponse = () => new Promise((resolve) => { releaseB = resolve; });

    sync.setPreferenceIdentityAuthenticated(false);
    assert.equal(localStorage.getItem('theme'), null);
    assert.ok(dispatched.some((event) => event.type === sync.PREFERENCE_APPLY_EVENT
      && (event.detail as { storageKey?: string; rawValue?: string | null })?.storageKey === 'theme'
      && (event.detail as { rawValue?: string | null })?.rawValue === null));
    // A mounted owner may persist its neutral default in response to the clear
    // event. It must not become a user write that blocks B's server value.
    localStorage.setItem('theme', 'neutral-default');

    sync.setPreferenceIdentityAuthenticated(true);
    const hydrationB = sync.hydratePreferencesFromServer();
    assert.equal(localStorage.getItem('theme'), 'neutral-default', 'A must stay absent while B is pending');
    releaseB({ ok: true, status: 200, json: async () => ({ preferences: { theme: 'light' } }) });
    assert.equal((await hydrationB).status, 'applied');
    assert.equal(localStorage.getItem('theme'), 'light');
  });

  it('keeps neutral defaults when account B preference hydration fails', async () => {
    localStorage.setItem('theme', 'dark');
    sync.setPreferenceIdentityAuthenticated(true);
    sync.setPreferenceIdentityAuthenticated(false);
    sync.setPreferenceIdentityAuthenticated(true);
    getResponse = () => Promise.reject(new Error('B unavailable'));
    assert.equal((await sync.hydratePreferencesFromServer()).status, 'unavailable');
    assert.equal(localStorage.getItem('theme'), null);
  });

  it('device sessions hydrate without a Bearer token', async () => {
    sync.setPreferenceIdentityAuthenticated(true);
    getResponse = () => ok({ preferences: { theme: 'dark' } });
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'applied');
    assert.equal(localStorage.getItem('theme'), 'dark');
  });

  it('a late account A read cannot overwrite account B preferences', async () => {
    sync.setPreferenceIdentityAuthenticated(true);
    let releaseA!: (value: FetchResponse) => void;
    getResponse = () => new Promise((resolve) => { releaseA = resolve; });
    const hydrationA = sync.hydratePreferencesFromServer();

    sync.setPreferenceIdentityAuthenticated(false);
    sync.setPreferenceIdentityAuthenticated(true);
    getResponse = () => ok({ preferences: { theme: 'light' } });
    assert.equal((await sync.hydratePreferencesFromServer()).status, 'applied');
    releaseA({ ok: true, status: 200, json: async () => ({ preferences: { theme: 'dark' } }) });
    assert.equal((await hydrationA).status, 'skipped');
    assert.equal(localStorage.getItem('theme'), 'light');
  });

  it('applies a non-empty server payload (server is authoritative)', async () => {
    localStorage.setItem('auth-token', 't');
    localStorage.setItem('theme', 'light'); // local differs
    getResponse = () => ok({ preferences: { theme: 'dark', userLanguage: 'ar' } });
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'applied');
    assert.equal(localStorage.getItem('theme'), 'dark');
    assert.equal(localStorage.getItem('userLanguage'), 'ar');
  });

  it('seeds the account from local values when the server returns {}', async () => {
    localStorage.setItem('auth-token', 't');
    localStorage.setItem('theme', 'dark');
    // rtlLayout is no longer synced; direction is derived from userLanguage.
    localStorage.setItem('rtlLayout', 'true'); // stale value — must NOT be seeded
    getResponse = () => ok({ preferences: {} });
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'seeded');
    assert.equal((lastPutBody as Record<string, unknown>).theme, 'dark');
    assert.ok(!('rtlLayout' in (lastPutBody as Record<string, unknown>)), 'rtlLayout must not be seeded');
  });

  it('does not seed a brand-new browser (no local values) → defaults stand', async () => {
    localStorage.setItem('auth-token', 't');
    getResponse = () => ok({ preferences: {} });
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'skipped');
    assert.equal(lastPutBody, undefined, 'must not PUT when there is nothing to seed');
  });

  it('degrades gracefully on a 404 (route not live yet) — no throw, marks unavailable', async () => {
    localStorage.setItem('auth-token', 't');
    localStorage.setItem('theme', 'dark');
    getResponse = () => notFound();
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'unavailable');
    // Local value is untouched; the app keeps running on localStorage.
    assert.equal(localStorage.getItem('theme'), 'dark');
  });

  it('degrades gracefully on a network error (api throws)', async () => {
    localStorage.setItem('auth-token', 't');
    getResponse = () => Promise.reject(new Error('network down'));
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'unavailable');
  });

  it('skips entirely when there is no auth token', async () => {
    getResponse = () => ok({ preferences: { theme: 'dark' } });
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'skipped');
    assert.equal(localStorage.getItem('theme'), null);
  });

  it('stops attempting after the route is marked unavailable', async () => {
    localStorage.setItem('auth-token', 't');
    sync.markRouteUnavailable();
    let called = false;
    getResponse = () => {
      called = true;
      return ok({ preferences: { theme: 'dark' } });
    };
    const result = await sync.hydratePreferencesFromServer();
    assert.equal(result.status, 'skipped');
    assert.equal(called, false, 'GET must not fire once route is known-unavailable');
  });
});
