import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Share2, ShieldCheck } from 'lucide-react';

import { usePaletteOps } from '../../contexts/PaletteOpsContext';
import { isProviderGloballyDisabled } from '../../../shared/disabledProviders';
import type { AgentProvider, SettingsDeepLink } from '../settings/types/types';
import { isolateBidi } from '../quick-settings-panel/subscriptionHelpers';

import { credentialProviderName } from './credentialNotLinked';
import { useRetirementNotice } from './useRetirementNotice';

type RetirementNoticeBannerProps = {
  /** Only owner-role accounts see (and fetch) the notice. */
  isOwner: boolean;
};

/** Isolation key → the agent page that holds its grant section. */
const AGENT_OF_KEY: Readonly<Record<string, AgentProvider>> = {
  claude: 'claude', agy: 'antigravity', codex: 'codex', opencode: 'opencode',
};

/** The grant section of the first shared agent that has a page, else the agents page. */
function grantsDestination(sharedProviders: readonly string[]): SettingsDeepLink {
  const agent = sharedProviders.map((key) => AGENT_OF_KEY[key]).find((id) => id && !isProviderGloballyDisabled(id));
  return agent
    ? { tab: 'agents', agent, category: 'account', section: 'credential-grants' }
    : { tab: 'agents', category: 'account', section: 'credential-grants' };
}

/**
 * One-time owner notice after the provider-sharing retirement (ADR-152 A1
 * §3.10, D3). Says what changed, lists what the snapshot recorded — providers
 * that were shared, providers with an install-wide key, members active at
 * retirement — and points to the grant section. It never says which members
 * have linked since (no enumeration of anyone's credential presence).
 */
export default function RetirementNoticeBanner({ isOwner }: RetirementNoticeBannerProps) {
  const { t, i18n } = useTranslation('common');
  const { openSettings } = usePaletteOps();
  const { notice, acknowledging, ackFailed, acknowledge } = useRetirementNotice(isOwner);
  const titleId = useId();
  if (!notice) return null;

  const separator = i18n.language?.startsWith('ar') ? '، ' : ', ';
  // Each name isolated, so a Latin list keeps the sentence's reading order in Arabic.
  const names = (keys: readonly string[]) => keys
    .map((key) => isolateBidi(credentialProviderName(key) ?? key)).join(separator);
  const destination = grantsDestination(notice.sharedProviders);

  return (
    <section
      aria-labelledby={titleId}
      data-testid="retirement-notice"
      className="max-h-[70vh] overflow-y-auto rounded-lg border border-warning/30 bg-background px-4 py-3 text-sm text-foreground shadow-lg"
    >
      <h2 id={titleId} className="flex items-start gap-2 text-[15px] font-semibold leading-snug">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        {t('retirementNotice.title')}
      </h2>
      <div className="mt-2 space-y-2 text-[13px] leading-relaxed">
        <p>{t('retirementNotice.body')}</p>
        <p>
          {notice.sharedProviders.length > 0
            ? t('retirementNotice.sharedProviders', { providers: names(notice.sharedProviders) })
            : t('retirementNotice.noSharedProviders')}
        </p>
        {notice.orgKeyProviders === 'unknown' ? (
          <p>{t('retirementNotice.orgKeyUnknown')}</p>
        ) : notice.orgKeyProviders.length > 0 && (
          <p>{t('retirementNotice.orgKeyProviders', { providers: names(notice.orgKeyProviders) })}</p>
        )}
        {notice.members.length > 0 ? (
          <div>
            <p>{t('retirementNotice.members')}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {notice.members.map((member) => (
                <li key={member.userId} className="rounded-md bg-muted px-2 py-0.5 text-foreground">
                  <bdi>{member.username}</bdi>
                </li>
              ))}
            </ul>
            <p className="mt-1">{t('retirementNotice.membersNeedOwnOrGrant')}</p>
          </div>
        ) : (
          <p>{t('retirementNotice.noMembers')}</p>
        )}
        {notice.ownersMustLinkOwnAccount && (
          <p className="font-medium">{t('retirementNotice.ownersMustLink')}</p>
        )}
        {ackFailed && <p role="alert" className="text-danger">{t('retirementNotice.ackFailed')}</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => openSettings(destination.tab, destination)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Share2 className="h-4 w-4" aria-hidden="true" />
          {t('retirementNotice.openGrants')}
        </button>
        <button
          type="button"
          onClick={() => { void acknowledge(); }}
          disabled={acknowledging}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {acknowledging && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('retirementNotice.acknowledge')}
        </button>
      </div>
    </section>
  );
}
