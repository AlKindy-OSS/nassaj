import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isolateBidi } from '../../../../../../quick-settings-panel/subscriptionHelpers';
import { Button } from '../../../../../../../shared/view/ui';
import {
  useLinkMode,
  type LinkModeStatus,
  type LinkModeWarning,
  type SwitchOutcome,
  type SwitchRequest,
} from '../../../../../../provider-auth/hooks/useLinkMode';
import type { LinkHarness, LinkMode } from '../../../../../../provider-auth/hooks/vendorKeyApi';
import SegmentedControl from '../../../../SegmentedControl';
import SettingsCard from '../../../../SettingsCard';
import SettingsGroup from '../../../../SettingsGroup';
import { useSettingsNavigation } from '../../../../SettingsNavigationContext';
import SettingsRow from '../../../../SettingsRow';
import StatusBadge from '../../../../StatusBadge';

import LinkModeSwitchDialog from './LinkModeSwitchDialog';

const HARNESS_LABEL: Record<LinkHarness, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Warning lines are shown in this order; `mode_unset` has its own neutral line instead. */
const WARNING_ORDER: readonly LinkModeWarning[] = [
  'record_unreadable', 'foreign_key_billing', 'effective_mode_mismatch',
  'fresh_subscription_login', 'subscription_also_present',
];

const DANGER_WARNINGS: ReadonlySet<LinkModeWarning> = new Set(['record_unreadable', 'foreign_key_billing']);

const OUTCOME_KEYS: Partial<Record<SwitchOutcome, string>> = {
  awaiting_key: 'awaitingKey',
  linked: 'linked',
  key_removed: 'removed',
  foreign_key_removed: 'removed',
  adopted_credential: 'foreignKept',
  foreign_credential: 'foreignKept',
};

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** One sentence per warning; `foreign_key_billing` adds which kind of key sits there. */
function warningLines(warning: LinkModeWarning, status: LinkModeStatus, harness: string, t: Translate): string[] {
  const mode = (value: string) => t(`linkMode.mode.${value}`);
  switch (warning) {
    case 'effective_mode_mismatch':
      return [t('linkMode.warning.mismatch', {
        harness,
        chosen: mode(status.chosenMode ?? 'none'),
        effective: mode(status.effectiveMode),
      })];
    case 'foreign_key_billing':
      return [
        t('linkMode.warning.foreignBilling'),
        t(status.credentials.key === 'adopted' ? 'linkMode.warning.adoptedKey' : 'linkMode.warning.foreignKey'),
      ];
    case 'fresh_subscription_login': return [t('linkMode.warning.freshLogin')];
    case 'subscription_also_present': return [t('linkMode.warning.alsoPresent')];
    case 'record_unreadable': return [t('linkMode.warning.unreadable')];
    default: return [];
  }
}

function LinkModeWarnings({ status, harness, onRemoveForeign }: {
  status: LinkModeStatus;
  harness: string;
  onRemoveForeign: () => void;
}) {
  const { t } = useTranslation('settings');
  const warnings = WARNING_ORDER.filter((warning) => status.warnings.includes(warning));
  if (warnings.length === 0) return null;
  const danger = warnings.some((warning) => DANGER_WARNINGS.has(warning));

  return (
    <SettingsCard tone={danger ? 'danger' : 'warning'}>
      <div role="alert" className="space-y-1.5 text-[13px] leading-relaxed text-foreground">
        {warnings.flatMap((warning) => warningLines(warning, status, harness, t).map((line) => (
          <p key={`${warning}-${line}`} className={DANGER_WARNINGS.has(warning) ? 'font-medium text-danger' : undefined}>
            {line}
          </p>
        )))}
        {warnings.includes('foreign_key_billing') && (
          <Button type="button" size="sm" variant="outline" onClick={onRemoveForeign}>
            {t('linkMode.warning.removeForeign')}
          </Button>
        )}
      </div>
    </SettingsCard>
  );
}

/** The mode now in force, shown only when it differs from the choice or something needs saying. */
function EffectiveLine({ status }: { status: LinkModeStatus }) {
  const { t } = useTranslation('settings');
  const differs = status.chosenMode !== null && status.effectiveMode !== status.chosenMode;
  if (!differs && status.warnings.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <span>{t('linkMode.effective')}</span>
      <StatusBadge tone={status.effectiveMode === 'api_key' ? 'warning' : 'neutral'}>
        {t(`linkMode.mode.${status.effectiveMode}`)}
      </StatusBadge>
    </p>
  );
}

/**
 * Chosen link mode beside the effective one (ADR-200 §5, brief §5): a segmented
 * control for the choice, the mode that actually runs, and one line per drift
 * warning. In API-key mode with no key the page says "not linked" and points at
 * the vendor card; it never hints at a fallback to the subscription (D6).
 * Renders nothing while the unified mode is OFF.
 */
export default function LinkModeSection({ agent }: { agent: LinkHarness }) {
  const { t } = useTranslation('settings');
  const navigation = useSettingsNavigation();
  const { status, saving, failure, outcome, switchMode } = useLinkMode(agent);
  const [request, setRequest] = useState<{ mode: LinkMode; removeForeignKey: boolean } | null>(null);
  if (!status) return null;

  const harness = isolateBidi(HARNESS_LABEL[agent]);
  const unlinkedKey = status.chosenMode === 'api_key' && status.linkState === 'unlinked';
  const confirm = async (payload: SwitchRequest) => {
    await switchMode(payload);
    setRequest(null);
  };

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t('linkMode.label')} className="py-2.5">
          <SegmentedControl
            label={t('linkMode.label')}
            // Nothing is selected while `mode_unset`: no segment matches the empty value.
            value={status.chosenMode ?? ('' as LinkMode)}
            options={[
              { value: 'subscription', label: t('linkMode.mode.subscription') },
              { value: 'api_key', label: t('linkMode.mode.api_key') },
            ]}
            onChange={(mode) => { if (mode !== status.chosenMode) setRequest({ mode, removeForeignKey: false }); }}
          />
        </SettingsRow>
        <div className="space-y-2 pb-2.5">
          {status.chosenMode === null && (
            <p className="text-[13px] text-muted-foreground">{t('linkMode.unset', { harness })}</p>
          )}
          <EffectiveLine status={status} />
          {unlinkedKey && (
            <p className="flex flex-wrap items-center gap-2 text-[13px]">
              <StatusBadge tone="danger">{t('linkMode.unlinked')}</StatusBadge>
              {navigation && (
                <button
                  type="button"
                  onClick={() => navigation.openVendors(agent === 'claude' ? 'anthropic' : 'openai')}
                  className="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('linkMode.addKey')}
                </button>
              )}
            </p>
          )}
          <LinkModeWarnings
            status={status}
            harness={harness}
            onRemoveForeign={() => setRequest({ mode: 'subscription', removeForeignKey: true })}
          />
          {status.granteeCount > 0 && (
            <p className="text-[13px] text-muted-foreground">
              {t('linkMode.grantees', { count: status.granteeCount })}
            </p>
          )}
          <div aria-live="polite" className="text-[13px] leading-relaxed">
            {outcome && OUTCOME_KEYS[outcome] && (
              <p className="text-muted-foreground">{t(`linkMode.outcome.${OUTCOME_KEYS[outcome]}`)}</p>
            )}
            {failure && <p role="alert" className="text-danger">{failure.message}</p>}
          </div>
        </div>
      </SettingsGroup>
      {request && (
        <LinkModeSwitchDialog
          harnessName={HARNESS_LABEL[agent]}
          mode={request.mode}
          removeForeignKey={request.removeForeignKey}
          granteeCount={status.granteeCount}
          offerSetupToken={agent === 'claude' && status.chosenModeSource === 'setup_token'}
          busy={saving}
          onConfirm={(payload) => { void confirm(payload); }}
          onCancel={() => setRequest(null)}
        />
      )}
    </>
  );
}
