import { useState } from 'react';
import { Settings, ArrowUpCircle, LogOut, RefreshCw } from 'lucide-react';
import type { TFunction } from 'i18next';

import { IS_PLATFORM } from '../../../../constants/config';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { PublicAction, ExecuteOutcome, DismissOutcome } from '../../../../hooks/useServerActions';
import { useAuth } from '../../../auth/context/AuthContext';
import { useRawExecQueue } from '../../../../hooks/useRawExecConfig';
import { SOURCE_REPO_URL } from '../../../../constants/sourceRepo';

import { SystemStatsFooter } from './SystemStats';
import UpstreamReleaseNotice from './UpstreamReleaseNotice';
import PendingActionsPanel from './PendingActionsPanel';

type SidebarFooterProps = {
  updateAvailable: boolean;
  /** T-928: true when build:client ran after the server process started. */
  restartRequired: boolean;
  /** T-944 F1: pending server actions queue. */
  actions: PublicAction[];
  loading: boolean;
  execute: (id: string) => Promise<ExecuteOutcome>;
  dismiss: (id: string) => Promise<DismissOutcome>;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  actions,
  loading,
  execute,
  dismiss,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const { logout, user } = useAuth();
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [showPanel, setShowPanel] = useState(false);

  // B-247: the raw shell queue. The server already scoped this list to the
  // caller (mayReadQueue), so a user without the tier gets [] and nothing below
  // changes for them — no client-side role check re-implements that decision.
  const { commands: rawCommands, refresh: refreshRawQueue } = useRawExecQueue(!!user);
  const rawCount = rawCommands.length;

  // Total count shown on the banner badge — BOTH queues (requirement 3).
  const pendingCount = (restartRequired ? 1 : 0) + actions.length + rawCount;
  const showBanner = pendingCount > 0;

  // T-1036: no badge on the Settings entry. Settings no longer holds the queue,
  // so a count there would route the owner away from the only place the command
  // can actually be read and run — this banner, two rows above it.
  //
  // One badge, two colours: amber while only declared server actions wait, red
  // as soon as free shell text is in the queue — the count alone cannot say
  // which tier is waiting, and the tiers do not carry the same risk.
  const badgeClass = rawCount > 0 ? 'bg-red-600' : 'bg-amber-500';

  const handleBannerClick = () => {
    setShowPanel(true);
  };

  const handleLogoutClick = () => {
    if (confirmingLogout) {
      logout();
      setConfirmingLogout(false);
    } else {
      setConfirmingLogout(true);
      // Auto-reset confirmation state after 3 seconds if user does nothing.
      setTimeout(() => setConfirmingLogout(false), 3000);
    }
  };

  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {/* Update banner */}
      {updateAvailable && (
        <>
          <div className="nav-divider" />
          {/* Desktop update */}
          <div className="hidden px-2 py-1.5 md:block">
            <button
              className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-blue-50/80 dark:hover:bg-blue-900/15"
              onClick={onShowVersionModal}
            >
              <div className="relative flex-shrink-0">
                <ArrowUpCircle className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-blue-600 dark:text-blue-300">
                  {releaseInfo?.title || `v${latestVersion}`}
                </span>
                <span className="text-[10px] text-blue-500/70 dark:text-blue-400/60">
                  {t('version.updateAvailable')}
                </span>
              </div>
            </button>
          </div>

          {/* Mobile update */}
          <div className="px-3 py-2 md:hidden">
            <button
              className="flex h-11 w-full items-center gap-3 rounded-xl border border-blue-200/60 bg-blue-50/80 px-3.5 transition-all active:scale-[0.98] dark:border-blue-700/40 dark:bg-blue-900/15"
              onClick={onShowVersionModal}
            >
              <div className="relative flex-shrink-0">
                <ArrowUpCircle className="w-4.5 h-4.5 text-blue-500 dark:text-blue-400" />
                <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              </div>
              <div className="min-w-0 flex-1 text-start">
                <span className="block truncate text-sm font-medium text-blue-600 dark:text-blue-300">
                  {releaseInfo?.title || `v${latestVersion}`}
                </span>
                <span className="text-xs text-blue-500/70 dark:text-blue-400/60">
                  {t('version.updateAvailable')}
                </span>
              </div>
            </button>
          </div>
        </>
      )}

      {/* T-944 F1: Pending actions banner — opens PendingActionsPanel.
          Shows when: pending queue non-empty OR restartRequired (build landed). */}
      {showBanner && (
        <>
          <div className="nav-divider" />
          {/* Desktop banner */}
          <div className="hidden px-2 py-1.5 md:block" role="status" aria-live="polite">
            <button
              type="button"
              className="group flex w-full items-center gap-2.5 rounded-lg border border-amber-200/60 bg-amber-50/80 px-2.5 py-2 text-start transition-colors hover:bg-amber-100/80 active:scale-[0.99] dark:border-amber-700/40 dark:bg-amber-900/15 dark:hover:bg-amber-900/25"
              onClick={handleBannerClick}
              aria-label={t('pendingActions.bannerAriaLabel')}
            >
              <div className="relative flex-shrink-0">
                <RefreshCw
                  className="h-4 w-4 text-amber-500 dark:text-amber-400"
                  aria-hidden="true"
                />
                <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-amber-700 dark:text-amber-300">
                  {restartRequired
                    ? t('version.restartRequired')
                    : t('pendingActions.title')}
                </span>
              </div>
              {pendingCount > 0 && (
                <span className={`flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white ${badgeClass}`}>
                  {pendingCount}
                </span>
              )}
            </button>
          </div>

          {/* Mobile banner */}
          <div className="px-3 py-2 md:hidden" role="status" aria-live="polite">
            <button
              type="button"
              className="flex h-11 w-full items-center gap-3 rounded-xl border border-amber-200/60 bg-amber-50/80 px-3.5 text-start transition-all hover:bg-amber-100/80 active:scale-[0.98] dark:border-amber-700/40 dark:bg-amber-900/15 dark:hover:bg-amber-900/25"
              onClick={handleBannerClick}
              aria-label={t('pendingActions.bannerAriaLabel')}
            >
              <div className="relative flex-shrink-0">
                <RefreshCw
                  className="w-4.5 h-4.5 text-amber-500 dark:text-amber-400"
                  aria-hidden="true"
                />
                <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-amber-700 dark:text-amber-300">
                  {restartRequired
                    ? t('version.restartRequired')
                    : t('pendingActions.title')}
                </span>
              </div>
              {pendingCount > 0 && (
                <span className={`flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white ${badgeClass}`}>
                  {pendingCount}
                </span>
              )}
            </button>
          </div>

          <PendingActionsPanel
            isOpen={showPanel}
            onClose={() => setShowPanel(false)}
            restartRequired={restartRequired}
            actions={actions}
            loading={loading}
            execute={execute}
            dismiss={dismiss}
            rawCommands={rawCommands}
            onRawQueueChange={refreshRawQueue}
          />
        </>
      )}

      {/* System stats + Settings */}
      <div className="nav-divider" />

      {/* Live CPU/RAM stats (desktop rows + mobile card) */}
      <SystemStatsFooter t={t} />

      {/* Desktop settings + logout */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          onClick={handleLogoutClick}
          aria-label={
            confirmingLogout
              ? t('actions.logoutConfirm', 'Sign out of your account?')
              : t('actions.logout', 'Sign out')
          }
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="text-sm">
            {confirmingLogout
              ? t('actions.logoutConfirm', 'Sign out of your account?')
              : t('actions.logout', 'Sign out')}
          </span>
        </button>
      </div>

      {/* Owner-only upstream release notice (next to the version line) */}
      <UpstreamReleaseNotice />

      {/* Desktop version brand line (OSS mode only) */}
      {!IS_PLATFORM && (
        <div className="hidden px-3 py-2 text-center md:block">
          <a
            href={SOURCE_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          >
            نسّاج v{currentVersion} — مفتوح المصدر
          </a>
        </div>
      )}

      {/* Mobile settings + logout */}
      <div className="space-y-2 px-3 pb-3 pt-2 md:hidden">
        <button
          className="flex h-12 w-full items-center gap-3.5 rounded-xl bg-muted/40 px-4 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
            <Settings className="w-4.5 h-4.5 text-muted-foreground" />
          </div>
          <span className="text-base font-medium text-foreground">
            {t('actions.settings')}
          </span>
        </button>
        <button
          className="bg-destructive/8 flex h-12 w-full items-center gap-3.5 rounded-xl px-4 transition-all hover:bg-destructive/15 active:scale-[0.98]"
          onClick={handleLogoutClick}
          aria-label={
            confirmingLogout
              ? t('actions.logoutConfirm', 'Sign out of your account?')
              : t('actions.logout', 'Sign out')
          }
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
            <LogOut className="w-4.5 h-4.5 text-destructive/70" />
          </div>
          <span className="text-base font-medium text-destructive/80">
            {confirmingLogout
              ? t('actions.logoutConfirm', 'Sign out of your account?')
              : t('actions.logout', 'Sign out')}
          </span>
        </button>
      </div>
    </div>
  );
}
