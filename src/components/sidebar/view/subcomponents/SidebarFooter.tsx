import { useState } from 'react';
import {
  ArrowUpCircle, ChevronUp, LogOut, Palette, RefreshCw, Settings, UserRound,
} from 'lucide-react';
import type { TFunction } from 'i18next';

import { IS_PLATFORM } from '../../../../constants/config';
import { UNKNOWN_VERSION } from '../../../../hooks/useVersionCheck';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import { countPendingServerActions, type PublicAction, type ExecuteOutcome, type DismissOutcome, type HistoryEntry } from '../../../../hooks/useServerActions';
import { useAuth } from '../../../auth/context/AuthContext';
import { useRawExecQueue } from '../../../../hooks/useRawExecConfig';
import { SOURCE_REPO_URL } from '../../../../constants/sourceRepo';
import { ActionMenu, Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import type { SettingsDeepLink } from '../../../settings/types/types';

import { SystemStatsFooter } from './SystemStats';
import UpstreamReleaseNotice from './UpstreamReleaseNotice';
import PendingActionsPanel from './PendingActionsPanel';
import AccountSwitcher from './AccountSwitcher';

import { staticAssetUrl } from '@/lib/static-asset-url';


type SidebarFooterProps = {
  updateAvailable: boolean;
  /**
   * B-1055 (ADR-156 WI-5): the third state — a build is staged or promoted and
   * only its governed activation is still owed. Distinct from an offer of a
   * newer release, which the owner has not acted on yet.
   */
  updatePrepared?: boolean;
  /** T-928: true when build:client ran after the server process started. */
  restartRequired: boolean;
  /** T-944 F1: pending server actions queue. */
  actions: PublicAction[];
  /** T-1684: settled operations, kept for one hour. */
  history?: readonly HistoryEntry[];
  loading: boolean;
  execute: (id: string) => Promise<ExecuteOutcome>;
  refreshActions?: () => Promise<void>;
  dismiss: (id: string) => Promise<DismissOutcome>;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: (dest?: SettingsDeepLink) => void;
  t: TFunction;
};

export default function SidebarFooter({
  updateAvailable,
  updatePrepared = false,
  restartRequired,
  actions,
  history,
  loading,
  execute,
  dismiss,
  refreshActions,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const { deviceAccountSessionsEnabled, logout, user } = useAuth();
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const userName = user?.username || t('account.fallbackName');
  const initials = Array.from(userName.trim()).slice(0, 2).join('').toLocaleUpperCase();
  const [showPanel, setShowPanel] = useState(false);

  // B-247: the raw shell queue. The server already scoped this list to the
  // caller (mayReadQueue), so a user without the tier gets [] and nothing below
  // changes for them — no client-side role check re-implements that decision.
  const { commands: rawCommands, refresh: refreshRawQueue } = useRawExecQueue(!!user);
  const rawCount = rawCommands.length;

  const pendingCount = (restartRequired ? 1 : 0) + countPendingServerActions(actions) + rawCount;
  const showBanner = pendingCount > 0;
  const badgeClass = rawCount > 0 ? 'bg-red-600' : 'bg-amber-500';

  return (
    <div className="mt-auto flex-shrink-0 pt-1" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {/* لوحة الأوامر تبقى على المسار القديم: لا تظهر إلا عند وجود أمر ينتظر. */}
      {showBanner && (
        <>
          <div className="px-3 py-0.5" role="status" aria-live="polite">
            <button
              type="button"
              className="flex h-8 w-full items-center gap-1.5 rounded-lg bg-amber-50/80 px-2 text-start text-xs font-medium text-warning transition-colors hover:bg-amber-100/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-amber-900/15 dark:hover:bg-amber-900/25"
              onClick={() => setShowPanel(true)}
              aria-label={t('pendingActions.bannerAriaLabel')}
            >
              <div className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                <RefreshCw className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" aria-hidden="true" />
                <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              </div>
              <span className="min-w-0 flex-1 truncate">
                {restartRequired ? t('version.restartRequired') : t('pendingActions.title')}
              </span>
              <span className={`flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ${badgeClass}`}>
                {pendingCount}
              </span>
            </button>
          </div>
        </>
      )}
      {/* Keep the open receipt visible when its completion clears the banner. */}
      {(showBanner || showPanel) && (
        <PendingActionsPanel
          isOpen={showPanel}
          onClose={() => setShowPanel(false)}
          restartRequired={restartRequired}
          actions={actions}
          history={history}
          loading={loading}
          execute={execute}
          dismiss={dismiss}
          refreshActions={refreshActions}
          rawCommands={rawCommands}
          onRawQueueChange={refreshRawQueue}
        />
      )}

      {/* العتاد بنفس بطاقة الإحصاءات الأصلية؛ زرّ التشغيل/الإيقاف انتقل إلى
          لوحة الإعدادات السريعة (B-1044 follow-up) لأنها تخدم الجوّال أيضاً. */}
      <SystemStatsFooter t={t} />

      <div className="px-3 pb-0 pt-0.5">
        {deviceAccountSessionsEnabled ? <AccountSwitcher
            current={{ displayName: userName, avatarUrl: user?.avatarUrl, secondary: t(`account.roles.${user?.role || 'user'}`) }}
            t={t}
            onShowSettings={() => onShowSettings()}
            onLegacyLogout={() => setConfirmingLogout(true)}
          /> : <ActionMenu
            label={userName}
            ariaLabel={t('account.menuLabel', { name: userName })}
            side="top"
            align="start"
            variant="ghost"
            className="w-full"
            triggerClassName="h-14 w-full justify-start gap-3 rounded-xl bg-muted/40 px-3 text-start hover:bg-muted/60"
            triggerContent={<>
              {user?.avatarUrl && failedAvatar !== user.avatarUrl
                ? <img src={staticAssetUrl(user.avatarUrl)} alt="" onError={() => setFailedAvatar(user.avatarUrl!)} className="h-8 w-8 shrink-0 rounded-full object-cover" />
                : <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-foreground">{initials}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{userName}</span>
                <span className="block text-xs text-muted-foreground">{t(`account.roles.${user?.role || 'user'}`)}</span>
              </span>
              <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            </>}
            items={[
              { key: 'profile', label: t('account.profile'), icon: UserRound, onSelect: () => onShowSettings({ tab: 'profile' }) },
              { key: 'appearance', label: t('account.appearance'), icon: Palette, onSelect: () => onShowSettings({ tab: 'appearance' }) },
              { key: 'settings', label: t('actions.settings'), icon: Settings, onSelect: () => onShowSettings() },
              { key: 'logout', label: t('actions.logout'), icon: LogOut, isDanger: true, showDividerBefore: true, onSelect: () => setConfirmingLogout(true) },
            ]}
          />}
      </div>
      <Dialog open={confirmingLogout} onOpenChange={setConfirmingLogout}>
        <DialogContent className="max-w-sm p-0">
          {/* sr-only: ربط aria-labelledby بالعنوان لقارئات الشاشة */}
          <DialogTitle className="sr-only">{t('actions.logoutConfirm')}</DialogTitle>
          <div className="space-y-4 p-5">
            <div className="space-y-1">
              <p className="text-base font-semibold text-foreground" aria-hidden="true">
                {t('actions.logoutConfirm')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('actions.logoutDescription')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
              <Button variant="outline" size="sm" onClick={() => setConfirmingLogout(false)}>
                {t('account.cancel')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => { setConfirmingLogout(false); logout(); }}>
                {t('actions.logout')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Owner-only upstream release notice */}
      <UpstreamReleaseNotice />

      {/* T-1862: عنصر تحديث واحد مضغوط يخلف بانر «تحديث جديد» الأزرق وسطر
          «نسّاج vX — مفتوح المصدر» معاً. الضغط يفتح نافذة الإصدار الموجودة.
          round 2 (qa LOW):
            - يظهر فقط عند وجود تحديث حقيقي، أو في نسخة OSS (سطر الترخيص كان
              ظاهراً دائماً بصرف النظر عن التحديث — استعادة السلوك السابق
              بدل عنصر يظهر دائماً حتى على منصّة بلا تحديث).
            - النصّ لا يُصيَّر أصلاً حين يفشل `/health` (currentVersion=UNKNOWN_VERSION)
              بدل عرض «v—» كأنه إصدار حقيقي.
            - «تحديث إلى vX» نصّاً صريحاً بدل سهم مجرَّد قد يلتبس اتجاهه في RTL.
            - تباين وهدف لمس أكبر (min-h-9 على الجوّال، h-6 من sm فصاعداً). */}
      {(updateAvailable || !IS_PLATFORM) && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 pb-0.5 pt-0.5">
          {currentVersion !== UNKNOWN_VERSION && (
            <button
              type="button"
              onClick={onShowVersionModal}
              className="flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs leading-none text-muted-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-6 sm:px-1.5"
              aria-label={updateAvailable
                ? `${updatePrepared ? t('version.updatePrepared') : t('version.updateAvailable')}${latestVersion ? ` — v${latestVersion}` : ''}`
                : t('version.currentVersionLabel', { version: currentVersion, defaultValue: 'Nassaj v{{version}}' }) as string}
            >
              {/* round 3 (qa): dir="ltr" على الغلاف كان يفرض ترتيب قراءة
                  إنجليزي على كل المحتوى فيلتبس نصّ «تحديث إلى» العربي. الآن
                  العزل على كل رقم إصدار عبر <bdi dir="ltr"> وحده، والنص
                  العربي بترتيبه الطبيعي، وفاصلة مرئية (·) بين الرقمين.
                  T-1868: النبرة (accent) على الإصدار الجديد وحده — الإصدار
                  الحالي يبقى محايداً (text-muted-foreground الموروثة من
                  الزرّ) لأنه ليس هو ما يستدعي الانتباه. */}
              <bdi dir="ltr" className="tabular-nums">v{currentVersion}</bdi>
              {updateAvailable && latestVersion && (
                <>
                  <span aria-hidden="true" className="text-muted-foreground/70">·</span>
                  <ArrowUpCircle className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                  <span className="font-medium text-primary">{t('version.updateToLabel', { defaultValue: 'Update to' })}</span>
                  <bdi dir="ltr" className="font-medium tabular-nums text-primary">v{latestVersion}</bdi>
                </>
              )}
            </button>
          )}
          {!IS_PLATFORM && (
            <a
              href={SOURCE_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              title={t('common:brand.openSourceLicense') as string}
              className="inline-flex min-h-9 items-center px-1 text-xs leading-none text-muted-foreground transition-colors hover:text-foreground sm:min-h-6"
            >
              {t('common:brand.openSourceShort', { defaultValue: 'Open source' })}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
