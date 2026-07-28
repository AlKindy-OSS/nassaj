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

// `exports` is the current (non-deprecated) runtime key; the @types lag behind
// it (they still only declare `namedExports`), so the options object is cast.
mock.module('../utils/api', {
  exports: {
    api: {
      get: (_endpoint: string) => getResponse(),
      put: (_endpoint: string, body: unknown) => {
        lastPutBody = body;
        return putResponse(body);
      },
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

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
      'gemini-settings',
      'selected-provider',
      'claude-model',
      'antigravity-model',
    ]) {
      assert.ok(keys.has(expected), `expected synced key: ${expected}`);
    }
    for (const local of [
      'activeTab',
      'showParticipantsBar',
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

describe('hydratePreferencesFromServer', () => {
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
