/**
 * Confirmation dialogs of the SSO tab (brief §6.1–§6.4). Each one only
 * collects the decision; the caller runs step-up and the write.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Lock } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';

import { INPUT_CLASS, LABEL_CLASS } from './ssoUi';
import type { SsoApplyImpact } from './ssoTypes';

function DialogShell({ open, title, onCancel, children, actions }: {
  open: boolean; title: string; onCancel: () => void; children: ReactNode; actions: ReactNode;
}) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent layerClassName="z-[10000]" className="w-[calc(100%-2rem)] max-w-lg p-5" aria-labelledby={titleId} aria-describedby={bodyId}>
        <DialogTitle id={titleId} className="not-sr-only text-base font-semibold text-foreground">{title}</DialogTitle>
        <div id={bodyId} className="mt-3 space-y-3 text-sm leading-relaxed text-foreground">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>
      </DialogContent>
    </Dialog>
  );
}

export type ApplyDecision = { keepOrphanedSessions?: boolean; confirmation?: string };

/** Brief §6.1 + §6.2: impact lines, the issuer-change block and its typed opt-out. */
export function SsoApplyDialog({ open, impact, firstEnable, onCancel, onConfirm }: {
  open: boolean; impact: SsoApplyImpact | null; firstEnable: boolean;
  onCancel: () => void; onConfirm: (decision: ApplyDecision) => void;
}) {
  const { t } = useTranslation('settings');
  const confirmId = useId();
  const [keep, setKeep] = useState(false);
  const [typed, setTyped] = useState('');
  const phrase = t('sso.dialog.issuer.phrase');

  useEffect(() => { if (open) { setKeep(false); setTyped(''); } }, [open]);

  const issuer = Boolean(impact?.issuerChanged);
  const orphaned = impact?.orphaned ?? 0;
  const showKeep = issuer && orphaned > 0;
  const matches = typed === phrase;
  const blocked = showKeep && keep && !matches;

  return (
    <DialogShell open={open} title={t('sso.dialog.impact.title')} onCancel={onCancel} actions={<>
      <Button type="button" variant="outline"  onClick={onCancel}>{t('sso.dialog.cancel')}</Button>
      <Button type="button"  variant={issuer ? 'destructive' : 'default'} disabled={blocked}
        onClick={() => onConfirm(showKeep && keep ? { keepOrphanedSessions: true, confirmation: typed } : {})}>
        {t('sso.dialog.impact.apply')}
      </Button>
    </>}>
      {impact?.mappingChanged && (impact.reattestRequired ?? 0) > 0 && (
        <p>{t('sso.dialog.impact.reattest', { count: impact.reattestRequired })}</p>
      )}
      {firstEnable && <p>{t('sso.dialog.impact.invites')}</p>}
      {!issuer && !(impact?.mappingChanged && impact.reattestRequired > 0) && !firstEnable && (
        <p>{t('sso.dialog.impact.none')}</p>
      )}
      {issuer && (
        <SettingsCard tone="danger">
          <div className="space-y-2">
            <p className="flex items-start gap-2 font-medium">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              {t('sso.dialog.issuer.title')}
            </p>
            {orphaned > 0 && <p>{t('sso.dialog.issuer.orphans', { count: orphaned })}</p>}
            {impact?.jitForcedOff && (
              <p className="flex items-start gap-2">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                {t('sso.dialog.issuer.jitOff')}
              </p>
            )}
            <p>{t('sso.dialog.issuer.keptLinks')}</p>
            {showKeep && (
              <div className="space-y-2 pt-1">
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={keep} onChange={(event) => setKeep(event.target.checked)} />
                  {t('sso.dialog.issuer.keep', { count: orphaned })}
                </label>
                {keep && (
                  <div className="space-y-1.5">
                    <label htmlFor={confirmId} className={LABEL_CLASS}>
                      {t('sso.dialog.issuer.typePrompt', { phrase })}
                    </label>
                    <input id={confirmId} className={INPUT_CLASS} value={typed} autoComplete="off"
                      onChange={(event) => setTyped(event.target.value)}
                      aria-describedby={`${confirmId}-hint`} />
                    <p id={`${confirmId}-hint`} aria-live="polite" className="text-[13px] text-muted-foreground">
                      {matches ? t('sso.dialog.issuer.matched') : t('sso.dialog.issuer.notMatched')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </SettingsCard>
      )}
    </DialogShell>
  );
}

/** Brief §6.3: keep-sessions choice only while active (with step-up); forced sign-out otherwise. */
export function SsoDisableDialog({ open, active, linked, onCancel, onConfirm }: {
  open: boolean; active: boolean; linked: number; onCancel: () => void; onConfirm: (keep: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const [keep, setKeep] = useState(false);
  useEffect(() => { if (open) setKeep(false); }, [open]);

  return (
    <DialogShell open={open} title={t('sso.dialog.disable.title')} onCancel={onCancel} actions={<>
      <Button type="button" variant="outline"  onClick={onCancel}>{t('sso.dialog.cancel')}</Button>
      <Button type="button" variant="destructive"  onClick={() => onConfirm(active && keep)}>
        {t('sso.dialog.disable.confirm')}
      </Button>
    </>}>
      <p>{active ? t('sso.dialog.disable.signOut', { count: linked }) : t('sso.dialog.disable.forced', { count: linked })}</p>
      <p>{t('sso.dialog.disable.passwords')}</p>
      <p>{t('sso.dialog.disable.kept')}</p>
      {active && (
        <>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={keep} onChange={(event) => setKeep(event.target.checked)} />
            {t('sso.dialog.disable.keep')}
          </label>
          <p className="text-[13px] text-muted-foreground">{t('sso.dialog.private.stepUpNote')}</p>
        </>
      )}
    </DialogShell>
  );
}

/** Brief §6.4: explanation before private-network reach; step-up follows. */
export function SsoPrivateNetworkDialog({ open, onCancel, onAllow }: {
  open: boolean; onCancel: () => void; onAllow: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <DialogShell open={open} title={t('sso.dialog.private.title')} onCancel={onCancel} actions={<>
      <Button type="button" variant="outline"  onClick={onCancel}>{t('sso.dialog.cancel')}</Button>
      <Button type="button"  onClick={onAllow}>{t('sso.dialog.private.allow')}</Button>
    </>}>
      <p>{t('sso.dialog.private.body')}</p>
      <p className="text-muted-foreground">{t('sso.dialog.private.stepUpNote')}</p>
    </DialogShell>
  );
}
