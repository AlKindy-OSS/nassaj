/**
 * T-1867: يبقى محتوى الإعدادات — والتبويب النشط على شريط الجوّال الأفقي —
 * متسقّين مع التبويب الحالي حتى حين يتغيّر من مصدرٍ غير النقر المباشر على
 * لصيقته (رابط عميق، مؤشّر نصّي في قسم آخر يفتح تبويباً آخر). هذا الحارس
 * يعزل ذلك السلوك وحده بتغييب كل تبويبٍ فعليّ (stub) والتحكّم المباشر بالتبويب
 * النشط عبر `useSettingsController` المُصطنَع.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key }),
}));

vi.mock('../../auth', () => ({ useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }) }));
vi.mock('../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({ preferences: {}, setPreference: () => {} }),
}));
vi.mock('../../../hooks/useWebPush', () => ({
  useWebPush: () => ({ permission: 'default', isSubscribed: false, isLoading: false, subscribe: async () => {}, unsubscribe: async () => {} }),
}));
vi.mock('../../provider-auth/view/ProviderLoginModal', () => ({ default: () => null }));

// كل لوح تبويب — استبداله بعنصر نصّي بسيط: هذا الحارس عن التمرير والتنقّل لا
// عن محتوى أي تبويب بعينه.
vi.mock('../view/tabs/agents-settings/AgentsSettingsTab', () => ({ default: () => <div>agents-tab</div> }));
vi.mock('../view/tabs/AppearanceSettingsTab', () => ({ default: () => <div>appearance-tab</div> }));
vi.mock('../view/tabs/api-settings/CredentialsSettingsTab', () => ({ default: () => <div>api-tab</div> }));
vi.mock('../view/tabs/git-settings/GitSettingsTab', () => ({ default: () => <div>git-tab</div> }));
vi.mock('../view/tabs/NotificationsSettingsTab', () => ({ default: () => <div>notifications-tab</div> }));
vi.mock('../view/tabs/AboutTab', () => ({ default: () => <div>about-tab</div> }));
vi.mock('../view/tabs/profile-settings/ProfileSettingsTab', () => ({ default: () => <div>profile-tab</div> }));
vi.mock('../view/tabs/users-settings/UsersSettingsTab', () => ({ default: () => <div>users-tab</div> }));
vi.mock('../view/tabs/references-settings/ReferencesSettingsTab', () => ({ default: () => <div>references-tab</div> }));
vi.mock('../view/tabs/vendors-settings/VendorsSettingsTab', () => ({ default: () => <div>vendors-tab</div> }));
vi.mock('../view/tabs/CommandBoardSettingsTab', () => ({ default: () => <div>command-board-tab</div> }));
// SystemSettingsTab هو التبويب المُقصود بالمؤشّر النصّي في HarnessVersionSection —
// محتوًى غير فارغ وحده يكفي، فالانتقال إليه يُختبر عبر التبويب النشط نفسه.
vi.mock('../view/tabs/SystemSettingsTab', () => ({ default: () => <div>system-tab</div> }));
vi.mock('./tabs/ConnectorsSettingsTab', () => ({ default: () => <div>connectors-tab</div> }));

let activeTab = 'agents';
const setActiveTab = vi.fn((tab: string) => { activeTab = tab; });

vi.mock('../hooks/useSettingsController', () => ({
  useSettingsController: () => ({
    activeTab,
    setActiveTab,
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

afterEach(() => { cleanup(); activeTab = 'agents'; setActiveTab.mockClear(); });

describe('T-1867: انتقال تبويبات الإعدادات', () => {
  it('يعيد سكرول منطقة المحتوى إلى الأعلى عند تغيّر التبويب النشط', () => {
    const { container, rerender } = render(<Settings isOpen onClose={() => {}} />);
    const main = container.querySelector('main')!;
    const scrollTo = vi.fn();
    Object.defineProperty(main, 'scrollTo', { configurable: true, value: scrollTo });

    activeTab = 'system';
    rerender(<Settings isOpen onClose={() => {}} />);

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('يمرّر لصيقة التبويب النشط في شريط الجوّال إلى مجال الرؤية عند تغيّر التبويب من مصدرٍ خارجي (مؤشّر HarnessVersionSection أو رابط عميق)', () => {
    const { container, rerender } = render(<Settings isOpen onClose={() => {}} />);
    // اللصيقتان (سطح المكتب والجوّال) تحملان نفس `data-settings-tab`؛ لصيقة
    // الجوّال هي الثانية في ترتيب الشجرة (`SettingsSidebar` يُصيّر aside أولاً).
    const pills = container.querySelectorAll('[data-settings-tab="system"]');
    const activePillBeforehand = pills[1] as HTMLElement;
    const scrollIntoView = vi.fn();
    Object.defineProperty(activePillBeforehand, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    // محاكاة الانتقال الذي يفتحه المؤشّر النصّي في HarnessVersionSection —
    // دون نقرٍ على لصيقة «النظام» نفسها.
    act(() => { activeTab = 'system'; });
    rerender(<Settings isOpen onClose={() => {}} />);

    expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
  });
});
