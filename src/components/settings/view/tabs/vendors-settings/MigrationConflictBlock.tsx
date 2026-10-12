import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { isolateBidi } from '../../../../quick-settings-panel/subscriptionHelpers';
import SettingsCard from '../../SettingsCard';
import type { ConflictSource } from '../../../../provider-auth/hooks/useCompanyKey';

import { harnessName } from './vendorFeeds';

type ConflictGroup = {
  /** Sources that hold the same key; `null` = a subscription token, never usable. */
  group: number | null;
  sources: ConflictSource[];
};

/** Equal `group` values merge; every `null` stays its own disabled line. */
function groupSources(sources: readonly ConflictSource[]): ConflictGroup[] {
  const groups: ConflictGroup[] = [];
  for (const source of sources) {
    const existing = source.group === null ? undefined : groups.find((entry) => entry.group === source.group);
    if (existing) existing.sources.push(source);
    else groups.push({ group: source.group, sources: [source] });
  }
  return groups;
}

function sourceLabel(group: ConflictGroup): string {
  return group.sources
    .map((source) => `${harnessName(source.harness)}${source.target ? ` (${source.target})` : ''}`)
    .join(' · ');
}

type MigrationConflictBlockProps = {
  company: string;
  sources: readonly ConflictSource[];
  busy: boolean;
  onChoose: (source: ConflictSource) => void;
};

/**
 * D9: the harness files hold different keys for this vendor, so nothing was
 * written until the user picks the one that stays. One radio per distinct key
 * (never a value or a fingerprint); a subscription token is listed but cannot
 * be picked. Save stays enabled elsewhere: a fresh Save resolves it too.
 */
export default function MigrationConflictBlock({ company, sources, busy, onChoose }: MigrationConflictBlockProps) {
  const { t } = useTranslation('settings');
  const name = useId();
  const groups = groupSources(sources);
  const [picked, setPicked] = useState<number | null>(null);
  const chosen = picked === null ? undefined : groups[picked];

  return (
    <SettingsCard tone="warning">
      <fieldset className="space-y-2" disabled={busy}>
        <legend className="text-[13px] leading-relaxed text-foreground">
          {t('vendors.link.conflict.intro', { company: isolateBidi(company) })}
        </legend>
        <div role="radiogroup" aria-label={t('vendors.link.conflict.groupLabel', { company: isolateBidi(company) })} className="space-y-1">
          {groups.map((group, index) => (
            <label
              key={`${group.group ?? 'none'}-${index}`}
              className="flex min-h-6 cursor-pointer items-center gap-2 text-[13px] text-foreground"
            >
              <input
                type="radio"
                name={name}
                disabled={group.group === null}
                checked={picked === index}
                onChange={() => setPicked(index)}
                className="h-4 w-4 accent-primary"
              />
              <bdi>{sourceLabel(group)}</bdi>
              {group.group === null && (
                <span className="text-muted-foreground">{t('vendors.link.conflict.notUsable')}</span>
              )}
            </label>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!chosen}
          onClick={() => chosen && onChoose(chosen.sources[0])}
        >
          {t('vendors.link.conflict.useThis')}
        </Button>
      </fieldset>
    </SettingsCard>
  );
}
