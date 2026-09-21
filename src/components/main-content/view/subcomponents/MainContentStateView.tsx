import { AlertTriangle, Folder, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MainContentStateViewProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';

export default function MainContentStateView({
  mode,
  isMobile,
  onMenuClick,
  deepLinkResolution,
  onRetryDeepLink,
}: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';
  const isDeepLink = mode === 'deep-link' && deepLinkResolution?.status !== 'idle';
  const deepLinkKey = isDeepLink && deepLinkResolution ? deepLinkResolution.status : null;

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 bg-background/80 backdrop-blur-sm">
          <div className="app-top-rail flex items-center px-3 sm:px-4">
            <MobileMenuButton onMenuClick={onMenuClick} compact />
          </div>
        </div>
      )}

      {isLoading || deepLinkKey === 'loading' ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              {deepLinkKey === 'loading' ? t('mainContent.sessionResolving') : t('mainContent.loading')}
            </h2>
            <p className="text-sm">
              {deepLinkKey === 'loading' ? t('mainContent.sessionResolvingDescription') : t('mainContent.settingUpWorkspace')}
            </p>
          </div>
        </div>
      ) : isDeepLink ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center" role="alert">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10">
              <AlertTriangle className="h-7 w-7 text-destructive" aria-hidden="true" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">
              {t(`mainContent.sessionDeepLink.${deepLinkKey}.title`)}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t(`mainContent.sessionDeepLink.${deepLinkKey}.description`)}
            </p>
            {deepLinkKey === 'error' && onRetryDeepLink && (
              <button
                type="button"
                onClick={onRetryDeepLink}
                className="mx-auto mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t('mainContent.sessionDeepLink.retry')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <Folder className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5">
              <p className="text-sm text-primary">
                <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
