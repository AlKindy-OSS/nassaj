import { useState } from 'react';
import { FolderLock, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { HarnessFilesMode, HarnessFilesView } from '../../../../../harness-files/harnessFilesApi';
import type { HarnessFilesState } from '../../../../../harness-files/useHarnessFiles';
import { providerDisplayName } from '../../../../../skills/constants';
import { Button } from '../../../../../../shared/view/ui';
import SegmentedControl from '../../../SegmentedControl';
import SettingsCard from '../../../SettingsCard';
import SettingsCollapsible from '../../../SettingsCollapsible';
import SettingsConfirmDialog from '../../../SettingsConfirmDialog';
import SettingsGroup from '../../../SettingsGroup';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';
import SettingsToggle from '../../../SettingsToggle';
import StatusBadge from '../../../StatusBadge';

/**
 * «ملفات الوكلاء» (ADR-203, T-2003 C4): every user picks shared or private
 * skills; owner/admin also hold the workspace switch that lets members use
 * their private files. State and writes come from `useHarnessFiles`, owned by
 * the parent so the skills list below reads the same effective mode.
 *
 * Copy is plain language for the owner: no file paths, no internal codes.
 */

type Translate = ReturnType<typeof useTranslation>['t'];
type Me = HarnessFilesView['me'];

const KNOWN_ERRORS = new Set([
  'HARNESS_FILES_PLATFORM', 'HARNESS_FILES_PRIVATE_DISABLED', 'HARNESS_FILES_FEATURE_DISABLED',
  'HARNESS_FILES_MODE_CHANGED', 'HARNESS_FILES_SEED_TOO_LARGE', 'HARNESS_FILES_PATH_REJECTED',
  'HARNESS_FILES_SEED_SOURCE_UNAVAILABLE', 'HARNESS_FILES_MODE_INVALID',
  'HARNESS_FILES_WORKSPACE_INVALID', 'HARNESS_FILES_WORKSPACE_FORBIDDEN', 'HARNESS_FILES_STORE_FAILED',
]);

/** Plain-language message for a server error code. */
function harnessFilesErrorText(t: Translate, code: string): string {
  const key = KNOWN_ERRORS.has(code) ? code : 'UNKNOWN';
  return t(`harnessFiles.errors.${key}`);
}

/** Why the effective mode differs from the stored choice, or null when they match. */
function effectiveNote(t: Translate, view: HarnessFilesView): string | null {
  const { me, workspace } = view;
  if (me.requested === me.effective) return null;
  if (me.requested === 'private' && !me.canManageWorkspace && !workspace.allowMemberPrivate) {
    return t('harnessFiles.effective.switchOff');
  }
  return t('harnessFiles.effective.generic', {
    mode: t(me.effective === 'private' ? 'harnessFiles.modePrivate' : 'harnessFiles.modeShared'),
  });
}

function ClaudeLinkNote({ me, lastClaudeLink }: { me: Me; lastClaudeLink: string | null }) {
  const { t } = useTranslation('settings');
  const pending = me.claude.link === 'pending' || lastClaudeLink === 'deferred-live-session';
  if (me.claude.link === 'legacy-real-dir' || lastClaudeLink === 'legacy-real-dir') {
    return <SettingsCard tone="warning"><p className="text-[13px] leading-relaxed text-foreground">{t('harnessFiles.claudeLegacy')}</p></SettingsCard>;
  }
  if (!pending) return null;
  return (
    <SettingsCard tone="info">
      <p className="text-[13px] leading-relaxed text-foreground" role="status">{t('harnessFiles.claudePending')}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t('harnessFiles.claudePendingHint')}</p>
    </SettingsCard>
  );
}

/** Owner/admin on private files manage their own skills, not the shared library. */
function ModeNotes({ me, lastClaudeLink }: { me: Me; lastClaudeLink: string | null }) {
  const { t } = useTranslation('settings');
  return (
    <>
      {me.canManageWorkspace && me.effective === 'private' && (
        <SettingsCard tone="info">
          <p className="text-[13px] leading-relaxed text-foreground" data-testid="harness-files-manager-private">
            {t('harnessFiles.managerPrivateNote')}
          </p>
        </SettingsCard>
      )}
      <ClaudeLinkNote me={me} lastClaudeLink={lastClaudeLink} />
    </>
  );
}

function MyModeRow({ state }: { state: HarnessFilesState }) {
  const { t } = useTranslation('settings');
  const view = state.view as HarnessFilesView;
  const { me } = view;
  const blockedReason = me.canChoose ? null : t('harnessFiles.blockedReason');
  const note = effectiveNote(t, view);

  return (
    <SettingsRow
      label={t('harnessFiles.myChoice.label')}
      description={(
        <span className="block space-y-1">
          <span className="block">{t('harnessFiles.myChoice.description')}</span>
          {blockedReason && !note && (
            <span className="block text-foreground" data-testid="harness-files-blocked">{blockedReason}</span>
          )}
          {note && <span className="block font-medium text-warning" data-testid="harness-files-effective">{note}</span>}
        </span>
      )}
    >
      <div className="flex items-center gap-2">
        {state.isSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
        <SegmentedControl<HarnessFilesMode>
          label={t('harnessFiles.myChoice.label')}
          // A blocked choice shows what actually runs; the saved one is named in the note.
          value={me.canChoose ? me.requested : me.effective}
          onChange={(mode) => { if (!state.isSaving && mode !== me.requested) void state.setMyMode(mode); }}
          options={[
            { value: 'shared', label: t('harnessFiles.modeShared') },
            { value: 'private', label: t('harnessFiles.modePrivate'), blockedReason },
          ]}
        />
      </div>
    </SettingsRow>
  );
}

function WorkspaceConfirmBody({ allow, saved }: { allow: boolean; saved: number }) {
  const { t } = useTranslation('settings');
  if (!allow) return <p>{t('harnessFiles.workspace.confirmOffBody')}</p>;
  return (
    <>
      <p>{t('harnessFiles.workspace.confirmOnBody')}</p>
      <p className="font-medium" data-testid="harness-files-saved-count">
        {saved > 0 ? t('harnessFiles.workspace.savedMembers', { count: saved }) : t('harnessFiles.workspace.savedNone')}
      </p>
    </>
  );
}

function WorkspaceSwitchRow({ state }: { state: HarnessFilesState }) {
  const { t } = useTranslation('settings');
  const [pending, setPending] = useState<boolean | null>(null);
  const { workspace } = state.view as HarnessFilesView;
  const label = t('harnessFiles.workspace.label');

  const confirm = async () => {
    if (pending === null) return;
    const ok = await state.setAllowMemberPrivate(pending);
    if (ok) setPending(null);
  };

  return (
    <>
      <SettingsRow
        label={label}
        description={(
          <span className="block space-y-1">
            <span className="block">{t('harnessFiles.workspace.description')}</span>
            {state.lastAffectedMembers !== null && (
              <span className="block text-foreground" role="status">
                {t('harnessFiles.workspace.affected', { count: state.lastAffectedMembers })}
              </span>
            )}
          </span>
        )}
      >
        <SettingsToggle
          checked={workspace.allowMemberPrivate}
          ariaLabel={label}
          disabled={state.isSaving}
          onChange={(next) => { state.clearSaveError(); setPending(next); }}
        />
      </SettingsRow>
      {pending !== null && (
        <SettingsConfirmDialog
          title={t(pending ? 'harnessFiles.workspace.confirmOnTitle' : 'harnessFiles.workspace.confirmOffTitle')}
          confirmLabel={t(pending ? 'harnessFiles.workspace.confirmOn' : 'harnessFiles.workspace.confirmOff')}
          cancelLabel={t('harnessFiles.cancel')}
          busy={state.isSaving}
          onConfirm={() => void confirm()}
          onCancel={() => { state.clearSaveError(); setPending(null); }}
        >
          <WorkspaceConfirmBody allow={pending} saved={workspace.savedPrivateMembers ?? 0} />
          {state.saveErrorCode && (
            <p className="text-danger" role="alert">{harnessFilesErrorText(t, state.saveErrorCode)}</p>
          )}
        </SettingsConfirmDialog>
      )}
    </>
  );
}

function HarnessSupportList({ me }: { me: Me }) {
  const { t } = useTranslation('settings');
  if (me.harnesses.length === 0) return null;
  return (
    <SettingsCollapsible summary={t('harnessFiles.harnesses.title')}>
      <SettingsGroup as="ul">
        {me.harnesses.map((harness) => {
          const full = harness.support === 'full';
          const reasonKey = full ? 'full' : (harness.reason ?? 'unknown');
          return (
            <li key={harness.provider}>
              <SettingsRow
                label={providerDisplayName(harness.provider)}
                description={t(`harnessFiles.harnesses.reasons.${reasonKey}`, {
                  defaultValue: t('harnessFiles.harnesses.reasons.unknown'),
                })}
              >
                <StatusBadge tone={full ? 'success' : 'neutral'}>
                  {t(full ? 'harnessFiles.harnesses.full' : 'harnessFiles.harnesses.sharedOnly')}
                </StatusBadge>
              </SettingsRow>
            </li>
          );
        })}
      </SettingsGroup>
    </SettingsCollapsible>
  );
}

function SectionBody({ state }: { state: HarnessFilesState }) {
  const { t } = useTranslation('settings');
  if (!state.view) {
    if (state.loadErrorCode) {
      return (
        <SettingsCard tone="danger">
          <p className="text-[13px] leading-relaxed text-danger" role="alert">{t('harnessFiles.loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void state.reload()}>
            {t('harnessFiles.retry')}
          </Button>
        </SettingsCard>
      );
    }
    return (
      <p className="flex items-center text-[13px] leading-relaxed text-muted-foreground" role="status">
        <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
        {t('harnessFiles.loading')}
      </p>
    );
  }

  const { me } = state.view;
  if (!me.featureEnabled) {
    return (
      <SettingsCard>
        <p className="text-[13px] leading-relaxed text-foreground" data-testid="harness-files-feature-off">
          {t('harnessFiles.featureOff')}
        </p>
      </SettingsCard>
    );
  }

  return (
    <div className="space-y-3">
      <SettingsGroup>
        <MyModeRow state={state} />
        {me.canManageWorkspace && <WorkspaceSwitchRow state={state} />}
      </SettingsGroup>
      {state.saveErrorCode && (
        <SettingsCard tone="danger">
          <p className="text-[13px] leading-relaxed text-danger" role="alert">
            {harnessFilesErrorText(t, state.saveErrorCode)}
          </p>
        </SettingsCard>
      )}
      <ModeNotes me={me} lastClaudeLink={state.lastClaudeLink} />
      <HarnessSupportList me={me} />
    </div>
  );
}

export default function HarnessFilesSection({ state }: { state: HarnessFilesState }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsSection
      boxed
      icon={FolderLock}
      title={t('harnessFiles.title')}
      description={t('harnessFiles.description')}
    >
      <SectionBody state={state} />
    </SettingsSection>
  );
}
