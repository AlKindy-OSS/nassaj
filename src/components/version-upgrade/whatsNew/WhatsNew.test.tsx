import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arCommon from '../../../i18n/locales/ar/common.json';
import enCommon from '../../../i18n/locales/en/common.json';
import {
  UI_PREFERENCES_STORAGE_KEY,
  __resetUiPreferencesStoreForTests,
} from '../../../hooks/useUiPreferences';
import {
  __resetPreferenceSyncForTests,
  hydratePreferencesFromServer,
  installPreferenceWriteMirror,
  setPreferenceIdentityAuthenticated,
} from '../../../preferences/preferencesSync';
import { WHATS_NEW, getWhatsNew } from './highlights';
import {
  WHATS_NEW_SEEN_KEY,
  resolveWhatsNewVersion,
  shouldPushBrowserSeen,
  useWhatsNew,
} from './useWhatsNew';
import { WhatsNewDialog, releaseNotesUrl } from './WhatsNewDialog';

// The account preferences endpoint, driven per test.
const server = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  fail: false,
}));

vi.mock('../../../utils/api', () => {
  const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
  return {
    hasAuthenticatedSession: () => true,
    authenticatedFetch: async () => json({}),
    api: {
      get: async () => {
        if (server.fail) throw new TypeError('network down');
        return json({ preferences: server.preferences });
      },
      put: async (_endpoint: string, body: Record<string, unknown>) => {
        if (server.fail) throw new TypeError('network down');
        server.preferences = { ...server.preferences, ...body };
        return json({ preferences: server.preferences });
      },
    },
  };
});

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { ar: { common: arCommon }, en: { common: enCommon } },
  lng: 'ar',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function Harness({ version, lang = 'ar' }: { version: string | null; lang?: string }) {
  const { version: shown, items, dismiss } = useWhatsNew(version, lang);
  return shown && items ? <WhatsNewDialog version={shown} items={items} onDismiss={dismiss} /> : null;
}

/**
 * Plain-object storage: jsdom's Storage swallows the method patch the write
 * mirror installs (its named-property setter stores "setItem" as an item), so
 * the account sync is exercised against a stub, as in preferencesSync.test.ts.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
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

/** A new browser: empty storage, fresh sync and preference stores. */
function freshBrowser() {
  vi.stubGlobal('localStorage', new MemoryStorage());
  __resetPreferenceSyncForTests();
  __resetUiPreferencesStoreForTests();
  installPreferenceWriteMirror();
}

/** Settle the account preferences the way AuthContext does after sign-in. */
async function signIn() {
  setPreferenceIdentityAuthenticated(true);
  await act(async () => {
    await hydratePreferencesFromServer();
  });
}

/** The account-synced record as the server last received it. */
const accountSeen = () =>
  (server.preferences[UI_PREFERENCES_STORAGE_KEY] as Record<string, unknown> | undefined)
    ?.whatsNewLastSeenVersion;

function renderHarness(version: string | null, lang: 'ar' | 'en' = 'ar') {
  void i18n.changeLanguage(lang);
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness version={version} lang={lang} />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  server.preferences = {};
  server.fail = false;
  freshBrowser();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('highlights data', () => {
  it('seeds 2.3.1.10 and 2.3.1.11 with the same number of items in both languages', () => {
    for (const v of ['2.3.1.10', '2.3.1.11']) {
      expect(WHATS_NEW[v].ar.length).toBeGreaterThan(0);
      expect(WHATS_NEW[v].ar.length).toBe(WHATS_NEW[v].en.length);
    }
  });

  it('picks the language and returns null for an unknown version', () => {
    expect(getWhatsNew('2.3.1.10', 'ar')?.[0]).toBe(WHATS_NEW['2.3.1.10'].ar[0]);
    expect(getWhatsNew('2.3.1.10', 'en-US')?.[0]).toBe(WHATS_NEW['2.3.1.10'].en[0]);
    expect(getWhatsNew('9.9.9.9', 'ar')).toBeNull();
    expect(getWhatsNew('constructor', 'ar')).toBeNull();
    expect(getWhatsNew(null, 'ar')).toBeNull();
  });
});

describe('resolveWhatsNewVersion', () => {
  it('shows for a new version with an entry, never for a seen or unknown one', () => {
    expect(resolveWhatsNewVersion('2.3.1.10', [null, null], 'ar')).toBe('2.3.1.10');
    expect(resolveWhatsNewVersion('2.3.1.10', ['2.3.1.9', null], 'ar')).toBe('2.3.1.10');
    expect(resolveWhatsNewVersion('2.3.1.10', ['2.3.1.10', null], 'ar')).toBeNull();
    expect(resolveWhatsNewVersion('2.3.1.10', [null, '2.3.1.10'], 'ar')).toBeNull();
    expect(resolveWhatsNewVersion('9.9.9.9', ['2.3.1.10'], 'ar')).toBeNull();
    expect(resolveWhatsNewVersion('—', [], 'ar')).toBeNull();
  });
});

describe('shouldPushBrowserSeen', () => {
  it('migrates a browser record the account lacks, never overwrites a newer account one', () => {
    expect(shouldPushBrowserSeen('2.3.1.10', null, '2.3.1.11')).toBe(true);
    expect(shouldPushBrowserSeen('2.3.1.11', '2.3.1.10', '2.3.1.11')).toBe(true);
    expect(shouldPushBrowserSeen('2.3.1.10', '2.3.1.11', '2.3.1.11')).toBe(false);
    expect(shouldPushBrowserSeen('2.3.1.10', '2.3.1.10', '2.3.1.10')).toBe(false);
    expect(shouldPushBrowserSeen(null, null, '2.3.1.10')).toBe(false);
  });
});

describe('WhatsNew popup', () => {
  beforeEach(signIn);

  it('shows the highlights once, and dismissing with OK persists the version', () => {
    renderHarness('2.3.1.10');
    const dialog = screen.getByTestId('whats-new-dialog');
    expect(dialog.textContent).toContain(WHATS_NEW['2.3.1.10'].ar[0]);
    expect(screen.getAllByRole('listitem')).toHaveLength(WHATS_NEW['2.3.1.10'].ar.length);

    fireEvent.click(screen.getByRole('button', { name: arCommon.dialog.ok }));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.10');

    cleanup();
    renderHarness('2.3.1.10');
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
  });

  it('shows again once the running version changes to another with an entry', () => {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, '2.3.1.10');
    renderHarness('2.3.1.11', 'en');
    expect(screen.getByTestId('whats-new-dialog').textContent).toContain(WHATS_NEW['2.3.1.11'].en[0]);
  });

  it('does not show when the version has no entry', () => {
    renderHarness('9.9.9.9');
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBeNull();
  });

  it('closes and persists through the close button and Escape', () => {
    renderHarness('2.3.1.10');
    fireEvent.click(screen.getByRole('button', { name: arCommon.whatsNew.close }));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.10');

    cleanup();
    window.localStorage.clear();
    renderHarness('2.3.1.11');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.11');
  });

  it('links to the public release page and labels the dialog', () => {
    renderHarness('2.3.1.10');
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(releaseNotesUrl('2.3.1.10'));
    expect(link.getAttribute('href')).toMatch(/\/releases\/tag\/v2\.3\.1\.10$/);
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('WhatsNew once per user', () => {
  it('stays hidden until the account preferences have loaded', async () => {
    renderHarness('2.3.1.10');
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();

    await signIn();
    expect(screen.getByTestId('whats-new-dialog')).toBeTruthy();
  });

  it('does not show on a fresh browser when the account already saw the version', async () => {
    server.preferences = { [UI_PREFERENCES_STORAGE_KEY]: { whatsNewLastSeenVersion: '2.3.1.10' } };
    renderHarness('2.3.1.10');
    await signIn();
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBeNull();
  });

  it('saves the dismissal to the account preferences', async () => {
    await signIn();
    renderHarness('2.3.1.10');
    fireEvent.click(screen.getByRole('button', { name: arCommon.dialog.ok }));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    await waitFor(() => expect(accountSeen()).toBe('2.3.1.10'));

    // Another device: empty localStorage, same account.
    cleanup();
    freshBrowser();
    renderHarness('2.3.1.10');
    await signIn();
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
  });

  it('migrates a legacy per-browser record to the account and treats it as seen', async () => {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, '2.3.1.10');
    server.preferences = { theme: 'dark' };
    renderHarness('2.3.1.10');
    await signIn();
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    await waitFor(() => expect(accountSeen()).toBe('2.3.1.10'));
  });

  it('shows at most once in this browser when the sync is offline', async () => {
    server.fail = true;
    renderHarness('2.3.1.10');
    await signIn();
    fireEvent.click(screen.getByRole('button', { name: arCommon.dialog.ok }));
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.10');

    cleanup();
    __resetPreferenceSyncForTests();
    __resetUiPreferencesStoreForTests();
    renderHarness('2.3.1.10');
    await signIn();
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
  });
});
