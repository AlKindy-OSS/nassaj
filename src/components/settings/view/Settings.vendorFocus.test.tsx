/**
 * T-1867 MEDIUM 1 (qa round): a deep link to `{tab:'vendors', companyId}`
 * (produced by `ProviderSelectionEmptyState.tsx`) makes `VendorsSettingsTab`
 * scroll a specific company's key field into view. The settings content
 * scroll-reset effect (T-1867) used to run its "scroll to top" AFTER that
 * child effect (plain `useEffect` order), undoing it. This mounts the REAL
 * `VendorsSettingsTab` (unlike `Settings.test.tsx`, which stubs every tab) to
 * prove the reset no longer fights the field focus for this deep link.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
}));

const fetchMock = vi.fn();
fetchMock.mockImplementation((url: string) => {
  const data = url.includes('/company/anthropic/key')
    ? { companyId: 'anthropic', writable: true, slots: [] }
    : { companyId: 'other', writable: true, slots: [] };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
});
vi.mock('../../../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

vi.mock('../../auth', () => ({ useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }) }));
vi.mock('../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({ preferences: {}, setPreference: () => {} }),
}));
vi.mock('../../../hooks/useWebPush', () => ({
  useWebPush: () => ({ permission: 'default', isSubscribed: false, isLoading: false, subscribe: async () => {}, unsubscribe: async () => {} }),
}));
vi.mock('../../provider-auth/view/ProviderLoginModal', () => ({ default: () => null }));

// كل تبويبٍ آخر — لا علاقة له بهذا الحارس — يبقى مُغيَّباً؛ `VendorsSettingsTab`
// وحده حقيقي، لأن الأثر المتسابق هو أثره هو لا أثر أي لوحٍ آخر.
vi.mock('../view/tabs/agents-settings/AgentsSettingsTab', () => ({ default: () => <div>agents-tab</div> }));
vi.mock('../view/tabs/AppearanceSettingsTab', () => ({ default: () => <div>appearance-tab</div> }));
vi.mock('../view/tabs/api-settings/CredentialsSettingsTab', () => ({ default: () => <div>api-tab</div> }));
vi.mock('../view/tabs/git-settings/GitSettingsTab', () => ({ default: () => <div>git-tab</div> }));
vi.mock('../view/tabs/NotificationsSettingsTab', () => ({ default: () => <div>notifications-tab</div> }));
vi.mock('../view/tabs/AboutTab', () => ({ default: () => <div>about-tab</div> }));
vi.mock('../view/tabs/profile-settings/ProfileSettingsTab', () => ({ default: () => <div>profile-tab</div> }));
vi.mock('../view/tabs/users-settings/UsersSettingsTab', () => ({ default: () => <div>users-tab</div> }));
vi.mock('../view/tabs/references-settings/ReferencesSettingsTab', () => ({ default: () => <div>references-tab</div> }));
vi.mock('../view/tabs/CommandBoardSettingsTab', () => ({ default: () => <div>command-board-tab</div> }));
vi.mock('../view/tabs/SystemSettingsTab', () => ({ default: () => <div>system-tab</div> }));
vi.mock('./tabs/ConnectorsSettingsTab', () => ({ default: () => <div>connectors-tab</div> }));

vi.mock('../hooks/useSettingsController', () => ({
  useSettingsController: () => ({
    activeTab: 'vendors',
    setActiveTab: () => {},
    saveStatus: null,
    projectSortOrder: 'name',
    setProjectSortOrder: () => {},
    codeEditorSettings: {},
    updateCodeEditorSetting: () => {},
    claudePermissions: {},
    setClaudePermissions: () => {},
    notificationPreferences: { channels: {} },
    setNotificationPreferences: () => {},
    codexPermissionMode: 'default',
    setCodexPermissionMode: () => {},
    providerAuthStatus: {},
    checkProviderAuthStatus: async () => {},
    openLoginForProvider: () => {},
    showLoginModal: false,
    setShowLoginModal: () => {},
    loginProvider: '',
    handleLoginComplete: () => {},
  }),
}));

import Settings from './Settings';

afterEach(() => cleanup());

describe('T-1867 MEDIUM 1: تركيز حقل شركةٍ عبر رابطٍ عميق لا يُبطَله سكرول الإعادة', () => {
  it('يُمرَّر حقل المفتاح إلى مجال الرؤية، ولا يعيد الغلاف السكرول إلى الأعلى إطلاقاً', async () => {
    // يُرصَد على البدائية قبل الرسم بأكمله — لا على عقدة `<main>` بعد ظهورها —
    // لأن أثر الإعادة قد يُنفَّذ أثناء التركيب الأول نفسه (`useLayoutEffect`
    // على تغيّر `activeTab` من `undefined` إلى `'vendors'`)، وسبقُ الرصد يضمن
    // أنه يلتقط تلك النافذة الزمنية أيضاً لا اللاحقة لها فقط.
    const scrollToSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollToSpy });
    const scrollIntoViewSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoViewSpy });

    render(
      <Settings isOpen onClose={() => {}} deepLink={{ tab: 'vendors', companyId: 'anthropic' }} />,
    );

    await waitFor(() => {
      expect(document.getElementById('company-api-key-anthropic')).toBeTruthy();
    });

    // `VendorsSettingsTab`'s own effect calls scrollIntoView on the field —
    // proof it actually ran and reached the DOM.
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    // The settings content wrapper's reset must never fire while a vendor
    // focus target is pending — the structural fix (skip, not just reorder).
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});
