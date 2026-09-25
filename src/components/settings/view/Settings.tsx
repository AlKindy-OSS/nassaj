import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ProviderLoginModal from '../../provider-auth/view/ProviderLoginModal';
import SettingsSidebar from '../view/SettingsSidebar';
import AgentsSettingsTab from '../view/tabs/agents-settings/AgentsSettingsTab';
import AppearanceSettingsTab from '../view/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '../view/tabs/api-settings/CredentialsSettingsTab';
import GitSettingsTab from '../view/tabs/git-settings/GitSettingsTab';
import NotificationsSettingsTab from '../view/tabs/NotificationsSettingsTab';
import AboutTab from '../view/tabs/AboutTab';
import ProfileSettingsTab from '../view/tabs/profile-settings/ProfileSettingsTab';
import UsersSettingsTab from '../view/tabs/users-settings/UsersSettingsTab';
import ReferencesSettingsTab from '../view/tabs/references-settings/ReferencesSettingsTab';
import VendorsSettingsTab from '../view/tabs/vendors-settings/VendorsSettingsTab';
import CommandBoardSettingsTab from '../view/tabs/CommandBoardSettingsTab';
import TmpfsCapSection from '../view/tabs/TmpfsCapSection';
import StoragePolicySection from '../view/tabs/StoragePolicySection';
import PermissionFencesSection from '../view/tabs/PermissionFencesSection';
import { useSettingsController } from '../hooks/useSettingsController';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useWebPush } from '../../../hooks/useWebPush';
import { useAuth } from '../../auth';
import type { AgentCategory, AgentProvider, SettingsProps, SettingsMainTab } from '../types/types';
import { canOpenSettingsTab, writeSettingsDestination } from '../settingsUrl';

import ConnectorsSettingsTab from './tabs/ConnectorsSettingsTab';
import SettingsCloseButton from './SettingsCloseButton';
import { hasActiveNestedDialog, resolveEscapeTarget } from './settingsDialogHelpers';

function Settings({ isOpen, onClose, projects = [], initialTab = 'agents', deepLink }: SettingsProps) {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const dialogRef = useRef<HTMLDivElement>(null);
  /** العنصر الذي كان له تركيز قبل فتح الإعدادات — يُستعاد عند الإغلاق. */
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  /** مرجع يعكس showLoginModal دون أن يُقيَّد بـclosure قديمة داخل مستمع الأحداث. */
  const showLoginModalRef = useRef(false);
  const canManageUsers = user?.role === 'owner' || user?.role === 'admin';
  const [focusCompanyId, setFocusCompanyId] = useState<string | undefined>(
    deepLink?.tab === 'vendors' ? deepLink.companyId : undefined,
  );
  const [agentDestination, setAgentDestination] = useState<{
    agent: AgentProvider;
    category: AgentCategory;
  }>({
    agent: deepLink?.tab === 'agents' && deepLink.agent ? deepLink.agent : 'claude',
    category: deepLink?.tab === 'agents' && deepLink.category ? deepLink.category : 'account',
  });
  // Whether the «النماذج المحلية» grid card is active inside the Agents tab.
  const [localModelsActiveInAgents, setLocalModelsActiveInAgents] = useState<boolean>(
    Boolean(deepLink?.tab === 'agents' && deepLink.localModels),
  );
  const { preferences: uiPreferences, setPreference: setUiPreference } = useUiPreferences();
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    checkProviderAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  useEffect(() => {
    if (!isOpen) return;
    setFocusCompanyId(deepLink?.tab === 'vendors' ? deepLink.companyId : undefined);
    if (deepLink?.tab === 'agents') {
      setLocalModelsActiveInAgents(Boolean(deepLink.localModels));
      if (!deepLink.localModels) {
        setAgentDestination({
          agent: deepLink.agent ?? 'claude',
          category: deepLink.category ?? 'account',
        });
      }
    }
  }, [deepLink, isOpen]);

  // Shared links to role-restricted pages must not leave members on an empty
  // settings surface. Replace the unsupported URL in place so Back does not
  // loop through the same inaccessible destination.
  useEffect(() => {
    if (!isOpen || canOpenSettingsTab(activeTab, user?.role)) return;
    setActiveTab('agents');
    writeSettingsDestination({ tab: 'agents', ...agentDestination }, { replace: true });
  }, [activeTab, agentDestination, isOpen, setActiveTab, user?.role]);

  // مزامنة المرجع مع الحالة حتى تقرأ مستمعات الأحداث القيمة الحالية دائماً.
  useEffect(() => { showLoginModalRef.current = showLoginModal; }, [showLoginModal]);

  // B-559: Escape closes the modal (WCAG 3.2.5 / ARIA dialog pattern).
  // الإصلاح (qa-critic): bubble phase لا capture، لا stopPropagation، حتى لا
  // تختطف Escape من المودالات المتداخلة (ResetPasswordModal، UserDialogShell،
  // CredentialGrantsSection). ProviderLoginModal (شقيق خارج dialogRef) بلا
  // معالج Escape خاصّ فنغلقه نحن عند الحاجة.
  const handleClose = useCallback(() => { onClose(); }, [onClose]);
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = resolveEscapeTarget({
        hasNestedDialog: hasActiveNestedDialog(dialogRef.current),
        showLoginModal: showLoginModalRef.current,
      });
      if (target === 'none') return;
      e.preventDefault();
      if (target === 'login-modal') { setShowLoginModal(false); return; }
      handleClose();
    };
    // bubble phase على document: يصل بعد window لأن bubble يسير
    // target → ... → document → window. المودالات المتداخلة تستمع على window
    // (ResetPasswordModal:60) ويمكنها استدعاء e.preventDefault() لو أرادت
    // منعنا — لكن حتى مع عدم استدعائها، hasActiveNestedDialog يكفي.
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose, setShowLoginModal]);

  // B-559: تخزين العنصر الذي كان له تركيز عند الفتح واستعادته عند الإغلاق.
  useEffect(() => {
    if (!isOpen) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      // استعادة التركيز على العنصر الذي فتح الإعدادات — WCAG 2.4.3.
      if (openerRef.current && typeof openerRef.current.focus === 'function') {
        openerRef.current.focus();
      }
      openerRef.current = null;
    };
  }, [isOpen]);

  const FOCUSABLE_SELECTOR = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // B-559: Focus trap — Tab و Shift+Tab يبقيان داخل الـdialog.
  // الإصلاح (qa-critic): إذا وُجد مودال متداخل مفتوح، اقصر التنقّل على
  // عناصره فقط لا على كامل الـdialog، حتى لا يهرب Tab إلى قائمة الإعدادات.
  useEffect(() => {
    if (!isOpen || !dialogRef.current) return;
    const el = dialogRef.current;
    const trapFocus = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // هل هناك مودال متداخل؟ اقصر النطاق عليه وحده.
      const innerDialog = el.querySelector<HTMLElement>('[role="dialog"]');
      const scope: HTMLElement = innerDialog ?? el;
      const nodes = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    el.addEventListener('keydown', trapFocus);
    // انقل التركيز إلى داخل الـdialog عند الفتح.
    const firstFocusable = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    return () => el.removeEventListener('keydown', trapFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  const handleMainTabChange = (tab: SettingsMainTab) => {
    setActiveTab(tab);
    if (tab !== 'agents') setLocalModelsActiveInAgents(false);
    writeSettingsDestination(tab === 'agents'
      ? (localModelsActiveInAgents ? { tab, localModels: true } : { tab, ...agentDestination })
      : { tab });
  };

  const handleAgentDestinationChange = (
    agent: AgentProvider,
    category: AgentCategory,
    options?: { replace?: boolean },
  ) => {
    setLocalModelsActiveInAgents(false);
    setAgentDestination({ agent, category });
    writeSettingsDestination({ tab: 'agents', agent, category }, options);
  };

  const handleLocalModelsSelect = (options?: { replace?: boolean }) => {
    setLocalModelsActiveInAgents(true);
    writeSettingsDestination({ tab: 'agents', localModels: true }, options);
  };

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      {/* B-559: role=dialog + aria-modal حبس التركيز الدلالي عن المساعدات؛
          aria-labelledby يربط العنوان المرئي بالمودال لقارئ الشاشة. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3 md:px-5">
          <h2 id={titleId} className="text-base font-semibold text-foreground">{t('title')}</h2>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span role="status" className="animate-in fade-in text-[13px] text-muted-foreground">{t('saveStatus.success')}</span>
            )}
            <SettingsCloseButton onClose={onClose} label={t('common.close')} />
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <SettingsSidebar activeTab={activeTab} onChange={handleMainTabChange} />

          {/* Content */}
          <main className="flex-1 overflow-y-auto">
            {/* `space-y-8`: الفصل بين الأقسام مسافةٌ لا خطّ ولا صندوق
                (`docs/design/SETTINGS-SURFACE-LANGUAGE.md` §1). */}
            <div key={activeTab} className="settings-content-enter space-y-8 p-4 pb-safe-area-inset-bottom md:p-6">
              {activeTab === 'profile' && <ProfileSettingsTab />}

              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorThemeChange={(value) => updateCodeEditorSetting('theme', value)}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                  showSidebarSearch={uiPreferences.showSidebarSearch}
                  onShowSidebarSearchChange={(value) => setUiPreference('showSidebarSearch', value)}
                  showHardwareUsage={uiPreferences.showHardwareUsage}
                  onShowHardwareUsageChange={(value) => setUiPreference('showHardwareUsage', value)}
                  codeHighlightScope={uiPreferences.codeHighlightScope}
                  onCodeHighlightScopeChange={(value) => setUiPreference('codeHighlightScope', value)}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  onRefreshAuthStatus={(provider) => { void checkProviderAuthStatus(provider); }}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  projects={projects}
                  initialAgent={agentDestination.agent}
                  initialCategory={agentDestination.category}
                  initialLocalModels={localModelsActiveInAgents}
                  onDestinationChange={handleAgentDestinationChange}
                  onLocalModelsSelect={handleLocalModelsSelect}
                />
              )}

              {/* «ماذا يصل الوكيل قبل أن يبدأ؟» — بلا قيد دور: القراءة لكل عضو،
                  والتمييز على التحرير وحده (`canManage` من الخادم). */}
              {activeTab === 'references' && <ReferencesSettingsTab />}

            {activeTab === 'notifications' && (
              <NotificationsSettingsTab
                notificationPreferences={notificationPreferences}
                onNotificationPreferencesChange={setNotificationPreferences}
                pushPermission={pushPermission}
                isPushSubscribed={isPushSubscribed}
                isPushLoading={isPushLoading}
                onEnablePush={handleEnablePush}
                onDisablePush={handleDisablePush}
              />
            )}

              {/* فهرسُ الاعتمادات ومنزلُ الشركة التي لا بلاطةَ لوكيلها
                  (T-1206) — لا سطحَ كتابةٍ ثانٍ: انظر رأس `VendorsSettingsTab`. */}
              {activeTab === 'vendors' && (
                <VendorsSettingsTab
                  focusCompanyId={focusCompanyId ?? (deepLink?.tab === 'vendors' ? deepLink.companyId : undefined)}
                  onQwenConnect={() => openLoginForProvider('qwen')}
                />
              )}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'connectors' && <ConnectorsSettingsTab />}


              {activeTab === 'users' && canManageUsers && <UsersSettingsTab />}

              {activeTab === 'command-board' && user?.role === 'owner' && (
                <>
                  <CommandBoardSettingsTab />
                  {/* سقف tmpfs يعيش هنا لأن تطبيقه أمرٌ ينفّذه المالك بنفسه —
                      نفس طبيعة هذا التبويب، ونفس قيده على الدور. */}
                  <TmpfsCapSection />
                  {/* عمر المحادثة وحدود صورها — بجوار سقف tmpfs لأنهما معاً
                      «كم يشغل هذا التطبيق من القرص»، وبنفس قيد الدور. بخلاف
                      جاره، هذا القسم يطبّق ما يقوله فعلاً. */}
                  <StoragePolicySection />
                  {/* حجوب الصلاحيات (T-1770): رفعها قرار مالك بإقرار صريح، فيعيش
                      هنا بنفس قيد الدور لا في تبويب يراه المدير. */}
                  <PermissionFencesSection />
                </>
              )}

              {activeTab === 'about' && <AboutTab />}
            </div>
          </main>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

export default Settings;
